#!/usr/bin/env bash
# Party Station — one-shot installer for a Raspberry Pi or any Linux box:
#
#   curl -fsSL https://raw.githubusercontent.com/fleetwoodjohnr/party-station/main/install.sh | sudo bash
#
# Thin wrapper: the real installer lives at scripts/setup-pi.sh (kept there so
# existing links keep working). Runs the local copy when executed from a
# checkout, otherwise fetches the latest from GitHub main.
set -euo pipefail

SETUP="scripts/setup-pi.sh"
SETUP_URL="https://raw.githubusercontent.com/fleetwoodjohnr/party-station/main/$SETUP"

SRC="${BASH_SOURCE[0]:-}"
if [ -n "$SRC" ] && [ -f "$(dirname "$SRC")/$SETUP" ]; then
  exec bash "$(dirname "$SRC")/$SETUP"
fi

TMP="$(mktemp /tmp/party-station-setup.XXXXXX)"
curl -fsSL "$SETUP_URL" -o "$TMP"
RC=0
bash "$TMP" </dev/null || RC=$?
rm -f "$TMP"
exit $RC
