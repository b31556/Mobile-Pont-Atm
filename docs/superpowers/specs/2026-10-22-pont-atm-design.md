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

## Left to the builder
Package names, exact file layout, DB column types, minor visual details not shown in the sketch, error copy for edge cases.
