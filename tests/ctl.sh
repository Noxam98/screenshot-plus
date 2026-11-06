#!/bin/bash
# Drives the test session. Usage:
#   ctl.sh <workdir> js '<async js>'   run in the shell and print the JSON result
#   ctl.sh <workdir> shot <png>        screenshot of the whole stage
#   ctl.sh <workdir> <command...>      run with the session's D-Bus
W=$1; shift; export DBUS_SESSION_BUS_ADDRESS=$(cat "$W/bus")
eval_js() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1"; }
case $1 in
 js)
  # Percent-encoded because gdbus unescapes backslashes in string arguments.
  code=$(printf '%s' "$2" | python3 -I -c 'import sys,urllib.parse as u; print(u.quote(sys.stdin.read(), safe=""))')
  eval_js "globalThis.__r = null; (async () => { const AsyncFunction = (async () => {}).constructor; return await new AsyncFunction(decodeURIComponent('$code'))(); })().then(v => { globalThis.__r = 'OK ' + JSON.stringify(v ?? null); }).catch(e => { globalThis.__r = 'ERR ' + e.message + ' @ ' + e.stack; }); 0" | grep -v "^(true, '0')" | cut -c1-400
  for i in $(seq 1 ${3:-600}); do
    r=$(eval_js 'globalThis.__r' 2>&1) || { echo "SHELL GONE: $r" | cut -c1-200; exit 2; }
    case "$r" in *OK\ *|*ERR\ *) printf '%s\n' "$r" | cut -c1-${4:-1500}; exit 0;; esac
    python3 -I -c 'import time; time.sleep(0.05)'
  done
  echo "TIMEOUT"; exit 1;;
 shot) gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$2" >/dev/null;;
 *) "$@";;
esac
