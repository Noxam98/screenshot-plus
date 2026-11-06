// The microphone part of a recording: noise suppression, a gentle automatic gain
// for quiet microphones, a limiter, then AAC. Kept apart from recorder.js so it can
// be tested on a file. Needs Gst initialised.

import Gst from 'gi://Gst?version=1.0';

// Mono AAC, which every player handles.
const AUDIO_BITRATE = 128000;

// Peaks are measured before the gain, every LEVEL_INTERVAL. Anything louder than
// SPEECH_DB counts as someone talking; after noise suppression the room is far
// below that. The gain brings speech peaks towards TARGET_DB, rising slowly and
// falling fast, and never adds more than MAX_GAIN_DB, so a dead input stays quiet.
const LEVEL_INTERVAL_NS = 200 * 1000 * 1000;
const SPEECH_DB = -55;
const TARGET_DB = -6;
const MAX_GAIN_DB = 20;
const RISE_DB = 1;
const FALL_DB = 4;
const ENVELOPE_DECAY_DB = 0.2;

function voiceProcessing() {
    if (!Gst.ElementFactory.find('webrtcdsp'))
        return '';
    // Its own gain control barely moves quiet speech, so only the cleaning is used.
    return `webrtcdsp echo-cancel=false gain-control=false
            noise-suppression=true noise-suppression-level=moderate
            high-pass-filter=true !`;
}

function aacEncoder() {
    return Gst.ElementFactory.find('fdkaacenc')
        ? `fdkaacenc rate-control=cbr bitrate=${AUDIO_BITRATE}`
        : `avenc_aac bitrate=${AUDIO_BITRATE}`;
}

// From raw microphone audio to AAC. `source` ends without a link.
export function microphoneChain(source) {
    return `${source} !
        queue !
        audioconvert !
        audioresample !
        audio/x-raw,format=S16LE,channels=1,rate=48000 !
        ${voiceProcessing()}
        level name=micmeter interval=${LEVEL_INTERVAL_NS} post-messages=true !
        volume name=micgain !
        audiodynamic mode=compressor characteristics=hard-knee threshold=0.7 ratio=0.1 !
        audioconvert !
        ${aacEncoder()} !
        aacparse`;
}

// Turns the meter's readings into the gain. Feed it every element message.
export class MicrophoneGain {
    constructor(pipeline) {
        this._volume = pipeline.get_by_name('micgain');
        this._gainDb = 0;
        this._envelope = null;
    }

    handle(message) {
        if (!this._volume || message.type !== Gst.MessageType.ELEMENT)
            return;
        const structure = message.get_structure();
        if (structure?.get_name() !== 'level')
            return;
        // A GValueArray, one peak per channel.
        const peaks = structure.get_value('peak');
        let peak = -Infinity;
        for (let i = 0; i < peaks.n_values; i++)
            peak = Math.max(peak, peaks.get_nth(i));
        this.update(peak);
    }

    update(peakDb) {
        if (peakDb > SPEECH_DB) {
            this._envelope = this._envelope === null
                ? peakDb : Math.max(peakDb, this._envelope - ENVELOPE_DECAY_DB);
        }
        if (this._envelope === null)
            return;

        const wanted = Math.min(MAX_GAIN_DB, Math.max(0, TARGET_DB - this._envelope));
        const change = wanted - this._gainDb;
        this._gainDb += change > 0 ? Math.min(change, RISE_DB) : Math.max(change, -FALL_DB);
        this._volume.volume = 10 ** (this._gainDb / 20);
    }

    get gainDb() {
        return this._gainDb;
    }
}
