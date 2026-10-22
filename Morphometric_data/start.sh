#!/bin/bash
# Linux launcher. Usage:
#   bash start.sh                 # port 8024 (or 'port' in config.json)
#   bash start.sh --port 9000     # any other port
#   FA_PORT=9000 bash start.sh    # same, via environment variable
# Other options: --images DIR  --metadata FILE  --data DIR  (see: bash start.sh --help)
# Uses its own .venv-linux so a copied Mac .venv can't interfere.
cd "$(dirname "$0")"
VENV=.venv-linux
if [ ! -x "$VENV/bin/python" ] || ! "$VENV/bin/python" -c "import sys" 2>/dev/null; then
  echo "First run: creating Python environment in $VENV …"
  rm -rf "$VENV"
  if ! python3 -m venv "$VENV"; then
    echo
    echo "Could not create a virtual environment. On Ubuntu/Debian run:"
    echo "    sudo apt install python3-venv python3-pip"
    echo "then run start.sh again."
    exit 1
  fi
  "$VENV/bin/pip" install -q --upgrade pip
fi
# installs anything new in requirements.txt (fast when already up to date)
"$VENV/bin/pip" install -q -r requirements.txt || { echo "pip install failed (no internet?)"; exit 1; }

# open a browser only when running on a desktop session (not on a headless server)
PORT="${FA_PORT:-}"
prev=""
for a in "$@"; do
  [ "$prev" = "--port" ] && PORT="$a"
  case "$a" in --port=*) PORT="${a#--port=}";; esac
  prev="$a"
done
if [ -n "$DISPLAY$WAYLAND_DISPLAY" ] && command -v xdg-open >/dev/null 2>&1; then
  ( sleep 3; xdg-open "http://localhost:${PORT:-8024}" >/dev/null 2>&1 ) &
fi
exec "$VENV/bin/python" server.py "$@"
