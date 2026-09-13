#!/usr/bin/env bash
# Exercise the privileged Wi-Fi helper with fake NetworkManager commands.
# No root access or real network changes are made.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/nmcli" <<'EOF'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "${FAKE_NMCLI_LOG:?}"
case "$*" in
  '-t -f DEVICE,TYPE device status')
    printf 'wlan0:wifi\n'
    ;;
  '-t -f UUID,TYPE,DEVICE connection show --active')
    printf 'old-uuid:802-11-wireless:wlan0\n'
    ;;
  '-t -f UUID,TYPE connection show')
    ;;
  connection\ load\ *)
    ;;
  '--wait 30 connection up uuid old-uuid')
    ;;
  --wait\ 30\ connection\ up\ uuid\ *)
    if [ "${FAKE_NMCLI_FAIL:-0}" = 1 ]; then
      echo 'Error: Secrets were required, but not provided.' >&2
      exit 4
    fi
    ;;
  connection\ delete\ uuid\ *)
    ;;
  *)
    echo "unexpected fake nmcli call: $*" >&2
    exit 64
    ;;
esac
EOF

cat > "$TMP/bin/ip" <<'EOF'
#!/usr/bin/env bash
printf '2: wlan0 inet 192.0.2.10/24 brd 192.0.2.255 scope global wlan0\n'
EOF
chmod +x "$TMP/bin/nmcli" "$TMP/bin/ip"

assert_json() {
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$1"
}

run_success() {
  local name="$1" newline="$2" dir out log
  dir="$TMP/$name"
  out="$TMP/$name.json"
  log="$TMP/$name.log"
  mkdir -p "$dir"
  if [ "$newline" = 1 ]; then
    printf 'secret123\n'
  else
    printf 'secret123'
  fi | env PATH="$TMP/bin:$PATH" FAKE_NMCLI_LOG="$log" \
      PARTY_STATION_NM_DIR="$dir" bash "$ROOT/scripts/psctl" net-connect 'Test Net' > "$out"

  assert_json "$out"
  grep -q '"ok":true' "$out"
  local profile
  profile="$(find "$dir" -type f -name '*.nmconnection' -print -quit)"
  [ -n "$profile" ]
  grep -qx 'ssid=Test Net' "$profile"
  grep -qx 'psk=secret123' "$profile"
  if grep -q 'secret123' "$log"; then
    echo 'password leaked into nmcli arguments' >&2
    exit 1
  fi
  echo "✓ $name password preserved and kept out of argv"
}

run_success no-newline 0
run_success newline 1

FAIL_DIR="$TMP/failure"
FAIL_OUT="$TMP/failure.json"
FAIL_LOG="$TMP/failure.log"
mkdir -p "$FAIL_DIR"
set +e
printf 'wrong-pass' | env PATH="$TMP/bin:$PATH" FAKE_NMCLI_LOG="$FAIL_LOG" \
  FAKE_NMCLI_FAIL=1 PARTY_STATION_NM_DIR="$FAIL_DIR" \
  bash "$ROOT/scripts/psctl" net-connect 'Test Net' > "$FAIL_OUT"
FAIL_RC=$?
set -e
[ "$FAIL_RC" -ne 0 ]
assert_json "$FAIL_OUT"
grep -q 'Wrong password' "$FAIL_OUT"
[ -z "$(find "$FAIL_DIR" -type f -name '*.nmconnection' -print -quit)" ]
grep -q -- '--wait 30 connection up uuid old-uuid' "$FAIL_LOG"
echo '✓ failed authentication removes the new profile and restores the old connection'
