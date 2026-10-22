# Pont ATM

An Android "point ATM". An operator types an amount (or taps a preset), taps a MIFARE Classic 1K card on the phone, and the server credits those points to the card. The phone shows a progress bar, beeps, and shows the cardholder's photo. Operators can storno (refund) recent charges without the card. Admins manage cards, terminals and staff on a website.

```
sketch/   Clickable HTML prototype (the approved design reference)
server/   Node + SQLite server and the admin website (served at /admin/)
android/  The terminal app (Kotlin, Jetpack Compose)
docs/     Design spec, implementation plan, device test checklist
```

## Run the server

Needs Node 22.

```bash
cd server
npm install
JWT_SECRET=change-me ADMIN_EMAIL=admin@pont.example ADMIN_PASSWORD='choose-a-password' npm run dev
```

- The admin site is at `http://localhost:3000/admin/`. The admin account is created on first start from `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
- `PORT` (default 3000), `DB_PATH` (default `./data/pont.db`; photos are stored next to it) and `JWT_SECRET` (required) are the settings.
- Tests: `npm test`.
- Put it behind HTTPS before real use. The release app refuses plain HTTP.

## Set up a terminal

1. In the admin site: **Staff**, add an operator (the temporary password is shown once).
2. **Terminals**, **Pair a phone**: name it (like "Bar 2") and note the 6-digit code (valid 10 minutes).
3. **Cards**, **Add card**: holder name, photo, card UID, starting points. To find a card's UID, tap it on a terminal: an unregistered card shows its UID on the phone.
4. On the phone: enter the server address and the code, then sign in with the operator's email and password.

## Build the app

Needs JDK 17 or newer (the Android Gradle Plugin does not run on Java 11) and the Android SDK.

```bash
cd android
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64   # any JDK 17+
export ANDROID_HOME=$HOME/Android/Sdk
./gradlew :app:assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:testDebugUnitTest    # JVM unit tests
```

The debug build allows plain HTTP, defaults the server address to `http://localhost:3000` (use `adb reverse tcp:3000 tcp:3000` with a USB phone), and shows two small "debug tap" links on the waiting-for-card screen so you can test without a card.

## How cards are identified

The app reads the card's UID (4, 7 or 10 bytes) and sends it to the server, which owns every balance. Nothing is stored on the card, so nobody can edit a card to gain points. A UID can be cloned with cheap hardware, which is acceptable for low-value points. If that matters, the next step is a secret block on the card checked by the server.

**Phone caveat:** only phones with an NXP NFC chip can read MIFARE Classic *sectors*. Reading the UID works on every NFC phone, which is all v1 needs. Test the terminal phones with your real cards before buying a batch (see `docs/device-test-checklist.md`).

## Behavior worth knowing

- A charge carries a one-time key. If the connection drops and the operator taps again, the server returns the original result instead of crediting twice.
- Storno reverses one charge in full and is refused if the card has already spent those points.
- Blocked cards and unregistered tags are refused with a clear message and change nothing.
- No offline mode: with no connection nothing is charged.
