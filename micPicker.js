// A small arrow next to the microphone toggle in the recording panel. It opens a
// list of microphones, so the right one can be picked just before recording.
// The list is GNOME's own, the same as in the sound quick settings.

import Clutter from 'gi://Clutter';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import {Tooltip} from 'resource:///org/gnome/shell/ui/screenshot.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

import {t} from './i18n.js';

const MENU_GAP = 8;

export class MicPicker {
    constructor(ui, settings) {
        this._ui = ui;
        this._settings = settings;

        this.button = new St.Button({
            style_class: 'splus-mic-more',
            child: new St.Icon({icon_name: 'pan-up-symbolic', icon_size: 12}),
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.button.connect('clicked', () => {
            if (this._menu.visible)
                this.close();
            else
                this._open();
        });
        this._tooltip = new Tooltip(this.button, {
            text: t('prefs.microphoneDevice'),
            style_class: 'screenshot-ui-tooltip',
            visible: false,
        });
        ui.add_child(this._tooltip);

        this._menu = new St.BoxLayout({
            style_class: 'splus-mic-menu',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            visible: false,
        });
        ui.add_child(this._menu);

        // A press anywhere else closes it, and still does what it does there.
        this._pressId = ui.connect('captured-event', (_actor, event) => {
            if (this._menu.visible && event.type() === Clutter.EventType.BUTTON_PRESS) {
                const target = global.stage.get_event_actor(event);
                if (!target || (!this._menu.contains(target) && !this.button.contains(target)))
                    this.close();
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._visibleId = ui.connect('notify::visible', () => this.close());
    }

    relabel() {
        this._tooltip.text = t('prefs.microphoneDevice');
    }

    close() {
        this._menu.hide();
    }

    destroy() {
        this._ui.disconnect(this._pressId);
        this._ui.disconnect(this._visibleId);
        this._tooltip.close(); // Cancels its pending show timeout.
        this._tooltip.destroy();
        this._menu.destroy();
        this.button.destroy();
    }

    // [source name, readable name] for the default entry and every microphone.
    // GNOME's mixer leaves out the monitors of outputs.
    _microphones() {
        const control = Volume.getMixerControl();
        const fallback = control.get_default_source()?.get_description();
        const label = fallback
            ? `${t('prefs.microphoneDefault')} (${fallback})` : t('prefs.microphoneDefault');
        return [
            ['', label],
            ...control.get_sources().map(s => [s.get_name(), s.get_description()]),
        ];
    }

    _open() {
        this._menu.destroy_all_children();
        const chosen = this._settings.get_string('microphone-device');
        const recording = this._settings.get_boolean('record-microphone');

        for (const [name, label] of this._microphones()) {
            const box = new St.BoxLayout({style_class: 'splus-mic-item-box'});
            box.add_child(new St.Icon({
                icon_name: 'object-select-symbolic',
                icon_size: 16,
                opacity: recording && name === chosen ? 255 : 0,
            }));
            box.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
            const item = new St.Button({style_class: 'splus-mic-item', child: box, can_focus: false});
            item.connect('clicked', () => {
                // Picking a microphone means wanting it, so it also turns sound on.
                this._settings.set_string('microphone-label', name ? label : '');
                this._settings.set_string('microphone-device', name);
                this._settings.set_boolean('record-microphone', true);
                this.close();
            });
            this._menu.add_child(item);
        }

        // Above the arrow, right edges lined up, kept on the monitor.
        const [, , width, height] = this._menu.get_preferred_size();
        const [bx, by] = this.button.get_transformed_position();
        const [bw] = this.button.get_transformed_size();
        const [, panelY] = this._ui._panel.get_transformed_position();
        const monitor = global.display.get_monitor_geometry(
            global.display.get_monitor_index_for_rect(new Mtk.Rectangle({
                x: Math.round(bx), y: Math.round(by), width: 1, height: 1,
            })));
        const x = Math.min(Math.max(bx + bw - width, monitor.x + MENU_GAP),
            monitor.x + monitor.width - width - MENU_GAP);
        const y = Math.max(panelY - height - MENU_GAP, monitor.y + MENU_GAP);
        this._menu.set_position(Math.round(x), Math.round(y));
        this._ui.set_child_above_sibling(this._menu, null);
        this._menu.show();
    }
}
