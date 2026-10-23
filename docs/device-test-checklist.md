# Device test checklist

Run this on a real NFC phone with a real MIFARE Classic 1K card before using the system. Tick each line and note the phone model and what happened.

Phone model / Android version: ______________   Card(s): ______________   App build: ______________

## Setup
- [ ] Server running, admin signed in, one terminal paired (code accepted once, a second use is refused)
- [ ] Card added in admin with a photo and 10 starting points
- [ ] Phone paired: after entering the code it goes straight to the keypad with no sign-in, and the presets are shown

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
- [ ] Sounds are clean and not cut off: a soft rising pair when approved, three lower beeps when refused
- [ ] Card read to result takes about half a second plus the server time
- [ ] Beep off in the terminal menu: silent on success and refusal

## Refusals
- [ ] Block the card in admin: tap shows "Card is blocked" with the holder's photo, balance unchanged
- [ ] Unblock it: charging works again
- [ ] Unregistered card: "Card not registered" with the UID, and a **Suggest for addition** button; after pressing it the admin site shows the card under Suggested cards, and Add as card opens the form with that UID
- [ ] After a successful charge, **One more like this** goes straight to waiting for the next card with the same amount (no keypad), and each tap is a separate charge
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
- [ ] Revoke the terminal in admin: the phone's next action sends it back to the pairing screen, and the old code can't be reused
- [ ] Unpair from the terminal menu (it asks first): the phone returns to pairing; a new code from admin pairs it again
- [ ] Close and reopen the app, and update it over the old APK: it stays paired, no sign-in

## Results

Notes / failures:

## Check-in mode
- [ ] In admin, make two zones with different rules (for example 8 points per 12 minutes and 3 points per 10 minutes). Set one phone to Check-in, zone A, **Sign in only**; a second phone (or the same one later) to Check-in, zone B, **Sign out only**. Both phones switch within about 30 seconds without re-pairing
- [ ] The waiting screen reads "Tap to sign in" / "Tap to sign out" / "Tap your card" and shows the zone name; there are no buttons anywhere
- [ ] Tap at the sign-in point: "Checked in" with photo, name, time, zone. After 5 seconds it returns to waiting. Tapping the next card straight away replaces the screen at once
- [ ] Tapping the same card again within the lock-out: "Already checked in", nothing changes
- [ ] Wait a few minutes, tap at the sign-out point: "Checked out" with minutes inside and points that match the **zone A** rules (and the admin preview table)
- [ ] Sign-in point after signing in again later (while inside): "Already checked in", no points move. Sign-out point with nobody inside: "Not checked in"
- [ ] Sign-in at A, sign out at a Toggle point in zone B: paid by zone A's rules
- [ ] Rules cap: set a per-visit or 24-hour cap and check the note ("Visit limit reached…" / "Daily limit reached…") and the totals
- [ ] A forgotten visit (set the longest stay to 1 hour, wait): the next tap says the last visit earned no points
- [ ] Unregistered card: "Card not registered, an admin has been told"; it appears under Suggested cards in admin without anyone pressing a button
- [ ] Long-press the terminal name: the menu opens (beep switch, Unpair). Unpairing asks first
- [ ] Switch the terminal back to ATM in admin: the phone shows the keypad within about 30 seconds
- [ ] Admin: Check-in page shows who is inside; Sign out awards points, Discard doesn't; Storno of a check-out award in Transactions frees the 24-hour allowance
- [ ] Admin: grant and deduct points on a card with a reason; both appear in Transactions as Admin grant / Admin deduction with the admin's name and the reason

## ESP32 readers (see firmware/esp32-reader/README.md)
- [ ] Wiring checked against the table; the display shows `8888` for a moment at power-on, and no `Err` after a few seconds
- [ ] The reader joins WiFi and shows a steady 4-digit code; the same code and the reader's address are listed under Readers in admin; no other reader shows that code
- [ ] Approve it as Fixed amount: within a few seconds the display shows `----`
- [ ] Tap a registered card: a line appears in the middle of digit 1, then 2, 3, 4 (a four-step bar that is over in a blink), then the new balance appears at once and stays about 3 seconds, then `----`. Nothing animates while idle
- [ ] The balance matches the card in admin, and the grant is in Transactions (and can be stornoed)
- [ ] Hold the card on the reader: it is read once, not repeatedly. Tap again straight away: `PAUS`
- [ ] Set limits (taps per 24 h, points per 24 h, taps ever) and check `FULL` when reached; storno a grant and the card can tap again
- [ ] Blocked card: `bLoc`. Unregistered card: `----` blinks, and the card appears under Suggested cards
- [ ] Change the reader to Check-in (zone, sign in / out / toggle): it follows within 30 seconds; `In` then balance, `OUt` then balance, `nOIn` at an exit with nobody inside
- [ ] Unplug the server's network: the reader shows `nEt`, and recovers by itself when the network is back
- [ ] Revoke the reader in admin: `OFF` within 30 seconds; Forget it, restart the reader: a new code appears
- [ ] Power-cycle the reader: it comes back approved without a new code
- [ ] Reader and card reader stay reliable for several minutes of taps (no random `Err`)
- [ ] While a balance (fixed amount) or `In` / `OUt` is still on the display, tap a different card: the display switches to the new card's bar and result at once, with no waiting
- [ ] Check-in: signing in shows only `In` for about 2 seconds, with no balance; signing out shows `OUt` for 2 seconds, then the balance

## Display pages
- [ ] In admin (Readers), press Open: a page with the reader's name and "Tap your card", and "Live" at the top right
- [ ] Tap a card on the reader: the page switches at once to the photo, name, headline and (fixed amount: after a grant; check-in: after signing out) the balance; after 6 seconds it returns to "Tap your card"
- [ ] Tapping a second card while the first is still shown replaces it immediately
- [ ] Signing in shows no balance; an unregistered card shows "Card not registered" with no name or photo; a blocked card shows its name and "Card is blocked"
- [ ] Switch "Beep on the display" on: the page asks for one click, then beeps (a rising pair for a grant or sign-out, one short beep for sign-in, three low beeps for a refusal). Switch it off in admin: the page goes quiet within 30 seconds
- [ ] Open the link on another device on the network (use this computer's address, not localhost)
- [ ] Unplug the server's network or restart the server: the page shows "Reconnecting…" and comes back by itself
- [ ] Press New link: the old page shows "This link is no longer valid"
