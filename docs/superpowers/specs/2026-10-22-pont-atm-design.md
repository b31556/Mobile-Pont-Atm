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

## Left to the builder
Package names, exact file layout, DB column types, minor visual details not shown in the sketch, error copy for edge cases.
