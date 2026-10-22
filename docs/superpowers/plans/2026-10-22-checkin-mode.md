# Check-in mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline, TDD, ledger). Steps use checkbox syntax.

**Goal:** Add a per-terminal check-in/check-out mode that awards points for time inside, configurable in admin, with a button-less phone UI.

**Architecture:** Pure rules function + sessions table on the server; one tap endpoint toggles in/out. Terminal mode is a column read by the phone via `/terminal/config`. The phone gets a pure `PresenceFlow` state machine and a button-less screen.

**Tech Stack:** unchanged (Fastify/SQLite/vitest; Kotlin/Compose/JUnit).

**Spec:** `docs/superpowers/specs/2026-10-22-pont-atm-design.md`, section "Check-in mode".

## Global Constraints
- Defaults: 8 points per 12 min, rounding `down`, min 0 min, no per-visit cap, no 24 h cap, longest stay 12 h, lock-out 30 s.
- Validation: pointsPerBlock 1..1000; blockMinutes 1..1440; minMinutes 0..1440; maxPointsVisit and maxPoints24h null or 1..100000; maxStayHours 1..72; cooldownSeconds 0..600; rounding in down|up|nearest|prorata.
- Every tap carries an idempotency key. Terminal mode values: `atm`, `presence`.
- UI copy: "Tap your card", "Checked in", "Checked out", "Already checked in".

## Review Focus
- Same tap key replayed after a lost response must not toggle twice. (Task 2)
- A card tapped at two terminals, or a re-tap inside the lock-out, must not close the visit. (Task 2)
- A forgotten sign-out must earn nothing and start a fresh check-in. (Task 2)
- Caps: per visit, then what is left of the rolling 24 h, with a stornoed award no longer counting. (Tasks 1, 2)
- A terminal in ATM mode must refuse check-in taps; blocked and unregistered cards change nothing. (Task 2)
- The same card tapped twice quickly on the phone (NFC fires twice) must show one result. (Task 5)

### Task 1: Rules engine and settings
**Files:** Create `server/src/presence.ts`; Test `server/test/presence-rules.test.ts`
**Produces:** `type PresenceSettings = {pointsPerBlock; blockMinutes; rounding; minMinutes; maxPointsVisit: number|null; maxPoints24h: number|null; maxStayHours; cooldownSeconds}`; `DEFAULT_SETTINGS`; `validateSettings(input: unknown): {ok: true, value: PresenceSettings} | {ok: false, error: string}`; `computePoints(s, minutes, remaining24h: number|null): {raw: number; awarded: number; cappedBy: null|'visit'|'24h'}`; `getSettings(db)`, `saveSettings(db, s)` (table `presence_settings`, one row).
- [ ] Write failing tests: 8p/12min with down/up/nearest/prorata at 5, 12, 17, 18, 30, 50 min (down: 0,8,8,8,16,32; up: 8,8,16,16,24,40; nearest: 0,8,8,16,24,32 [half rounds up]; prorata: 3,8,11,12,20,33); min minutes gate; visit cap; 24h cap (remaining 5 gives 5, `cappedBy` '24h'; remaining 0 gives 0); both caps (visit applied first, label is the one that reduced last); validation accepts defaults, rejects each out-of-range field with a message naming the field.
- [ ] Run (FAIL), implement, run (PASS), commit.

### Task 2: Sessions, tap endpoint, terminal mode, admin API
**Files:** Create `server/src/routes/presence.ts`; Modify `server/src/db.ts` (tables `presence_settings`, `presence_sessions`; columns `terminals.mode text default 'atm'`, `transactions.kind text default 'atm'`, `transactions.note text`), `server/src/app.ts`, `server/src/routes/terminals.ts` (PATCH + mode in list), `server/src/routes/charges.ts` (transactions list returns `kind`, `note`); Test `server/test/presence.test.ts`
**Produces (HTTP):**
- `GET /terminal/config` (phone) -> `{mode, name}`.
- `POST /presence/tap {cardUid, idempotencyKey}` (phone) -> 200 `{action: 'in'|'out'|'cooldown'|'expired_in', card:{id,name,photoUrl,balance}, inAt, outAt?, minutes?, points, raw, cappedBy, today:{earned, max}, expiredMinutes?}`; 404 `unknown_card` (also records a card suggestion), 403 `card_blocked` (with card), 409 `wrong_mode`, 400 `bad_request`.
- `GET/PUT /presence/settings` (admin); `POST /presence/preview {settings?, minutes: number[]}` (admin) -> `[{minutes, raw, awarded, cappedBy}]`; `GET /presence/sessions` (admin) -> `{inside:[{id, card, inAt, terminal, minutes, wouldEarn}], recent:[{id, card, inAt, outAt, minutes, points, status, terminal}]}`; `POST /presence/sessions/:id/close {award: boolean}` (admin); `PATCH /terminals/:id {name?, place?, mode?}` (admin).
- [ ] Failing tests for: first tap checks in; tap after lock-out checks out and credits points and balance and a `presence` transaction (note "36 min"); tap inside lock-out is `cooldown` and changes nothing; same key replay returns the same action without toggling; second terminal toggles the same card; forgotten visit (older than max stay) is `expired_in`, earns nothing, new open session; caps incl. a stornoed award freeing the 24 h allowance; ATM-mode terminal gets 409; blocked 403 and unknown 404 (suggestion recorded) change nothing; admin close with award true applies rules, false discards with 0 points; settings round trip and 400 on invalid; preview matches `computePoints`; mode PATCH validated; `/terminal/config` for a phone. Tests control time by writing `in_at` into the past.
- [ ] Run (FAIL), implement (one SQLite transaction per tap), run all server tests (PASS), commit.

### Task 3: Admin site
**Files:** Modify `server/public/admin/admin.js`, `admin.css`; Test `server/test/admin-static.test.ts` (page still served).
- [ ] Nav page "Check-in": rules form (all fields, blank cap = no limit), Save, live preview table (calls `/presence/preview` with the draft), "Inside now" table (Sign out / Discard), recent visits table. Terminals table: Mode select calling PATCH. Transactions table: show note for presence rows.
- [ ] Verify in a browser on a throwaway server; commit.

### Task 4: App core
**Files:** Modify `core/Api.kt`, `core/Models.kt`, `core/SessionStore.kt`; Create `core/PresenceFlow.kt`; Tests `PresenceFlowTest.kt`, additions to `ApiTest.kt`.
**Produces:** `suspend fun config(): Result<TerminalConfig>`; `suspend fun presenceTap(uid, key): PresenceOutcome`; `sealed interface PresenceOutcome {Done(PresenceResult), Blocked(name, photoUrl), UnknownCard, NoConnection, WrongMode, Failed(message)}`; `SessionStore.mode: String` persisted; `class PresenceFlow(api: PresenceApi, newKey: () -> String, now: () -> Long)` with `state: StateFlow<PresenceState>` (`Idle`, `Sending(uid)`, `Showing(uid, outcome, at)`), `suspend fun onTag(uid)`, `fun clear()`; same-card guard 3 s; key re-use after NoConnection/Failed for same uid within 60 s.
- [ ] Failing tests (ApiTest: config parse, presenceTap mapping for in/out/cooldown/expired_in/blocked/unknown/wrong_mode/no connection; PresenceFlowTest: sending blocks taps, showing is replaced by a different card at once, same card within 3 s ignored, key reuse rules, `clear()` only from Showing), implement, pass, commit.

### Task 5: App screens and mode switching
**Files:** Create `ui/PresenceScreen.kt`; Modify `ui/AppNav.kt`, `AppGraph.kt`, `ui/ToneSynth.kt` (`Beeps.checkIn`), `ui/Beeper.kt`; Test additions to `ToneSynthTest.kt`.
- [ ] `Beeps.checkIn` = one soft sine tone (test: one tone, 60..200 ms). PresenceScreen: idle "Tap your card" with rings, result panels (check-in, check-out, already checked in, expired, blocked, unknown, no connection, wrong mode), auto-clear after 5 s, hidden long-press on the terminal name opening the menu. AppNav: poll `/terminal/config` on resume and every 30 s while idle; `presence` shows PresenceScreen with no tab bar and no buttons; mode saved in the session store. Beeps: in = checkIn, out = success, refusals = refusal.
- [ ] Build debug and release, run unit tests, commit.

### Task 6: Docs, deploy, APK
- [ ] README, device checklist; rebuild server, restart service; rebuild APK; verify version code and signature; run the whole check-in flow against a throwaway server with curl.
