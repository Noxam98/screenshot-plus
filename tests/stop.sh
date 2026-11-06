#!/bin/bash
# Stops everything belonging to the test session, identified by its private
# runtime dir in the process environment (never by matching command lines).
RUN="$XDG_RUNTIME_DIR/splus-test"
python3 -I - "$RUN" <<'PY'
import os, signal, sys, time
needle = ('XDG_RUNTIME_DIR=' + sys.argv[1]).encode()
me = {os.getpid(), os.getppid()}
def owned():
    out = []
    for p in os.listdir('/proc'):
        if not p.isdigit() or int(p) in me:
            continue
        try:
            env = open(f'/proc/{p}/environ', 'rb').read().split(b'\0')
        except OSError:
            continue
        if needle in env:
            out.append(int(p))
    return out
for sig in (signal.SIGTERM, signal.SIGKILL):
    for pid in owned():
        try:
            os.kill(pid, sig)
        except OSError:
            pass
    time.sleep(0.5)
print('left:', owned())
PY
for m in doc gvfs; do fusermount -u -z "$RUN/$m" 2>/dev/null; done
rm -rf "$RUN" 2>/dev/null
[ -e "$RUN" ] && echo "still present: $(ls -A "$RUN")" || echo "runtime dir clean"
