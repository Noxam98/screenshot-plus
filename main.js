// The extension proper. extension.js loads this from a fresh copy on every enable.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ScreencastError, ScreencastErrors} from 'resource:///org/gnome/shell/misc/dbusErrors.js';
import {ScreenshotUI, Tooltip} from 'resource:///org/gnome/shell/ui/screenshot.js';

import {Annotator} from './annotator.js';
import {destroyNotificationSource} from './exporter.js';
import {RecorderClient} from './recorderClient.js';

const CODEC_LABELS = {av1: 'AV1', h264: 'H.264'};

export class ScreenshotPlus {
    constructor(path, settings) {
        this.path = path;
        this._settings = settings;
    }

    enable() {
        const ui = Main.screenshotUI;

        this._annotator = new Annotator(ui, this._settings, this.path);
        this._annotator.enable();

        const annotator = this._annotator;
        this._injections = new InjectionManager();
        this._injections.overrideMethod(ScreenshotUI.prototype, '_onCaptureButtonClicked',
            original => function () {
                return this._shotButton.checked
                    ? annotator.saveCopyAndClose()
                    : original.call(this);
            });

        const recorder = new RecorderClient(ui, this._settings, this.path);
        recorder.enable();
        this._recorder = recorder;

        // GNOME's recorder service exits when idle, and the UI reads that as a
        // crash if any recording is in progress. Ours does not depend on it.
        this._injections.overrideMethod(ScreenshotUI.prototype, '_screencastFailed',
            original => function (phase, error) {
                if (recorder.isRecording &&
                    error.matches(ScreencastErrors, ScreencastError.SERVICE_CRASH))
                    return;
                original.call(this, phase, error);
            });

        // GNOME's shutter is loud and almost a second long. Every screenshot,
        // including GNOME's own shortcuts, gets a short soft click instead. Event
        // sounds turned off in Settings still silence it.
        const click = Gio.File.new_for_path(
            GLib.build_filenamev([this.path, 'sounds', 'screenshot.wav']));
        this._injections.overrideMethod(Meta.SoundPlayer.prototype, 'play_from_theme',
            original => function (name, description, cancellable) {
                if (name === 'screen-capture' && click.query_exists(null))
                    return this.play_from_file(click, description, cancellable);
                return original.call(this, name, description, cancellable);
            });

        this._buildCodecButton(ui);
    }

    disable() {
        // Runs on logout and when turned off. It stays enabled on the lock screen
        // (see session-modes), so locking does not interrupt a recording.
        this._recorder.disable();
        this._recorder = null;

        this._injections.clear();
        this._injections = null;

        this._annotator.destroy();
        this._annotator = null;

        this._destroyCodecButton();
        destroyNotificationSource();
        this._settings = null;
    }

    // AV1 is the default. H.264 is GNOME's own recorder, for sending a video to
    // someone whose device cannot play AV1.
    _buildCodecButton(ui) {
        const button = new St.Button({
            style_class: 'splus-codec',
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        const sync = () => {
            button.label = CODEC_LABELS[this._settings.get_string('video-codec')] ?? 'AV1';
            button.visible = ui._castButton.checked;
        };
        button.connect('clicked', () => {
            const next = this._settings.get_string('video-codec') === 'av1' ? 'h264' : 'av1';
            this._settings.set_string('video-codec', next);
            sync();
        });
        ui._showPointerButtonContainer.insert_child_at_index(button, 0);

        this._codecTooltip = new Tooltip(button, {
            text: 'Кодек записи: AV1 или H.264 для совместимости',
            style_class: 'screenshot-ui-tooltip',
            visible: false,
        });
        ui.add_child(this._codecTooltip);

        this._codecButton = button;
        this._codecSignal = [ui._castButton, ui._castButton.connect('notify::checked', sync)];
        sync();
    }

    _destroyCodecButton() {
        const [object, id] = this._codecSignal;
        object.disconnect(id);
        this._codecTooltip.close(); // Cancels its pending show timeout.
        this._codecTooltip.destroy();
        this._codecButton.destroy();
        this._codecButton = null;
        this._codecTooltip = null;
    }
}
