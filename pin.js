// A screenshot pinned on top of the windows, as Flameshot's pins: it stays where
// the selection was, at the same size, until it is closed. Drag it to move it;
// the wheel zooms around the pointer and Ctrl with the wheel changes how see-
// through it is; a double-click closes it, the right button opens a menu.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {copyImage, imageContentOf, saveImage} from './exporter.js';
import {t} from './i18n.js';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.1;
const MIN_OPACITY = 0.2;
const OPACITY_STEP = 0.1;
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_PX = 6;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export class Pin {
    // `image` is {bytes, pixbuf}; (x, y, width, height) is where it shows, in
    // stage coordinates, at zoom 1. `onClosed` runs once it is gone.
    constructor(image, [x, y, width, height], onClosed) {
        this._image = image;
        this._width = width;
        this._height = height;
        this._zoom = 1;
        this._onClosed = onClosed;
        this._drag = null;
        this._lastClick = null;

        this.actor = new St.Widget({
            style_class: 'splus-pin',
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this._picture = new St.Widget({content: imageContentOf(image.pixbuf)});
        this.actor.add_child(this._picture);
        this._resize();

        this.actor.connect('button-press-event', (_a, event) => this._onPress(event));
        this.actor.connect('motion-event', (_a, event) => this._onMotion(event));
        this.actor.connect('button-release-event', (_a, event) => this._onRelease(event));
        this.actor.connect('scroll-event', (_a, event) => this._onScroll(event));
        this.actor.connect('destroy', () => this._onDestroy());

        Main.layoutManager.addTopChrome(this.actor);
        // The border sits outside the picture, so the picture is where it was.
        const [border] = this._borders();
        this.actor.set_position(Math.round(x - border), Math.round(y - border));

        this._menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0, St.Side.TOP);
        this._menu.addAction(t('pin.copy'), () => copyImage(this._image));
        this._menu.addAction(t('pin.save'), () => saveImage(this._image));
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addAction(t('pin.close'), () => this.close());
        Main.layoutManager.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();
        this._menuManager = new PopupMenu.PopupMenuManager(this.actor);
        this._menuManager.addMenu(this._menu);
    }

    close() {
        this.actor.destroy();
    }

    _onDestroy() {
        this._drag?.grab.dismiss();
        this._drag = null;
        this._menu.destroy();
        this._onClosed?.(this);
    }

    _borders() {
        const node = this.actor.get_theme_node();
        return [node.get_border_width(St.Side.LEFT), node.get_border_width(St.Side.TOP)];
    }

    _resize() {
        this._picture.set_size(
            Math.max(1, Math.round(this._width * this._zoom)),
            Math.max(1, Math.round(this._height * this._zoom)));
    }

    _onPress(event) {
        const button = event.get_button();
        const [x, y] = event.get_coords();
        if (button === Clutter.BUTTON_SECONDARY) {
            Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
            Main.layoutManager.uiGroup.set_child_above_sibling(this._menu.actor, null);
            this._menu.open();
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        const time = event.get_time();
        const last = this._lastClick;
        this._lastClick = {time, x, y};
        if (last && time - last.time <= DOUBLE_CLICK_MS &&
            Math.hypot(x - last.x, y - last.y) <= DOUBLE_CLICK_PX) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        this._drag = {
            dx: x - this.actor.x,
            dy: y - this.actor.y,
            grab: global.stage.grab(this.actor),
        };
        Main.layoutManager.uiGroup.set_child_above_sibling(this.actor, null);
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this.actor.set_position(Math.round(x - this._drag.dx), Math.round(y - this._drag.dy));
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        if (!this._drag || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._drag.grab.dismiss();
        this._drag = null;
        return Clutter.EVENT_STOP;
    }

    _onScroll(event) {
        // A wheel notch arrives twice, as a smooth and as an emulated event.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        const direction = event.get_scroll_direction();
        let delta = 0;
        if (direction === Clutter.ScrollDirection.UP)
            delta = 1;
        else if (direction === Clutter.ScrollDirection.DOWN)
            delta = -1;
        else if (direction === Clutter.ScrollDirection.SMOOTH)
            delta = -Math.sign(event.get_scroll_delta()[1]);
        if (delta === 0)
            return Clutter.EVENT_STOP;

        if (event.get_state() & Clutter.ModifierType.CONTROL_MASK) {
            this.actor.opacity = Math.round(255 *
                clamp(this.actor.opacity / 255 + delta * OPACITY_STEP, MIN_OPACITY, 1));
            return Clutter.EVENT_STOP;
        }

        // The point under the pointer stays under it.
        const zoom = clamp(this._zoom * ZOOM_STEP ** delta, MIN_ZOOM, MAX_ZOOM);
        if (zoom === this._zoom)
            return Clutter.EVENT_STOP;
        const [x, y] = event.get_coords();
        const [border, top] = this._borders();
        const fx = (x - this.actor.x - border) / (this._width * this._zoom);
        const fy = (y - this.actor.y - top) / (this._height * this._zoom);
        this._zoom = zoom;
        this._resize();
        this.actor.set_position(
            Math.round(x - border - fx * this._width * zoom),
            Math.round(y - top - fy * this._height * zoom));
        return Clutter.EVENT_STOP;
    }
}

// Keeps the pins of the session, so they all go when the extension does.
export class Pins {
    constructor() {
        this._pins = new Set();
    }

    add(image, rect) {
        this._pins.add(new Pin(image, rect, pin => this._pins.delete(pin)));
    }

    destroy() {
        for (const pin of [...this._pins])
            pin.close();
    }
}
