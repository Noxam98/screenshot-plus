// A plain window for testing window-mode capture.
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
Gtk.init();
const win = new Gtk.Window({title: 'test window', default_width: 500, default_height: 300});
win.set_child(new Gtk.Label({label: 'test window'}));
win.present();
new GLib.MainLoop(null, false).run();
