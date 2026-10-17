#!/bin/bash
# Double-click this file on macOS to start FMH DRILL.
# (First time only: right-click → Open, or run `chmod +x start.command` in Terminal.)
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 was not found. Install the Xcode Command Line Tools with:  xcode-select --install"
  read -r -p "press Enter to close"
  exit 1
fi
python3 server.py
