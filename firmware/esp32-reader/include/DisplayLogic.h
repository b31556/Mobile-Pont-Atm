// Everything about what the 4-digit display shows, with no Arduino code in it so it can be tested on a computer
// (see test/host). Segment bits follow the TM1637 library: a=0x01 b=0x02 c=0x04 d=0x08 e=0x10 f=0x20 g=0x40 dp=0x80.
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace reader {

// (named so they cannot clash with the SEG_A... macros of the TM1637 library)
constexpr uint8_t LINE_MIDDLE = 0x40;

/** The segments for one character; anything that can't be drawn on seven segments is blank. */
inline uint8_t glyph(char c) {
  switch (c) {
    case '0': return 0x3F; case '1': return 0x06; case '2': return 0x5B; case '3': return 0x4F; case '4': return 0x66;
    case '5': return 0x6D; case '6': return 0x7D; case '7': return 0x07; case '8': return 0x7F; case '9': return 0x6F;
    case 'A': return 0x77; case 'b': return 0x7C; case 'C': return 0x39; case 'c': return 0x58; case 'd': return 0x5E;
    case 'E': return 0x79; case 'F': return 0x71; case 'H': return 0x76; case 'h': return 0x74; case 'I': return 0x06;
    case 'L': return 0x38; case 'n': return 0x54; case 'O': return 0x3F; case 'o': return 0x5C; case 'P': return 0x73;
    case 'r': return 0x50; case 'S': return 0x6D; case 't': return 0x78; case 'U': return 0x3E; case 'u': return 0x1C;
    case 'y': return 0x6E; case '-': return 0x40; case '_': return 0x08;
    default: return 0x00;
  }
}

/** Up to four characters, padded with blanks. */
inline void textToSegments(const char* text, uint8_t out[4]) {
  for (int i = 0; i < 4; i++) out[i] = 0;
  if (!text) return;
  for (int i = 0; i < 4 && text[i]; i++) out[i] = glyph(text[i]);
}

inline bool fitsOnDisplay(long n) { return n >= 0 && n <= 9999; }

/** A number right-aligned with no leading zeros. Out of range is capped, so it can never show something wrong-looking. */
inline void numberToSegments(long n, uint8_t out[4]) {
  if (n < 0) n = 0;
  if (n > 9999) n = 9999;
  char buf[8];
  std::snprintf(buf, sizeof buf, "%ld", n);
  const int len = static_cast<int>(std::strlen(buf));
  for (int i = 0; i < 4; i++) out[i] = 0;
  for (int i = 0; i < len; i++) out[4 - len + i] = glyph(buf[i]);
}

/** The bar has one step per digit. */
constexpr int PROGRESS_STEPS = 4;

/**
 * The bar shown while a tap is read and answered: a line in the middle of digit 1, then of digit 2, and so on,
 * one step for each stage of the work. Step 4 is "----", which is also what the display shows when ready.
 */
inline void progressFrame(int step, uint8_t out[4]) {
  for (int d = 0; d < 4; d++) out[d] = d < step ? LINE_MIDDLE : 0;
}

/** For numbers wider than the display: how many positions a four-digit window can sit at. */
inline int scrollPositions(int length) { return length <= 4 ? 1 : length - 3; }

inline void scrollFrame(const char* digits, int pos, uint8_t out[4]) {
  const int len = digits ? static_cast<int>(std::strlen(digits)) : 0;
  const int last = scrollPositions(len) - 1;
  if (pos < 0) pos = 0;
  if (pos > last) pos = last;
  for (int i = 0; i < 4; i++) out[i] = (pos + i < len) ? glyph(digits[pos + i]) : 0;
}

inline bool isSupportedUidLength(size_t length) { return length == 4 || length == 7 || length == 10; }

/** "04:A2:3B:1C", the same form the server uses. Always ends in a zero byte, even in a small buffer. */
inline void formatUid(const uint8_t* bytes, size_t length, char* out, size_t outSize) {
  if (outSize == 0) return;
  size_t at = 0;
  out[0] = '\0';
  for (size_t i = 0; i < length; i++) {
    if (at + (i ? 3 : 2) >= outSize) break;
    at += static_cast<size_t>(std::snprintf(out + at, outSize - at, i ? ":%02X" : "%02X", bytes[i]));
  }
}

/** A pairing code from the server: exactly four digits. */
inline bool isPairCode(const char* s) {
  if (!s || std::strlen(s) != 4) return false;
  for (int i = 0; i < 4; i++) if (s[i] < '0' || s[i] > '9') return false;
  return true;
}

enum class Kind { Good, Refused, Error };

/** What to show for an answer: an optional word, then the balance if there is one. */
struct Plan {
  const char* word;      // "" = go straight to the balance
  bool showBalance;
  Kind kind;
  bool blink;
};

/** The words for what a card tap did, as the server names it. */
inline Plan planFor(const char* action) {
  struct Row { const char* action; Plan plan; };
  static const Row rows[] = {
    {"granted",      {"",     true,  Kind::Good,    false}},
    {"in",           {"In",   true,  Kind::Good,    false}},
    {"out",          {"OUt",  true,  Kind::Good,    false}},
    {"expired_in",   {"In",   true,  Kind::Good,    false}},
    {"expired_out",  {"OUt",  true,  Kind::Good,    false}},
    {"already_in",   {"In",   false, Kind::Refused, false}},
    {"not_in",       {"nOIn", false, Kind::Refused, false}},
    {"cooldown",     {"PAUS", true,  Kind::Refused, false}},    // too soon / limit reached: the word, then the balance
    {"limit_uses",   {"FULL", true,  Kind::Refused, false}},
    {"limit_points", {"FULL", true,  Kind::Refused, false}},
    {"limit_total",  {"FULL", true,  Kind::Refused, false}},
  };
  if (action) for (const Row& r : rows) if (std::strcmp(r.action, action) == 0) return r.plan;
  return {"Err", false, Kind::Error, false};
}

/** The words for a refusal that comes as an HTTP error. A status of 0 means no answer arrived at all. */
inline Plan planForHttp(int status, const char* code) {
  if (status == 0) return {"nEt", false, Kind::Error, false};
  if (status == 404 && code && std::strcmp(code, "unknown_card") == 0) return {"----", false, Kind::Refused, true};
  if (status == 403 && code && std::strcmp(code, "card_blocked") == 0) return {"bLoc", false, Kind::Refused, false};
  return {"Err", false, Kind::Error, false};
}

/** The words while the reader waits for its setup: "pending", "revoked" or "approved". */
inline Plan planForStatus(const char* status) {
  if (status && std::strcmp(status, "pending") == 0) return {"PEnd", false, Kind::Refused, false};
  if (status && std::strcmp(status, "revoked") == 0) return {"OFF", false, Kind::Error, false};
  if (status && std::strcmp(status, "approved") == 0) return {"", false, Kind::Good, false};
  if (status && std::strcmp(status, "denied") == 0) return {"dEny", false, Kind::Error, false};    // the server doesn't accept this reader's secret
  if (status && std::strcmp(status, "busy") == 0) return {"bUSy", false, Kind::Refused, false};    // the server has too many readers waiting
  return {"Err", false, Kind::Error, false};
}

/**
 * What the display shows when nothing is happening, most important first: the card reader not answering, then no
 * network (a reader that can't reach the server must never look like it is just waiting), then what the server said.
 * For a waiting reader that is the pairing code, but only if it really is four digits.
 */
inline const char* idleText(const char* status, bool online, bool rfidOk, const char* pairCode) {
  if (!rfidOk) return "Err";
  if (!online) return "nEt";
  if (!status) return "Err";
  if (std::strcmp(status, "approved") == 0) return "----";
  if (std::strcmp(status, "pending") == 0) return isPairCode(pairCode) ? pairCode : "PEnd";
  if (std::strcmp(status, "revoked") == 0) return "OFF";
  if (std::strcmp(status, "denied") == 0) return "dEny";
  if (std::strcmp(status, "busy") == 0) return "bUSy";
  return "Err";
}

}  // namespace reader
