// Loader. GNOME caches ES modules by path for the whole session, which normally
// means logging out to try a code change. So the code runs from a new copy in a
// new directory on every enable, and disabling and enabling picks up new code.
// See reload.sh. Changes to this file itself still need a new session.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const SNAPSHOT_ROOT = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'screenshot-plus']);

function childrenOf(directory) {
    const names = [];
    const children = directory.enumerate_children(
        'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    for (let info = children.next_file(null); info; info = children.next_file(null))
        names.push(info.get_name());
    children.close(null);
    return names;
}

// Modules already loaded stay in memory, so earlier copies are only clutter.
function removeOldSnapshots() {
    const root = Gio.File.new_for_path(SNAPSHOT_ROOT);
    if (!root.query_exists(null))
        return;
    for (const name of childrenOf(root)) {
        const snapshot = root.get_child(name);
        for (const file of childrenOf(snapshot))
            snapshot.get_child(file).delete(null);
        snapshot.delete(null);
    }
}

function makeSnapshot(extensionPath) {
    removeOldSnapshots();

    const directory = GLib.build_filenamev([SNAPSHOT_ROOT, String(GLib.get_monotonic_time())]);
    GLib.mkdir_with_parents(directory, 0o700);

    const source = Gio.File.new_for_path(extensionPath);
    const target = Gio.File.new_for_path(directory);
    for (const name of childrenOf(source)) {
        if (name.endsWith('.js') && name !== 'extension.js') {
            source.get_child(name).copy(target.get_child(name),
                Gio.FileCopyFlags.NONE, null, null);
        }
    }
    return target.get_child('main.js').get_uri();
}

export default class ScreenshotPlusLoader extends Extension {
    enable() {
        this._generation = (this._generation ?? 0) + 1;
        const generation = this._generation;
        this._load(generation).catch(e => {
            // A newer enable may have removed this copy mid-import, which is fine.
            // A real failure happens before anything is hooked, so the native UI
            // simply stays as it is.
            if (generation === this._generation)
                logError(e, 'screenshot-plus: cannot load');
        });
    }

    async _load(generation) {
        const {ScreenshotPlus} = await import(makeSnapshot(this.path));

        // Disabled again while the import was running.
        if (generation !== this._generation)
            return;

        this._main = new ScreenshotPlus(this.path, this.getSettings());
        this._main.enable();
    }

    disable() {
        this._generation++;
        this._main?.disable();
        this._main = null;
    }
}
