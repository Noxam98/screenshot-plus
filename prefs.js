// Preferences window: language, screenshot sound and recording.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {unpluggedSourcesSync} from './audioDevices.js';
import {LANGUAGE_CODES, languageName, setLanguage, systemLanguage, t} from './i18n.js';

const SOUNDS = ['soft', 'gnome', 'none'];
const SOUND_LABELS = ['prefs.soundSoft', 'prefs.soundGnome', 'prefs.soundNone'];
const CODECS = ['av1', 'h264'];

// Microphones as PipeWire lists them: [node name, readable name]. Monitors of
// outputs are sinks there, so they do not show up, and inputs with nothing
// plugged in are left out.
function listMicrophones(monitor) {
    const unplugged = unpluggedSourcesSync();
    return monitor.get_devices().map(device => [
        device.get_properties()?.get_string('node.name') ?? null,
        device.display_name,
    ]).filter(([node]) => node && !unplugged.has(node));
}

// A drop-down row bound to a string key, one entry per value.
function choiceRow(settings, key, title, values, labels) {
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(labels),
        selected: Math.max(0, values.indexOf(settings.get_string(key))),
    });
    row.connect('notify::selected', () => {
        const value = values[row.selected];
        if (value !== undefined && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    return row;
}

export default class ScreenshotPlusPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Watched while the window is open, so a headset plugged in shows up.
        Gst.init(null);
        const monitor = new Gst.DeviceMonitor();
        monitor.add_filter('Audio/Source', null);
        monitor.start();

        let page = this._buildPage(settings, monitor);
        window.add(page);

        // The page itself is in the chosen language, so it is rebuilt when that
        // changes. Later, so the drop-down is not destroyed inside its own signal.
        let rebuildId = 0;
        const rebuild = () => {
            if (rebuildId)
                return;
            rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                rebuildId = 0;
                window.remove(page);
                page = this._buildPage(settings, monitor);
                window.add(page);
                return GLib.SOURCE_REMOVE;
            });
        };
        const changed = settings.connect('changed::language', rebuild);
        const bus = monitor.get_bus();
        bus.add_watch(GLib.PRIORITY_DEFAULT, (_bus, message) => {
            if (message.type === Gst.MessageType.DEVICE_ADDED ||
                message.type === Gst.MessageType.DEVICE_REMOVED)
                rebuild();
            return GLib.SOURCE_CONTINUE;
        });
        window.connect('close-request', () => {
            settings.disconnect(changed);
            bus.remove_watch();
            monitor.stop();
            if (rebuildId)
                GLib.source_remove(rebuildId);
            return false;
        });
    }

    _buildPage(settings, monitor) {
        setLanguage(settings.get_string('language'));

        const page = new Adw.PreferencesPage({
            title: t('prefs.general'),
            icon_name: 'preferences-system-symbolic',
        });

        const language = new Adw.PreferencesGroup({title: t('prefs.languageGroup')});
        language.add(choiceRow(settings, 'language', t('prefs.language'),
            ['system', ...LANGUAGE_CODES],
            [t('prefs.systemLanguage', languageName(systemLanguage())),
                ...LANGUAGE_CODES.map(languageName)]));
        page.add(language);

        const screenshots = new Adw.PreferencesGroup({title: t('prefs.screenshots')});
        screenshots.add(choiceRow(settings, 'screenshot-sound', t('prefs.sound'),
            SOUNDS, SOUND_LABELS.map(key => t(key))));
        page.add(screenshots);

        // Short names in the list, what they mean underneath.
        const recording = new Adw.PreferencesGroup({title: t('prefs.recording')});
        const codec = choiceRow(settings, 'video-codec', t('prefs.codec'), CODECS, ['AV1', 'H.264']);
        codec.subtitle = `${t('prefs.codecAv1')}\n${t('prefs.codecH264')}`;
        recording.add(codec);
        const microphone = new Adw.SwitchRow({
            title: t('prefs.microphone'),
            subtitle: t('prefs.microphoneHint'),
        });
        settings.bind('record-microphone', microphone, 'active', Gio.SettingsBindFlags.DEFAULT);
        recording.add(microphone);
        recording.add(this._microphoneRow(settings, monitor));
        const clicks = new Adw.SwitchRow({
            title: t('prefs.clicks'),
            subtitle: t('prefs.clicksHint'),
        });
        settings.bind('show-clicks', clicks, 'active', Gio.SettingsBindFlags.DEFAULT);
        recording.add(clicks);
        page.add(recording);

        return page;
    }

    // Default first, then every microphone. One that was chosen but is not
    // plugged in now stays in the list, so the choice is not lost.
    _microphoneRow(settings, monitor) {
        const devices = listMicrophones(monitor);
        const chosen = settings.get_string('microphone-device');
        if (chosen && !devices.some(([node]) => node === chosen)) {
            const label = settings.get_string('microphone-label') || chosen;
            devices.push([chosen, t('prefs.microphoneMissing', label)]);
        }
        const values = ['', ...devices.map(([node]) => node)];
        const labels = [t('prefs.microphoneDefault'), ...devices.map(([, label]) => label)];

        const row = new Adw.ComboRow({
            title: t('prefs.microphoneDevice'),
            model: Gtk.StringList.new(labels),
            selected: Math.max(0, values.indexOf(chosen)),
        });
        row.connect('notify::selected', () => {
            const node = values[row.selected];
            if (node === undefined || node === settings.get_string('microphone-device'))
                return;
            // A connected one gives its name; an unplugged one keeps the old name.
            const connected = listMicrophones(monitor).find(([n]) => n === node);
            if (!node || connected)
                settings.set_string('microphone-label', connected?.[1] ?? '');
            settings.set_string('microphone-device', node);
        });
        settings.bind('record-microphone', row, 'sensitive', Gio.SettingsBindFlags.GET);
        return row;
    }
}
