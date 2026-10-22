# Device test checklist

Run this on a real NFC phone with a real MIFARE Classic 1K card before using the system. Tick each line and note the phone model and what happened.

Phone model / Android version: ______________   Card(s): ______________   App build: ______________

## Setup
- [ ] Server running, admin signed in, one operator, one terminal paired (code accepted once, a second use is refused)
- [ ] Card added in admin with a photo and 10 starting points
- [ ] Phone paired, operator signed in, presets shown on the keypad

## Reading
- [ ] Tap the card at the "Hold the card" screen: UID is read within about a second, no double charge
- [ ] The UID on the "card not registered" screen matches the one that works after adding the card in admin
- [ ] Tap a different brand of NFC tag or phone wallet card: it is refused or read as an unknown UID, never crashes
- [ ] Hold the card on the back, then slide it: the app still reads it once
- [ ] Keep the card against the phone through the progress bar and the result screen: Android's own "New tag collected" screen never appears
- [ ] Tap a card while on the keypad (not waiting for a card): nothing happens, and no Android tag screen opens

## Charging
- [ ] Keypad: type 8, press the green button, tap: +8, balance 10 → 18, holder photo correct, beep heard
- [ ] Preset: one tap on "8" goes straight to the card screen, then tap: charged
- [ ] With "Tap once, then card" off, a preset only fills the amount
- [ ] Progress bar is visible for about a second even when the server answers instantly
- [ ] Beep off in the terminal menu: silent on success and refusal

## Refusals
- [ ] Block the card in admin: tap shows "Card is blocked" with the holder's photo, balance unchanged
- [ ] Unblock it: charging works again
- [ ] Unregistered card: "Card not registered" with the UID
- [ ] NFC switched off in settings: the tap screen says so and offers a button to the settings

## Connection
- [ ] Airplane mode, tap: "No connection", nothing charged; back online, "Tap again": charged once (check the card balance and the transaction list)
- [ ] Server stopped mid-charge, then restarted, "Tap again": still one charge

## Storno
- [ ] From the result screen: "Storno this charge" restores the balance and shows "Stornoed"
- [ ] From History: tap a row, Storno…, confirm: row struck through, balance restored, no card needed
- [ ] Storno twice (admin site, same transaction): refused
- [ ] Spend/reduce the card below the charged amount in admin, then storno: refused with "Card has fewer points than this storno."

## Sessions and admin
- [ ] Switch the operator off in admin: the phone is sent to sign-in on the next action
- [ ] Revoke the terminal in admin: the phone can no longer sign in
- [ ] Sign out, sign in as a different operator on the same terminal: presets are the same

## Results

Notes / failures:
