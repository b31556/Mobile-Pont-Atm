# Pont ATM: design

Approved visual reference: `sketch/index.html` (clickable prototype, approved by the user on 2026-10-22).

## Intent
An Android "point ATM". An operator types an amount (or taps a preset), taps a MIFARE Classic 1K card on the phone, and the server credits that many points to the card. The phone shows a POS-style progress bar, beeps, and shows the cardholder's photo so the operator can check the face. Operators can storno (refund) recent transactions without the card. Admins manage cards, terminals and staff on a website.

## Goals
- Terminal app (Android only): pairing screen, charge screen with numpad and green button, presets (tap once, then card), tap/read/progress/beep flow, result screen with holder photo, history with storno, presets management.
- Server: authoritative balances, transactions, storno, presets per terminal, photos, auth.
- Admin website: cards (add, edit, photo, UID, block, adjust), terminals (pair, revoke), transactions (with storno), staff.
- Real NFC reading of MIFARE Classic 1K tags.

## Non-goals (v1)
- iOS. Offline queueing. Spending or deducting points. Partial refunds. Multi-tenant. Push notifications.

## Anti-goals
- Double-crediting from a retry (every charge carries an idempotency key).
- Points stored on the card (the card only identifies the holder).
- A storno that drives a balance below zero.

## Decisions
These are my calls unless noted.
- **Giving points means crediting.** Storno takes them back. (My assumption, stated in the sketch.)
- **Card identification:** v1 reads the 4-byte UID (works on every NFC phone, no keys). The app uses `NfcA`/`MifareClassic` reader mode and reads the UID from the tag. Reading secret sector data is out of scope for v1 because it only works on NXP-chip phones. The server stores UIDs as the card key and is built so a secret-token check can be added later.
- **App:** native Kotlin, Jetpack Compose with a custom theme matching the sketch (colors and type from its CSS tokens), OkHttp for HTTP, kotlinx.serialization for JSON, Coil for photos. Min SDK 26.
- **Server:** Node.js 20+, TypeScript, Fastify, SQLite (better-sqlite3), JWT auth, argon2/bcrypt password hashing. Admin website is plain HTML/JS served by the same server (reusing the sketch's styles), calling the same JSON API.
- **Photos:** uploaded in admin, stored on disk, served at `/photos/:cardId` (authenticated), shown in the app via an image loader (Coil).
- **Terminal pairing, no sign-in (changed 2026-10-22 at the user's request):** admin creates a terminal and gets a one-time 6-digit code (10 min expiry). The app exchanges the code for a long-lived terminal token, and that token alone authorizes charges, history, storno and presets for that terminal. There is no per-person login in the app. Charges are recorded under the terminal's name (no staff id). A lost or retired phone is cut off by revoking its terminal in admin. Admins sign in on the website with email and password. Staff operator accounts still work on the server for sessions made before this change.
- **Presets** belong to the terminal and are stored on the server.
- **Storno** creates a reversing transaction and marks the original `stornoed`. Refused if it would make the balance negative or if already stornoed.
- **Beep:** generated in the app (ToneSynth) because `ToneGenerator` cut tones off. An approval is a soft rising pair of sine tones; a refusal is three lower beeps with a buzzer waveform like a card terminal. No beep when the card is read.
- **Repeat charge:** the result screen has "One more like this", which starts a new charge for the same amount at once.
- **Card suggestions:** on "Card not registered" the phone can send the UID to the server (`POST /card-suggestions`). Admins see them under Suggested cards, copy the UID or add it as a card in one step; adding the card clears the suggestion.

## Check-in mode (added 2026-10-22, approved by the user)
A terminal can run as a sign-in / sign-out point instead of an ATM. Points are earned for time spent inside.

- **Mode** is a per-terminal admin setting (`atm` | `presence`). The phone reads it from `GET /terminal/config` on resume and every 30 s while idle, so no re-pairing.
- **Phone in check-in mode has no buttons.** It shows "Tap your card". A tap on a card that is not inside checks it in; a tap on a card that is inside checks it out and awards points. The result shows photo, name and stats for 5 s, then returns to idle; the next tap replaces it immediately. Unregistered cards are recorded as suggestions automatically. Unpair and the beep switch are behind a hidden long-press on the terminal name.
- **Rules (one global set, edited in admin):** points per block (default 8) and block length in minutes (12); rounding of the partial block: `down` (default), `up`, `nearest`, `prorata`; minimum minutes to earn anything (0); max points per visit (none); max points per rolling 24 h per card (none); longest stay in hours (12); re-tap lock-out in seconds (30).
- **Calculation:** minutes = whole minutes inside. If below the minimum: 0. units = minutes / block; down/up/nearest round units to whole blocks, `prorata` rounds units x points to whole points. Then capped by max per visit, then by what is left of the 24 h allowance (points from presence awards in the last 24 h that were not stornoed).
- **Forgotten sign-out:** a visit older than the longest stay earns nothing; the tap closes it as `expired` and starts a new check-in.
- **Re-tap lock-out:** a tap within the lock-out of the last check-in changes nothing ("Already checked in").
- **A card is inside or outside system-wide**, not per terminal.
- **Storno:** check-out awards are normal `give` transactions (kind `presence`) and can be stornoed from the admin site.
- **Admin:** a Check-in page with the rules, a live preview table (computed by the server), who is inside now (with sign out / discard), and recent visits.
- **Idempotency:** each tap carries a key; the phone re-uses it when the same card is re-tapped after a lost connection.

### Zones and point types (added 2026-10-22, same day, requested by the user)
- **Rules belong to a zone**, not to the whole system. Admins create zones (name + the full rule set above). A default zone "Main area" always exists. The 24 h allowance is per card **per zone**.
- **Each check-in terminal is assigned to a zone** and has a **point type**: `in` (sign-in only), `out` (sign-out only) or `toggle` (default; in if outside, out if inside).
- **A visit belongs to the zone where it began.** Checking out always uses that zone's rules, whichever terminal is used. A card is inside at most one zone at a time.
- **Behavior by point type** (the visit's zone supplies lock-out and longest stay):
  - Sign-in point: not inside -> check in (zone of the terminal). Inside and within the lock-out -> `cooldown`. Inside for longer than the longest stay -> the old visit expires with no points and a new check-in starts (`expired_in`). Otherwise inside -> `already_in`: nothing changes.
  - Sign-out point: not inside -> `not_in`: nothing changes. Inside within the lock-out -> `cooldown`. Inside for longer than the longest stay -> the visit expires with no points, no new check-in (`expired_out`). Otherwise check out.
  - Toggle point: as before.
- The phone shows the zone name and what the point does ("Tap to sign in" / "Tap to sign out" / "Tap your card"). The admin site shows zone and point type per terminal, and zone per visit.

### Admin grants and deductions in the transaction list (added 2026-10-22, requested by the user)
Points an admin grants or takes away by hand are listed in the admin Transactions table (`type: adjust`, positive = grant, negative = deduction) with the admin's name, an optional reason (up to 200 characters) and the time. They are never shown to phones. They are stored in `balance_adjustments` (with the balance after), not in `transactions`, so they cannot be stornoed. Timestamps for charges, stornos, adjustments and check-ins are strictly increasing, so records made in the same millisecond keep their order.

## ESP32 readers (added 2026-10-23, approved by the user)
A small hardware terminal: ESP32 DevKit V1 + MFRC522 + 4-digit TM1637 display, on the LAN over plain HTTP (e.g. `http://192.168.x.x:3000`). Firmware lives in `firmware/esp32-reader/` (PlatformIO, Arduino framework).

- **Joining:** the reader generates a secret once and calls `POST /device/hello {deviceId, secret, firmware}` every 30 s (every 4 s while waiting). An unknown device becomes `pending`; the server gives it a **4-digit pairing code** (unique among waiting devices, stable until approved), the reader shows that code on its display, and the admin Readers tab lists the same code with the device's IP, so the admin can tell which physical reader is which and cannot approve an impostor by mistake. An admin approves it with a name and a mode; the reply to the next hello carries a terminal token, which the reader keeps and uses exactly like a phone. Admins can revoke or forget a device. A wrong secret for a known device id is refused. At most 20 devices can wait for approval, and hello calls are rate limited per IP.
- **A reader is a terminal with `kind='device'`.** Phones are `kind='phone'`. Modes: phones `atm` or `presence`; readers `presence` (zone + in/out/toggle, as for phones) or `fixed`. The admin Terminals tab lists phones; the Readers tab lists readers.
- **Fixed amount mode:** every tap grants the same number of points. Rules are per reader and apply per card (an empty cap means no limit): points per tap (default 10), seconds between taps (default 60), max taps per rolling 24 h, max points per rolling 24 h, max taps ever. Checks run in this order: ever, 24 h taps, 24 h points, then seconds between taps (so a person who has hit a daily limit hears "limit", not "wait"). Stornoed grants stop counting. A grant is a normal `give` transaction (`kind='fixed'`), so it can be stornoed in admin.
- **Answers to the reader** (`POST /fixed/tap`, `POST /presence/tap`) always include the card balance after the action; the display shows it.
- **Display (changed at the user's request):** idle is static dashes, with no animation anywhere. While a tap is processed, a four-step bar: a line in the middle of digit 1, then 2, 3, 4, one step per stage (card read, request sent, answer arriving, answer understood), with no artificial minimum time. Then the balance appears at once and stays 3 s; balances above 9999 scroll. Fixed-amount: a refusal (too soon, limit) shows its word, then the balance. Check-in: signing in shows only `In` (2 s, no balance); signing out shows `OUt` (2 s) then the balance (3 s); refusals show only their word. The display is a non-blocking schedule: the reader keeps reading cards while anything is shown, and a new card replaces the display at once. Words: `In`, `OUt`, `bLoc` (blocked), `FULL` (limit), `PAUS` (too soon), `nEt` (no network), `PEnd` (not approved), `----` blinking (unknown card), `Err`.

## Reader display pages (added 2026-10-23, requested by the user; access changed the same day from a key in the address to a 6-digit code)
Every terminal has a **display page** for a screen next to it (a tablet, a monitor). The page is `GET /display`, the same for everybody. A person types the terminal's **6-digit display code** (made on first use, unique among terminals, shown to admins on the Readers tab and in the Terminals list). `POST /display/enter {code}` then gives that screen a private session: a random 192-bit token in an **HttpOnly, SameSite=Strict cookie** (path `/display`, kept a year, `Secure` over https), stored on the server only as a SHA-256 hash. The code never appears in an address.
- **What it shows**, live: photo, name, a headline (like "+10 points", "Checked in", "Too soon", "Card is blocked"), details and the balance, then "Tap your card" again after 6 seconds without a tap; a new tap replaces the screen at once. It can **beep** if an admin switched "Beep on the display" on for that terminal, after one click on the page (browsers refuse sound before that). The page has a "Use a different reader" button.
- **Endpoints for a signed-in screen** (all need the cookie, else 401): `GET /display/state`, `GET /display/events` (Server-Sent Events, at most 20 viewers per terminal), `GET /display/photo/<cardId>` (only for cards that tapped on that terminal in the last hour, so a screen cannot look up arbitrary photos), `POST /display/leave`. At most 20 screens stay signed in per terminal; the oldest is dropped.
- **Guessing the code:** wrong codes are limited to 10 per address per 15 minutes (then 429, even for the right code) and 300 per hour across all addresses (new sign-ins stop for a while; screens already signed in keep working).
- **New code** (`POST /terminals/:id/display-code`, admin): replaces the code, deletes every session of that terminal and hangs up its open live connections at once. Revoking a terminal does the same. A screen that is signed out shows the code form again.
- The same rule as the reader's own display decides whether a balance is shown (not after signing in). Events come from fixed-amount taps, check-in taps and ATM charges; a retried tap (same idempotency key) is shown once; an unregistered card shows "Card not registered" with no name or photo. Events live in memory only. The page sends a strict content security policy and no referrer.
- Anyone who knows a code can sign a screen in and watch who taps (photo, name, points). Treat it like a screen on a wall; press **New code** if it is shared too widely.

## Left to the builder
Package names, exact file layout, DB column types, minor visual details not shown in the sketch, error copy for edge cases.
