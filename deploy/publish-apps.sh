#!/usr/bin/env bash
# Builds the two Android apps, signs them with the release key, and publishes them on the server, where
# https://<server>/app offers them: "Pont Card" (for card holders, module :user), "Pont Terminal" (for staff, module :app) and "Pont Admin" (the admin site with a card scanner, module :admin).
#
#   deploy/publish-apps.sh                 build, sign, upload
#   deploy/publish-apps.sh --no-build      sign and upload the apps built last time
#   deploy/publish-apps.sh --dry-run       build and sign into a temporary folder, upload nothing
#
#   --host user@server    where to upload      (or PONT_HOST)
#   --url https://server  the server address built into the apps (or PONT_URL)
#   --remote-dir /path    the downloads folder on the server       (or PONT_REMOTE_DIR)
# There are no built-in values. Put them in private/deploy.env (ignored by git) or pass them. See deploy/README.md.
#
# The apps are copied into the downloads folder (pont-card.apk, pont-terminal.apk, pont-admin.apk) and apps.json is written last,
# so the page never points at a file that is not there yet. Needs the release key made once, kept outside the repository
# (KEYSTORE and KEYPASS_FILE). Keep both safe: a phone only accepts an update signed with the same key.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Where to deploy comes from private/deploy.env (not in git), the environment or the options; nothing is built in.
[ -f "$ROOT/private/deploy.env" ] && . "$ROOT/private/deploy.env"
HOST="${PONT_HOST:-}"
URL="${PONT_URL:-}"
REMOTE_DIR="${PONT_REMOTE_DIR:-}"
KEYSTORE="${KEYSTORE:-$HOME/.config/pont/release.keystore}"
KEYPASS_FILE="${KEYPASS_FILE:-$HOME/.config/pont/release-keystore.pass}"
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
BUILD=1; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host needs a value}"; shift 2 ;;
    --url) URL="${2:?--url needs a value}"; shift 2 ;;
    --remote-dir) REMOTE_DIR="${2:?--remote-dir needs a value}"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done
die() { echo "Error: $*" >&2; exit 1; }
[ -n "$URL" ] || die "no server address: pass --url, set PONT_URL, or put it in private/deploy.env"
if [ "$DRY" != 1 ]; then [ -n "$HOST" ] || die "no server to upload to: pass --host, set PONT_HOST, or put it in private/deploy.env"; [ -n "$REMOTE_DIR" ] || die "no downloads folder: pass --remote-dir, set PONT_REMOTE_DIR, or put it in private/deploy.env"; fi

[ -f "$KEYSTORE" ] || die "the release key is missing: $KEYSTORE"
[ -f "$KEYPASS_FILE" ] || die "the release key's password file is missing: $KEYPASS_FILE"
BT="${BUILD_TOOLS:-$(find "$SDK/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1)}"
for tool in apksigner zipalign aapt2; do [ -x "$BT/$tool" ] || die "Android build-tools ($tool) not found under $SDK (set ANDROID_HOME)"; done
if [ -z "${JAVA_HOME:-}" ]; then for j in /usr/lib/jvm/java-21-openjdk-amd64 /usr/lib/jvm/java-17-openjdk-amd64; do [ -d "$j" ] && JAVA_HOME="$j" && break; done; fi
export JAVA_HOME ANDROID_HOME="$SDK"

if [ "$BUILD" = 1 ]; then
  echo "Building both apps for $URL ..."
  (cd "$ROOT/android" && ./gradlew assembleRelease -Ppont.baseUrl="$URL" --console=plain -q) || die "the build failed"
fi

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
KSPASS="$(cat "$KEYPASS_FILE")"; export KSPASS

# name in the page : file name : where the build left it
APPS=(
  "card|pont-card.apk|$ROOT/android/user/build/outputs/apk/release/user-release-unsigned.apk"
  "terminal|pont-terminal.apk|$ROOT/android/app/build/outputs/apk/release/app-release-unsigned.apk"
  "admin|pont-admin.apk|$ROOT/android/admin/build/outputs/apk/release/admin-release-unsigned.apk"
)
JSON="{"
for entry in "${APPS[@]}"; do
  IFS='|' read -r key file built <<<"$entry"
  [ -f "$built" ] || die "$built is missing: build first (without --no-build)"
  "$BT/zipalign" -f -p 4 "$built" "$WORK/$file.aligned"
  "$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass env:KSPASS --key-pass env:KSPASS --out "$WORK/$file" "$WORK/$file.aligned"
  "$BT/apksigner" verify "$WORK/$file" >/dev/null || die "$file does not verify after signing"
  rm -f "$WORK/$file.aligned" "$WORK/$file.idsig"
  badging="$("$BT/aapt2" dump badging "$WORK/$file")"
  pkg="$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<<"$badging")"
  version="$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<<"$badging" | head -1)"
  grep -q "application-debuggable" <<<"$badging" && die "$file is a debuggable build"
  size="$(stat -c %s "$WORK/$file")"; sum="$(sha256sum "$WORK/$file" | cut -d' ' -f1)"
  echo "  $key: $pkg $version, $((size / 1024)) KB, sha256 ${sum:0:16}..."
  JSON+="$([ "$JSON" = "{" ] || echo ",")\"$key\":{\"file\":\"$file\",\"package\":\"$pkg\",\"version\":\"$version\",\"size\":$size,\"sha256\":\"$sum\",\"updated\":\"$(date -u +%Y-%m-%d)\"}"
done
JSON+="}"
echo "$JSON" > "$WORK/apps.json"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$WORK/apps.json" || die "apps.json is not valid JSON"

if [ "$DRY" = 1 ]; then
  echo "(dry run) would upload to $HOST:$REMOTE_DIR :"; (cd "$WORK" && stat -c '  %s %n' ./*); cat "$WORK/apps.json"; echo
  exit 0
fi

echo "Uploading to $HOST ..."
ssh -o BatchMode=yes "$HOST" "mkdir -p '$REMOTE_DIR'"
for entry in "${APPS[@]}"; do IFS='|' read -r _ file _ <<<"$entry"; scp -q -o BatchMode=yes "$WORK/$file" "$HOST:$REMOTE_DIR/$file.new"; done
scp -q -o BatchMode=yes "$WORK/apps.json" "$HOST:$REMOTE_DIR/apps.json.new"
# the apps first, the list of them last
ssh -o BatchMode=yes "$HOST" "cd '$REMOTE_DIR' && chmod 644 *.new && for f in *.apk.new; do mv -f \"\$f\" \"\${f%.new}\"; done && mv -f apps.json.new apps.json"

echo "Checking what the page offers ..."
curl -fsS -m 20 "$URL/downloads/apps.json" | python3 -c 'import json,sys; [print("  " + k + ": " + v["version"] + ", " + str(v["size"] // 1024) + " KB") for k, v in json.load(sys.stdin).items()]'
for entry in "${APPS[@]}"; do
  IFS='|' read -r _ file _ <<<"$entry"
  got="$(curl -fsS -m 120 "$URL/downloads/$file" | sha256sum | cut -d' ' -f1)"
  want="$(sha256sum "$WORK/$file" | cut -d' ' -f1)"
  if [ "$got" = "$want" ]; then echo "  $file downloads intact"; else die "$file from the server is different from what was uploaded"; fi
done
echo "Done: $URL/app"
