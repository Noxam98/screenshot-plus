#!/bin/bash
# Runs an isolated headless GNOME Shell for testing: its own HOME, dconf and D-Bus,
# so the real session and its settings are not touched. Usage: session.sh <workdir>
set -eu
W=$1; EXT=$(cd "$(dirname "$0")/.." && pwd)
# The Wayland socket path has a 108 byte limit, so the runtime dir must be short.
RUN="$XDG_RUNTIME_DIR/splus-test"
"$EXT/tests/stop.sh" >/dev/null
# The work dir is wiped, so only one this script made earlier (or a new one).
MARK="$W/.splus-test-workdir"
if [ -e "$W" ] && [ ! -e "$MARK" ]; then
  echo "refusing to wipe $W: it was not made by this script" >&2; exit 1
fi
rm -rf "$W"; mkdir -p "$W"/{home/Pictures,home/Videos,config,data/gnome-shell/extensions,cache} "$RUN"
touch "$MARK"
chmod 700 "$RUN"
ln -s "$EXT" "$W/data/gnome-shell/extensions/screenshot-plus@maksym"
D="$W/data/gnome-shell/extensions/testdriver@local"; mkdir -p "$D"
cat > "$D/metadata.json" <<'J'
{"uuid":"testdriver@local","name":"Test driver","description":"Opens Eval for tests","shell-version":["50","51"],"session-modes":["user","unlock-dialog"]}
J
cp "$EXT/tests/driver.js" "$D/extension.js"
export HOME="$W/home" XDG_CONFIG_HOME="$W/config" XDG_DATA_HOME="$W/data" XDG_CACHE_HOME="$W/cache"
export PIPEWIRE_RUNTIME_DIR="$XDG_RUNTIME_DIR" XDG_RUNTIME_DIR="$RUN"
export LANG=${SPLUS_LANG:-ru_RU.UTF-8} XDG_SESSION_TYPE=wayland GIO_USE_VFS=local GVFS_DISABLE_FUSE=1; unset DISPLAY WAYLAND_DISPLAY
export SPLUS_EXTENSIONS="${SPLUS_EXTENSIONS:-}" SPLUS_TEST_SHELL=1
exec dbus-run-session -- bash -c '
  echo "$DBUS_SESSION_BUS_ADDRESS" > "'"$W"'/bus"
  gsettings set org.gnome.shell enabled-extensions "${SPLUS_EXTENSIONS:-[\"testdriver@local\",\"screenshot-plus@maksym\"]}"
  gsettings set org.gnome.desktop.interface enable-animations false
  gsettings set org.gnome.desktop.notifications show-banners true
  gsettings set org.gnome.mutter experimental-features "[\"scale-monitor-framebuffer\"]"
  exec gnome-shell --headless --wayland --no-x11 --wayland-display splus-test --virtual-monitor 1920x1080 --virtual-monitor 3840x2160 --force-animations
' > "$W/shell.log" 2>&1
