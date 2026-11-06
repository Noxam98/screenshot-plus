// Turns the current capture into a PNG, optionally burns annotations into it, and
// sends it to the clipboard and/or disk.
//
// This runs in two parts so the UI can close the moment a key is pressed. The first
// part takes the pixels synchronously, and after it the UI is free to go away. The
// second part avoids blocking the compositor: PNG work goes through GdkPixbuf's
// threaded calls, because Cairo's own PNG functions would stall the desktop while
// the user is already back at work.

import Cairo from 'cairo';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gettext from 'gettext';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {t} from './i18n.js';
import {drawShape} from './shapes.js';

// Reuse GNOME's translations so names and text stay exactly what they are today,
// e.g. "Снимок экрана от 2026-11-05 10-57-27.png".
const _ = Gettext.domain('gnome-shell').gettext;

let tempCounter = 0;

// Temporary PNGs live a moment in a private folder in $XDG_RUNTIME_DIR, which is
// in memory. One holds the original pixels behind a pixelated area while the
// preview is made, so leftovers from a crash are removed at the next start.
const TEMP_DIR = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'screenshot-plus-tmp']);

function tempPath() {
    tempCounter++;
    GLib.mkdir_with_parents(TEMP_DIR, 0o700);
    return GLib.build_filenamev([
        TEMP_DIR,
        `${new Gio.Credentials().get_unix_pid()}-${tempCounter}.png`,
    ]);
}

function removeMatching(path, pattern) {
    const dir = Gio.File.new_for_path(path);
    try {
        const children = dir.enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        for (let info = children.next_file(null); info; info = children.next_file(null)) {
            if (pattern.test(info.get_name()))
                dir.get_child(info.get_name()).delete(null);
        }
        children.close(null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.warn(`screenshot-plus: cannot clean ${path}: ${e.message}`);
    }
}

export function removeTempFiles() {
    removeMatching(TEMP_DIR, /\.png$/);
    // Where earlier versions put them.
    removeMatching(GLib.get_user_runtime_dir(), /^screenshot-plus-\d+-\d+\.png$/);
}

// write_bytes may stop short, which would leave a truncated PNG looking fine.
function writeAll(stream, bytes) {
    stream.write_all(bytes.toArray(), null);
    stream.close(null);
}

function writeBytes(path, bytes) {
    writeAll(Gio.File.new_for_path(path)
        .replace(null, false, Gio.FileCreateFlags.PRIVATE, null), bytes);
}

// The pixels are read during this call. The encode continues in a thread and does
// not need the texture or the UI any more.
async function compositePng(texture, x, y, w, h, scale, cursor) {
    const stream = Gio.MemoryOutputStream.new_resizable();
    const pixbuf = await Shell.Screenshot.composite_to_stream(
        texture, x, y, w, h, scale,
        cursor.texture, cursor.x, cursor.y, cursor.scale,
        stream);
    stream.close(null);
    return {bytes: stream.steal_as_bytes(), pixbuf};
}

// Mirrors ScreenshotUI._saveScreenshot, minus the storing. Returns the pending PNG,
// or null when there is nothing to capture.
function startCapture(ui) {
    if (ui._selectionButton.checked || ui._screenButton.checked) {
        const content = ui._stageScreenshot.get_content();
        if (!content)
            return null;

        const [x, y, w, h] = ui._getSelectedGeometry(true);
        const cursorTexture = ui._cursor.visible
            ? ui._cursor.content?.get_texture() ?? null : null;

        return compositePng(content.get_texture(), x, y, w, h, ui._scale, {
            texture: cursorTexture,
            x: ui._cursor.x * ui._scale,
            y: ui._cursor.y * ui._scale,
            scale: ui._cursorScale,
        });
    }

    if (ui._windowButton.checked) {
        const window = ui._windowSelectors
            .flatMap(selector => selector.windows())
            .find(win => win.checked);
        const content = window?.windowContent;
        if (!content)
            return null;

        const cursorTexture = ui._cursor.visible
            ? window.getCursorTexture()?.get_texture() ?? null : null;

        return compositePng(content.get_texture(), 0, 0, -1, -1, window.bufferScale, {
            texture: cursorTexture,
            x: window.cursorPoint.x * window.bufferScale,
            y: window.cursorPoint.y * window.bufferScale,
            scale: ui._cursorScale,
        });
    }

    return null;
}

function loadPixbuf(path) {
    return new Promise((resolve, reject) => {
        GdkPixbuf.Pixbuf.new_from_stream_async(
            Gio.File.new_for_path(path).read(null), null, (_s, result) => {
                try {
                    resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// The fast setting: on a 3166x1666 screenshot it took 92 ms against 1466 ms for the
// default, for a file about a third larger. The clipboard should not lag that much.
function encodePng(pixbuf) {
    return new Promise((resolve, reject) => {
        const stream = Gio.MemoryOutputStream.new_resizable();
        pixbuf.save_to_streamv_async(stream, 'png', ['compression'], ['1'], null, (_p, result) => {
            try {
                GdkPixbuf.Pixbuf.save_to_stream_finish(result);
                stream.close(null);
                resolve(stream.steal_as_bytes());
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Annotations go on a transparent layer of their own, and that layer is merged with
// the captured pixels. Cairo in GJS cannot wrap raw pixels, so a PNG on tmpfs is the
// bridge. The files hold screen contents: they sit in the private runtime dir and
// go away at once.
async function burnAnnotations(png, {shapes, origin: [x, y], scale}) {
    const {pixbuf} = png;
    const layerPath = tempPath();
    try {
        let base = null;
        if (shapes.some(s => s.type === 'pixelate')) {
            const basePath = tempPath();
            try {
                writeBytes(basePath, png.bytes);
                base = {surface: Cairo.ImageSurface.createFromPNG(basePath), x, y, scale};
            } finally {
                GLib.unlink(basePath);
            }
        }

        const layer = new Cairo.ImageSurface(Cairo.Format.ARGB32, pixbuf.width, pixbuf.height);
        const cr = new Cairo.Context(layer);
        // The crop was truncated to whole pixels, so match that exactly.
        cr.translate(-Math.trunc(x * scale), -Math.trunc(y * scale));
        cr.scale(scale, scale);
        for (const shape of shapes)
            drawShape(cr, shape, base);
        cr.$dispose();
        layer.writeToPNG(layerPath);
        layer.finish();
        base?.surface.finish();

        const annotations = await loadPixbuf(layerPath);
        annotations.composite(pixbuf,
            0, 0, pixbuf.width, pixbuf.height,
            0, 0, 1, 1,
            GdkPixbuf.InterpType.NEAREST, 255);

        return {bytes: await encodePng(pixbuf), pixbuf};
    } finally {
        GLib.unlink(layerPath);
    }
}

function saveRecent(file) {
    const recent = GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']);
    const uri = file.get_uri();
    const bookmarks = new GLib.BookmarkFile();
    try {
        bookmarks.load_from_file(recent);
    } catch (e) {
        if (!e.matches(GLib.FileError, GLib.FileError.NOENT)) {
            console.warn(`screenshot-plus: cannot read recent files: ${e.message}`);
            return;
        }
    }
    try {
        bookmarks.add_application(uri, GLib.get_prgname(), 'gio open %u');
        bookmarks.to_file(recent);
    } catch (e) {
        console.warn(`screenshot-plus: cannot update recent files: ${e.message}`);
    }
}

function saveToDisk(bytes, time) {
    const dir = Gio.File.new_for_path(GLib.build_filenamev([
        GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir(),
        _('Screenshots'),
    ]));
    try {
        dir.make_directory_with_parents(null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw e;
    }

    const name = _('Screenshot From %s').format(time.format('%Y-%m-%d %H-%M-%S'));
    for (let i = 0; ; i++) {
        const suffix = i === 0 ? '' : `-${i}`;
        const file = dir.get_child(`${name}${suffix}.png`);
        let stream;
        try {
            stream = file.create(Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                continue;
            throw e;
        }
        try {
            writeAll(stream, bytes);
        } catch (e) {
            // Disk full and the like: no half-written screenshot left behind.
            file.delete(null);
            throw e;
        }
        saveRecent(file);
        return file;
    }
}

let notificationSource = null;

function getSource() {
    if (!notificationSource) {
        notificationSource = new MessageTray.Source({
            title: t('notify.source'),
            iconName: 'screenshooter-symbolic',
        });
        notificationSource.connect('destroy', () => {
            notificationSource = null;
        });
        Main.messageTray.add(notificationSource);
    }
    return notificationSource;
}

function notify(pixbuf, file, copied, time) {
    const coglContext = global.stage.context.get_backend().get_cogl_context();
    const content = St.ImageContent.new_with_preferred_size(pixbuf.width, pixbuf.height);
    content.set_bytes(
        coglContext,
        pixbuf.read_pixel_bytes(),
        pixbuf.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
        pixbuf.width,
        pixbuf.height,
        pixbuf.rowstride);

    const notification = new MessageTray.Notification({
        source: getSource(),
        title: t('notify.title'),
        body: copied
            ? t('notify.paste')
            : file.get_basename(),
        datetime: time,
        gicon: content,
        isTransient: true,
    });

    if (file)
        addFileActions(notification, file);

    getSource().addNotification(notification);
}

// Opens the folder with the file selected, like "Show in Folder" in Files, and
// falls back to just the folder when no file manager answers that.
function showInFiles(file) {
    Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1', 'ShowItems',
        new GLib.Variant('(ass)', [[file.get_uri()], '']),
        null, Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
            try {
                connection.call_finish(result);
            } catch (e) {
                console.debug(`screenshot-plus: ShowItems: ${e.message}`);
                const app = Gio.app_info_get_default_for_type('inode/directory', false);
                app?.launch([file.get_parent()], global.create_app_launch_context(0, -1));
            }
        });
}

function addFileActions(notification, file) {
    notification.addAction(t('notify.showInFiles'), () => showInFiles(file));
    notification.connect('activated', () => {
        try {
            Gio.app_info_launch_default_for_uri(
                file.get_uri(), global.create_app_launch_context(0, -1));
        } catch (e) {
            logError(e, `screenshot-plus: cannot open ${file.get_path()}`);
        }
        Main.overview.hide();
        Main.panel.closeCalendar();
    });
}

// After a recording. GNOME's own notice disappears from the list after a few
// seconds; this one stays until dismissed, so the video is easy to find again.
export function notifyRecording(title, path) {
    const file = Gio.File.new_for_path(path);
    const notification = new MessageTray.Notification({
        source: getSource(),
        title,
        body: `${file.get_basename()}\n${t('notify.video')}`,
        isTransient: false,
    });
    addFileActions(notification, file);
    getSource().addNotification(notification);
}

export function destroyNotificationSource() {
    notificationSource?.destroy();
    notificationSource = null;
}

// Part one. Keys and the pointer stay live, so everything that decides what the file
// contains is fixed here: a stray key must not drop the pixelation from a screenshot
// about to be shared. Returns null when there is nothing to capture.
export function beginExport(ui, shapes) {
    const annotations = shapes.length > 0 && !ui._windowButton.checked
        ? {
            shapes: [...shapes],
            origin: ui._getSelectedGeometry(false),
            scale: ui._scale,
        }
        : null;

    const capture = startCapture(ui);
    if (!capture)
        return null;

    global.display.get_sound_player().play_from_theme(
        'screen-capture', _('Screenshot taken'), null);

    return {capture, annotations};
}

// Part two. With `rescue`, a failed save still leaves the image on the clipboard: the
// UI is already closed by then, and this is the only copy of the drawing there is.
export async function finishExport(ui, job, {copy, save, rescue = false}) {
    const png = await job.capture;
    const result = job.annotations ? await burnAnnotations(png, job.annotations) : png;

    const time = GLib.DateTime.new_now_local();
    const lockdown = new Gio.Settings({schema_id: 'org.gnome.desktop.lockdown'});

    let file = null;
    let saveError = null;
    if (save && !lockdown.get_boolean('disable-save-to-disk')) {
        try {
            file = saveToDisk(result.bytes, time);
        } catch (e) {
            if (!rescue)
                throw e;
            saveError = e;
        }
    }

    if (copy || saveError) {
        St.Clipboard.get_default().set_content(
            St.ClipboardType.CLIPBOARD, 'image/png', result.bytes);
    }

    if (saveError) {
        logError(saveError, 'screenshot-plus: save failed');
        Main.notifyError(
            t('error.saveClipboard'),
            saveError.message);
    } else if (file || copy) {
        notify(result.pixbuf, file, copy, time);
    }

    // Keeps the screenshot portal working: it waits on this signal for the file.
    if (file)
        ui.emit('screenshot-taken', file);
}

// Captures part of the frozen screen, [x, y, w, h] in stage coordinates, for the
// pixelate preview.
export async function captureBase(ui, [lx, ly, lw, lh]) {
    const content = ui._stageScreenshot.get_content();
    if (!content)
        return null;

    const scale = ui._scale;
    const png = await compositePng(content.get_texture(),
        lx * scale, ly * scale, lw * scale, lh * scale, scale, {
        texture: null,
        x: 0,
        y: 0,
        scale: 1,
    });

    const path = tempPath();
    try {
        writeBytes(path, png.bytes);
        return {
            surface: Cairo.ImageSurface.createFromPNG(path),
            x: lx,
            y: ly,
            scale,
        };
    } finally {
        GLib.unlink(path);
    }
}
