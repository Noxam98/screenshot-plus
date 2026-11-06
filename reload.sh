#!/bin/sh
# Applies code changes without logging out. A recording in progress gets stopped
# and saved, and an open screenshot UI goes back to plain GNOME for the moment.
set -e
uuid=screenshot-plus@maksym
glib-compile-schemas "$(dirname "$(readlink -f "$0")")/schemas"
gnome-extensions disable "$uuid"
gnome-extensions enable "$uuid"
gnome-extensions info "$uuid" | grep -E 'Состояние|State'
