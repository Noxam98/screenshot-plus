// Flameshot-style drawing layer and toolbar on top of GNOME's screenshot UI.
//
// Everything is added to the existing ScreenshotUI actor, so selection, the two
// monitor handling and the native panel keep working exactly as before. Shapes
// live in stage coordinates, which span all monitors.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Tooltip} from 'resource:///org/gnome/shell/ui/screenshot.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {beginExport, captureBase, finishExport} from './exporter.js';
import {t} from './i18n.js';
import {
    MAX_FONT,
    MAX_RADIUS,
    MAX_WIDTH,
    MIN_FONT,
    MIN_RADIUS,
    MIN_WIDTH,
    constrainEnd,
    drawShape,
    handlesOf,
    hitTest,
    moveCounterBadge,
    moveShape,
    overCounterBadge,
    parseColor,
    resizeShape,
    resizeTextAroundCenter,
    rotateAround,
    shapeBounds,
    shapeBox,
    textCenter,
    textCorners,
    withTip,
    textFont,
} from './shapes.js';
import {placeGroups} from './toolLayout.js';

const SELECT_TOOL = {id: 'select', icon: 'select', label: 'tool.select'};

// Order matches the digit keys 1 to 9.
const DRAW_TOOLS = [
    {id: 'pen', icon: 'pen', label: 'tool.pen'},
    {id: 'line', icon: 'line', label: 'tool.line'},
    {id: 'arrow', icon: 'arrow', label: 'tool.arrow'},
    {id: 'rect', icon: 'rect', label: 'tool.rect'},
    {id: 'ellipse', icon: 'ellipse', label: 'tool.ellipse'},
    {id: 'marker', icon: 'marker', label: 'tool.marker'},
    {id: 'text', icon: 'text', label: 'tool.text'},
    {id: 'pixelate', icon: 'pixelate', label: 'tool.pixelate'},
    {id: 'counter', icon: 'counter', label: 'tool.counter'},
];

const COLORS = [
    '#e01b24', '#ff7800', '#f6d32d', '#33d17a', '#3584e4',
    '#9141ac', '#e64ea0', '#ffffff', '#9a9996', '#000000',
];

const DEFAULT_TEXT_STYLE = {
    fontPx: 28,
    outlineColor: '#ffffff',
    outlineWidth: 2,
    bgColor: null,
    bgAlpha: 0.85,
    // Space around the letters, as a fraction of the font size.
    bgPadX: 0.3,
    bgPadY: 0.1,
};

// UIMode.SCREENSHOT_ONLY in screenshot.js, which does not export it.
const UI_MODE_SCREENSHOT_ONLY = 2;

const TOOLBAR_GAP = 8;
// Between the panels when they stand around the selection.
const GROUP_SPACING = 6;
const counterRadius = width => 10 + width * 2;
// A press and release this close together is a click, not a drag.
const CLICK_SLOP = 3;
const HINT_OFFSET = 18;
const HANDLE_RADIUS = 5;
const GRIP_RADIUS = 9;
const HANDLE_GRAB = 12;
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_PX = 6;
const UNDO_LIMIT = 200;
const SCROLL_UNDO_GAP_US = 800000;

// Every tool remembers its own width. Text has its own size instead.
const DEFAULT_WIDTHS = {
    pen: 3,
    line: 4,
    arrow: 4,
    rect: 4,
    ellipse: 4,
    marker: 4,
    pixelate: 4,
    counter: 4,
};
const WIDTH_SAVE_DELAY_MS = 500;

// Tools whose shapes can be filled, each remembering whether it fills.
const FILLABLE = new Set(['rect', 'ellipse']);

// Thin lines get most of the slider, since that is where most drawing happens.
const sliderOf = width => Math.sqrt((width - MIN_WIDTH) / (MAX_WIDTH - MIN_WIDTH));
const widthOf = value => MIN_WIDTH + value * value * (MAX_WIDTH - MIN_WIDTH);

// Physical key codes (evdev + 8), so shortcuts work on the Russian layout too.
const KEYCODE = {C: 54, F: 41, S: 39, V: 55, Y: 29, Z: 52};
const DIGIT_1_KEYCODE = 10;
const DIGIT_0_KEYCODE = 19;

const HANDLE_CURSORS = {
    nw: Clutter.CursorType.NW_RESIZE,
    ne: Clutter.CursorType.NE_RESIZE,
    sw: Clutter.CursorType.SW_RESIZE,
    se: Clutter.CursorType.SE_RESIZE,
    n: Clutter.CursorType.N_RESIZE,
    s: Clutter.CursorType.S_RESIZE,
    e: Clutter.CursorType.E_RESIZE,
    w: Clutter.CursorType.W_RESIZE,
    p1: Clutter.CursorType.CROSSHAIR,
    p2: Clutter.CursorType.CROSSHAIR,
    tip: Clutter.CursorType.CROSSHAIR,
    left: Clutter.CursorType.POINTER,
    right: Clutter.CursorType.POINTER,
    grip: Clutter.CursorType.MOVE,
};

function pointerOf(event) {
    const [x, y] = event.get_coords();
    const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
    return {x, y, shift};
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// The whole-pixel box around all of these [x, y, w, h], cut to the stage, or null.
function unionOf(boxes) {
    if (boxes.length === 0)
        return null;
    const left = Math.max(0, Math.floor(Math.min(...boxes.map(b => b[0]))));
    const top = Math.max(0, Math.floor(Math.min(...boxes.map(b => b[1]))));
    const right = Math.min(global.stage.width, Math.ceil(Math.max(...boxes.map(b => b[0] + b[2]))));
    const bottom = Math.min(global.stage.height, Math.ceil(Math.max(...boxes.map(b => b[1] + b[3]))));
    return right > left && bottom > top ? [left, top, right - left, bottom - top] : null;
}
const snapshotOf = shapes => shapes.map(shape => ({...shape}));

export class Annotator {
    constructor(ui, settings, extensionPath) {
        this._ui = ui;
        this._settings = settings;
        this._extensionPath = extensionPath;

        this._signals = [];
        this._shapes = [];
        this._undoStack = [];
        this._redoStack = [];
        this._current = null;
        this._selected = null;
        this._transform = null;
        this._textActor = null;
        this._textHolder = null;
        this._textEdit = null;
        this._tool = null;
        this._slot = 'text';
        this._dragGrab = null;
        this._base = null;
        this._baseRect = null;
        this._baseLoading = false;
        this._exporting = false;
        this._selectionDragging = false;
        this._selectionPress = null;
        this._panelTop = null;
        this._laterId = 0;
        this._scrollRemainder = 0;
        this._lastScrollUndo = 0;
        this._lastClick = null;
        this._movingTooltip = false;

        this._color = settings.get_string('tool-color');
        this._widths = {...DEFAULT_WIDTHS};
        for (const [tool, width] of Object.entries(settings.get_value('tool-widths').deepUnpack())) {
            if (tool in DEFAULT_WIDTHS)
                this._widths[tool] = clamp(width, MIN_WIDTH, MAX_WIDTH);
        }
        this._saveWidthsId = 0;
        this._syncingWidth = false;
        this._filled = new Set(settings.get_strv('filled-tools').filter(tool => FILLABLE.has(tool)));
        this._translations = [];
        this._textStyle = this._loadTextStyle();
    }

    enable() {
        this._buildCanvas();
        this._buildToolbar();
        this._stack();

        const ui = this._ui;
        this._connect(ui, 'notify::visible', () => this._onUiVisible());
        this._connect(ui, 'closed', () => this._reset());
        // Connected before GrabHelper's handler, which is added on every open,
        // so Escape can cancel text entry instead of closing the whole UI.
        this._connect(ui, 'captured-event', (_a, event) => this._onCapturedEvent(event));

        for (const button of [
            ui._selectionButton,
            ui._screenButton,
            ui._windowButton,
            ui._shotButton,
            ui._castButton,
        ])
            this._connect(button, 'notify::checked', () => this._sync());

        this._connect(ui._areaSelector, 'drag-started', () => {
            this._selectionDragging = true;
            this._sync();
        });
        this._connect(ui._areaSelector, 'drag-ended', () => {
            this._selectionDragging = false;
            this._keepSelectionOnClick();
            this._sync();
        });

        this._connect(this._settings, 'changed::tools-around-selection', () => {
            this._arrange();
            this._sync();
        });

        // The native handler rebuilds the per-monitor actors, which puts them
        // above ours. This one runs after it.
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            this._stack();
            // The native handler already destroyed the old selectors.
            this._screenSignals = [];
            this._watchScreenSelectors();
        });
        this._watchScreenSelectors();
    }

    destroy() {
        this._endDrag();
        this._discardText();
        // Before the later is removed, because this schedules one.
        this._setTool(null);
        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        }

        if (this._saveWidthsId) {
            GLib.source_remove(this._saveWidthsId);
            this._saveWidthsId = 0;
            this._saveWidths();
        }

        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        this._disconnectScreenSelectors();

        this._dropBase();
        this._catcher.destroy();
        this._drawing.destroy();
        this._hint.destroy();
        this._toolbar.destroy();
        for (const tooltip of this._tooltips) {
            tooltip.close(); // Cancels its pending show timeout.
            tooltip.destroy();
        }
    }

    // Enter and the round button.
    saveCopyAndClose() {
        return this._exportAndClose({copy: true, save: true});
    }

    _connect(object, signal, handler) {
        this._signals.push([object, object.connect(signal, handler)]);
    }

    _watchScreenSelectors() {
        this._disconnectScreenSelectors();
        this._screenSignals = this._ui._screenSelectors.map(selector =>
            [selector, selector.connect('notify::checked', () => this._sync())]);
    }

    _disconnectScreenSelectors() {
        for (const [selector, id] of this._screenSignals ?? [])
            selector.disconnect(id);
        this._screenSignals = [];
    }

    _loadTextStyle() {
        try {
            return {
                ...DEFAULT_TEXT_STYLE,
                ...JSON.parse(this._settings.get_string('text-style')),
            };
        } catch (e) {
            console.warn(`screenshot-plus: bad text style: ${e.message}`);
            return {...DEFAULT_TEXT_STYLE};
        }
    }

    _saveTextStyle() {
        this._settings.set_string('text-style', JSON.stringify(this._textStyle));
    }

    // ---- actors ----

    _buildCanvas() {
        // Spans the stage and takes the pointer for drawing. Strokes may wander
        // outside the selection; only what is inside it gets exported.
        this._catcher = new St.Widget({
            reactive: false,
            visible: false,
            x: 0,
            y: 0,
        });
        this._catcher.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));

        // The drawing itself sits below GNOME's shade, so whatever ends up outside
        // the selection is dimmed like the screen there, and stays in view while
        // the selection is dragged. Input still goes to the catcher above.
        this._drawing = new St.Widget({visible: false, x: 0, y: 0});
        this._drawing.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));

        this._committed = new St.DrawingArea({reactive: false, visible: false});
        this._committed.connect('repaint', area => this._repaintCommitted(area));
        this._drawing.add_child(this._committed);

        this._live = new St.DrawingArea({reactive: false, visible: false});
        this._live.connect('repaint', area => this._repaintLive(area));
        this._drawing.add_child(this._live);

        this._overlay = new St.DrawingArea({reactive: false, visible: false});
        this._overlay.connect('repaint', area => this._repaintOverlay(area));
        this._catcher.add_child(this._overlay);

        // Says so next to the pointer wherever a press would change the
        // selection instead of drawing.
        // On top of everything, the toolbar included, which often sits right
        // under a corner of the selection.
        this._hint = new St.Label({style_class: 'splus-cursor-hint', visible: false});
        this._catcher.connect('leave-event', () => {
            this._hint.hide();
            return Clutter.EVENT_PROPAGATE;
        });

        this._catcher.connect('button-press-event', (_a, e) => this._onPress(e));
        this._catcher.connect('motion-event', (_a, e) => this._onMotion(e));
        this._catcher.connect('button-release-event', (_a, e) => this._onRelease(e));
        this._catcher.connect('scroll-event', (_a, e) => this._onScroll(e));
        // During a drag the grab is on this actor, so keys land here and never
        // reach the handler on the UI.
        this._catcher.connect('key-press-event', (_a, e) => {
            if (this._dragGrab && e.get_key_symbol() === Clutter.KEY_Escape)
                this._cancelDrag();
            return this._dragGrab ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        });

        this._ui.add_child(this._catcher);
        this._ui.insert_child_below(this._drawing, this._ui._areaSelector);
        this._ui.add_child(this._hint);
    }

    _icon(name) {
        return new St.Icon({
            gicon: Gio.icon_new_for_string(
                `${this._extensionPath}/icons/splus-${name}-symbolic.svg`),
            icon_size: 16,
        });
    }

    // Sets a text now and again whenever the language changes.
    _translate(apply) {
        apply();
        this._translations.push(apply);
    }

    // The language was changed in the preferences.
    relabel() {
        for (const apply of this._translations)
            apply();
        this._schedulePlacement();
    }

    _addTooltip(widget, key) {
        const tooltip = new Tooltip(widget, {
            style_class: 'screenshot-ui-tooltip',
            visible: false,
        });
        this._translate(() => {
            tooltip.text = t(key);
        });
        // GNOME puts it above the button, which in a column is the button above.
        for (const property of ['notify::x', 'notify::y'])
            tooltip.connect(property, () => this._besideInColumn(tooltip, widget));
        this._ui.add_child(tooltip);
        this._tooltips.push(tooltip);
    }

    // Beside the column instead, on the side away from the selection while
    // the stage has room there.
    _besideInColumn(tooltip, widget) {
        const box = widget.get_parent();
        if (this._movingTooltip || !(box instanceof St.BoxLayout) ||
            box.orientation !== Clutter.Orientation.VERTICAL)
            return;
        const panel = [this._toolPanel, this._actionPanel].find(p => p.contains(widget));
        if (!panel)
            return;
        const [panelX] = panel.get_transformed_position();
        const [panelWidth] = panel.get_transformed_size();
        const [, y] = widget.get_transformed_position();
        const [, height] = widget.get_transformed_size();

        const right = panelX + panelWidth + GROUP_SPACING;
        const left = panelX - GROUP_SPACING - tooltip.width;
        const rect = this._selection();
        const outwardLeft = rect && panelX + panelWidth / 2 < rect[0] + rect[2] / 2;
        const x = outwardLeft
            ? (left >= 0 ? left : right)
            : (right + tooltip.width <= global.stage.width ? right : left);

        this._movingTooltip = true;
        tooltip.set_position(Math.round(x), Math.round(y + (height - tooltip.height) / 2));
        this._movingTooltip = false;
    }

    _toolButton(icon, label, onClick, styleClass = 'splus-tool') {
        const button = new St.Button({
            style_class: styleClass,
            child: this._icon(icon),
            can_focus: false,
        });
        button.connect('clicked', onClick);
        this._addTooltip(button, label);
        return button;
    }

    _separator() {
        return new St.Widget({style_class: 'splus-separator', y_expand: true});
    }

    // Columns for the right and the left of the selection, rows otherwise. A
    // separator in a column lies across it.
    _setUpright(boxes, separators, upright) {
        for (const box of boxes) {
            box.orientation = upright
                ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
        }
        for (const separator of separators) {
            separator.style_class = upright ? 'splus-separator-across' : 'splus-separator';
            separator.y_expand = !upright;
        }
        // A box turning does not reach the sizes its parents keep, so the
        // panel around it would stay the old shape.
        for (const box of boxes) {
            for (let actor = box; actor && actor !== this._toolbar; actor = actor.get_parent())
                actor.queue_relayout();
        }
    }

    _panel(orientation = Clutter.Orientation.HORIZONTAL) {
        const panel = new St.BoxLayout({
            style_class: 'splus-toolbar',
            orientation,
            reactive: true,
            visible: false,
        });
        panel.connect('scroll-event', (_a, e) => this._onScroll(e));
        this._toolbar.add_child(panel);
        return panel;
    }

    // The same groups show in one of two ways: one bar under the selection, or
    // with tools-around-selection a panel for each group around it, placed by
    // toolLayout.js. They move between the two when the setting changes.
    _buildToolbar() {
        this._tooltips = [];
        // Spans the stage, so the panels in it are placed in stage coordinates.
        this._toolbar = new St.Widget({visible: false, x: 0, y: 0});
        this._toolbar.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));
        this._ui.add_child(this._toolbar);

        this._buildGroups();
        this._textRow = new St.BoxLayout({style_class: 'splus-row splus-text-row', visible: false});
        this._buildTextRow();

        this._bar = this._panel(Clutter.Orientation.VERTICAL);
        this._mainRow = new St.BoxLayout({style_class: 'splus-row'});
        this._barSeparators = [this._separator(), this._separator()];
        for (const separator of this._barSeparators)
            this._mainRow.add_child(separator);
        this._bar.add_child(this._mainRow);

        this._toolPanel = this._panel();
        this._colorPanel = this._panel(Clutter.Orientation.VERTICAL);
        this._actionPanel = this._panel();

        this._around = null;
        this._arrange();

        this._syncColor();
        this._syncUndo();
        this._syncTextRow();
    }

    // Puts the groups in the bar, or each in its own panel.
    _arrange() {
        const around = this._settings.get_boolean('tools-around-selection');
        if (around === this._around)
            return;
        this._around = around;

        for (const group of [this._toolGroup, this._colorGroup, this._actionGroup, this._textRow])
            group.get_parent()?.remove_child(group);
        this._setUpright([this._toolGroup], [], false);
        this._setUpright([this._actionGroup, this._undoGroup], [this._undoSeparator], false);

        if (around) {
            this._toolPanel.add_child(this._toolGroup);
            this._colorPanel.add_child(this._colorGroup);
            this._colorPanel.add_child(this._textRow);
            this._actionPanel.add_child(this._actionGroup);
        } else {
            const [first] = this._barSeparators;
            this._mainRow.insert_child_below(this._toolGroup, first);
            this._mainRow.insert_child_above(this._colorGroup, first);
            this._mainRow.add_child(this._actionGroup);
            this._bar.add_child(this._textRow);
        }
    }

    // A preview dot, GNOME's own slider and the number.
    _buildWidthControl() {
        this._widthGroup = new St.BoxLayout({
            style_class: 'splus-width',
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const dotBin = new St.Widget({
            style_class: 'splus-width-bin',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._widthDot = new St.Widget({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        dotBin.add_child(this._widthDot);
        this._widthGroup.add_child(dotBin);

        this._widthSlider = new Slider(0);
        this._widthSlider.add_style_class_name('splus-width-slider');
        this._widthSlider.can_focus = false;
        this._widthSlider.x_expand = false;
        this._widthSlider.y_align = Clutter.ActorAlign.CENTER;
        this._widthSlider.connect('notify::value', () => {
            if (!this._syncingWidth)
                this._setWidth(widthOf(this._widthSlider.value));
        });
        // The slider's own wheel step is a fraction of a pixel. This is one.
        // GNOME 51 takes the wheel in scroll controllers, before any handler.
        for (const action of this._widthSlider.get_actions()) {
            if (Clutter.ScrollController && action instanceof Clutter.ScrollController)
                this._widthSlider.remove_action(action);
        }
        this._widthSlider.connect('scroll-event', (_a, e) => {
            this._onScroll(e);
            return Clutter.EVENT_STOP;
        });
        this._widthGroup.add_child(this._widthSlider);

        this._widthLabel = new St.Label({
            style_class: 'splus-width-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._widthGroup.add_child(this._widthLabel);

        this._addTooltip(this._widthGroup, 'width');
        return this._widthGroup;
    }

    // The selected shape, or else the tool about to draw. Text has its own size.
    _widthTarget() {
        const shape = this._selected;
        if (shape && shape.type !== 'text')
            return {shape, type: shape.type};
        if (this._tool in DEFAULT_WIDTHS)
            return {shape: null, type: this._tool};
        return null;
    }

    _widthOfTarget({shape, type}) {
        if (!shape)
            return this._widths[type];
        // A number's size follows from its circle, which handles can also scale.
        return type === 'counter' ? (shape.radius - counterRadius(0)) / 2 : shape.width;
    }

    _setWidth(value) {
        const target = this._widthTarget();
        if (!target)
            return;
        const width = clamp(Math.round(value), MIN_WIDTH, MAX_WIDTH);
        const {shape, type} = target;

        if (shape) {
            this._scrollUndo();
            if (type === 'counter')
                shape.radius = counterRadius(width);
            else
                shape.width = width;
            this._refreshCommitted();
            this._updateOverlay();
        }

        this._widths[type] = width;
        this._saveWidthsLater();

        if (this._current?.type === type) {
            if (type === 'counter')
                this._current.radius = counterRadius(width);
            else
                this._current.width = width;
            this._updateLive();
        }
        this._syncWidth();
    }

    _syncWidth() {
        this._syncFill();
        const target = this._widthTarget();
        this._widthSlider.reactive = target !== null;
        this._widthGroup.opacity = target ? 255 : 90;
        if (!target) {
            this._widthLabel.text = '';
            this._widthDot.set_style('width: 0; height: 0;');
            return;
        }

        const width = clamp(Math.round(this._widthOfTarget(target)), MIN_WIDTH, MAX_WIDTH);
        this._syncingWidth = true;
        this._widthSlider.value = sliderOf(width);
        this._syncingWidth = false;
        this._widthLabel.text = String(width);

        const color = target.shape?.color ?? this._color;
        const size = Math.min(22, 3 + width);
        this._widthDot.set_style(
            `background-color: ${color}; width: ${size}px; height: ${size}px; ` +
            `border-radius: ${size / 2}px; border: 1px solid rgba(255,255,255,0.5);`);
    }

    // Writing on every pixel of a slider drag would be pointless disk traffic.
    _saveWidthsLater() {
        if (this._saveWidthsId)
            return;
        this._saveWidthsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WIDTH_SAVE_DELAY_MS, () => {
            this._saveWidthsId = 0;
            this._saveWidths();
            return GLib.SOURCE_REMOVE;
        });
    }

    _saveWidths() {
        this._settings.set_value('tool-widths', new GLib.Variant('a{si}', this._widths));
    }

    // The selected rectangle or ellipse, or else the tool about to draw one.
    _fillTarget() {
        const shape = this._selected;
        if (shape)
            return FILLABLE.has(shape.type) ? {shape, type: shape.type} : null;
        return FILLABLE.has(this._tool) ? {shape: null, type: this._tool} : null;
    }

    // Like the width, a change to a selected shape is also what its tool draws next.
    _toggleFill() {
        const target = this._fillTarget();
        if (!target)
            return;
        const {shape, type} = target;
        const fill = !(shape ? shape.fill : this._filled.has(type));

        if (shape) {
            this._pushUndo();
            shape.fill = fill;
            this._refreshCommitted();
        }
        if (fill)
            this._filled.add(type);
        else
            this._filled.delete(type);
        this._settings.set_strv('filled-tools', [...this._filled]);
        this._syncFill();
    }

    _syncFill() {
        const target = this._fillTarget();
        this._fillButton.reactive = target !== null;
        this._fillButton.opacity = target ? 255 : 90;
        this._fillButton.checked = target
            ? Boolean(target.shape ? target.shape.fill : this._filled.has(target.type)) : false;
    }

    // Tools; colours and width; undo, redo, copy, save and close. In the bar
    // separators stand between them.
    _buildGroups() {
        this._toolGroup = new St.BoxLayout({style_class: 'splus-group'});
        this._toolButtons = new Map();
        for (const tool of [SELECT_TOOL, ...DRAW_TOOLS]) {
            const button = this._toolButton(tool.icon, tool.label, () => {
                this._setTool(this._tool === tool.id ? null : tool.id);
            });
            this._toolButtons.set(tool.id, button);
            this._toolGroup.add_child(button);
        }

        this._colorGroup = new St.BoxLayout({style_class: 'splus-group'});
        this._colorButtons = new Map();
        for (const color of COLORS) {
            const button = new St.Button({
                style_class: 'splus-color',
                style: `background-color: ${color};`,
                can_focus: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            button.connect('clicked', () => this._setColor(color));
            this._colorButtons.set(color, button);
            this._colorGroup.add_child(button);
        }

        this._colorGroup.add_child(this._separator());
        this._colorGroup.add_child(this._buildWidthControl());
        this._fillButton = this._toolButton('fill', 'fill', () => this._toggleFill());
        this._fillButton.y_align = Clutter.ActorAlign.CENTER;
        this._colorGroup.add_child(this._fillButton);

        // Undo and redo are a group of their own, hidden where there is
        // nothing to draw on.
        this._actionGroup = new St.BoxLayout({style_class: 'splus-group'});
        this._undoGroup = new St.BoxLayout({style_class: 'splus-group'});
        this._undoButton = this._toolButton('undo', 'undo', () => this._undo());
        this._redoButton = this._toolButton('redo', 'redo', () => this._redo());
        this._undoSeparator = this._separator();
        this._undoGroup.add_child(this._undoButton);
        this._undoGroup.add_child(this._redoButton);
        this._undoGroup.add_child(this._undoSeparator);
        this._actionGroup.add_child(this._undoGroup);

        this._copyButton = this._toolButton('copy', 'copy', () => {
            this._exportAndClose({copy: true, save: false});
        }, 'splus-tool splus-action');
        this._saveButton = this._toolButton('save', 'save', () => {
            this._exportAndClose({copy: false, save: true});
        }, 'splus-tool splus-action');
        this._actionGroup.add_child(this._copyButton);
        this._actionGroup.add_child(this._saveButton);
        this._actionGroup.add_child(this._toolButton('close', 'close', () => {
            this._ui.close();
        }));
    }

    _slotButton(slot, key) {
        const swatch = new St.Widget({style_class: 'splus-swatch', y_align: Clutter.ActorAlign.CENTER});
        const box = new St.BoxLayout({style_class: 'splus-slot-box'});
        box.add_child(swatch);
        const label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._translate(() => {
            label.text = t(key);
        });
        box.add_child(label);
        const button = new St.Button({style_class: 'splus-slot', child: box, can_focus: false});
        button.connect('clicked', () => {
            this._slot = slot;
            this._syncColor();
            this._syncTextRow();
        });
        return {button, swatch};
    }

    _stepper(key, onStep) {
        const box = new St.BoxLayout({style_class: 'splus-stepper'});
        const title = new St.Label({
            style_class: 'splus-step-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._translate(() => {
            title.text = t(key);
        });
        box.add_child(title);
        const step = (text, delta) => {
            const button = new St.Button({
                label: text,
                style_class: 'splus-step-button',
                can_focus: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            button.connect('clicked', () => onStep(delta));
            return button;
        };
        const value = new St.Label({
            style_class: 'splus-step-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(step('−', -1));
        box.add_child(value);
        box.add_child(step('+', 1));
        return {box, value};
    }

    _buildTextRow() {
        this._slots = {
            text: this._slotButton('text', 'text.color'),
            outline: this._slotButton('outline', 'text.outline'),
            bg: this._slotButton('bg', 'text.background'),
        };
        for (const {button} of Object.values(this._slots))
            this._textRow.add_child(button);

        // Only outline and background can be absent, and it is the palette's
        // natural extra entry for those two.
        this._noneButton = new St.Button({
            style_class: 'splus-slot',
            can_focus: false,
        });
        this._translate(() => {
            this._noneButton.label = t('text.none');
        });
        this._noneButton.connect('clicked', () => {
            this._applyStyle(this._slot === 'outline' ? {outlineColor: null} : {bgColor: null});
        });
        this._textRow.add_child(this._noneButton);
        this._textRow.add_child(this._separator());

        this._sizeStepper = this._stepper('text.size', delta => {
            const {fontPx} = this._readStyle();
            this._applyStyle({fontPx: clamp(Math.round(fontPx) + delta * 2, MIN_FONT, MAX_FONT)});
        });
        this._textRow.add_child(this._sizeStepper.box);

        this._outlineStepper = this._stepper('text.outlineWidth', delta => {
            const {outlineWidth} = this._readStyle();
            this._applyStyle({outlineWidth: clamp(outlineWidth + delta, 1, 20)});
        });
        this._textRow.add_child(this._outlineStepper.box);

        this._alphaStepper = this._stepper('text.bgOpacity', delta => {
            const {bgAlpha} = this._readStyle();
            this._applyStyle({bgAlpha: clamp(Math.round((bgAlpha + delta * 0.1) * 10) / 10, 0.1, 1)});
        });
        this._textRow.add_child(this._alphaStepper.box);

        const padding = (title, key) => {
            const stepper = this._stepper(title, delta => {
                const value = this._readStyle()[key];
                this._applyStyle({[key]: clamp(Math.round(value * 20 + delta) / 20, 0, 1)});
            });
            this._textRow.add_child(stepper.box);
            return stepper;
        };
        this._bgHeightStepper = padding('text.bgHeight', 'bgPadY');
        this._bgWidthStepper = padding('text.bgWidth', 'bgPadX');
    }

    // Order: selection and monitor actors < drawing < native panel < toolbar <
    // tooltips < hint.
    _stack() {
        const ui = this._ui;
        ui.set_child_below_sibling(this._catcher, ui._primaryMonitorBin);
        ui.set_child_below_sibling(this._drawing, ui._areaSelector);
        ui.set_child_above_sibling(this._toolbar, null);
        // Above the panels, which a tooltip beside a column could reach.
        for (const tooltip of this._tooltips)
            ui.set_child_above_sibling(tooltip, null);
        ui.set_child_above_sibling(this._hint, null);
    }

    // ---- state ----

    _canAnnotate() {
        const ui = this._ui;
        return ui._shotButton.checked &&
            (ui._selectionButton.checked || ui._screenButton.checked) &&
            !Main.sessionMode.isLocked;
    }

    _onUiVisible() {
        this._color = this._settings.get_string('tool-color');
        this._syncColor();
        this._sync();
    }

    _sync() {
        const ui = this._ui;
        const annotate = this._canAnnotate() && ui.visible;

        if (!annotate)
            this._setTool(null);

        this._catcher.visible = annotate && !this._selectionDragging;
        this._drawing.visible = annotate;
        this._toolGroup.visible = annotate;
        this._colorGroup.visible = annotate;
        this._undoGroup.visible = annotate;
        for (const separator of this._barSeparators)
            separator.visible = annotate;
        this._bar.visible = !this._around;
        this._toolPanel.visible = this._around && annotate;
        this._colorPanel.visible = this._around && annotate;
        this._actionPanel.visible = this._around;

        this._toolbar.visible = ui.visible && ui._shotButton.checked &&
            !this._selectionDragging && !Main.sessionMode.isLocked;

        if (annotate)
            this._syncCanvas();

        this._syncTextRow();
        this._schedulePlacement();
    }

    _selection() {
        if (!this._ui._selectionButton.checked && !this._ui._screenButton.checked)
            return null;
        return this._ui._getSelectedGeometry(false);
    }

    _syncCanvas() {
        if (this._selection())
            this._refreshCommitted();
    }

    // The committed canvas covers the shapes and nothing else, wherever they are,
    // so dragging the selection never repaints or resizes it.
    _refreshCommitted() {
        const area = this._committed;
        const box = unionOf(this._shapes.map(shapeBounds));
        if (box) {
            const [x, y, w, h] = box;
            area.set_position(x, y);
            area.set_size(w, h);
            area.queue_repaint();
        }
        area.visible = box !== null;

        if (this._tool === 'pixelate' || this._shapes.some(s => s.type === 'pixelate'))
            this._ensureBase();
    }

    _schedulePlacement() {
        if (this._laterId)
            return;
        // Sizes are only valid once the frame has been laid out.
        this._laterId = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._laterId = 0;
                this._placeToolbar();
                return GLib.SOURCE_REMOVE;
            });
    }

    // On whichever monitor holds most of the selection, clear of the native
    // panel on the primary monitor.
    _placeToolbar() {
        if (!this._toolbar.visible)
            return;

        const ui = this._ui;
        const layout = Main.layoutManager;
        const rect = this._selection();

        let index = layout.primaryIndex;
        if (rect) {
            const [x, y, width, height] = rect;
            const found = global.display.get_monitor_index_for_rect(
                new Mtk.Rectangle({x, y, width, height}));
            if (found >= 0)
                index = found;
        }
        const monitor = layout.monitors[index];
        if (!monitor)
            return;

        if (ui._panel.visible && ui._panel.height > 0) {
            const [, panelY] = ui._panel.get_transformed_position();
            this._panelTop = panelY;
        }

        const area = {
            left: monitor.x + TOOLBAR_GAP,
            top: monitor.y + TOOLBAR_GAP,
            right: monitor.x + monitor.width - TOOLBAR_GAP,
            bottom: index === layout.primaryIndex && this._panelTop !== null
                ? this._panelTop - TOOLBAR_GAP
                : monitor.y + monitor.height - TOOLBAR_GAP,
        };
        // Clear of the corner handles, which are there to be grabbed.
        const gap = rect ? ui._areaSelector._handleSize / 2 + TOOLBAR_GAP : TOOLBAR_GAP;

        if (this._around)
            this._placeAround(rect, area, gap);
        else
            this._placeBar(rect, area, gap, monitor);
    }

    // Under the selection, else over it, else inside it at the bottom.
    _placeBar(rect, area, gap, monitor) {
        const [, , width, height] = this._bar.get_preferred_size();
        const [sx, sy, sw, sh] = rect ?? [monitor.x, area.bottom, monitor.width, 0];

        let y;
        if (sy + sh + gap + height <= area.bottom)
            y = sy + sh + gap;
        else if (sy - gap - height >= area.top)
            y = sy - gap - height;
        else
            y = area.bottom - height;

        const x = Math.max(area.left, Math.min(area.right - width, sx + (sw - width) / 2));

        this._bar.set_position(Math.round(x), Math.round(y));
    }

    _placeAround(rect, area, gap) {
        const sizeOf = actor => {
            const [, , width, height] = actor.get_preferred_size();
            return [width, height];
        };
        // Measured both ways, then left the way it goes.
        const turning = (id, panel, boxes, separators) => {
            const upright = value => this._setUpright(boxes, separators, value);
            upright(true);
            const column = sizeOf(panel);
            upright(false);
            return {id, panel, upright, row: sizeOf(panel), column};
        };
        const groups = [];
        if (this._toolPanel.visible)
            groups.push(turning('tools', this._toolPanel, [this._toolGroup], []));
        if (this._colorPanel.visible)
            groups.push({id: 'colors', panel: this._colorPanel, row: sizeOf(this._colorPanel), column: null});
        if (this._actionPanel.visible) {
            groups.push(turning('actions', this._actionPanel,
                [this._actionGroup, this._undoGroup], [this._undoSeparator]));
        }

        const places = placeGroups({groups, rect, area, gap, spacing: GROUP_SPACING});
        for (const {id, panel, upright} of groups) {
            const {x, y, vertical} = places.get(id);
            upright?.(vertical);
            panel.set_position(x, y);
        }
    }

    _setTool(id) {
        this._commitText();
        this._tool = id;

        for (const [toolId, button] of this._toolButtons ?? [])
            button.checked = toolId === id;

        // Keep the selection when going to the tool that edits it, or to text
        // when text is what is selected.
        const keepSelection = id === 'select' || (id === 'text' && this._selected?.type === 'text');
        if (!keepSelection)
            this._select(null);

        const ui = this._ui;
        const active = id !== null;
        this._catcher.reactive = active;
        this._catcher.set_cursor_type(this._toolCursor());
        this._hint.hide();

        // The panel would sit on top of the very area being drawn on.
        ui._panel.visible = !active;
        ui._closeButton.visible = !active;

        if (id === 'pixelate')
            this._ensureBase();

        this._syncTextRow();
        this._syncWidth();
        this._schedulePlacement();
    }

    _toolCursor() {
        if (this._tool === null || this._tool === 'select')
            return Clutter.CursorType.INHERIT;
        return this._tool === 'text' ? Clutter.CursorType.TEXT : Clutter.CursorType.CROSSHAIR;
    }

    _textContext() {
        return this._tool === 'text' || this._textActor !== null ||
            this._selected?.type === 'text';
    }

    // The text being typed, then the selected text, then the defaults for new text.
    _readStyle() {
        const target = this._textActor ? this._current
            : this._selected?.type === 'text' ? this._selected : null;
        return {color: this._color, ...this._textStyle, ...target};
    }

    _applyStyle(changes) {
        if (this._textActor) {
            this._changeEditedText(() => Object.assign(this._current, changes));
            this._textActor.set_font_name(textFont(this._current.fontPx));
        } else if (this._selected?.type === 'text') {
            this._pushUndo();
            const {fontPx, ...others} = changes;
            if (fontPx !== undefined) {
                const {x, y} = resizeTextAroundCenter(this._selected, fontPx);
                Object.assign(this._selected, {x, y, fontPx});
            }
            Object.assign(this._selected, others);
            this._refreshCommitted();
            this._updateOverlay();
        }

        const {color: _color, ...style} = changes;
        Object.assign(this._textStyle, style);
        this._saveTextStyle();
        this._syncTextRow();
        this._syncColor();
    }

    _setColor(color) {
        if (this._textContext() && this._slot !== 'text') {
            this._applyStyle(this._slot === 'outline' ? {outlineColor: color} : {bgColor: color});
            return;
        }

        this._color = color;
        this._settings.set_string('tool-color', color);

        if (this._textActor) {
            this._current.color = color;
            this._updateLive();
        } else if (this._selected && this._selected.type !== 'pixelate') {
            this._pushUndo();
            this._selected.color = color;
            this._refreshCommitted();
        }

        this._syncColor();
        this._syncTextRow();
    }

    _coglColor(hex, alpha = 1) {
        const [r, g, b] = parseColor(hex);
        const color = new Cogl.Color();
        color.init_from_4f(r, g, b, alpha);
        return color;
    }

    _activeColor() {
        const style = this._readStyle();
        if (this._textContext()) {
            if (this._slot === 'outline')
                return style.outlineColor;
            if (this._slot === 'bg')
                return style.bgColor;
            return style.color;
        }
        return this._selected?.color ?? this._color;
    }

    _syncColor() {
        const active = this._activeColor();
        for (const [color, button] of this._colorButtons)
            button.checked = color === active;

        this._syncWidth();
    }

    _syncTextRow() {
        const show = this._textContext() && this._canAnnotate();
        if (this._textRow.visible !== show) {
            this._textRow.visible = show;
            this._schedulePlacement();
        }
        if (!show)
            return;

        const style = this._readStyle();
        const paint = (slot, color) => {
            const {button, swatch} = this._slots[slot];
            button.checked = this._slot === slot;
            swatch.set_style(color
                ? `background-color: ${color};`
                : 'background-color: transparent; border-style: dashed;');
        };
        paint('text', style.color);
        paint('outline', style.outlineColor);
        paint('bg', style.bgColor);

        this._noneButton.visible = this._slot !== 'text';
        this._noneButton.checked = (this._slot === 'outline' && !style.outlineColor) ||
            (this._slot === 'bg' && !style.bgColor);

        this._sizeStepper.value.text = String(Math.round(style.fontPx));
        this._outlineStepper.box.visible = Boolean(style.outlineColor);
        this._outlineStepper.value.text = String(style.outlineWidth);
        this._alphaStepper.box.visible = Boolean(style.bgColor);
        this._alphaStepper.value.text = `${Math.round(style.bgAlpha * 100)}%`;
        this._bgHeightStepper.box.visible = Boolean(style.bgColor);
        this._bgHeightStepper.value.text = `${Math.round(style.bgPadY * 100)}%`;
        this._bgWidthStepper.box.visible = Boolean(style.bgColor);
        this._bgWidthStepper.value.text = `${Math.round(style.bgPadX * 100)}%`;

        // Steppers appearing change the row's width.
        this._schedulePlacement();
    }

    _syncUndo() {
        const canUndo = this._undoStack.length > 0;
        const canRedo = this._redoStack.length > 0;
        this._undoButton.reactive = canUndo;
        this._undoButton.opacity = canUndo ? 255 : 90;
        this._redoButton.reactive = canRedo;
        this._redoButton.opacity = canRedo ? 255 : 90;
    }

    _reset() {
        this._endDrag();
        this._discardText();
        this._setTool(null);
        this._shapes = [];
        this._undoStack = [];
        this._redoStack = [];
        this._current = null;
        this._transform = null;
        this._selected = null;
        this._selectionDragging = false;
        this._selectionPress = null;
        this._slot = 'text';
        this._lastClick = null;
        this._live.hide();
        this._overlay.hide();
        this._dropBase();
        this._syncUndo();
        this._refreshCommitted();
        this._toolbar.hide();
        this._catcher.hide();
    }

    // ---- painting ----

    _repaintCommitted(area) {
        const cr = area.get_context();
        const [x, y] = area.get_position();
        cr.translate(-x, -y);
        for (const shape of this._shapes)
            drawShape(cr, shape, this._base);
        cr.$dispose();
    }

    _repaintLive(area) {
        const cr = area.get_context();
        if (this._current) {
            const [x, y] = area.get_position();
            cr.translate(-x, -y);
            drawShape(cr, this._current, this._base);
            // Pixels over a calm background barely show, so mark the area being
            // covered. This is the on-screen canvas only, so it is never exported.
            if (this._current.type === 'pixelate') {
                const [rx, ry, rw, rh] = shapeBox(this._current);
                this._strokeDashed(cr, [[rx, ry], [rx + rw, ry], [rx + rw, ry + rh], [rx, ry + rh]]);
            }
        }
        cr.$dispose();
    }

    _strokeDashed(cr, corners) {
        cr.newPath();
        for (const [x, y] of corners)
            cr.lineTo(x, y);
        cr.closePath();
        cr.setLineWidth(1);
        cr.setDash([4, 3], 0);
        cr.setSourceRGBA(1, 1, 1, 0.9);
        cr.strokePreserve();
        cr.setDash([4, 3], 4);
        cr.setSourceRGBA(0.2, 0.52, 0.89, 1);
        cr.stroke();
        cr.setDash([], 0);
    }

    _repaintOverlay(area) {
        const cr = area.get_context();
        if (this._selected) {
            const [ox, oy] = area.get_position();
            cr.translate(-ox, -oy);

            const shape = this._selected;
            const handles = handlesOf(shape);

            if (shape.type === 'text') {
                const corners = textCorners(shape);
                this._strokeDashed(cr, corners);

                // The grip hangs off the middle of the top edge.
                const grip = handles.find(h => h.id === 'grip');
                cr.moveTo((corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2);
                cr.lineTo(grip.x, grip.y);
                cr.setLineWidth(1.5);
                cr.setSourceRGBA(1, 1, 1, 0.9);
                cr.stroke();
            } else if (shape.type !== 'line' && shape.type !== 'arrow') {
                const [x, y, w, h] = shapeBox(shape);
                this._strokeDashed(cr, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
            }

            for (const handle of handles) {
                const isGrip = handle.id === 'grip';
                cr.arc(handle.x, handle.y, isGrip ? GRIP_RADIUS : HANDLE_RADIUS, 0, 2 * Math.PI);
                cr.setSourceRGBA(1, 1, 1, 1);
                cr.fillPreserve();
                cr.setLineWidth(1.5);
                cr.setSourceRGBA(0.2, 0.52, 0.89, 1);
                cr.stroke();
                if (isGrip)
                    this._drawMoveMark(cr, handle.x, handle.y);
            }
        }
        cr.$dispose();
    }

    // A four-way arrow, so the grip reads as "drag to move".
    _drawMoveMark(cr, x, y) {
        const reach = GRIP_RADIUS - 3;
        const head = 2.5;
        cr.setSourceRGBA(0.2, 0.52, 0.89, 1);
        cr.setLineWidth(1.5);
        cr.moveTo(x - reach, y);
        cr.lineTo(x + reach, y);
        cr.moveTo(x, y - reach);
        cr.lineTo(x, y + reach);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            cr.moveTo(x + dx * reach - dx * head + dy * head, y + dy * reach - dy * head + dx * head);
            cr.lineTo(x + dx * reach, y + dy * reach);
            cr.lineTo(x + dx * reach - dx * head - dy * head, y + dy * reach - dy * head - dx * head);
        }
        cr.stroke();
    }

    // Keeps the live canvas to the shape's bounds.
    _updateLive() {
        const box = this._current && this._selection()
            ? unionOf([shapeBounds(this._current)]) : null;
        if (!box) {
            this._live.hide();
            return;
        }
        const [x, y, w, h] = box;
        this._live.set_position(x, y);
        this._live.set_size(w, h);
        this._live.show();
        this._live.queue_repaint();
    }

    _updateOverlay() {
        if (!this._selected || this._textActor) {
            this._overlay.hide();
            return;
        }
        const handles = handlesOf(this._selected);
        const margin = GRIP_RADIUS + 3;
        // A turned text's corners can reach beyond its handles.
        const [bx, by, bw, bh] = shapeBounds(this._selected);
        const xs = [...handles.map(h => h.x), bx, bx + bw];
        const ys = [...handles.map(h => h.y), by, by + bh];
        const left = Math.floor(Math.min(...xs) - margin);
        const top = Math.floor(Math.min(...ys) - margin);
        const right = Math.ceil(Math.max(...xs) + margin);
        const bottom = Math.ceil(Math.max(...ys) + margin);
        this._overlay.set_position(left, top);
        this._overlay.set_size(right - left, bottom - top);
        this._overlay.show();
        this._overlay.queue_repaint();
    }

    _select(shape) {
        this._selected = shape;
        this._updateOverlay();
        this._syncTextRow();
        this._syncColor();
    }

    _dropBase() {
        this._base?.surface.finish();
        this._base = null;
        this._baseRect = null;
    }

    // The selection and every pixelated area, since those show outside it too.
    _baseArea() {
        const rect = this._selection();
        if (!rect)
            return null;
        const boxes = this._shapes.filter(s => s.type === 'pixelate').map(s => shapeBox(s));
        return unionOf([rect, ...boxes]);
    }

    async _ensureBase() {
        const rect = this._baseArea();
        if (!rect || this._baseLoading)
            return;
        if (this._baseRect?.join() === rect.join())
            return;

        this._baseLoading = true;
        try {
            const base = await captureBase(this._ui, rect);
            // The UI may have closed while the PNG was being encoded.
            if (base && this._ui.visible) {
                this._dropBase();
                this._base = base;
                this._baseRect = rect;
                this._committed.queue_repaint();
                this._live.queue_repaint();
            } else {
                base?.surface.finish();
            }
        } catch (e) {
            logError(e, 'screenshot-plus: cannot capture pixelate source');
        } finally {
            this._baseLoading = false;
        }

        // The selection may have moved while this one was encoding. Only that
        // earns a retry: a failed capture would fail the same way, forever.
        const now = this._baseArea();
        if (this._ui.visible && now && now.join() !== rect.join())
            this._ensureBase();
    }

    // ---- input ----

    _handleAt(x, y) {
        if (!this._selected)
            return null;
        return handlesOf(this._selected).find(h =>
            Math.hypot(h.x - x, h.y - y) <= HANDLE_GRAB) ?? null;
    }

    _isDoubleClick(event, x, y) {
        const time = event.get_time();
        const last = this._lastClick;
        this._lastClick = {time, x, y};
        return last !== null && time - last.time <= DOUBLE_CLICK_MS &&
            Math.hypot(last.x - x, last.y - y) <= DOUBLE_CLICK_PX;
    }

    // Outside the selection and on its corners a press does what it does with no
    // tool: drags out a new selection, or resizes this one. A selected shape's own
    // handles still come first, since they can stick out of the selection.
    _selectionTakes(x, y) {
        if (!this._ui._selectionButton.checked || this._handleAt(x, y))
            return null;
        const cursor = this._ui._areaSelector._computeCursorType(x, y);
        return cursor === Clutter.CursorType.MOVE ? null : cursor;
    }

    _showHint(cursor, x, y) {
        if (cursor === null) {
            this._hint.hide();
            return;
        }
        this._hint.text = cursor === Clutter.CursorType.CROSSHAIR
            ? t('hint.newSelection') : t('hint.resizeSelection');

        // Below right of the pointer, flipped where that would leave the monitor.
        const monitor = Main.layoutManager.monitors[global.display.get_current_monitor()];
        const [, , width, height] = this._hint.get_preferred_size();
        let left = x + HINT_OFFSET;
        let top = y + HINT_OFFSET;
        if (monitor && left + width > monitor.x + monitor.width)
            left = x - HINT_OFFSET - width;
        if (monitor && top + height > monitor.y + monitor.height)
            top = y - HINT_OFFSET - height;
        this._hint.set_position(Math.round(left), Math.round(top));
        this._hint.show();
    }

    _pressSelection(event, x, y, cursor) {
        this._hint.hide();
        this._commitText();
        this._lastClick = null;
        const selector = this._ui._areaSelector;
        if (cursor === Clutter.CursorType.CROSSHAIR) {
            this._select(null);
            this._selectionPress = {
                x,
                y,
                area: [selector._startX, selector._startY, selector._lastX, selector._lastY],
            };
        }
        return selector._onPress(event, Clutter.BUTTON_PRIMARY, null);
    }

    // On its own a click outside makes a small selection around itself. While
    // drawing that is nearly always a slip that would throw the area away.
    _keepSelectionOnClick() {
        const press = this._selectionPress;
        this._selectionPress = null;
        if (!press)
            return;
        const [x, y] = global.get_pointer();
        if (Math.hypot(x - press.x, y - press.y) > CLICK_SLOP)
            return;
        const selector = this._ui._areaSelector;
        [selector._startX, selector._startY, selector._lastX, selector._lastY] = press.area;
        selector._updateSelectionRect();
    }

    _onPress(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || !this._tool)
            return Clutter.EVENT_PROPAGATE;

        const {x, y} = pointerOf(event);
        const selectionCursor = this._selectionTakes(x, y);
        if (selectionCursor !== null)
            return this._pressSelection(event, x, y, selectionCursor);
        this._hint.hide();

        const doubleClick = this._isDoubleClick(event, x, y);

        if (this._textActor) {
            this._commitText();
            return Clutter.EVENT_STOP;
        }

        // With a drawing tool only outlines grab, so a new shape can still start
        // inside the previous one.
        const edgesOnly = this._tool !== 'select' && this._tool !== 'text';

        const handle = this._handleAt(x, y);
        if (handle) {
            if (handle.id === 'grip')
                this._beginTransform('move', null, x, y);
            else
                this._beginTransform('resize', handle.id, x, y, x - handle.x, y - handle.y);
            return Clutter.EVENT_STOP;
        }

        if (this._selected && hitTest(this._selected, x, y, edgesOnly)) {
            if (doubleClick && this._selected.type === 'text') {
                this._editText(this._selected);
                return Clutter.EVENT_STOP;
            }
            this._beginMove(x, y);
            return Clutter.EVENT_STOP;
        }

        if (this._tool === 'select' || this._tool === 'text') {
            const candidates = this._tool === 'text'
                ? this._shapes.filter(s => s.type === 'text') : this._shapes;
            const hit = [...candidates].reverse().find(s => hitTest(s, x, y));
            if (hit) {
                this._select(hit);
                this._beginMove(x, y);
                return Clutter.EVENT_STOP;
            }
            this._select(null);
            if (this._tool === 'text')
                this._startText(x, y);
            return Clutter.EVENT_STOP;
        }

        this._select(null);
        const base = {color: this._color, width: this._widths[this._tool]};

        switch (this._tool) {
        case 'counter': {
            const number = this._shapes.reduce(
                (max, s) => s.type === 'counter' ? Math.max(max, s.number) : max, 0) + 1;
            this._current = {
                type: 'counter',
                color: this._color,
                radius: counterRadius(this._widths.counter),
                x,
                y,
                number,
            };
            break;
        }
        case 'pen':
        case 'marker':
            this._current = {...base, type: this._tool, points: [[x, y]]};
            break;
        default:
            this._current = {...base, type: this._tool, x1: x, y1: y, x2: x, y2: y};
            if (this._filled.has(this._tool))
                this._current.fill = true;
        }

        this._dragGrab = global.stage.grab(this._catcher);
        this._updateLive();
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        const {x, y, shift} = pointerOf(event);

        if (this._transform) {
            this._updateTransform(x, y, shift);
            return Clutter.EVENT_STOP;
        }

        if (!this._current || this._textActor) {
            this._updateHover(x, y);
            return Clutter.EVENT_PROPAGATE;
        }

        const shape = this._current;
        if (shape.type === 'counter') {
            this._current = withTip(shape, x, y, shift);
        } else if (shape.points) {
            shape.points.push([x, y]);
        } else if (shift) {
            [shape.x2, shape.y2] = constrainEnd(shape.type, shape.x1, shape.y1, x, y);
        } else {
            shape.x2 = x;
            shape.y2 = y;
        }

        this._updateLive();
        return Clutter.EVENT_STOP;
    }

    _updateHover(x, y) {
        const handle = this._handleAt(x, y);
        const selectionCursor = this._selectionTakes(x, y);
        let cursor = this._toolCursor();
        if (handle) {
            cursor = HANDLE_CURSORS[handle.id];
        } else if (selectionCursor !== null) {
            cursor = selectionCursor;
        } else if (this._selected) {
            const edgesOnly = this._tool !== 'select' && this._tool !== 'text';
            if (hitTest(this._selected, x, y, edgesOnly))
                cursor = Clutter.CursorType.MOVE;
        } else if (this._tool === 'select' && this._shapes.some(s => hitTest(s, x, y))) {
            cursor = Clutter.CursorType.MOVE;
        }
        this._catcher.set_cursor_type(cursor);
        this._showHint(handle ? null : selectionCursor, x, y);
    }

    _onRelease(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        if (this._transform) {
            this._finishTransform();
            return Clutter.EVENT_STOP;
        }

        if (!this._current || this._textActor)
            return Clutter.EVENT_PROPAGATE;

        const shape = this._current;
        this._current = null;
        this._endDrag();
        this._live.hide();

        // A click without a drag leaves nothing visible for box-like shapes.
        const empty = !shape.points && shape.type !== 'counter' &&
            shape.x1 === shape.x2 && shape.y1 === shape.y2;
        if (!empty) {
            // Freehand strokes stay unselected so the next one can start anywhere.
            this._commit(shape, !shape.points);
        }

        return Clutter.EVENT_STOP;
    }

    // The offset is where on the handle it was grabbed, so it does not jump to the
    // pointer on the first motion.
    _beginTransform(kind, handle, x, y, offsetX = 0, offsetY = 0) {
        this._transform = {
            kind,
            handle,
            offsetX,
            offsetY,
            startX: x,
            startY: y,
            original: this._selected,
            index: this._shapes.indexOf(this._selected),
            moved: false,
        };
        this._dragGrab = global.stage.grab(this._catcher);
    }

    // Dragging a numbered arrow by its number leaves the tip on what it points at.
    _beginMove(x, y) {
        const kind = overCounterBadge(this._selected, x, y) ? 'badge' : 'move';
        this._beginTransform(kind, null, x, y);
    }

    _updateTransform(x, y, shift) {
        const transform = this._transform;
        if (!transform.moved) {
            if (Math.hypot(x - transform.startX, y - transform.startY) < 2)
                return;
            transform.moved = true;
            // Dragged on the live canvas, so the big one is not re-uploaded per
            // pointer motion.
            this._pushUndo();
            this._shapes.splice(transform.index, 1);
            this._refreshCommitted();
        }

        const dx = x - transform.startX;
        const dy = y - transform.startY;
        let shape;
        if (transform.kind === 'move') {
            shape = moveShape(transform.original, dx, dy);
        } else if (transform.kind === 'badge') {
            shape = moveCounterBadge(transform.original, dx, dy);
        } else {
            shape = resizeShape(transform.original, transform.handle,
                x - transform.offsetX, y - transform.offsetY, shift);
        }
        this._current = shape;
        this._selected = shape;
        this._updateLive();
        this._updateOverlay();
    }

    _cancelDrag() {
        const transform = this._transform;
        this._transform = null;
        this._current = null;
        this._endDrag();
        this._live.hide();

        if (transform?.moved) {
            this._undoStack.pop();
            this._syncUndo();
            this._shapes.splice(transform.index, 0, transform.original);
            this._refreshCommitted();
        }
        if (transform) {
            this._selected = transform.original;
            this._updateOverlay();
        }
    }

    _finishTransform() {
        const transform = this._transform;
        this._transform = null;
        this._endDrag();

        if (!transform.moved)
            return;

        this._shapes.splice(transform.index, 0, this._current);
        this._selected = this._current;
        this._current = null;
        this._live.hide();
        this._refreshCommitted();
        this._updateOverlay();
        this._syncTextRow();
    }

    _onScroll(event) {
        // A wheel notch arrives twice, as a smooth and as an emulated event.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;

        // The shape being dragged is outside the list, so a snapshot would lose it.
        if (this._transform)
            return Clutter.EVENT_STOP;

        let delta = 0;
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP) {
            delta = 1;
        } else if (direction === Clutter.ScrollDirection.DOWN) {
            delta = -1;
        } else if (direction === Clutter.ScrollDirection.SMOOTH) {
            // Touchpads send many tiny deltas, so only whole steps count.
            this._scrollRemainder -= event.get_scroll_delta()[1];
            delta = Math.trunc(this._scrollRemainder);
            this._scrollRemainder -= delta;
        }

        if (delta === 0)
            return Clutter.EVENT_PROPAGATE;

        if (this._textContext()) {
            const {fontPx} = this._readStyle();
            this._applyStyle({fontPx: clamp(Math.round(fontPx) + delta * 2, MIN_FONT, MAX_FONT)});
            return Clutter.EVENT_STOP;
        }

        const target = this._widthTarget();
        if (target)
            this._setWidth(this._widthOfTarget(target) + delta);
        return Clutter.EVENT_STOP;
    }

    // One undo step for a whole burst of wheel notches.
    _scrollUndo() {
        const now = GLib.get_monotonic_time();
        if (now - this._lastScrollUndo > SCROLL_UNDO_GAP_US)
            this._pushUndo();
        this._lastScrollUndo = now;
    }

    _endDrag() {
        this._dragGrab?.dismiss();
        this._dragGrab = null;
    }

    _onCapturedEvent(event) {
        if (event.type() !== Clutter.EventType.KEY_PRESS || !this._ui.visible)
            return Clutter.EVENT_PROPAGATE;
        if (!this._ui._shotButton.checked || Main.sessionMode.isLocked)
            return Clutter.EVENT_PROPAGATE;

        const symbol = event.get_key_symbol();
        const code = event.get_key_code();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

        if (this._textActor) {
            if (ctrl && code === KEYCODE.V) {
                this._pasteIntoText();
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_Escape) {
                this._discardText();
                return Clutter.EVENT_STOP;
            }
            if ((symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) && !shift) {
                this._commitText();
                return Clutter.EVENT_STOP;
            }
            if (!ctrl)
                return Clutter.EVENT_PROPAGATE; // Typing, including Shift+Enter.
            if (code !== KEYCODE.C && code !== KEYCODE.S)
                return Clutter.EVENT_PROPAGATE;
        }

        if (ctrl) {
            switch (code) {
            case KEYCODE.C:
                this._exportAndClose({copy: true, save: false});
                return Clutter.EVENT_STOP;
            case KEYCODE.S:
                this._exportAndClose({copy: false, save: true});
                return Clutter.EVENT_STOP;
            case KEYCODE.Z:
                if (shift)
                    this._redo();
                else
                    this._undo();
                return Clutter.EVENT_STOP;
            case KEYCODE.Y:
                this._redo();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (this._selected) {
            if (symbol === Clutter.KEY_Delete || symbol === Clutter.KEY_BackSpace) {
                this._deleteSelected();
                return Clutter.EVENT_STOP;
            }
            // Esc peels off the selection before it closes everything.
            if (symbol === Clutter.KEY_Escape) {
                this._select(null);
                return Clutter.EVENT_STOP;
            }
        }

        if (this._canAnnotate()) {
            if (code === KEYCODE.F && this._fillTarget()) {
                this._toggleFill();
                return Clutter.EVENT_STOP;
            }
            if (code === DIGIT_0_KEYCODE) {
                this._setTool(this._tool === 'select' ? null : 'select');
                return Clutter.EVENT_STOP;
            }
            const toolIndex = code - DIGIT_1_KEYCODE;
            if (toolIndex >= 0 && toolIndex < DRAW_TOOLS.length) {
                const {id} = DRAW_TOOLS[toolIndex];
                this._setTool(this._tool === id ? null : id);
                return Clutter.EVENT_STOP;
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // ---- shapes ----

    _pushUndo() {
        this._undoStack.push(snapshotOf(this._shapes));
        if (this._undoStack.length > UNDO_LIMIT)
            this._undoStack.shift();
        this._redoStack = [];
        this._syncUndo();
    }

    _commit(shape, select = false) {
        this._pushUndo();
        this._shapes.push(shape);
        this._refreshCommitted();
        this._select(select ? shape : null);
    }

    _deleteSelected() {
        this._pushUndo();
        this._shapes.splice(this._shapes.indexOf(this._selected), 1);
        this._select(null);
        this._refreshCommitted();
    }

    _restore(from, to) {
        const shapes = from.pop();
        if (!shapes)
            return;
        to.push(snapshotOf(this._shapes));
        this._shapes = shapes;
        this._select(null);
        this._syncUndo();
        this._refreshCommitted();
    }

    // Text is committed before the stacks are read, because committing replaces
    // the redo stack.
    _undo() {
        this._commitText();
        this._restore(this._undoStack, this._redoStack);
    }

    _redo() {
        this._commitText();
        this._restore(this._redoStack, this._undoStack);
    }

    // The canvas paints the real styled text under a transparent Clutter.Text,
    // which only contributes the input handling and the caret. That way typing
    // already looks exactly like the result.
    _openTextActor(shape) {
        this._current = shape;
        this._textActor = new Clutter.Text({
            editable: true,
            reactive: true,
            selectable: true,
            cursor_visible: true,
            activatable: false,
            single_line_mode: false,
            line_wrap: false,
            font_name: textFont(shape.fontPx),
            color: this._coglColor('#000000', 0),
            cursor_color: this._coglColor(shape.color),
            selected_text_color: this._coglColor('#ffffff', 0),
            selection_color: this._coglColor('#3584e4', 0.45),
            text: shape.text,
        });
        this._textActor.connect('text-changed', actor => {
            this._changeEditedText(() => {
                this._current.text = actor.get_text();
            });
        });
        // Keys the editor has no use for would bubble up to the native handler,
        // where Ctrl+V switches to recording and Ctrl+Space saves and closes.
        this._textActor.connect_after('key-press-event', () => Clutter.EVENT_STOP);

        // The editor turns with the text, around the same centre, so the caret and
        // a selection made with the mouse sit right on the turned letters.
        this._textHolder = new Clutter.Actor();
        this._textHolder.add_child(this._textActor);
        this._catcher.add_child(this._textHolder);
        this._placeTextActor();
        global.stage.set_key_focus(this._textActor);
        this._overlay.hide();
        this._updateLive();
        this._syncTextRow();
    }

    // The text's start stays where it is on screen while it grows or shrinks, also
    // when it is turned, so typing extends it along its own direction.
    _changeEditedText(change) {
        const shape = this._current;
        const angle = shape.angle ?? 0;
        const [ax, ay] = rotateAround(shape.x, shape.y, ...textCenter(shape), angle);
        change();
        const [bx, by] = rotateAround(shape.x, shape.y, ...textCenter(shape), angle);
        shape.x += ax - bx;
        shape.y += ay - by;
        this._placeTextActor();
        this._updateLive();
    }

    _placeTextActor() {
        const shape = this._current;
        const [cx, cy] = textCenter(shape);
        this._textHolder.set_position(cx, cy);
        this._textHolder.rotation_angle_z = (shape.angle ?? 0) * 180 / Math.PI;
        this._textActor.set_position(shape.x - cx, shape.y - cy);
    }

    _pasteIntoText() {
        const actor = this._textActor;
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (text && actor === this._textActor) {
                actor.delete_selection();
                actor.insert_text(text, actor.get_cursor_position());
            }
        });
    }

    _startText(x, y) {
        this._textEdit = null;
        this._openTextActor({
            type: 'text',
            color: this._color,
            ...this._textStyle,
            x,
            y,
            text: '',
        });
    }

    _editText(shape) {
        const index = this._shapes.indexOf(shape);
        this._pushUndo();
        this._shapes.splice(index, 1);
        this._selected = null;
        this._refreshCommitted();
        this._textEdit = {index, original: shape};
        this._openTextActor({...shape});
        // Caret at the end with nothing selected, so typing adds to the text.
        this._textActor.set_cursor_position(-1);
        this._textActor.set_selection_bound(-1);
    }

    _closeTextActor() {
        this._textHolder.destroy();
        this._textHolder = null;
        this._textActor = null;
        this._current = null;
        this._lastClick = null; // Clicks in the editor must not pair with later ones.
        this._live.hide();
        // Only while modal: focus on a closed UI would swallow the user's typing.
        if (this._ui._grabHelper.grabbed)
            global.stage.set_key_focus(this._ui);
    }

    _discardText() {
        if (!this._textActor)
            return;
        this._closeTextActor();

        // Editing existing text: put it back as it was.
        if (this._textEdit) {
            const {index, original} = this._textEdit;
            this._textEdit = null;
            this._undoStack.pop();
            this._shapes.splice(index, 0, original);
            this._refreshCommitted();
            this._select(original);
            this._syncUndo();
            return;
        }
        this._syncTextRow();
    }

    _commitText() {
        if (!this._textActor)
            return;
        const shape = this._current;
        const edit = this._textEdit;
        this._textEdit = null;
        this._closeTextActor();

        const hasText = shape.text.trim().length > 0;
        if (edit) {
            // The undo step was taken when editing began.
            if (hasText)
                this._shapes.splice(edit.index, 0, shape);
            this._refreshCommitted();
            this._select(hasText ? shape : null);
        } else if (hasText) {
            this._commit(shape, true);
        } else {
            this._syncTextRow();
        }
    }

    // ---- export ----

    // Closes at once and finishes in the background, so the desktop is usable the
    // moment the key is pressed.
    _exportAndClose(options) {
        this._commitText();

        // An app asked for this screenshot, and it takes the UI closing before the
        // file exists as a cancel. That one has to finish first.
        if (this._ui._currentMode === UI_MODE_SCREENSHOT_ONLY)
            return this._exportForApp(options);

        const job = beginExport(this._ui, this._shapes);
        // Nothing to capture, such as window mode with no window chosen. The UI
        // stays, so the user can pick one.
        if (!job)
            return Promise.resolve();

        this._ui.close(true);

        return finishExport(this._ui, job, {...options, rescue: true}).catch(e => {
            logError(e, 'screenshot-plus: export failed');
            Main.notifyError(t('error.capture'), e.message);
        });
    }

    // On failure the UI stays open, so the capture and the drawing are not lost.
    // The app gets its file whichever button was used; the clipboard gets the
    // image only when copying was asked for.
    async _exportForApp({copy}) {
        if (this._exporting)
            return;
        this._exporting = true;
        try {
            const job = beginExport(this._ui, this._shapes);
            if (!job)
                return;
            await finishExport(this._ui, job, {copy, save: true});
            this._ui.close();
        } catch (e) {
            logError(e, 'screenshot-plus: export failed');
            Main.notifyError(t('error.save'), e.message);
        } finally {
            this._exporting = false;
        }
    }
}
