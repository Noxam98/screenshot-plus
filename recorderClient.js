// Shell side of the recorder. It intercepts the three calls ScreenshotUI makes on
// its D-Bus proxy, so the native UI, panel indicator and notifications all keep
// working while the frames go to our own process. Anything that goes wrong at
// startup falls back to GNOME's recorder, so recording never just stops working.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {t} from './i18n.js';

const SCREENCAST_PHASE_RECORDING = 'RECORDING';
const SPAWN_TIMEOUT_SECONDS = 10;
// Longer than the recorder's own 10 s flush limit, so that one normally wins.
const STOP_TIMEOUT_SECONDS = 15;

// Same expansion as GNOME's recorder, including its folder under ~/Videos.
function expandTemplate(template) {
    const now = GLib.DateTime.new_now_local();
    const name = template
        .replace(/%d/g, now.format('%Y-%m-%d'))
        .replace(/%t/g, now.format('%H-%M-%S'))
        .replace(/%%/g, '%');

    if (GLib.path_is_absolute(name))
        return `${name}.mp4`;

    const videos = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ||
        GLib.get_home_dir();
    return `${GLib.build_filenamev([videos, name])}.mp4`;
}

function overlaps(layout, x, y, width, height) {
    return x < layout.x + layout.width && layout.x < x + width &&
        y < layout.y + layout.height && layout.y < y + height;
}

// The largest scale of any monitor the area touches, which is what Mutter
// records at. Spanning monitors therefore upscales the lower-scale one, exactly
// as GNOME's own recorder does.
function scaleForArea(x, y, width, height) {
    let scale = 0;
    for (const view of global.stage.peek_stage_views()) {
        const layout = new Mtk.Rectangle();
        view.get_layout(layout);
        if (overlaps(layout, x, y, width, height))
            scale = Math.max(scale, view.get_scale());
    }
    return scale || 1;
}

function addToRecent(path) {
    const recent = GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']);
    const uri = Gio.File.new_for_path(path).get_uri();
    const bookmarks = new GLib.BookmarkFile();
    try {
        try {
            bookmarks.load_from_file(recent);
        } catch (e) {
            if (!e.matches(GLib.FileError, GLib.FileError.NOENT))
                throw e;
        }
        bookmarks.add_application(uri, GLib.get_prgname(), 'gio open %u');
        bookmarks.to_file(recent);
    } catch (e) {
        console.warn(`screenshot-plus: cannot update recent files: ${e.message}`);
    }
}

// A recorder killed in its first moments leaves a 0-byte file nobody can use.
function removeIfEmpty(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_size() === 0)
            file.delete(null);
    } catch (e) {
        console.debug(`screenshot-plus: ${path}: ${e.message}`);
    }
}

// One recorder process and everything about it. Nothing is shared between
// processes, because a new recording may start while the last one still flushes.
// End of stdout is the one place a process is declared finished, so every pending
// promise resolves there no matter how the process went away.
class RecorderProcess {
    constructor(script, request, {onDied, onEnded}) {
        this._script = script;
        this._request = request;
        this._onDied = onDied;
        this._onEnded = onEnded;

        this.starting = false;
        this.stopRequested = false;
        this.path = null;

        this._ended = false;
        this._stopped = false;
        this._failure = null;
        this._timer = 0;
        this._stopPromise = null;
        this._resolveStop = null;
    }

    start() {
        return new Promise((resolve, reject) => {
            this._process = Gio.Subprocess.new(
                ['gjs', '-m', this._script, JSON.stringify(this._request)],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
            this._stdin = this._process.get_stdin_pipe();
            this._stdout = new Gio.DataInputStream({
                base_stream: this._process.get_stdout_pipe(),
            });
            this._resolveStart = resolve;
            this._rejectStart = reject;
            this.starting = true;
            this._setKillTimer(SPAWN_TIMEOUT_SECONDS);
            this._readLine();
        });
    }

    stop() {
        if (this._stopPromise)
            return this._stopPromise;
        if (this._ended)
            return Promise.resolve([false]);

        this.stopRequested = true;
        this._stopPromise = new Promise(resolve => {
            this._resolveStop = resolve;
        });
        this._setKillTimer(STOP_TIMEOUT_SECONDS);
        try {
            this._stdin.write_all('stop\n', null);
        } catch (e) {
            // The process is gone. End of stdout resolves the promise.
            console.warn(`screenshot-plus: cannot reach recorder: ${e.message}`);
        }
        return this._stopPromise;
    }

    // Closing stdin would not help a process that is stuck.
    _setKillTimer(seconds) {
        this._clearTimer();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timer = 0;
            console.warn('screenshot-plus: recorder not responding, killing it');
            this._process.force_exit();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimer() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
    }

    _readLine() {
        this._stdout.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
            let line = null;
            try {
                [line] = stream.read_line_finish_utf8(result);
            } catch (e) {
                console.warn(`screenshot-plus: recorder output: ${e.message}`);
            }

            if (line === null) {
                this._onEndOfOutput();
                return;
            }
            this._onLine(line);
            this._readLine();
        });
    }

    // Libraries can print to stdout too. Only our own lines count.
    _onLine(line) {
        if (line.startsWith('started ') && this.starting) {
            const [, id, ...rest] = line.split(' ');
            this.id = id;
            this.path = rest.join(' ');
            this.starting = false;
            if (!this.stopRequested)
                this._clearTimer();
            console.log(`screenshot-plus: recording with ${id}`);
            this._resolveStart(this.path);
        } else if (line.startsWith('failed ') && this.starting) {
            this.starting = false;
            this._rejectStart(new Error(line));
        } else if (line === 'stopped') {
            this._stopped = true;
            this._resolveStop?.([true]);
        } else if (line.startsWith('error ')) {
            this._failure = line.replace(/^error /, '');
        }
    }

    _onEndOfOutput() {
        this._ended = true;
        this._clearTimer();
        try {
            this._stdin.close(null);
        } catch (e) {
            console.debug(`screenshot-plus: closing stdin: ${e.message}`);
        }

        if (this.starting) {
            this.starting = false;
            this._rejectStart(new Error('recorder exited before starting'));
        }

        if (this.path) {
            if (this._stopped)
                addToRecent(this.path);
            else
                removeIfEmpty(this.path);
        }

        this._resolveStop?.([this._stopped]);
        this._onEnded();

        if (!this.stopRequested && !this._stopped && this.path)
            this._onDied(this._failure ?? 'recorder exited unexpectedly');
    }
}

export class RecorderClient {
    constructor(ui, settings, extensionPath) {
        this._ui = ui;
        this._settings = settings;
        this._script = GLib.build_filenamev([extensionPath, 'recorder.js']);
        this._current = null;
    }

    enable() {
        const proxy = this._ui._screencastProxy;
        this._native = {
            area: proxy.ScreencastAreaAsync,
            full: proxy.ScreencastAsync,
            stop: proxy.StopScreencastAsync,
        };

        proxy.ScreencastAreaAsync = (x, y, w, h, template, options) =>
            this._start(x, y, w, h, template, options);
        proxy.ScreencastAsync = (template, options) => {
            const {width, height} = global.stage;
            return this._start(0, 0, width, height, template, options);
        };
        proxy.StopScreencastAsync = () => this._stop();

        // Whatever ended the recording as far as the UI knows, end the process.
        this._progressSignal = this._ui.connect('notify::screencast-in-progress', () => {
            if (!this._ui.screencast_in_progress && this.isRecording)
                this._current.stop();
        });
    }

    get isRecording() {
        return this._current !== null && !this._current.starting;
    }

    disable() {
        const proxy = this._ui._screencastProxy;
        this._ui.disconnect(this._progressSignal);

        // Restored first, so a quick re-enable cannot mistake our wrappers for
        // the native methods.
        proxy.ScreencastAreaAsync = this._native.area;
        proxy.ScreencastAsync = this._native.full;
        proxy.StopScreencastAsync = this._native.stop;

        // Never orphan a recording, even one still starting: finish the file.
        if (this._current) {
            if (!this._current.starting)
                this._ui._setScreencastInProgress(false);
            this._current.stop();
        }
    }

    async _start(x, y, width, height, template, options) {
        const native = () => this._native.area.call(
            this._ui._screencastProxy, x, y, width, height, template, options);

        // GNOME's recorder has no sound, so H.264 with the microphone is ours too.
        const codec = this._settings.get_string('video-codec') === 'av1' ? 'av1' : 'h264';
        const microphone = this._settings.get_boolean('record-microphone');
        if (codec === 'h264' && !microphone)
            return native();

        const process = new RecorderProcess(this._script, {
            x,
            y,
            width,
            height,
            scale: scaleForArea(x, y, width, height),
            drawCursor: options['draw-cursor']?.deepUnpack() ?? true,
            path: expandTemplate(template),
            codec,
            microphone,
        }, {
            onEnded: () => {
                const wasCurrent = this._current === process;
                if (wasCurrent)
                    this._current = null;
                // A stop that overtook the start leaves the UI thinking it records.
                if (wasCurrent && process.stopRequested && this._ui.screencast_in_progress)
                    this._ui._setScreencastInProgress(false);
            },
            onDied: message => {
                console.error(`screenshot-plus: recording failed: ${message}`);
                this._ui._screencastFailed(SCREENCAST_PHASE_RECORDING,
                    new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED, message));
            },
        });
        this._current = process;

        try {
            const path = await process.start();
            if (microphone && !process.id.endsWith('+mic'))
                Main.notify(t('mic.withoutSound'), '');
            return [true, path];
        } catch (e) {
            if (this._current === process)
                this._current = null;
            // The user pressed stop while we were starting. Starting GNOME's
            // recorder now would record something they just asked to end.
            if (process.stopRequested) {
                throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED,
                    'stopped while starting');
            }
            console.warn(`screenshot-plus: falling back to GNOME's recorder: ${e.message}`);
            if (microphone)
                Main.notify(t('mic.withoutSound'), '');
            return native();
        }
    }

    _stop() {
        if (this._current)
            return this._current.stop();
        return this._native.stop.call(this._ui._screencastProxy);
    }
}
