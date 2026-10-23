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
- `PORT` (default 3000), `DB_PATH` (default `./data/pont.db`; photos are stored next to it) and `JWT_SECRET` (required; use a long random value) are the settings. Set `TRUST_PROXY=1` when the server sits behind a reverse proxy, so attempt limits count each client separately.
- Tests: `npm test`.
- Put it behind HTTPS before real use. The release app refuses plain HTTP.

## Run it as a service on Tailscale

This is how it runs on the dev machine. The server listens only on the machine's Tailscale address, so only devices on your tailnet can reach it (Tailscale encrypts the traffic).

```bash
cd server && npm install && npm run build          # build once; `npm start` runs dist/index.js
mkdir -p ~/.config/pont-atm ~/.local/share/pont-atm
# ~/.config/pont-atm/env (chmod 600): JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, PORT=3000,
#   HOST=<this machine's Tailscale IP, from `tailscale ip -4`>, DB_PATH=$HOME/.local/share/pont-atm/pont.db
```

A systemd user unit (`~/.config/systemd/user/pont-atm.service`) runs `node dist/index.js` from `server/` with that env file; `systemctl --user enable --now pont-atm` starts it, and `loginctl enable-linger $USER` keeps it running after logout and across reboots. Logs: `journalctl --user -u pont-atm`. After pulling new code, run `npm run build` and `systemctl --user restart pont-atm`.

Address for the app and admin site: `http://<machine>.<tailnet>.ts.net:3000` (the debug APK allows plain HTTP). For HTTPS, which the release app requires, enable Tailscale Serve for the tailnet, set `HOST=127.0.0.1` and `TRUST_PROXY=1`, then run `tailscale serve --bg --https=443 http://127.0.0.1:3000`. Do not set `TRUST_PROXY=1` without a proxy in front: clients could then fake their address and dodge the login limit.

## Set up a terminal

1. In the admin site: **Terminals**, **Pair a phone**: name it (like "Bar 2") and note the 6-digit code (valid 10 minutes).
2. **Cards**, **Add card**: holder name, photo, card UID, starting points. To register a card without typing its UID: tap it on a terminal, and on the "Card not registered" screen press **Suggest for addition**. It then shows up on the admin site's Cards page under **Suggested cards**, with **Copy UID** and **Add as card** (the form opens with the UID already filled in).
3. On the phone: enter the pairing code. That is all: there is no sign-in, and the phone goes straight to the keypad. Charges are recorded under the terminal's name. To retire or lose a phone, revoke its terminal in the admin site, or use **Unpair** in the phone's terminal menu. The server address is fixed in the app at build time (`DEFAULT_BASE_URL` in `android/app/build.gradle.kts`); change it there and rebuild to point at another server.

## Build the app

Needs JDK 17 or newer (the Android Gradle Plugin does not run on Java 11) and the Android SDK.

```bash
cd android
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64   # any JDK 17+
export ANDROID_HOME=$HOME/Android/Sdk
./gradlew :app:assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:testDebugUnitTest    # JVM unit tests
```

Both builds use the fixed server address above. Plain HTTP is allowed only to `*.ts.net` (Tailscale encrypts it) in release, and to anything in debug. The debug build also shows two small "debug tap" links on the waiting-for-card screen so you can test without a card.

## How cards are identified

The app reads the card's UID (4, 7 or 10 bytes) and sends it to the server, which owns every balance. Nothing is stored on the card, so nobody can edit a card to gain points. A UID can be cloned with cheap hardware, which is acceptable for low-value points. If that matters, the next step is a secret block on the card checked by the server.

**Phone caveat:** only phones with an NXP NFC chip can read MIFARE Classic *sectors*. Reading the UID works on every NFC phone, which is all v1 needs. Test the terminal phones with your real cards before buying a batch (see `docs/device-test-checklist.md`).

## Check-in mode (points for time inside)

A terminal can be a sign-in / sign-out point instead of an ATM. In the admin site:

1. **Check-in** page: make **zones** (like "Workshop", "Gym"). Each zone has its own rules: points per block (say 8 per 12 minutes), how a partial block is rounded (down, up, nearest, or exact per minute), minimum stay, max points per visit, max points per 24 hours (per card, per zone), the longest stay that counts, and a re-tap lock-out. A live table shows what a stay of 5, 12, 30, 60… minutes earns.
2. **Terminals** page: set the terminal's mode to **Check-in**, pick its **zone**, and its **point type**: *Toggle* (in if outside, out if inside), *Sign in only* or *Sign out only*. The phone follows within about 30 seconds.

The phone then has no buttons: "Tap your card" (or "Tap to sign in" / "Tap to sign out"), the zone name, and after a tap the photo, name, time and points, then back to waiting after 5 seconds. A tap on the next card replaces the screen at once. Unpair and the beep switch are behind a **long press on the terminal name** at the bottom.

Good to know: a visit is paid by the rules of the zone where it began, whichever point signs out. A visit longer than the zone's longest stay earns nothing (forgotten sign-outs can't farm points). A sign-in point does not move someone who is still inside; a sign-out point does nothing for someone who isn't inside. Admins see who is inside, with Sign out and Discard buttons, and can storno a check-out award in Transactions. Admin grants and deductions (Cards, then a card, then Grant or take away) are listed in Transactions with who did it and why.

## ESP32 readers

`firmware/esp32-reader/` has the firmware for a small reader (ESP32 DevKit V1 + MFRC522 + 4-digit display) with wiring, flashing steps and what the display shows. The reader finds the server on your network and shows a 4-digit code until you approve it on the admin **Readers** tab (the same code is listed there). Then you set it to **Fixed amount** (every tap gives X points, with per-card limits: seconds between taps, taps and points per 24 hours, taps ever) or **Check-in** (zone and sign-in / sign-out / toggle). Fixed-amount grants appear in Transactions and can be stornoed like any other.

## Behavior worth knowing

- A charge carries a one-time key. If the connection drops and the operator taps again, the server returns the original result instead of crediting twice.
- Storno reverses one charge in full and is refused if the card has already spent those points.
- Blocked cards and unregistered tags are refused with a clear message and change nothing.
- No offline mode. If the connection drops during a charge, the phone says it couldn't confirm: the card may already have been credited, so the operator taps again (the server answers once) or checks History before charging again.
- A paired phone stays paired until it is revoked in admin or unpaired on the phone. Anyone holding an unlocked paired phone can charge points, so revoke a lost phone straight away. Admin sessions last 12 hours and end at once when a password is reset or an account is switched off. Admin login and pairing lock out for 15 minutes after 10 wrong attempts.
