// Pont reader: an ESP32 with an MFRC522 card reader and a 4-digit TM1637 display.
//
// It joins WiFi, introduces itself to the server (POST /device/hello) and waits to be approved in the admin
// site, showing a 4-digit code on its display meanwhile. Once approved it works as the admin has set it up:
// a fixed-amount reader (everybody who taps gets the same points) or a check-in point (sign in / out).
// While the server answers a tap, lines fill the display; then it rolls to the card's balance.
#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <MFRC522.h>
#include <Preferences.h>
#include <SPI.h>
#include <TM1637Display.h>
#include <WiFi.h>
#include <esp_system.h>

#if __has_include("config.h")
#include "config.h"
#else
#error "Copy include/config.example.h to include/config.h and fill in your WiFi and server address."
#endif
#include "DisplayLogic.h"

#ifndef PIN_RFID_SS
#define PIN_RFID_SS 5
#endif
#ifndef PIN_RFID_RST
#define PIN_RFID_RST 22
#endif
#ifndef PIN_DISPLAY_CLK
#define PIN_DISPLAY_CLK 16
#endif
#ifndef PIN_DISPLAY_DIO
#define PIN_DISPLAY_DIO 17
#endif

static const char* FIRMWARE = "1.0.0";
static const uint32_t HELLO_EVERY_MS = 30000;          // approved readers check in this often
static const uint32_t HELLO_PENDING_EVERY_MS = 4000;   // waiting readers ask faster, so approval shows up quickly
static const uint32_t MIN_LOADING_MS = 900;            // one full fill of the lines, so the animation is always seen
static const uint32_t SAME_CARD_PAUSE_MS = 3000;
static const uint8_t BRIGHT_ACTIVE = 7, BRIGHT_IDLE = 2;

MFRC522 rfid(PIN_RFID_SS, PIN_RFID_RST);
TM1637Display display(PIN_DISPLAY_CLK, PIN_DISPLAY_DIO);
Preferences prefs;
SemaphoreHandle_t displayLock;

String deviceId, secret, token, mode, pairCode;
String status = "pending";           // pending | approved | revoked | denied
bool serverReachable = false;
uint32_t lastHelloMs = 0;
bool rfidOk = true;
uint32_t lastRfidCheckMs = 0;
char lastUid[32] = "";
uint32_t lastTapEndMs = 0;
volatile bool loading = false;

// ---------------------------------------------------------------- display

void showSegments(const uint8_t seg[4]) {
  xSemaphoreTake(displayLock, portMAX_DELAY);
  display.setSegments(seg);
  xSemaphoreGive(displayLock);
}

void showText(const char* text) {
  uint8_t seg[4];
  reader::textToSegments(text, seg);
  showSegments(seg);
}

void showNumber(long n) {
  uint8_t seg[4];
  reader::numberToSegments(n, seg);
  showSegments(seg);
}

void setBrightness(uint8_t level) {
  xSemaphoreTake(displayLock, portMAX_DELAY);
  display.setBrightness(level);
  xSemaphoreGive(displayLock);
}

/** Draws one animation frame, but only if the animation is still wanted once the display is ours. */
void showFrameIfLoading(const uint8_t seg[4]) {
  xSemaphoreTake(displayLock, portMAX_DELAY);
  if (loading) display.setSegments(seg);
  xSemaphoreGive(displayLock);
}

/** Runs beside the main loop: draws the filling lines for as long as [loading] is set. */
void animationTask(void*) {
  int step = 0;
  for (;;) {
    if (loading) {
      uint8_t seg[4];
      reader::loadingFrame(step++, seg);
      showFrameIfLoading(seg);
      vTaskDelay(pdMS_TO_TICKS(70));
    } else {
      step = 0;
      vTaskDelay(pdMS_TO_TICKS(15));
    }
  }
}

void startLoading() { setBrightness(BRIGHT_ACTIVE); loading = true; }

void stopLoading() {
  loading = false;
  xSemaphoreTake(displayLock, portMAX_DELAY);   // wait until a frame in progress is finished
  xSemaphoreGive(displayLock);
}

void blinkText(const char* text, int times) {
  for (int i = 0; i < times; i++) {
    showText(text); delay(280);
    showText("    "); delay(180);
  }
}

/** Counts from [from] to [to], then holds it. Numbers wider than the display scroll across. */
void showBalance(long from, long to) {
  if (reader::fitsOnDisplay(to)) {
    const int steps = (from == to) ? 0 : 14;
    for (int i = 0; i <= steps; i++) { showNumber(reader::rollValue(from, to, i, steps)); if (i < steps) delay(45); }
    delay(3000);
    return;
  }
  char digits[16];
  snprintf(digits, sizeof digits, "%ld", to);
  const int positions = reader::scrollPositions(static_cast<int>(strlen(digits)));
  for (int p = 0; p < positions; p++) {
    uint8_t seg[4];
    reader::scrollFrame(digits, p, seg);
    showSegments(seg);
    delay(p == 0 ? 900 : 550);
  }
  delay(1800);
}

/** What the display shows while nothing is happening. */
void showIdle() {
  setBrightness(BRIGHT_IDLE);
  if (status == "pending") { showText(reader::isPairCode(pairCode.c_str()) ? pairCode.c_str() : "PEnd"); setBrightness(BRIGHT_ACTIVE); return; }
  if (status == "revoked") { showText("OFF"); return; }
  if (status == "denied")  { showText("Err"); return; }
  if (WiFi.status() != WL_CONNECTED || !serverReachable || !rfidOk) { showText(rfidOk ? "nEt" : "Err"); return; }
  showText("----");
}

// ---------------------------------------------------------------- server

String hex32() {
  char buf[33];
  for (int i = 0; i < 4; i++) snprintf(buf + i * 8, 9, "%08x", esp_random());
  return String(buf);
}

/** POSTs JSON to the server. Returns the HTTP status, or 0 when no answer arrived. */
int postJson(const String& path, const String& body, String& answer, bool withToken) {
  if (WiFi.status() != WL_CONNECTED) return 0;
  WiFiClient client;
  HTTPClient http;
  http.setConnectTimeout(3000);
  http.setTimeout(4000);
  if (!http.begin(client, String(SERVER_URL) + path)) return 0;
  http.addHeader("Content-Type", "application/json");
  if (withToken) http.addHeader("Authorization", "Bearer " + token);
  const int code = http.POST(body);
  if (code > 0) answer = http.getString();
  http.end();
  return code > 0 ? code : 0;
}

/** Introduces the reader and learns whether it is approved, and in what mode. */
void sayHello() {
  lastHelloMs = millis();
  JsonDocument out;
  out["deviceId"] = deviceId;
  out["secret"] = secret;
  out["firmware"] = FIRMWARE;
  String payload, answer;
  serializeJson(out, payload);
  const int code = postJson("/device/hello", payload, answer, false);
  serverReachable = code > 0;
  if (code == 0) { Serial.println("hello: no answer from the server"); return; }
  JsonDocument doc;
  if (deserializeJson(doc, answer)) { Serial.println("hello: unreadable answer"); return; }
  if (code == 403) { status = "denied"; Serial.println("hello: the server does not accept this reader's secret. Forget the device in admin and reset it."); return; }
  if (code != 200) { Serial.printf("hello: HTTP %d\n", code); return; }
  const String s = doc["status"] | "";
  if (s == "approved") {
    const String t = doc["terminalToken"] | "";
    if (t.length() && t != token) { token = t; prefs.putString("token", token); }
    mode = String(doc["mode"] | "fixed");
    pairCode = "";
    status = "approved";
  } else if (s == "pending") {
    pairCode = String(doc["code"] | "");
    status = "pending";
  } else if (s == "revoked") {
    token = ""; prefs.remove("token"); status = "revoked";
  }
  Serial.printf("hello: %s mode=%s code=%s\n", status.c_str(), mode.c_str(), pairCode.c_str());
}

/** Shows what the server answered to a tap. */
void present(int httpStatus, const String& answer) {
  JsonDocument doc;
  const bool parsed = httpStatus > 0 && !deserializeJson(doc, answer);
  reader::Plan plan = (httpStatus == 200 && parsed)
      ? reader::planFor(doc["action"] | "")
      : reader::planForHttp(httpStatus, parsed ? (doc["code"] | "") : nullptr);
  if (httpStatus == 401) { token = ""; prefs.remove("token"); status = "pending"; lastHelloMs = 0; }   // not accepted any more: ask again
  Serial.printf("tap answer: HTTP %d -> %s\n", httpStatus, plan.word);

  if (plan.word[0]) { if (plan.blink) blinkText(plan.word, 3); else { showText(plan.word); delay(plan.showBalance ? 800 : 1500); } }
  if (plan.showBalance && parsed) {
    const long to = doc["card"]["balance"] | 0L;
    const long points = doc["points"] | 0L;
    const long from = doc["balanceBefore"].is<long>() ? doc["balanceBefore"].as<long>() : (to - points);
    showBalance(from < 0 ? to : from, to);
  }
}

String makeKey() { return hex32().substring(0, 16) + String(millis(), HEX); }

/** A card was read: send it, animate while waiting, show the answer. */
void handleCard(const char* uid) {
  const uint32_t start = millis();
  startLoading();
  JsonDocument out;
  out["cardUid"] = uid;
  out["idempotencyKey"] = makeKey();       // the same key on every retry, so a lost answer can't give points twice
  String payload, answer;
  serializeJson(out, payload);
  const String path = (mode == "presence") ? "/presence/tap" : "/fixed/tap";
  int code = 0;
  for (int attempt = 0; attempt < 3 && code == 0; attempt++) {
    code = postJson(path, payload, answer, true);
    if (code == 0) delay(300);
  }
  serverReachable = code > 0;
  while (millis() - start < MIN_LOADING_MS) delay(10);
  stopLoading();
  setBrightness(BRIGHT_ACTIVE);
  present(code, answer);
  showIdle();
  strncpy(lastUid, uid, sizeof lastUid - 1);
  lastTapEndMs = millis();
}

// ---------------------------------------------------------------- card reader

bool rfidPresent() {
  const byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  return v != 0x00 && v != 0xFF;
}

void checkRfid() {
  lastRfidCheckMs = millis();
  if (rfidPresent()) { if (!rfidOk) { rfidOk = true; showIdle(); } return; }
  rfid.PCD_Init();                         // the chip stopped answering (power dip?): start it again
  if (!rfidPresent()) { if (rfidOk) { rfidOk = false; Serial.println("MFRC522 not answering. Check the wiring."); showIdle(); } }
}

/** Returns true and fills [uid] when a card has just been presented. */
bool readCard(char* uid, size_t size) {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return false;
  const bool ok = reader::isSupportedUidLength(rfid.uid.size);
  if (ok) reader::formatUid(rfid.uid.uidByte, rfid.uid.size, uid, size);
  rfid.PICC_HaltA();                       // the card must leave and come back before it is read again
  rfid.PCD_StopCrypto1();
  return ok;
}

// ---------------------------------------------------------------- setup and loop

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  startLoading();
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) delay(100);
  stopLoading();
  Serial.printf("WiFi: %s  address %s\n", WiFi.status() == WL_CONNECTED ? "connected" : "not connected yet", WiFi.localIP().toString().c_str());
}

void setup() {
  Serial.begin(115200);
  displayLock = xSemaphoreCreateMutex();
  xTaskCreatePinnedToCore(animationTask, "anim", 3072, nullptr, 1, nullptr, 0);
  display.setBrightness(BRIGHT_ACTIVE);
  showText("8888"); delay(400);
  showText("    ");

  SPI.begin();
  rfid.PCD_Init();
  checkRfid();

  prefs.begin("pont", false);
  secret = prefs.getString("secret", "");
  if (secret.length() < 16) { secret = hex32(); prefs.putString("secret", secret); }
  token = prefs.getString("token", "");
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);     // readable before WiFi is started, unlike WiFi.macAddress()
  char id[18];
  snprintf(id, sizeof id, "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  deviceId = id;                           // e.g. 24:6F:28:AA:BB:01
  Serial.printf("Pont reader %s, device id %s\n", FIRMWARE, deviceId.c_str());
  if (token.length()) status = "approved";  // until the first hello says otherwise

  connectWifi();
  sayHello();
  showIdle();
}

void loop() {
  const uint32_t now = millis();

  if (now - lastHelloMs > (status == "pending" ? HELLO_PENDING_EVERY_MS : HELLO_EVERY_MS) || lastHelloMs == 0) {
    const String before = status;
    const bool wasReachable = serverReachable;
    sayHello();
    if (before != status || wasReachable != serverReachable || status == "pending") showIdle();
  }
  if (now - lastRfidCheckMs > 10000) checkRfid();

  if (status == "approved" && token.length() && rfidOk) {
    char uid[32];
    if (readCard(uid, sizeof uid)) {
      const bool sameCardAgain = strcmp(uid, lastUid) == 0 && millis() - lastTapEndMs < SAME_CARD_PAUSE_MS;
      if (!sameCardAgain) handleCard(uid);
    }
  }
  delay(20);
}
