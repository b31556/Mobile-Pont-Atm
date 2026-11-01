// Pont reader: an ESP32 with an MFRC522 card reader and a 4-digit TM1637 display.
//
// It joins WiFi, introduces itself to the server (POST /device/hello) and waits to be approved in the admin
// site, showing a 4-digit code on its display meanwhile. Once approved it works as the admin has set it up:
// a fixed-amount reader (everybody who taps gets the same points), a check-in point (sign in / out) or an info
// kiosk (a tap only shows the card's points).
// While a tap is read and answered a four-step bar fills the display (a line per digit); then it shows the balance.
#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <MFRC522.h>
#include <Preferences.h>
#include <SPI.h>
#include <TM1637Display.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_system.h>
#include <time.h>

#if __has_include("config.h")
#include "config.h"
#else
#error "Copy include/config.example.h to include/config.h and fill in your WiFi and server address."
#endif
#include "DisplayLogic.h"
#include "root_ca.h"

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
static const uint32_t SAME_CARD_PAUSE_MS = 1000;       // the same card read again this soon after a tap is ignored
static const uint8_t BRIGHT_ACTIVE = 7, BRIGHT_IDLE = 2;

MFRC522 rfid(PIN_RFID_SS, PIN_RFID_RST);
TM1637Display display(PIN_DISPLAY_CLK, PIN_DISPLAY_DIO);
Preferences prefs;
WiFiClientSecure secureClient;       // used when SERVER_URL is https://; kept between calls so the connection can be reused
WiFiClient plainClient;              // used when SERVER_URL is http:// (a trusted network only)

String deviceId, secret, token, mode, pairCode;
String status = "pending";           // pending | approved | revoked | denied
bool serverReachable = false;
uint32_t lastHelloMs = 0;
bool rfidOk = true;
uint32_t lastRfidCheckMs = 0;
char lastUid[32] = "";
uint32_t lastTapEndMs = 0;
reader::StepQueue steps;             // what the display shows next; it never blocks, so cards keep being read
bool idleShown = false;

// ---------------------------------------------------------------- display

void showSegments(const uint8_t seg[4]) { display.setSegments(seg); }

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

void setBrightness(uint8_t level) { display.setBrightness(level); }

/** One step of the bar: a line in the middle of one more digit. Called as each stage of a tap is done. */
void showProgress(int step) {
  uint8_t seg[4];
  reader::progressFrame(step, seg);
  showSegments(seg);
}

/** What the display shows while nothing is happening (the rules are in DisplayLogic.h and are tested there). */
void showIdle() {
  const bool online = WiFi.status() == WL_CONNECTED && serverReachable;
  const char* text = reader::idleText(status.c_str(), online, rfidOk, pairCode.c_str());
  showText(text);
  setBrightness(strcmp(text, "----") == 0 ? BRIGHT_IDLE : BRIGHT_ACTIVE);
  idleShown = true;
}

/**
 * Called all the time from loop(): moves the display on to its next step when the time is up, and back to the
 * idle text when there are none left. A tap clears the steps, so a new card can be read at any moment.
 */
void tickDisplay() {
  const uint32_t now = millis();
  uint8_t seg[4];
  if (steps.tick(now, seg)) { setBrightness(BRIGHT_ACTIVE); showSegments(seg); idleShown = false; }
  else if (!steps.busy(now) && !idleShown) showIdle();
}

// ---------------------------------------------------------------- server

String hex32() {
  char buf[33];
  for (int i = 0; i < 4; i++) snprintf(buf + i * 8, 9, "%08x", esp_random());
  return String(buf);
}

bool serverIsHttps() { return strncmp(SERVER_URL, "https://", 8) == 0; }

/** An https server's certificate is only valid between two dates, so the reader needs the real date and time first. */
bool clockReady() { return time(nullptr) > 1700000000; }   // later than November 2023: the clock has been set from the internet

void startClock() {
  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");   // keeps retrying by itself until it succeeds
  const uint32_t start = millis();
  while (!clockReady() && millis() - start < 10000) delay(100);
  Serial.printf("Clock: %s\n", clockReady() ? "set from the internet" : "not set yet (https calls wait for it)");
}

/**
 * POSTs JSON to the server. Returns the HTTP status, or 0 when no answer arrived. Over https the server's certificate
 * must chain up to ROOT_CA_PEM and match the host name, or nothing is sent. The connection is kept open between calls,
 * and if a kept connection has gone stale the call is made once more on a fresh one (the same body and key, so a
 * repeat cannot give points twice).
 */
int postJson(const String& path, const String& body, String& answer, bool withToken, void (*stage)(int) = nullptr) {
  if (WiFi.status() != WL_CONNECTED) return 0;
  const bool tls = serverIsHttps();
  if (tls && !clockReady()) { Serial.println("TLS: waiting for the clock, not sending"); return 0; }
  WiFiClient& client = tls ? static_cast<WiFiClient&>(secureClient) : plainClient;
  int code = 0;
  for (int pass = 0; pass < 2; pass++) {
    const bool reused = client.connected();
    const uint32_t startedMs = millis();
    // Kept for the life of the program, on purpose: the library closes the connection when an HTTPClient is destroyed,
    // so one made fresh for each call would do a new TLS handshake every time (about 1.7 s here instead of about 0.1 s).
    static HTTPClient http;
    http.setReuse(true);
    http.setConnectTimeout(tls ? 6000 : 3000);
    http.setTimeout(4000);
    if (!http.begin(client, String(SERVER_URL) + path)) return 0;
    http.addHeader("Content-Type", "application/json");
    if (withToken) http.addHeader("Authorization", "Bearer " + token);
    if (stage) stage(2);                     // request on its way
    code = http.POST(body);
    if (stage) stage(3);                     // the server has answered
    if (code > 0) answer = http.getString();
    http.end();
    Serial.printf("%s -> HTTP %d in %lu ms (%s connection)\n", path.c_str(), code, static_cast<unsigned long>(millis() - startedMs), reused ? "kept" : "new");
    if (code > 0) break;
    if (tls && !reused) {                    // a fresh connection failed: say why (a wrong clock or certificate shows up here)
      char why[100] = "";
      secureClient.lastError(why, sizeof why);
      Serial.printf("TLS: connection failed: %s\n", why[0] ? why : "no detail");
    }
    client.stop();
    if (!reused) break;                      // only a stale kept connection is worth one more try right away
  }
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
  if (code == 429) { status = "busy"; Serial.println("hello: the server has too many readers waiting for approval (or too many tries). Approve or remove some in admin."); return; }
  if (code != 200) { Serial.printf("hello: HTTP %d\n", code); return; }
  const String s = doc["status"] | "";
  if (s == "approved") {
    // Every hello brings a freshly signed token, but an earlier one stays valid, so the flash is written only
    // the first time (or after a revoke), not every 30 seconds.
    const String t = doc["terminalToken"] | "";
    if (t.length() && token.length() == 0) { token = t; prefs.putString("token", token); }
    const String newMode = String(doc["mode"] | "fixed");
    if (newMode != mode) { mode = newMode; prefs.putString("mode", mode); }
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
      ? reader::planFor(doc["action"] | "", mode == "presence")
      : reader::planForHttp(httpStatus, parsed ? (doc["code"] | "") : nullptr);
  // Signed in, but a visit that was still open somewhere else was cancelled by it: warn first.
  if (httpStatus == 200 && parsed && doc["discarded"].is<JsonObject>() && strcmp(doc["action"] | "", "in") == 0) plan = reader::planDiscarded();
  if (httpStatus == 401) { token = ""; prefs.remove("token"); status = "pending"; lastHelloMs = 0; }   // not accepted any more: ask again
  if (httpStatus == 409) lastHelloMs = 0;                                                            // the mode was changed in admin: learn the new one now
  Serial.printf("tap answer: HTTP %d -> %s\n", httpStatus, plan.word);

  reader::queuePlan(steps, plan, parsed ? (doc["card"]["balance"] | -1L) : -1L);
}

String makeKey() { return hex32().substring(0, 16) + String(millis(), HEX); }

/** A card was read: send it and show the answer as fast as it arrives. */
void handleCard(const char* uid) {
  steps.clear();                           // whatever was on show gives way to this card at once
  setBrightness(BRIGHT_ACTIVE);
  idleShown = false;
  showProgress(1);                         // card read
  JsonDocument out;
  out["cardUid"] = uid;
  out["idempotencyKey"] = makeKey();       // the same key on every retry, so a lost answer can't give points twice
  String payload, answer;
  serializeJson(out, payload);
  const String path = (mode == "presence") ? "/presence/tap" : (mode == "info") ? "/info/tap" : "/fixed/tap";
  int code = 0;
  for (int attempt = 0; attempt < 3 && code == 0; attempt++) {
    code = postJson(path, payload, answer, true, showProgress);
    if (code == 0) delay(300);
  }
  serverReachable = code > 0;
  showProgress(reader::PROGRESS_STEPS);    // answer understood: the bar is full, the result follows at once
  present(code, answer);
  tickDisplay();                           // the first step of the result goes up now; the rest follows from loop()
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
  if (rfidPresent()) { if (!rfidOk) { rfidOk = true; idleShown = false; } return; }
  rfid.PCD_Init();                         // the chip stopped answering (power dip?): start it again
  if (!rfidPresent()) { if (rfidOk) { rfidOk = false; Serial.println("MFRC522 not answering. Check the wiring."); idleShown = false; } }
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

/** Says in the serial log why WiFi lets go: reason 15 / 202 = wrong password, 201 = network not found, 2 = auth expired. */
void onWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) Serial.printf("WiFi: disconnected, reason %d\n", info.wifi_sta_disconnected.reason);
  if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) { WiFi.setSleep(false); Serial.printf("WiFi: got address %s\n", WiFi.localIP().toString().c_str()); }
}

/** Prints the networks this reader can see, to tell a wrong name from a weak signal from a 5 GHz-only network. */
void listNetworks() {
  Serial.println("WiFi: networks this reader can see (name, signal in dBm, channel):");
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(false);                  // a scan fails while the radio is busy retrying to join
  delay(300);
  const int n = WiFi.scanNetworks();
  if (n <= 0) Serial.println("  none: the antenna may be covered, or the board is too far from the router");
  for (int i = 0; i < n && i < 15; i++) {
    const String ssid = WiFi.SSID(i);
    Serial.printf("  \"%s\"  %d dBm  channel %d%s\n", ssid.c_str(), WiFi.RSSI(i), WiFi.channel(i), ssid == WIFI_SSID ? "   <-- the one in config.h" : "");
  }
  WiFi.scanDelete();
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void connectWifi() {
  WiFi.onEvent(onWifiEvent);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                    // this reader is plugged in: modem sleep only adds a wait of 100 ms or more to every exchange
  WiFi.setAutoReconnect(true);
  Serial.printf("WiFi: joining \"%s\"\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  showText("nEt");                         // not online yet
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) delay(100);
  Serial.printf("WiFi: %s (status %d)  address %s\n", WiFi.status() == WL_CONNECTED ? "connected" : "not connected yet", static_cast<int>(WiFi.status()), WiFi.localIP().toString().c_str());
  if (WiFi.status() != WL_CONNECTED) listNetworks();
}

void setup() {
  Serial.begin(115200);
  display.setBrightness(BRIGHT_ACTIVE);
  showText("    ");

  SPI.begin();
  rfid.PCD_Init();
  checkRfid();

  WiFi.mode(WIFI_STA);                     // radio on first: the random numbers for the secret are then truly random
  prefs.begin("pont", false);
  mode = prefs.getString("mode", "");
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
  if (serverIsHttps()) {
    secureClient.setCACert(ROOT_CA_PEM);     // without this the connection is refused: the server is never accepted unchecked
    secureClient.setHandshakeTimeout(10);    // seconds
    startClock();
  } else {
    Serial.println("WARNING: SERVER_URL is plain http://. Tokens and card numbers travel unencrypted. Use https:// for a server outside a trusted network.");
  }
  sayHello();
  showIdle();
}

void loop() {
  const uint32_t now = millis();

  if (now - lastHelloMs > (status == "pending" ? HELLO_PENDING_EVERY_MS : HELLO_EVERY_MS) || lastHelloMs == 0) {
    const String before = status;
    const bool wasReachable = serverReachable;
    sayHello();
    if ((before != status || wasReachable != serverReachable || status == "pending") && !steps.busy(millis())) showIdle();
  }
  if (now - lastRfidCheckMs > 10000) checkRfid();
  tickDisplay();

  if (status == "approved" && token.length() && rfidOk) {
    char uid[32];
    if (readCard(uid, sizeof uid)) {
      const bool sameCardAgain = strcmp(uid, lastUid) == 0 && millis() - lastTapEndMs < SAME_CARD_PAUSE_MS;
      if (!sameCardAgain) handleCard(uid);
    }
  }
  delay(20);
}
