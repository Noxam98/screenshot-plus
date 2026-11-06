// Full-screen window whose whole area changes every frame: the worst case for a
// recorder. Usage: gjs -m tests/animated.js <monitor index>
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import {programArgs} from 'system';

Gtk.init();
const area = new Gtk.DrawingArea();
let frame = 0;
area.set_draw_func((_a, cr, width, height) => {
    for (let i = 0; i < 40; i++) {
        const t = (frame + i * 11) % 240 / 240;
        cr.setSourceRGB((i * 37 % 100) / 100, t, 1 - t);
        cr.rectangle(((i * 97 + frame * (i % 7 + 1)) % 100) / 100 * width,
            (i * 53 % 100) / 100 * height, width / 6, height / 6);
        cr.fill();
    }
    cr.$dispose();
});
area.add_tick_callback(() => {
    frame++;
    area.queue_draw();
    return GLib.SOURCE_CONTINUE;
});
const window = new Gtk.Window({title: 'animated'});
window.set_child(area);
const monitors = Gdk.Display.get_default().get_monitors();
window.fullscreen_on_monitor(monitors.get_item(parseInt(programArgs[0] ?? '0')));
window.present();
new GLib.MainLoop(null, false).run();
