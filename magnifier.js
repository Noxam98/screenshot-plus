// A zoomed view of the frozen screenshot around the pointer, with a line of text
// under it: the selection's size while it is dragged out, the colour under the
// pointer for the pipette. It shows the screenshot's own pixels, so with
// fractional scaling every physical pixel is a square of its own.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Pixels across the lens, an odd number so one sits in the middle.
const PIXELS = 15;
// The size of one of them in the lens, in stage pixels.
const PIXEL_SIZE = 9;
const LENS = PIXELS * PIXEL_SIZE;
// Between the pointer and the magnifier.
const OFFSET = 24;

export class Magnifier {
    constructor(ui) {
        this._ui = ui;

        this.actor = new St.BoxLayout({
            style_class: 'splus-magnifier',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            visible: false,
        });

        this._lens = new St.Widget({
            style_class: 'splus-lens',
            width: LENS,
            height: LENS,
            clip_to_allocation: true,
        });
        // The whole screenshot, blown up and moved so the pixel under the
        // pointer lands in the middle; the lens shows only that part of it.
        this._image = new Clutter.Actor();
        this._image.set_content_scaling_filters(
            Clutter.ScalingFilter.NEAREST, Clutter.ScalingFilter.NEAREST);
        this._lens.add_child(this._image);
        this._marks = new St.DrawingArea({width: LENS, height: LENS});
        this._marks.connect('repaint', area => this._paintMarks(area));
        this._lens.add_child(this._marks);
        this.actor.add_child(this._lens);

        // The text, with a swatch before it for a colour.
        const line = new St.BoxLayout({
            style_class: 'splus-magnifier-line',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._swatch = new St.Widget({
            style_class: 'splus-swatch',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        line.add_child(this._swatch);
        this._label = new St.Label({
            style_class: 'splus-magnifier-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        line.add_child(this._label);
        this.actor.add_child(line);
    }

    destroy() {
        this.actor.destroy();
    }

    hide() {
        this.actor.hide();
        // Lets go of the screenshot, which the UI drops when it closes.
        this._image.set_content(null);
    }

    // Around (x, y) in stage coordinates, with `text` under the lens, and a
    // swatch of `color` before it when given.
    show(x, y, text, color = null) {
        const content = this._ui._stageScreenshot?.get_content();
        const [, textureWidth] = content?.get_preferred_size() ?? [false, 0];
        if (!content || textureWidth <= 0) {
            this.hide();
            return;
        }
        // Screenshot pixels per stage pixel: the largest monitor scale.
        const scale = textureWidth / global.stage.width;
        const zoom = PIXEL_SIZE * scale;
        if (this._image.content !== content)
            this._image.set_content(content);
        this._image.set_size(global.stage.width * zoom, global.stage.height * zoom);
        const column = Math.floor(x * scale);
        const row = Math.floor(y * scale);
        const middle = (PIXELS - 1) / 2 * PIXEL_SIZE;
        this._image.set_position(middle - column * PIXEL_SIZE, middle - row * PIXEL_SIZE);

        this._label.text = text;
        this._swatch.visible = color !== null;
        if (color)
            this._swatch.set_style(`background-color: ${color};`);
        this.actor.show();
        this._place(x, y);
    }

    // Below and to the right of the pointer, flipped where that leaves the monitor.
    _place(x, y) {
        const monitor = Main.layoutManager.monitors[global.display.get_current_monitor()];
        const [, , width, height] = this.actor.get_preferred_size();
        let left = x + OFFSET;
        let top = y + OFFSET;
        if (monitor && left + width > monitor.x + monitor.width)
            left = x - OFFSET - width;
        if (monitor && top + height > monitor.y + monitor.height)
            top = y - OFFSET - height;
        this.actor.set_position(Math.round(left), Math.round(top));
    }

    // A frame around the middle pixel, light inside dark so it shows on any
    // colour, and faint lines from it to the edges.
    _paintMarks(area) {
        const cr = area.get_context();
        const start = (PIXELS - 1) / 2 * PIXEL_SIZE;
        const end = start + PIXEL_SIZE;
        const centre = start + PIXEL_SIZE / 2;

        cr.setLineWidth(1);
        cr.setSourceRGBA(1, 1, 1, 0.35);
        for (const [x1, y1, x2, y2] of [
            [centre, 0, centre, start - 1],
            [centre, end + 1, centre, LENS],
            [0, centre, start - 1, centre],
            [end + 1, centre, LENS, centre],
        ]) {
            cr.moveTo(x1, y1);
            cr.lineTo(x2, y2);
        }
        cr.stroke();

        cr.setSourceRGBA(0, 0, 0, 0.85);
        cr.rectangle(start - 1.5, start - 1.5, PIXEL_SIZE + 3, PIXEL_SIZE + 3);
        cr.stroke();
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.rectangle(start - 0.5, start - 0.5, PIXEL_SIZE + 1, PIXEL_SIZE + 1);
        cr.stroke();
        cr.$dispose();
    }
}
