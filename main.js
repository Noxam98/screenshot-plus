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
import {setLanguage, t} from './i18n.js';
import {MicPicker} from './micPicker.js';
import {RecorderClient} from './recorderClient.js';

const CODEC_LABELS = {av1: 'AV1', h264: 'H.264'};

export class ScreenshotPlus {
    constructor(path, settings) {
        this.path = path;
        this._settings = settings;
    }

    enable() {
        const ui = Main.screenshotUI;
        const settings = this._settings;
        setLanguage(settings.get_string('language'));

        this._annotator = new Annotator(ui, settings, this.path);
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

        // GNOME's shutter is loud and almost a second long. By default every
        // screenshot, including GNOME's own shortcuts, gets a short soft click
        // instead. Event sounds turned off in Settings still silence it.
        const click = Gio.File.new_for_path(
            GLib.build_filenamev([this.path, 'sounds', 'screenshot.wav']));
        this._injections.overrideMethod(Meta.SoundPlayer.prototype, 'play_from_theme',
            original => function (name, description, cancellable) {
                if (name !== 'screen-capture')
                    return original.call(this, name, description, cancellable);
                const sound = settings.get_string('screenshot-sound');
                if (sound === 'none')
                    return undefined;
                if (sound === 'soft' && click.query_exists(null))
                    return this.play_from_file(click, description, cancellable);
                return original.call(this, name, description, cancellable);
            });

        this._buildCodecButton(ui);
        this._announcePrefs();

        this._settingsSignals = [
            settings.connect('changed::language', () => {
                setLanguage(settings.get_string('language'));
                this._annotator.relabel();
                this._codecTooltip.text = t('codec.tooltip');
                this._micPicker.relabel();
                this._syncCodecButton();
                // Its title is fixed when made, so the next one is made anew.
                destroyNotificationSource();
            }),
            settings.connect('changed::video-codec', () => this._syncCodecButton()),
            settings.connect('changed::record-microphone', () => this._syncCodecButton()),
            settings.connect('changed::microphone-label', () => this._syncCodecButton()),
        ];
    }

    // GNOME checks for prefs.js once per session. When reload.sh brings in a
    // version that has one, the settings button would otherwise wait for the
    // next login.
    _announcePrefs() {
        const manager = Main.extensionManager;
        const extension = manager.getUuids().map(uuid => manager.lookup(uuid))
            .find(e => e?.path === this.path);
        if (!extension || extension.hasPrefs)
            return;
        if (!Gio.File.new_for_path(GLib.build_filenamev([this.path, 'prefs.js'])).query_exists(null))
            return;
        extension.hasPrefs = true;
        manager.emit('extension-state-changed', extension);
    }

    disable() {
        // Runs on logout and when turned off. It stays enabled on the lock screen
        // (see session-modes), so locking does not interrupt a recording.
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];

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
        this._syncCodecButton = sync;
        button.connect('clicked', () => {
            const next = this._settings.get_string('video-codec') === 'av1' ? 'h264' : 'av1';
            this._settings.set_string('video-codec', next);
        });
        ui._showPointerButtonContainer.insert_child_at_index(button, 0);

        this._codecTooltip = new Tooltip(button, {
            text: t('codec.tooltip'),
            style_class: 'screenshot-ui-tooltip',
            visible: false,
        });
        ui.add_child(this._codecTooltip);

        // The microphone, a toggle next to the native pointer one, styled like it.
        const mic = new St.Button({
            style_class: 'screenshot-ui-show-pointer-button',
            child: new St.Icon({icon_name: 'audio-input-microphone-symbolic'}),
            toggle_mode: true,
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        mic.connect('notify::checked', () => {
            if (mic.checked !== this._settings.get_boolean('record-microphone'))
                this._settings.set_boolean('record-microphone', mic.checked);
        });
        ui._showPointerButtonContainer.insert_child_at_index(mic, 1);
        this._micPicker = new MicPicker(ui, this._settings);
        ui._showPointerButtonContainer.insert_child_at_index(this._micPicker.button, 2);
        // The bottom row overlaps its parts instead of widening the panel, so
        // with more buttons the panel has to be made wider by hand.
        ui._panel.add_style_class_name('splus-panel');
        this._micTooltip = new Tooltip(mic, {
            style_class: 'screenshot-ui-tooltip',
            visible: false,
        });
        ui.add_child(this._micTooltip);
        this._micButton = mic;

        const syncAll = () => {
            sync();
            mic.checked = this._settings.get_boolean('record-microphone');
            mic.visible = ui._castButton.checked;
            this._micPicker.button.visible = ui._castButton.checked;
            if (!ui._castButton.checked)
                this._micPicker.close();
            // Which microphone, so that it is clear without opening the settings.
            const label = this._settings.get_string('microphone-device')
                ? this._settings.get_string('microphone-label') : '';
            this._micTooltip.text = label ? `${t('mic.tooltip')}: ${label}` : t('mic.tooltip');
        };
        this._syncCodecButton = syncAll;

        this._codecButton = button;
        this._codecSignal = [ui._castButton, ui._castButton.connect('notify::checked', syncAll)];
        syncAll();
    }

    _destroyCodecButton() {
        const [object, id] = this._codecSignal;
        object.disconnect(id);
        for (const tooltip of [this._codecTooltip, this._micTooltip]) {
            tooltip.close(); // Cancels its pending show timeout.
            tooltip.destroy();
        }
        Main.screenshotUI._panel.remove_style_class_name('splus-panel');
        this._micPicker.destroy();
        this._micPicker = null;
        this._codecButton.destroy();
        this._micButton.destroy();
        this._codecButton = null;
        this._micButton = null;
        this._codecTooltip = null;
        this._micTooltip = null;
    }
}
