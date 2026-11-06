// Standalone screen recorder, run by the extension as `gjs -m recorder.js '<json>'`.
//
// GNOME's own recorder can only hand custom pipelines frames in system memory,
// so this process talks to Mutter's ScreenCast API directly. It lives outside
// the compositor so that a crashing encoder cannot take the session down.
//
// Protocol, one line each:
//   stdout  started <pipeline-id> <path>   recording is running
//           failed <message>               no pipeline could start
//           error <message>                recording died after starting
//           stopped                        file finalised, about to exit
//   stdin   any line, or EOF, stops recording. EOF also covers the shell dying.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GioUnix from 'gi://GioUnix';
import Gst from 'gi://Gst?version=1.0';
import {programArgs, exit} from 'system';

const ScreenCastIface = `<node>
  <interface name="org.gnome.Mutter.ScreenCast">
    <method name="CreateSession">
      <arg name="properties" type="a{sv}" direction="in"/>
      <arg name="session_path" type="o" direction="out"/>
    </method>
  </interface>
</node>`;

const SessionIface = `<node>
  <interface name="org.gnome.Mutter.ScreenCast.Session">
    <method name="Start"/>
    <method name="Stop"/>
    <signal name="Closed"/>
    <method name="RecordArea">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
      <arg name="width" type="i" direction="in"/>
      <arg name="height" type="i" direction="in"/>
      <arg name="properties" type="a{sv}" direction="in"/>
      <arg name="stream_path" type="o" direction="out"/>
    </method>
  </interface>
</node>`;

const StreamIface = `<node>
  <interface name="org.gnome.Mutter.ScreenCast.Stream">
    <signal name="PipeWireStreamAdded">
      <arg name="node_id" type="u"/>
    </signal>
  </interface>
</node>`;

const ScreenCastProxy = Gio.DBusProxy.makeProxyWrapper(ScreenCastIface);
const SessionProxy = Gio.DBusProxy.makeProxyWrapper(SessionIface);
const StreamProxy = Gio.DBusProxy.makeProxyWrapper(StreamIface);

const MUTTER_BUS_NAME = 'org.gnome.Mutter.ScreenCast';
const FRAMERATE = 30;
const CAPS_POLL_MS = 20;
const CAPS_TIMEOUT_MS = 2000;
const START_TIMEOUT_SECONDS = 3;

const MP4_TAIL =
    'mp4mux fragment-duration=500 fragment-mode=first-moov-then-finalise';

// Measured on Hawk Point's VCN 4: any other size gains black padding that
// cannot be cropped afterwards (1920x1080 comes out as 1920x1082).
export function amdFitsExactly(width, height) {
    return width >= 128 && height >= 128 &&
        width % 64 === 0 && height % 16 === 0;
}

// The first pipeline that starts wins. Only the AMD one avoids copying frames
// through system memory, because GNOME composites on the AMD GPU. An empty list
// (very small areas, which NVENC rejects) sends the shell to GNOME's recorder.
export function candidates(width, height) {
    const list = [];

    if (amdFitsExactly(width, height)) {
        list.push({
            id: 'amd-av1-dmabuf',
            needsExactFit: true,
            pipeline: `capsfilter caps=video/x-raw(memory:DMABuf),format=DMA_DRM,max-framerate=${FRAMERATE}/1 !
                vapostproc !
                vaav1enc target-usage=1 rate-control=cqp qp=118 !
                queue !
                av1parse !
                ${MP4_TAIL}`,
        });
    }

    // Odd sizes would otherwise be padded by one pixel.
    const crop = width % 2 || height % 2
        ? `videocrop right=${width % 2} bottom=${height % 2} !` : '';

    if (Math.min(width, height) >= 200) {
        list.push({
            id: 'nvenc-av1',
            pipeline: `capsfilter caps=video/x-raw,max-framerate=${FRAMERATE}/1 !
                ${crop}
                queue !
                nvav1enc preset=p4 tune=high-quality rc-mode=vbr bitrate=0 const-quality=30 !
                av1parse !
                ${MP4_TAIL}`,
        });
    }

    return list;
}

const State = {
    STARTING: 'starting',
    PLAYING: 'playing',
    FLUSHING: 'flushing',
    DONE: 'done',
};

class Recorder {
    constructor(request, loop) {
        this._request = request;
        this._loop = loop;
        this._state = State.STARTING;
        this._pipeline = null;
        this._current = null;
        this._queue = [];
        this._sessionActive = false;
        this._capsTimer = 0;
        this._flushTimer = 0;
        this._startTimer = 0;

        const {x, y, width, height, scale} = request;
        this._expected = [Math.round(width * scale), Math.round(height * scale)];
        this._queue = candidates(...this._expected);
        this._area = [x, y, width, height];
    }

    start() {
        if (this._queue.length === 0)
            throw new Error('area too small for the AV1 encoders');

        const parent = GLib.path_get_dirname(this._request.path);
        GLib.mkdir_with_parents(parent, 0o755);

        const screenCast = new ScreenCastProxy(
            Gio.DBus.session, MUTTER_BUS_NAME, '/org/gnome/Mutter/ScreenCast');
        const [sessionPath] = screenCast.CreateSessionSync({});

        this._session = new SessionProxy(
            Gio.DBus.session, MUTTER_BUS_NAME, sessionPath);
        this._session.connectSignal('Closed', () => this._onSessionClosed());

        const [streamPath] = this._session.RecordAreaSync(...this._area, {
            'is-recording': GLib.Variant.new('b', true),
            'cursor-mode': GLib.Variant.new('u', this._request.drawCursor ? 1 : 0),
        });

        this._stream = new StreamProxy(
            Gio.DBus.session, MUTTER_BUS_NAME, streamPath);
        this._stream.connectSignal('PipeWireStreamAdded', (_p, _s, [nodeId]) => {
            this._nodeId = nodeId;
            this._tryNext();
        });

        this._session.StartSync();
        this._sessionActive = true;
    }

    stop() {
        if (this._state === State.DONE || this._state === State.FLUSHING)
            return;

        if (this._state !== State.PLAYING) {
            this._finish('failed stopped before starting', 1);
            return;
        }

        this._state = State.FLUSHING;
        this._pipeline.send_event(Gst.Event.new_eos());

        // Never leave the file unfinalised forever if EOS gets stuck.
        this._flushTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
            this._flushTimer = 0;
            this._finish('error flush timed out', 1);
            return GLib.SOURCE_REMOVE;
        });
    }

    _tryNext(reason = null) {
        if (reason)
            printerr(`${this._current?.id} did not start: ${reason}`);

        this._teardownPipeline();
        GLib.unlink(this._request.path);

        this._current = this._queue.shift() ?? null;
        if (!this._current) {
            this._finish(`failed no pipeline could start: ${reason}`, 1);
            return;
        }

        const description = `pipewiresrc name=src path=${this._nodeId}
                do-timestamp=true keepalive-time=1000 resend-last=true !
            ${this._current.pipeline} !
            filesink location="${this._request.path}"`;

        try {
            this._pipeline = Gst.parse_launch_full(
                description, null, Gst.ParseFlags.FATAL_ERRORS);
        } catch (e) {
            this._tryNext(e.message);
            return;
        }

        const bus = this._pipeline.get_bus();
        bus.add_signal_watch();
        bus.connect('message', (_b, message) => this._onMessage(message));

        // A pipeline that hangs must not hold up the next one.
        this._startTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, START_TIMEOUT_SECONDS, () => {
            this._startTimer = 0;
            this._tryNext('timed out');
            return GLib.SOURCE_REMOVE;
        });

        if (this._pipeline.set_state(Gst.State.PLAYING) === Gst.StateChangeReturn.FAILURE)
            this._tryNext('could not start playing');
    }

    _onMessage(message) {
        switch (message.type) {
        case Gst.MessageType.STATE_CHANGED: {
            if (message.src !== this._pipeline || this._state !== State.STARTING)
                break;
            const [, newState] = message.parse_state_changed();
            if (newState === Gst.State.PLAYING)
                this._confirmStart();
            break;
        }
        case Gst.MessageType.EOS:
            if (this._state === State.FLUSHING)
                this._finish('stopped', 0);
            else if (this._state === State.STARTING)
                this._tryNext('unexpected EOS');
            else
                this._finish('error unexpected end of stream', 1);
            break;
        case Gst.MessageType.ERROR: {
            const [error] = message.parse_error();
            if (this._state === State.STARTING)
                this._tryNext(error.message);
            else
                this._finish(`error ${error.message}`, 1);
            break;
        }
        }
    }

    // The expected size is computed by the shell. A wrong guess on the AMD path
    // would silently add black padding, so check it against the real stream.
    _confirmStart() {
        if (!this._current.needsExactFit) {
            this._reportStarted();
            return;
        }

        let waited = 0;
        const src = this._pipeline.get_by_name('src').get_static_pad('src');
        this._capsTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CAPS_POLL_MS, () => {
            waited += CAPS_POLL_MS;
            const structure = src.get_current_caps()?.get_structure(0);
            if (structure) {
                this._capsTimer = 0;
                const [, width] = structure.get_int('width');
                const [, height] = structure.get_int('height');
                if (amdFitsExactly(width, height))
                    this._reportStarted();
                else
                    this._tryNext(`stream is ${width}x${height}, would be padded`);
                return GLib.SOURCE_REMOVE;
            }
            if (waited >= CAPS_TIMEOUT_MS) {
                this._capsTimer = 0;
                this._tryNext('no frames arrived');
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _clearStartTimer() {
        if (this._startTimer) {
            GLib.source_remove(this._startTimer);
            this._startTimer = 0;
        }
    }

    _reportStarted() {
        this._clearStartTimer();
        this._state = State.PLAYING;
        print(`started ${this._current.id} ${this._request.path}`);
    }

    _onSessionClosed() {
        this._sessionActive = false;
        if (this._state !== State.DONE)
            this._finish('error screen cast session closed', 1);
    }

    _teardownPipeline() {
        this._clearStartTimer();
        if (this._capsTimer) {
            GLib.source_remove(this._capsTimer);
            this._capsTimer = 0;
        }
        if (!this._pipeline)
            return;
        this._pipeline.get_bus().remove_signal_watch();
        this._pipeline.set_state(Gst.State.NULL);
        this._pipeline = null;
    }

    _finish(line, code) {
        if (this._state === State.DONE)
            return;
        this._state = State.DONE;

        if (this._flushTimer) {
            GLib.source_remove(this._flushTimer);
            this._flushTimer = 0;
        }
        this._teardownPipeline();

        if (this._sessionActive) {
            this._sessionActive = false;
            try {
                this._session.StopSync();
            } catch (e) {
                printerr(`could not stop session: ${e.message}`);
            }
        }

        // Nothing was recorded, so do not leave an empty file behind.
        if (line.startsWith('failed '))
            GLib.unlink(this._request.path);

        print(line);
        this._exitCode = code;
        this._loop.quit();
    }

    get exitCode() {
        return this._exitCode ?? 0;
    }
}

function watchStdin(recorder) {
    const stream = new Gio.DataInputStream({
        base_stream: new GioUnix.InputStream({fd: 0, close_fd: false}),
    });
    stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s, result) => {
        try {
            stream.read_line_finish(result);
        } catch (e) {
            printerr(`stdin: ${e.message}`);
        }
        // A line and EOF mean the same thing: stop now.
        recorder.stop();
    });
}

function main() {
    Gst.init(null);

    const loop = new GLib.MainLoop(null, false);
    const recorder = new Recorder(JSON.parse(programArgs[0]), loop);

    watchStdin(recorder);
    try {
        recorder.start();
    } catch (e) {
        print(`failed ${e.message}`);
        exit(1);
    }

    loop.run();
    exit(recorder.exitCode);
}

main();
