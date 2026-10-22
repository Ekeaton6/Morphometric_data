#!/bin/bash
# macOS launcher: double-click, or run ./start.command [--port 9000]
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "First run: creating Python environment…"
  python3 -m venv .venv || { echo "python3 not found. Install Python 3 from python.org"; read -r; exit 1; }
  ./.venv/bin/pip install -q --upgrade pip
fi
# installs anything new in requirements.txt (fast when already up to date)
./.venv/bin/pip install -q -r requirements.txt
PORT="${FA_PORT:-}"
prev=""
for a in "$@"; do
  [ "$prev" = "--port" ] && PORT="$a"
  case "$a" in --port=*) PORT="${a#--port=}";; esac
  prev="$a"
done
( sleep 3; open "http://localhost:${PORT:-8024}" ) &
./.venv/bin/python server.py "$@"
