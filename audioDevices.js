// Which microphones have nothing plugged in, such as a headset jack with no
// headset. GNOME's mixer cannot tell "unplugged" from "unknown", so this asks the
// sound server (PipeWire, through its Pulse side) directly. Recording from such an
// input gives silence. Anything going wrong here just means no filtering.

import Gio from 'gi://Gio';

const COMMAND = ['pactl', '-f', 'json', 'list', 'sources'];

function launcher() {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    });
    // Port states are translated otherwise.
    launcher.setenv('LC_ALL', 'C', true);
    return launcher;
}

function parse(output) {
    const unplugged = new Set();
    for (const source of JSON.parse(output)) {
        const port = source.ports?.find(p => p.name === source.active_port);
        if (port?.availability === 'not available')
            unplugged.add(source.name);
    }
    return unplugged;
}

export function unpluggedSources() {
    return new Promise(resolve => {
        try {
            launcher().spawnv(COMMAND).communicate_utf8_async(null, null, (process, result) => {
                try {
                    const [, output] = process.communicate_utf8_finish(result);
                    resolve(parse(output));
                } catch (e) {
                    resolve(new Set());
                }
            });
        } catch (e) {
            resolve(new Set());
        }
    });
}

// For the preferences window, where waiting a moment is fine.
export function unpluggedSourcesSync() {
    try {
        const [, output] = launcher().spawnv(COMMAND).communicate_utf8(null, null);
        return parse(output);
    } catch (e) {
        return new Set();
    }
}
