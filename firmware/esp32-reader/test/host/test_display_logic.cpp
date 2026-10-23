// Host tests for include/DisplayLogic.h (no Arduino needed). Run: ./test/host/run.sh
#include <cstdio>
#include <cstring>
#include <string>
#include "../../include/DisplayLogic.h"

static int failures = 0, checks = 0;
#define CHECK(cond) do { checks++; if (!(cond)) { failures++; std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_SEG(out, a, b, c, d) do { checks++; if (!((out)[0] == (a) && (out)[1] == (b) && (out)[2] == (c) && (out)[3] == (d))) { failures++; \
  std::printf("FAIL %s:%d  got %02X %02X %02X %02X want %02X %02X %02X %02X\n", __FILE__, __LINE__, (out)[0], (out)[1], (out)[2], (out)[3], a, b, c, d); } } while (0)

using namespace reader;

static void testGlyphs() {
  CHECK(glyph('0') == 0x3F); CHECK(glyph('1') == 0x06); CHECK(glyph('2') == 0x5B); CHECK(glyph('3') == 0x4F); CHECK(glyph('4') == 0x66);
  CHECK(glyph('5') == 0x6D); CHECK(glyph('6') == 0x7D); CHECK(glyph('7') == 0x07); CHECK(glyph('8') == 0x7F); CHECK(glyph('9') == 0x6F);
  CHECK(glyph('A') == 0x77); CHECK(glyph('b') == 0x7C); CHECK(glyph('c') == 0x58); CHECK(glyph('d') == 0x5E); CHECK(glyph('E') == 0x79);
  CHECK(glyph('F') == 0x71); CHECK(glyph('I') == 0x06); CHECK(glyph('L') == 0x38); CHECK(glyph('n') == 0x54); CHECK(glyph('O') == 0x3F);
  CHECK(glyph('o') == 0x5C); CHECK(glyph('P') == 0x73); CHECK(glyph('r') == 0x50); CHECK(glyph('S') == 0x6D); CHECK(glyph('t') == 0x78);
  CHECK(glyph('U') == 0x3E); CHECK(glyph('-') == 0x40); CHECK(glyph('_') == 0x08); CHECK(glyph(' ') == 0x00);
  CHECK(glyph('~') == 0x00);   // not drawable: blank, never garbage
  CHECK(glyph('\0') == 0x00);
}

static void testText() {
  uint8_t o[4];
  textToSegments("OUt ", o); CHECK_SEG(o, 0x3F, 0x3E, 0x78, 0x00);
  textToSegments("In", o);   CHECK_SEG(o, 0x06, 0x54, 0x00, 0x00);     // shorter text is padded with blanks
  textToSegments("bLoc", o); CHECK_SEG(o, 0x7C, 0x38, 0x5C, 0x58);
  textToSegments("FULL1234", o); CHECK_SEG(o, 0x71, 0x3E, 0x38, 0x38); // longer text is cut
  textToSegments("----", o); CHECK_SEG(o, 0x40, 0x40, 0x40, 0x40);
  textToSegments(nullptr, o); CHECK_SEG(o, 0, 0, 0, 0);
}

static void testNumbers() {
  uint8_t o[4];
  numberToSegments(0, o);    CHECK_SEG(o, 0x00, 0x00, 0x00, 0x3F);
  numberToSegments(7, o);    CHECK_SEG(o, 0x00, 0x00, 0x00, 0x07);
  numberToSegments(56, o);   CHECK_SEG(o, 0x00, 0x00, 0x6D, 0x7D);     // no leading zeros, right aligned
  numberToSegments(120, o);  CHECK_SEG(o, 0x00, 0x06, 0x5B, 0x3F);
  numberToSegments(1234, o); CHECK_SEG(o, 0x06, 0x5B, 0x4F, 0x66);
  numberToSegments(9999, o); CHECK_SEG(o, 0x6F, 0x6F, 0x6F, 0x6F);
  numberToSegments(-5, o);   CHECK_SEG(o, 0x00, 0x00, 0x00, 0x3F);     // never negative on the display
  numberToSegments(12345, o); CHECK_SEG(o, 0x6F, 0x6F, 0x6F, 0x6F);    // callers scroll big numbers; this is only a safe cap
  CHECK(fitsOnDisplay(9999)); CHECK(!fitsOnDisplay(10000)); CHECK(fitsOnDisplay(0));
}

static void testProgress() {
  uint8_t o[4];
  const uint8_t L = 0x40;                                              // the middle line of a digit
  progressFrame(0, o); CHECK_SEG(o, 0, 0, 0, 0);
  progressFrame(1, o); CHECK_SEG(o, L, 0, 0, 0);                       // first line, digit 1 ...
  progressFrame(2, o); CHECK_SEG(o, L, L, 0, 0);                       // ... then digit 2, and so on: a four-step bar
  progressFrame(3, o); CHECK_SEG(o, L, L, L, 0);
  progressFrame(4, o); CHECK_SEG(o, L, L, L, L);
  progressFrame(9, o); CHECK_SEG(o, L, L, L, L);                       // past the end stays full
  progressFrame(-3, o); CHECK_SEG(o, 0, 0, 0, 0);
  CHECK(PROGRESS_STEPS == 4);
  // the bar is the same "----" that means ready, drawn one digit at a time, so it ends where idle begins
  uint8_t idle[4]; textToSegments("----", idle);
  progressFrame(PROGRESS_STEPS, o); CHECK(std::memcmp(o, idle, 4) == 0);
}

static void testScroll() {
  uint8_t o[4];
  CHECK(scrollPositions(5) == 2); CHECK(scrollPositions(4) == 1); CHECK(scrollPositions(3) == 1); CHECK(scrollPositions(8) == 5);
  scrollFrame("12345", 0, o); CHECK_SEG(o, 0x06, 0x5B, 0x4F, 0x66);    // 1234
  scrollFrame("12345", 1, o); CHECK_SEG(o, 0x5B, 0x4F, 0x66, 0x6D);    // 2345
  scrollFrame("12345", 9, o); CHECK_SEG(o, 0x5B, 0x4F, 0x66, 0x6D);    // past the end holds on the last window
  scrollFrame("12345", -2, o); CHECK_SEG(o, 0x06, 0x5B, 0x4F, 0x66);
}

static void testUid() {
  char out[32];
  const uint8_t a[] = {0x04, 0xA2, 0x3B, 0x1C};
  formatUid(a, 4, out, sizeof out); CHECK(std::strcmp(out, "04:A2:3B:1C") == 0);
  const uint8_t b[] = {0x00, 0x0A, 0x01, 0xFF, 0x5D, 0x6E, 0x7F};
  formatUid(b, 7, out, sizeof out); CHECK(std::strcmp(out, "00:0A:01:FF:5D:6E:7F") == 0);
  const uint8_t c[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
  formatUid(c, 10, out, sizeof out); CHECK(std::strlen(out) == 29);
  char small[8];
  formatUid(a, 4, small, sizeof small); CHECK(std::strlen(small) < sizeof small);   // never overruns a small buffer
  CHECK(isSupportedUidLength(4) && isSupportedUidLength(7) && isSupportedUidLength(10));
  CHECK(!isSupportedUidLength(0) && !isSupportedUidLength(5) && !isSupportedUidLength(3));
}

static void testPlans() {
  struct Case { const char* action; const char* word; bool balance; };
  const Case cases[] = {
    {"granted", "", true}, {"in", "In", false}, {"out", "OUt", true}, {"expired_in", "In", false}, {"expired_out", "OUt", true},
    {"already_in", "In", false}, {"not_in", "nOIn", false},
    {"cooldown", "PAUS", true}, {"limit_uses", "FULL", true}, {"limit_points", "FULL", true}, {"limit_total", "FULL", true},   // too soon / limit: the balance follows
  };
  for (const Case& c : cases) {
    const Plan p = planFor(c.action);
    CHECK(std::strcmp(p.word, c.word) == 0); CHECK(p.showBalance == c.balance);
    if (std::strcmp(p.word, c.word) != 0) std::printf("   for action %s: word '%s'\n", c.action, p.word);
  }
  CHECK(planFor("granted").kind == Kind::Good); CHECK(planFor("in").kind == Kind::Good); CHECK(planFor("cooldown").kind == Kind::Refused);
  CHECK(planFor("limit_uses").kind == Kind::Refused); CHECK(planFor("not_in").kind == Kind::Refused);
  CHECK(std::strcmp(planFor("something new").word, "Err") == 0); CHECK(planFor("something new").kind == Kind::Error);
  CHECK(std::strcmp(planFor(nullptr).word, "Err") == 0);
  CHECK(std::strcmp(planForHttp(404, "unknown_card").word, "----") == 0);
  CHECK(std::strcmp(planForHttp(403, "card_blocked").word, "bLoc") == 0);
  CHECK(std::strcmp(planForHttp(409, "wrong_mode").word, "Err") == 0);
  CHECK(std::strcmp(planForHttp(500, nullptr).word, "Err") == 0);
  CHECK(std::strcmp(planForHttp(0, nullptr).word, "nEt") == 0);        // no answer at all: network
  CHECK(planForHttp(404, "unknown_card").blink);
  CHECK(!planFor("granted").blink);
  // every word fits the display and is drawable (no blank letters inside a word)
  const char* words[] = {"In", "OUt", "nOIn", "PAUS", "FULL", "Err", "----", "bLoc", "nEt", "PEnd", "OFF", "dEny", "bUSy"};
  for (const char* w : words) { CHECK(std::strlen(w) <= 4); for (const char* q = w; *q; q++) CHECK(glyph(*q) != 0); }
}

static void testCheckInPlans() {
  // in check-in mode a balance follows only when someone signs out (that is when points are paid)
  CHECK(!planFor("in", true).showBalance); CHECK(!planFor("expired_in", true).showBalance);
  CHECK(planFor("out", true).showBalance); CHECK(planFor("expired_out", true).showBalance);
  CHECK(!planFor("cooldown", true).showBalance); CHECK(!planFor("already_in", true).showBalance); CHECK(!planFor("not_in", true).showBalance);
  CHECK(std::strcmp(planFor("cooldown", true).word, "PAUS") == 0);
  // fixed-amount mode still shows the balance after a grant, and after "too soon" or a limit
  CHECK(planFor("granted", false).showBalance); CHECK(planFor("cooldown", false).showBalance); CHECK(planFor("limit_uses", false).showBalance);
  CHECK(planFor("cooldown").showBalance);                              // the default is fixed-amount mode
}

static void testQueue() {
  StepQueue q;
  uint8_t seg[4], a[4] = {1, 1, 1, 1}, b[4] = {2, 2, 2, 2};
  CHECK(!q.busy(0)); CHECK(!q.tick(0, seg));
  CHECK(q.push(a, 100)); CHECK(q.push(b, 200));
  CHECK(q.busy(0));
  CHECK(q.tick(0, seg) && seg[0] == 1);                                // first step shows at once
  CHECK(!q.tick(50, seg)); CHECK(q.busy(50));
  CHECK(q.tick(100, seg) && seg[0] == 2);                              // the next one as soon as the first has had its time
  CHECK(!q.tick(299, seg)); CHECK(q.busy(299));
  CHECK(!q.busy(300)); CHECK(!q.tick(300, seg));                       // finished: nothing more to draw, not busy
  // a new card arrives while something is on show: the display is free at once
  q.clear(); CHECK(q.push(a, 5000)); CHECK(q.tick(1000, seg)); CHECK(q.busy(1500));
  q.clear(); CHECK(!q.busy(1501)); CHECK(!q.tick(1501, seg));
  CHECK(q.push(b, 100)); CHECK(q.tick(1502, seg) && seg[0] == 2);     // and the next thing shows straight away
  // a full queue says so instead of losing steps silently
  q.clear();
  int accepted = 0; for (int i = 0; i < 100; i++) if (q.push(a, 10)) accepted++;
  CHECK(accepted >= 12); CHECK(accepted < 100);
  // the clock wraps around after about 49 days; the schedule must not notice
  q.clear(); CHECK(q.push(a, 100)); CHECK(q.push(b, 100));
  const uint32_t near = 0xFFFFFFF0u;
  CHECK(q.tick(near, seg) && seg[0] == 1);
  CHECK(!q.tick(near + 50, seg));
  CHECK(q.tick(near + 100, seg) && seg[0] == 2);                       // wrapped past zero here
  CHECK(q.busy(near + 150)); CHECK(!q.busy(near + 200));
}

static int stepCount(StepQueue& q, uint32_t* total, uint8_t first[4]) {
  int n = 0; uint32_t sum = 0; uint32_t now = 0; uint8_t seg[4];
  while (q.busy(now) && n < 100) {
    if (q.tick(now, seg)) { if (n == 0) std::memcpy(first, seg, 4); n++; }
    now += 10;
  }
  *total = now; (void)sum;
  return n;
}

static void testQueuePlan() {
  StepQueue q; uint8_t first[4], want[4]; uint32_t total;
  // a grant: the balance, for three seconds
  queuePlan(q, planFor("granted"), 56);
  CHECK(stepCount(q, &total, first) == 1); numberToSegments(56, want); CHECK(std::memcmp(first, want, 4) == 0);
  CHECK(total >= BALANCE_MS && total < BALANCE_MS + 30);
  // signing in: only the word, and for a bit longer than before
  q.clear(); queuePlan(q, planFor("in", true), 120);
  CHECK(stepCount(q, &total, first) == 1); textToSegments("In", want); CHECK(std::memcmp(first, want, 4) == 0);
  CHECK(total >= WORD_MS && total < WORD_MS + 30); CHECK(WORD_MS >= 2000);
  // signing out: the word, then the balance
  q.clear(); queuePlan(q, planFor("out", true), 70);
  CHECK(stepCount(q, &total, first) == 2); CHECK(total >= WORD_MS + BALANCE_MS);
  // too soon in fixed-amount mode: the word, then the balance; in check-in mode just the word
  q.clear(); queuePlan(q, planFor("cooldown", false), 56); CHECK(stepCount(q, &total, first) == 2);
  q.clear(); queuePlan(q, planFor("cooldown", true), 56);  CHECK(stepCount(q, &total, first) == 1);
  // a balance is never shown when the plan has none, whatever number is passed
  q.clear(); queuePlan(q, planFor("not_in", true), 999); CHECK(stepCount(q, &total, first) == 1);
  // an unknown card blinks three times
  q.clear(); queuePlan(q, planForHttp(404, "unknown_card"), 0); CHECK(stepCount(q, &total, first) == 6);
  // a number wider than the display scrolls: one step per window, the last held longer
  q.clear(); queuePlan(q, planFor("granted"), 123456); CHECK(stepCount(q, &total, first) == scrollPositions(6));
  textToSegments("1234", want); CHECK(std::memcmp(first, want, 4) == 0);
  // an error shows its word and no balance
  q.clear(); queuePlan(q, planForHttp(0, nullptr), 50); CHECK(stepCount(q, &total, first) == 1); textToSegments("nEt", want); CHECK(std::memcmp(first, want, 4) == 0);
  // a queue that was busy is replaced, not appended to
  q.clear(); queuePlan(q, planFor("out", true), 70); q.clear(); queuePlan(q, planFor("in", true), 70);
  CHECK(stepCount(q, &total, first) == 1);
}

static void testPairCode() {
  CHECK(isPairCode("4821")); CHECK(isPairCode("1000")); CHECK(isPairCode("9999"));
  CHECK(!isPairCode("482")); CHECK(!isPairCode("48210")); CHECK(!isPairCode("48a1")); CHECK(!isPairCode("")); CHECK(!isPairCode(nullptr));
  uint8_t o[4];
  textToSegments("4821", o); CHECK_SEG(o, 0x66, 0x7F, 0x5B, 0x06);      // shown as typed: digits, not stripped of anything
  CHECK(std::strcmp(planForStatus("pending").word, "PEnd") == 0);
  CHECK(std::strcmp(planForStatus("revoked").word, "OFF") == 0);
  CHECK(std::strcmp(planForStatus("approved").word, "") == 0);
  CHECK(std::strcmp(planForStatus("denied").word, "dEny") == 0);
  CHECK(std::strcmp(planForStatus("busy").word, "bUSy") == 0);
  CHECK(std::strcmp(planForStatus(nullptr).word, "Err") == 0);
}

static void testIdle() {
  // what the display shows when nothing is happening, in order of importance
  CHECK(std::strcmp(idleText("approved", true, true, ""), "----") == 0);
  CHECK(std::strcmp(idleText("pending", true, true, "4821"), "4821") == 0);          // the pairing code, as sent by the server
  CHECK(std::strcmp(idleText("pending", true, true, ""), "PEnd") == 0);              // no code yet
  CHECK(std::strcmp(idleText("pending", true, true, "48x1"), "PEnd") == 0);          // junk is never displayed
  CHECK(std::strcmp(idleText("pending", false, true, "4821"), "nEt") == 0);          // no network beats waiting
  CHECK(std::strcmp(idleText("approved", false, true, ""), "nEt") == 0);
  CHECK(std::strcmp(idleText("approved", true, false, ""), "Err") == 0);             // the card reader not answering is shown first
  CHECK(std::strcmp(idleText("pending", false, false, "4821"), "Err") == 0);
  CHECK(std::strcmp(idleText("revoked", true, true, ""), "OFF") == 0);
  CHECK(std::strcmp(idleText("denied", true, true, ""), "dEny") == 0);
  CHECK(std::strcmp(idleText("busy", true, true, ""), "bUSy") == 0);
  CHECK(std::strcmp(idleText("whatever", true, true, ""), "Err") == 0);
  CHECK(std::strcmp(idleText(nullptr, true, true, nullptr), "Err") == 0);
  CHECK(std::strcmp(idleText("pending", true, true, nullptr), "PEnd") == 0);
}

int main() {
  testGlyphs(); testText(); testNumbers(); testProgress(); testScroll(); testUid(); testPlans(); testPairCode(); testIdle(); testCheckInPlans(); testQueue(); testQueuePlan();
  std::printf("%d checks, %d failed\n", checks, failures);
  return failures ? 1 : 0;
}
