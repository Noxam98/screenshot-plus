#!/bin/bash
# Blocks until the test shell answers Eval.
W=$1; for i in $(seq 1 60); do
  [ -s "$W/bus" ] && DBUS_SESSION_BUS_ADDRESS=$(cat "$W/bus") gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval 'globalThis.T?.main?._annotator ? "ready" : "no"' 2>/dev/null | grep -q ready && exit 0
  python3 -I -c 'import time;time.sleep(0.25)'
done; echo "test shell did not start"; exit 1
