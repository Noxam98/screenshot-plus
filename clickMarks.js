// While a recording shows the pointer, every click gets a circle around the
// pointer, so it can be seen in the video. A held button keeps its circle under
// the pointer, which shows drags; letting go makes it spread out and fade. The
// left, right and middle buttons have their own colours (stylesheet.css).
//
// Clicks on windows go from Mutter straight to the app and never reach the
// shell's own event handling, so the buttons are read from the pointer state
// instead, a hundred times a second, and only while recording.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const POLL_MS = 10;
// Logical pixels; the rounding in stylesheet.css is half of it.
const SIZE = 44;
const PRESS_MS = 100;
const RELEASE_MS = 400;
const PRESS_SCALE = 0.5;
const RELEASE_SCALE = 1.9;

const BUTTONS = [
    [Clutter.ModifierType.BUTTON1_MASK, 'splus-click-left'],
    [Clutter.ModifierType.BUTTON3_MASK, 'splus-click-right'],
    [Clutter.ModifierType.BUTTON2_MASK, 'splus-click-middle'],
];

class Mark {
    // `all` holds every mark still on screen, fading ones included.
    constructor(layer, all, style, x, y) {
        this._all = all;
        all.add(this);
        this._size = SIZE * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.actor = new St.Widget({
            style_class: `splus-click ${style}`,
            width: this._size,
            height: this._size,
        });
        this.actor.set_pivot_point(0.5, 0.5);
        layer.add_child(this.actor);
        this.moveTo(x, y);
        this._play(PRESS_MS, PRESS_SCALE, 0, 1, 255);
    }

    moveTo(x, y) {
        this.actor.set_position(Math.round(x - this._size / 2), Math.round(y - this._size / 2));
    }

    release() {
        this._play(RELEASE_MS, this.actor.scale_x, this.actor.opacity, RELEASE_SCALE, 0,
            () => this.destroy());
    }

    destroy() {
        this._timeline?.stop();
        this._timeline = null;
        this.actor.destroy();
        this._all.delete(this);
    }

    // A timeline of its own rather than ease(), which jumps straight to the end
    // when animations are turned off in the system: the circle would never show.
    _play(duration, fromScale, fromOpacity, toScale, toOpacity, done) {
        this._timeline?.stop();
        const timeline = new Clutter.Timeline({
            actor: this.actor,
            duration,
            progress_mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        const step = () => {
            const p = timeline.get_progress();
            const scale = fromScale + (toScale - fromScale) * p;
            this.actor.set_scale(scale, scale);
            this.actor.opacity = Math.round(fromOpacity + (toOpacity - fromOpacity) * p);
        };
        timeline.connect('new-frame', step);
        timeline.connect('completed', () => {
            this._timeline = null;
            done?.();
        });
        step();
        timeline.start();
        this._timeline = timeline;
    }
}

export class ClickMarks {
    constructor(ui, settings) {
        this._ui = ui;
        this._settings = settings;
        this._layer = null;
        this._timer = 0;
        this._signals = [
            [ui, ui.connect('notify::screencast-in-progress', () => this._sync())],
            [settings, settings.connect('changed::show-clicks', () => this._sync())],
        ];
        this._sync();
    }

    destroy() {
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        this._stop();
    }

    // The pointer button is read when the recording starts, as GNOME does.
    _sync() {
        const wanted = this._ui.screencast_in_progress &&
            this._settings.get_boolean('show-clicks');
        if (!wanted)
            this._stop();
        else if (!this._layer && this._ui._showPointerButton.checked)
            this._start();
    }

    _start() {
        this._layer = new Clutter.Actor({reactive: false});
        Main.layoutManager.uiGroup.add_child(this._layer);
        this._held = new Map();
        this._marks = new Set();
        // A button already down when recording starts is not a click in it.
        const [, , mods] = global.get_pointer();
        this._ignored = BUTTONS.map(([mask]) => mask).filter(mask => mods & mask);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stop() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._marks?.forEach(mark => mark.destroy());
        this._marks = null;
        this._held = null;
        this._layer?.destroy();
        this._layer = null;
    }

    _poll() {
        const [x, y, mods] = global.get_pointer();
        for (const [mask, style] of BUTTONS) {
            const down = (mods & mask) !== 0;
            const mark = this._held.get(mask);
            if (down && mark) {
                mark.moveTo(x, y);
            } else if (down && !this._ignored.includes(mask)) {
                // Above whatever opened since, such as a menu.
                Main.layoutManager.uiGroup.set_child_above_sibling(this._layer, null);
                this._held.set(mask, new Mark(this._layer, this._marks, style, x, y));
            } else if (!down) {
                this._ignored = this._ignored.filter(m => m !== mask);
                if (mark) {
                    mark.release();
                    this._held.delete(mask);
                }
            }
        }
    }
}
