// Test-only extension: opens Eval and exposes synthetic input as globalThis.T.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const now = () => GLib.get_monotonic_time();
const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

export default class {
    enable() {
        global.context.unsafe_mode = true;
        const seat = global.stage.context.get_backend().get_default_seat();
        const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        const T = {
            wait,
            Clutter,
            GLib,
            Main,
            ui: Main.screenshotUI,
            get ext() {
                return Main.extensionManager.lookup('screenshot-plus@maksym');
            },
            get main() {
                return this.ext.stateObj._main;
            },
            get ann() {
                return this.main._annotator;
            },
            async move(x, y) {
                // Sent twice: the first absolute motion of a long jump gets clamped.
                pointer.notify_absolute_motion(now(), x, y);
                pointer.notify_absolute_motion(now(), x, y);
                await wait(25);
            },
            async press(button = 1) {
                pointer.notify_button(now(), button, Clutter.ButtonState.PRESSED);
                await wait(25);
            },
            async release(button = 1) {
                pointer.notify_button(now(), button, Clutter.ButtonState.RELEASED);
                await wait(25);
            },
            async click(x, y, button = 1) {
                await T.move(x, y);
                await T.press(button);
                await T.release(button);
            },
            async drag(...points) {
                const [first, ...rest] = points;
                await T.move(...first);
                await T.press();
                for (const point of rest)
                    await T.move(...point);
                await T.release();
            },
            // evdev key codes, modifiers held around the key
            async key(code, ...modifiers) {
                for (const m of modifiers)
                    keyboard.notify_key(now(), m, Clutter.KeyState.PRESSED);
                keyboard.notify_key(now(), code, Clutter.KeyState.PRESSED);
                keyboard.notify_key(now(), code, Clutter.KeyState.RELEASED);
                for (const m of modifiers.reverse())
                    keyboard.notify_key(now(), m, Clutter.KeyState.RELEASED);
                await wait(40);
            },
            async scroll(up, x, y) {
                await T.move(x, y);
                pointer.notify_discrete_scroll(now(),
                    up ? Clutter.ScrollDirection.UP : Clutter.ScrollDirection.DOWN,
                    Clutter.ScrollSource.WHEEL);
                await wait(40);
            },
            center(actor) {
                const [x, y] = actor.get_transformed_position();
                const [w, h] = actor.get_transformed_size();
                return [x + w / 2, y + h / 2];
            },
            // Same layout as the laptop: 1080p panel, 4K at 1.67 to its right.
            async applyUserLayout() {
                const bus = Gio.DBus.session;
                const call = (method, args) => new Promise((resolve, reject) => {
                    bus.call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
                        'org.gnome.Mutter.DisplayConfig', method, args, null,
                        Gio.DBusCallFlags.NONE, -1, null, (_b, res) => {
                            try {
                                resolve(bus.call_finish(res));
                            } catch (e) {
                                reject(e);
                            }
                        });
                });
                const [serial, monitors] = (await call('GetCurrentState', null)).deepUnpack();
                const mode = connector => {
                    const [, modes] = monitors.find(m => m[0][0] === connector);
                    return modes.find(m => m[6]['is-current']?.deepUnpack())[0];
                };
                const scale = 1.6666666269302368;
                const logical = [
                    [0, 0, 1, 0, true, [['Meta-0', mode('Meta-0'), {}]]],
                    [1920, 0, scale, 0, false, [['Meta-1', mode('Meta-1'), {}]]],
                ];
                await call('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
                    [serial, 1, logical, {}]));
                await wait(500);
            },
            // The buffer is only valid inside the callback, so copy it there.
            readClipboard(mime = 'image/png') {
                return new Promise(resolve => {
                    St.Clipboard.get_default().get_content(St.ClipboardType.CLIPBOARD, mime,
                        (_c, bytes) => resolve(bytes && bytes.get_size() > 0 ? bytes.toArray().slice() : null));
                });
            },
            KEY: {CTRL: 29, SHIFT: 42, ESC: 1, ENTER: 28, C: 46, S: 31, Z: 44, Y: 21, A: 30, B: 48, D1: 2},
        };
        globalThis.T = T;
    }

    // T stays defined: extensions are re-enabled in order, mid-test.
    disable() {}
}
