// Preferences window: language, screenshot sound and recording codec.

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {LANGUAGE_CODES, languageName, setLanguage, systemLanguage, t} from './i18n.js';

const SOUNDS = ['soft', 'gnome', 'none'];
const SOUND_LABELS = ['prefs.soundSoft', 'prefs.soundGnome', 'prefs.soundNone'];
const CODECS = ['av1', 'h264'];

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

        let page = this._buildPage(settings);
        window.add(page);

        // The page itself is in the chosen language, so it is rebuilt when that
        // changes. Later, so the drop-down is not destroyed inside its own signal.
        const changed = settings.connect('changed::language', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                window.remove(page);
                page = this._buildPage(settings);
                window.add(page);
                return GLib.SOURCE_REMOVE;
            });
        });
        window.connect('close-request', () => {
            settings.disconnect(changed);
            return false;
        });
    }

    _buildPage(settings) {
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
        page.add(recording);

        return page;
    }
}
