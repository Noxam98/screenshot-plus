// Picks the interface language: the one chosen in the preferences, else the
// system's when there is a translation for it, else English. Our own table rather
// than gettext, because gettext follows the whole shell's locale and the language
// here can be chosen apart from it.

import GLib from 'gi://GLib';

import {TRANSLATIONS} from './translations.js';

export const LANGUAGE_CODES = Object.keys(TRANSLATIONS);

// Nynorsk and plain "no" readers get Bokmål, the closest there is.
const ALIASES = {no: 'nb', nn: 'nb'};

let current = 'en';

export function languageName(code) {
    return TRANSLATIONS[code]?.name ?? code;
}

// The first of the user's preferred languages there is a translation for.
export function systemLanguage() {
    for (const name of GLib.get_language_names()) {
        const base = name.split(/[._@]/)[0];
        const code = ALIASES[base] ?? base;
        if (code in TRANSLATIONS)
            return code;
    }
    return 'en';
}

// `setting` is a language code, or 'system'.
export function setLanguage(setting) {
    current = setting in TRANSLATIONS ? setting : systemLanguage();
}

// The string for `key`, with {0}, {1}… replaced by the arguments.
export function t(key, ...args) {
    const text = TRANSLATIONS[current].strings[key] ?? TRANSLATIONS.en.strings[key] ?? key;
    return text.replace(/\{(\d)\}/g, (_match, index) => String(args[index]));
}
