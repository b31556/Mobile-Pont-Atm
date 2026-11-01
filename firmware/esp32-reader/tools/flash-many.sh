#!/usr/bin/env bash
# Writes the Pont reader firmware to ESP32 boards, one after another: plug a board in, it is written and
# checked, unplug it, plug in the next one. The firmware is built once at the start, from include/config.h
# (WiFi and server address), so every board gets the same settings.
#
#   tools/flash-many.sh                        many boards, one at a time (Ctrl+C when done)
#   tools/flash-many.sh --port /dev/ttyUSB0    only the board on that port, then stop
#
#   --no-build        use the firmware built last time instead of building again
#   --keep-settings   do not wipe the board first. By default the whole flash is erased, so each board starts
#                     fresh (no old secret or token from another server) and registers itself with the server.
#   --baud N          upload speed (default 460800; a failed board is retried once at 115200)
#   --dry-run         show what would be done and write nothing
#
# Every board that was written is added to firmware/esp32-reader/.flashed.log with its MAC address. The MAC is
# also the reader's "device id" in the admin site, so you can tell the boards apart when you approve them.
#
# Boards are expected one at a time (not several plugged in together). Works on Linux and macOS with PlatformIO
# installed (https://platformio.org/install/cli); on Linux your user needs to be in the "dialout" group.

set -u -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/.pio/build/esp32dev"
LOG="$ROOT/.flashed.log"
BOOT_APP0="$HOME/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin"
ESPTOOL="${ESPTOOL:-$HOME/.platformio/packages/tool-esptoolpy/esptool.py}"
PY="$HOME/.platformio/penv/bin/python"; [ -x "$PY" ] || PY="$(command -v python3 || true)"

PORT="" ; BAUD=460800 ; DO_BUILD=1 ; ERASE=1 ; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --baud) BAUD="${2:-}"; shift 2 ;;
    --no-build) DO_BUILD=0; shift ;;
    --keep-settings) ERASE=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

die() { echo "Error: $*" >&2; exit 1; }

[ -f "$ROOT/include/config.h" ] || die "include/config.h is missing. Copy include/config.example.h to include/config.h and fill in the WiFi and the server address."
SERVER_URL="$(sed -n 's/^#define SERVER_URL[[:space:]]*"\(.*\)".*/\1/p' "$ROOT/include/config.h" | head -1)"
FIRMWARE_VERSION="$(sed -n 's/.*FIRMWARE = "\(.*\)".*/\1/p' "$ROOT/src/main.cpp" | head -1)"
[ -n "$SERVER_URL" ] || die "SERVER_URL is not set in include/config.h"
echo "Firmware $FIRMWARE_VERSION, server: $SERVER_URL"
case "$SERVER_URL" in
  https://*) ;;
  *) echo "WARNING: that address is plain http://. The readers will send their tokens and card numbers unencrypted." ;;
esac

if [ "$DO_BUILD" = 1 ]; then
  command -v pio >/dev/null || die "PlatformIO ('pio') is not installed. See https://platformio.org/install/cli"
  echo "Building..."
  if [ "$DRY" = 1 ]; then echo "(dry run: would run: pio run -d $ROOT)"; else pio run -d "$ROOT" >/tmp/pont-flash-build.log 2>&1 || { tail -20 /tmp/pont-flash-build.log; die "the build failed"; }; fi
fi
if [ "$DRY" = 0 ]; then
  for f in "$BUILD/bootloader.bin" "$BUILD/partitions.bin" "$BUILD/firmware.bin" "$BOOT_APP0"; do [ -f "$f" ] || die "missing $f (build first, without --no-build)"; done
  [ -n "$PY" ] || die "python3 was not found"
  [ -f "$ESPTOOL" ] || die "esptool was not found at $ESPTOOL (run 'pio run' once so PlatformIO installs it)"
fi

ports() { local p; for p in /dev/ttyUSB* /dev/ttyACM* /dev/cu.usbserial* /dev/cu.SLAB_USBtoUART* /dev/cu.wchusbserial*; do [ -e "$p" ] && echo "$p"; done; }

# The same command PlatformIO uses to upload to this board type (esp32doit-devkit-v1).
write_args() {
  local port="$1" baud="$2" extra=()
  [ "$ERASE" = 1 ] && extra=(--erase-all)
  echo --chip esp32 --port "$port" --baud "$baud" --before default_reset --after hard_reset write_flash "${extra[@]}" -z \
    --flash_mode dio --flash_freq 40m --flash_size 4MB \
    0x1000 "$BUILD/bootloader.bin" 0x8000 "$BUILD/partitions.bin" 0xe000 "$BOOT_APP0" 0x10000 "$BUILD/firmware.bin"
}

OK=0 ; FAILED=0 ; MACS=()
summary() {
  echo; echo "Done: $OK board(s) written, $FAILED failed."
  [ "$OK" -gt 0 ] && { echo "Device ids (MAC addresses) written this time:"; printf '  %s\n' "${MACS[@]}"; echo "Log: $LOG"; }
}
trap 'summary; exit 0' INT

flash_one() {
  local port="$1" out mac baud
  for baud in "$BAUD" 115200; do
    out="$(mktemp)"
    # shellcheck disable=SC2046
    if "$PY" "$ESPTOOL" $(write_args "$port" "$baud") >"$out" 2>&1; then
      mac="$(sed -n 's/^MAC: //p' "$out" | head -1 | tr 'a-f' 'A-F')"
      rm -f "$out"
      echo "  written and verified. Device id: ${mac:-unknown}"
      echo "$(date '+%Y-%m-%d %H:%M:%S') ${mac:-unknown} firmware=$FIRMWARE_VERSION server=$SERVER_URL" >> "$LOG"
      MACS+=("${mac:-unknown}"); OK=$((OK + 1)); return 0
    fi
    echo "  attempt at $baud baud failed:"; tail -4 "$out" | sed 's/^/    /'; rm -f "$out"
    [ "$baud" = 115200 ] && break
  done
  FAILED=$((FAILED + 1)); echo "  FAILED. Unplug it, check the cable (it must carry data, not only power) and try again."; return 1
}

if [ "$DRY" = 1 ]; then
  echo "(dry run) would write, for each board:"
  echo "  $PY $ESPTOOL $(write_args "${PORT:-<port>}" "$BAUD")"
  [ "$ERASE" = 1 ] && echo "(the whole flash is erased first, so every board registers fresh with the server)"
  exit 0
fi

if [ -n "$PORT" ]; then
  [ -e "$PORT" ] || die "$PORT does not exist"
  echo "Writing $PORT ..."; flash_one "$PORT"; rc=$?; summary; exit $rc
fi

echo "Ready. Plug in a board (Ctrl+C to stop)."
while true; do
  p=""
  until [ -n "$p" ]; do p="$(ports | head -1)"; sleep 0.5; done
  sleep 1; [ -e "$p" ] || continue                   # let the USB connection settle
  echo "Board found on $p, writing ..."
  flash_one "$p"
  echo "Unplug it, then plug in the next one."
  while [ -e "$p" ]; do sleep 0.5; done              # wait until it is unplugged
done
