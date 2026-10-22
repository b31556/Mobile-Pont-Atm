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
2. **Cards**, **Add card**: holder name, photo, card UID, starting points. To find a card's UID, tap it on a terminal: an unregistered card shows its UID on the phone.
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

## Behavior worth knowing

- A charge carries a one-time key. If the connection drops and the operator taps again, the server returns the original result instead of crediting twice.
- Storno reverses one charge in full and is refused if the card has already spent those points.
- Blocked cards and unregistered tags are refused with a clear message and change nothing.
- No offline mode. If the connection drops during a charge, the phone says it couldn't confirm: the card may already have been credited, so the operator taps again (the server answers once) or checks History before charging again.
- A paired phone stays paired until it is revoked in admin or unpaired on the phone. Anyone holding an unlocked paired phone can charge points, so revoke a lost phone straight away. Admin sessions last 12 hours and end at once when a password is reset or an account is switched off. Admin login and pairing lock out for 15 minutes after 10 wrong attempts.
