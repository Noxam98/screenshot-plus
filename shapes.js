// Annotation shapes in stage (logical) coordinates. The same code paints the
// on-screen canvas and the exported PNG, so what you see is what you get
// regardless of monitor scale. Geometry helpers never mutate: they return new
// shapes, which is what makes undo snapshots safe.

import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

export const MIN_WIDTH = 1;
export const MAX_WIDTH = 30;
export const MIN_FONT = 8;
export const MAX_FONT = 300;
export const MIN_RADIUS = 6;
export const MAX_RADIUS = 200;

const ARROW_ANGLE = Math.PI / 7;
const FONT_FAMILY = 'Sans Bold';
const HIT_TOLERANCE = 6;
const GRIP_DISTANCE = 26;
// A number's arrow must reach this far past the circle, so a shaky click stays a
// plain number.
const MIN_COUNTER_ARROW = 8;
// Straight text is what people usually want, so the angle sticks near it.
const ANGLE_MAGNET = Math.PI / 60;
const ANGLE_STEP = Math.PI / 12;

export function parseColor(hex) {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
}

const pixelBlock = width => Math.max(10, width * 4);
const markerWidth = width => width * 5;

export function textFont(fontPx) {
    return `${FONT_FAMILY} ${fontPx}px`;
}

function setColor(cr, hex, alpha = 1) {
    const [r, g, b] = parseColor(hex);
    cr.setSourceRGBA(r, g, b, alpha);
}

function strokeSetup(cr, width) {
    cr.setLineWidth(width);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
}

function drawPath(cr, shape, width, alpha) {
    setColor(cr, shape.color, alpha);
    strokeSetup(cr, width);
    const [first, ...rest] = shape.points;
    cr.moveTo(first[0], first[1]);
    // A lone point still needs a segment for the round cap to draw a dot.
    if (rest.length === 0)
        cr.lineTo(first[0], first[1]);
    for (const [x, y] of rest)
        cr.lineTo(x, y);
    cr.stroke();
}

function drawArrow(cr, shape) {
    const {x1, y1, x2, y2, width} = shape;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const length = Math.hypot(x2 - x1, y2 - y1);
    const size = Math.min(arrowHeadSize(width), length);

    setColor(cr, shape.color);
    strokeSetup(cr, width);
    cr.moveTo(x1, y1);
    // The shaft stops inside the head so its round cap cannot poke through.
    cr.lineTo(x2 - Math.cos(angle) * size * 0.8, y2 - Math.sin(angle) * size * 0.8);
    cr.stroke();

    cr.moveTo(x2, y2);
    cr.lineTo(x2 - size * Math.cos(angle - ARROW_ANGLE),
        y2 - size * Math.sin(angle - ARROW_ANGLE));
    cr.lineTo(x2 - size * Math.cos(angle + ARROW_ANGLE),
        y2 - size * Math.sin(angle + ARROW_ANGLE));
    cr.closePath();
    cr.fill();
}

function rectOf({x1, y1, x2, y2}) {
    return [
        Math.min(x1, x2),
        Math.min(y1, y2),
        Math.abs(x2 - x1),
        Math.abs(y2 - y1),
    ];
}

function drawEllipse(cr, shape) {
    const [x, y, w, h] = rectOf(shape);
    setColor(cr, shape.color);
    strokeSetup(cr, shape.width);
    cr.save();
    cr.translate(x + w / 2, y + h / 2);
    cr.scale(Math.max(w, 0.5) / 2, Math.max(h, 0.5) / 2);
    cr.arc(0, 0, 1, 0, 2 * Math.PI);
    cr.restore();
    cr.stroke();
}

// Text is laid out once at this size and then only ever scaled, as vector outlines.
// Laying it out at each size would round glyph advances to whole pixels at that
// size, so the width would jump while dragging, and the letters would shift when
// the text is turned. Scaling makes width exactly proportional to the font size.
const REFERENCE_FONT = 256;

let referenceLayoutObject = null;

// One layout, reused: making a new one per keystroke would redo the font lookup.
function referenceLayout(text) {
    if (!referenceLayoutObject) {
        const measureCr = new Cairo.Context(new Cairo.ImageSurface(Cairo.Format.A8, 1, 1));
        const layout = PangoCairo.create_layout(measureCr);
        layout.get_context().set_round_glyph_positions(false);
        layout.context_changed();
        const description = Pango.FontDescription.from_string(FONT_FAMILY);
        description.set_absolute_size(REFERENCE_FONT * Pango.SCALE);
        layout.set_font_description(description);
        referenceLayoutObject = layout;
    }
    if (referenceLayoutObject.get_text() !== text)
        referenceLayoutObject.set_text(text, -1);
    return referenceLayoutObject;
}

// Unrounded [width, height] of the text at this size.
function measure(text, fontPx) {
    const [width, height] = referenceLayout(text).get_size();
    const scale = fontPx / REFERENCE_FONT / Pango.SCALE;
    return [width * scale, height * scale];
}

// Leaves the outlines of the text as the current path, its top-left at (x, y).
function textPath(cr, text, fontPx, x, y) {
    const scale = fontPx / REFERENCE_FONT;
    cr.save();
    cr.translate(x, y);
    cr.scale(scale, scale);
    cr.newPath();
    cr.moveTo(0, 0);
    PangoCairo.layout_path(cr, referenceLayout(text));
    cr.restore();
}

function textSize(shape) {
    // An empty layout has no height, and the editor still needs a box for the caret.
    return measure(shape.text || ' ', shape.fontPx);
}

// How much of a text's lines is empty above and below its letters, as fractions of
// the font size. A line is about 1.4 times the font size and the letters only fill
// about 1, so a box counted from the line looks far too tall. Ordinary letters all
// get the same box, so it does not jump while typing, and only something taller
// than them, such as Й, makes more room for itself.
function emptyLineSpace(layout) {
    const [ink, logical] = layout.get_extents();
    const unit = REFERENCE_FONT * Pango.SCALE;
    return ink.height === 0 ? null : {
        top: (ink.y - logical.y) / unit,
        bottom: (logical.y + logical.height - ink.y - ink.height) / unit,
    };
}

let ordinaryLineSpace = null;

function lineTrim(text) {
    ordinaryLineSpace ??= emptyLineSpace(referenceLayout('lHНру'));
    const own = emptyLineSpace(referenceLayout(text || ' ')) ?? ordinaryLineSpace;
    return {
        top: Math.min(own.top, ordinaryLineSpace.top),
        bottom: Math.min(own.bottom, ordinaryLineSpace.bottom),
    };
}

// [sideways, up and down]. The background's are fractions of the font size, so it
// keeps its proportions when the text is scaled.
function textPadding(shape) {
    const outline = shape.outlineColor ? shape.outlineWidth : 0;
    if (!shape.bgColor)
        return [2 + outline, 2 + outline];
    return [shape.fontPx * shape.bgPadX + outline, shape.fontPx * shape.bgPadY + outline];
}

function roundedRect(cr, x, y, w, h, radius) {
    const r = Math.min(radius, w / 2, h / 2);
    cr.newPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function drawText(cr, shape) {
    if (shape.bgColor) {
        const [x, y, w, h] = shapeBox(shape);
        setColor(cr, shape.bgColor, shape.bgAlpha);
        roundedRect(cr, x, y, w, h, shape.fontPx * 0.25);
        cr.fill();
    }

    if (!shape.text)
        return;

    textPath(cr, shape.text, shape.fontPx, shape.x, shape.y);

    // Stroked first and at double width, so the outline sits outside the glyphs
    // and never eats into them.
    if (shape.outlineColor && shape.outlineWidth > 0) {
        setColor(cr, shape.outlineColor);
        cr.setLineWidth(shape.outlineWidth * 2);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.strokePreserve();
    }

    setColor(cr, shape.color);
    cr.fill();
}

// Scales with the circle, so resizing a number keeps it looking the same.
const counterArrowWidth = shape => Math.max(2, shape.radius * 0.2);
const arrowHeadSize = width => Math.max(12, width * 5);

function drawCounter(cr, shape) {
    if (shape.tipX !== undefined) {
        const dx = shape.tipX - shape.x;
        const dy = shape.tipY - shape.y;
        const distance = Math.hypot(dx, dy);
        // The wheel can grow the circle past the tip.
        if (distance > shape.radius) {
            // From the circle's edge, so a short arrow's head is never under it.
            drawArrow(cr, {
                color: shape.color,
                width: counterArrowWidth(shape),
                x1: shape.x + dx / distance * shape.radius,
                y1: shape.y + dy / distance * shape.radius,
                x2: shape.tipX,
                y2: shape.tipY,
            });
        }
    }

    setColor(cr, shape.color);
    cr.arc(shape.x, shape.y, shape.radius, 0, 2 * Math.PI);
    cr.fill();

    // White reads on every palette colour except the light ones.
    const [r, g, b] = parseColor(shape.color);
    const shade = 0.299 * r + 0.587 * g + 0.114 * b > 0.65 ? 0 : 1;
    cr.setSourceRGBA(shade, shade, shade, 1);
    const label = String(shape.number);
    const fontPx = shape.radius * 1.1;
    const [w, h] = measure(label, fontPx);
    textPath(cr, label, fontPx, shape.x - w / 2, shape.y - h / 2);
    cr.fill();
}

// Averages each block, then upscales without filtering. The original pixels are
// replaced in the exported file, so nothing but the blocks ends up in it.
function drawPixelate(cr, shape, base) {
    const [x, y, w, h] = rectOf(shape);
    if (w < 1 || h < 1)
        return;

    if (!base) {
        cr.setSourceRGBA(0.5, 0.5, 0.5, 1);
        cr.rectangle(x, y, w, h);
        cr.fill();
        return;
    }

    const block = pixelBlock(shape.width);
    const small = new Cairo.ImageSurface(Cairo.Format.RGB24,
        Math.ceil(w / block), Math.ceil(h / block));
    const smallCr = new Cairo.Context(small);
    smallCr.scale(1 / (block * base.scale), 1 / (block * base.scale));
    smallCr.translate(-(x - base.x) * base.scale, -(y - base.y) * base.scale);
    smallCr.setSourceSurface(base.surface, 0, 0);
    smallCr.getSource().setFilter(Cairo.Filter.GOOD);
    smallCr.paint();
    smallCr.$dispose();

    cr.save();
    cr.rectangle(x, y, w, h);
    cr.clip();
    // Beyond the captured image there is nothing to take the colours from.
    cr.rectangle(base.x, base.y,
        base.surface.getWidth() / base.scale, base.surface.getHeight() / base.scale);
    cr.clip();
    cr.translate(x, y);
    cr.scale(block, block);
    cr.setSourceSurface(small, 0, 0);
    cr.getSource().setFilter(Cairo.Filter.NEAREST);
    cr.paint();
    cr.restore();
    small.finish();
}

// `base` is {surface, x, y, scale}: the captured image behind the selection.
export function drawShape(cr, shape, base = null) {
    switch (shape.type) {
    case 'pen':
        drawPath(cr, shape, shape.width, 1);
        break;
    case 'marker':
        drawPath(cr, shape, markerWidth(shape.width), 0.4);
        break;
    case 'line':
        setColor(cr, shape.color);
        strokeSetup(cr, shape.width);
        cr.moveTo(shape.x1, shape.y1);
        cr.lineTo(shape.x2, shape.y2);
        cr.stroke();
        break;
    case 'arrow':
        drawArrow(cr, shape);
        break;
    case 'rect': {
        const [x, y, w, h] = rectOf(shape);
        setColor(cr, shape.color);
        strokeSetup(cr, shape.width);
        cr.rectangle(x, y, w, h);
        cr.stroke();
        break;
    }
    case 'ellipse':
        drawEllipse(cr, shape);
        break;
    case 'text':
        if (shape.angle) {
            const [cx, cy] = textCenter(shape);
            cr.save();
            cr.translate(cx, cy);
            cr.rotate(shape.angle);
            cr.translate(-cx, -cy);
            drawText(cr, shape);
            cr.restore();
        } else {
            drawText(cr, shape);
        }
        break;
    case 'counter':
        drawCounter(cr, shape);
        break;
    case 'pixelate':
        drawPixelate(cr, shape, base);
        break;
    }
}

export function rotateAround(x, y, cx, cy, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [
        cx + (x - cx) * cos - (y - cy) * sin,
        cy + (x - cx) * sin + (y - cy) * cos,
    ];
}

export function textCenter(shape) {
    const [x, y, w, h] = shapeBox(shape);
    return [x + w / 2, y + h / 2];
}

// The same text at another size, still centred where it was.
export function resizeTextAroundCenter(shape, fontPx) {
    const [cx, cy] = textCenter(shape);
    const resized = {...shape, fontPx};
    const [nx, ny] = textCenter(resized);
    resized.x += cx - nx;
    resized.y += cy - ny;
    return resized;
}

// The corners of a text's box, turned with it, in stage coordinates.
export function textCorners(shape) {
    const [x, y, w, h] = shapeBox(shape);
    const [cx, cy] = textCenter(shape);
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
        .map(([px, py]) => rotateAround(px, py, cx, cy, shape.angle ?? 0));
}

// The shape's own box [x, y, w, h], before any rotation.
export function shapeBox(shape) {
    switch (shape.type) {
    case 'pen':
    case 'marker': {
        const xs = shape.points.map(p => p[0]);
        const ys = shape.points.map(p => p[1]);
        const left = Math.min(...xs);
        const top = Math.min(...ys);
        return [left, top, Math.max(...xs) - left, Math.max(...ys) - top];
    }
    case 'text': {
        const [w, h] = textSize(shape);
        const [padX, padY] = textPadding(shape);
        const {top, bottom} = lineTrim(shape.text);
        return [
            shape.x - padX,
            shape.y + top * shape.fontPx - padY,
            w + 2 * padX,
            h - (top + bottom) * shape.fontPx + 2 * padY,
        ];
    }
    case 'counter':
        return [
            shape.x - shape.radius,
            shape.y - shape.radius,
            shape.radius * 2,
            shape.radius * 2,
        ];
    default:
        return rectOf(shape);
    }
}

function strokeReach(shape) {
    switch (shape.type) {
    case 'marker':
        return markerWidth(shape.width);
    case 'arrow':
        return arrowHeadSize(shape.width);
    case 'text':
    case 'counter':
        return 2;
    default:
        return shape.width;
    }
}

// Paint bounds as integers. Keeps the live canvas small, since re-uploading a 4K
// canvas per pointer motion would make drawing visibly lag.
export function shapeBounds(shape) {
    let [x, y, w, h] = shapeBox(shape);
    if (shape.type === 'text' && shape.angle) {
        const corners = textCorners(shape);
        const xs = corners.map(c => c[0]);
        const ys = corners.map(c => c[1]);
        x = Math.min(...xs);
        y = Math.min(...ys);
        w = Math.max(...xs) - x;
        h = Math.max(...ys) - y;
    }
    if (shape.type === 'counter' && shape.tipX !== undefined) {
        const head = arrowHeadSize(counterArrowWidth(shape));
        const right = Math.max(x + w, shape.tipX + head);
        const bottom = Math.max(y + h, shape.tipY + head);
        x = Math.min(x, shape.tipX - head);
        y = Math.min(y, shape.tipY - head);
        w = right - x;
        h = bottom - y;
    }
    const pad = strokeReach(shape) + 2;
    const left = Math.floor(x - pad);
    const top = Math.floor(y - pad);
    return [
        left,
        top,
        Math.ceil(x + w + pad) - left,
        Math.ceil(y + h + pad) - top,
    ];
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0
        ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function nearBoxEdge(shape, px, py, tolerance) {
    const [x, y, w, h] = shapeBox(shape);
    const inOuter = px >= x - tolerance && px <= x + w + tolerance &&
        py >= y - tolerance && py <= y + h + tolerance;
    const inInner = px > x + tolerance && px < x + w - tolerance &&
        py > y + tolerance && py < y + h - tolerance;
    return inOuter && !inInner;
}

function insideBox(shape, px, py) {
    const [x, y, w, h] = shapeBox(shape);
    return px >= x && px <= x + w && py >= y && py <= y + h;
}

// `edgesOnly` makes hollow shapes grabbable by their outline alone. While a
// drawing tool is active, the inside of the last rectangle must still start a new
// shape rather than drag the old one.
export function hitTest(shape, px, py, edgesOnly = false) {
    const reach = Math.max(HIT_TOLERANCE, shape.width ? shape.width / 2 + 3 : 0);
    switch (shape.type) {
    case 'pen':
    case 'marker': {
        const tolerance = shape.type === 'marker'
            ? markerWidth(shape.width) / 2 + 3 : reach;
        const {points} = shape;
        if (points.length === 1)
            return Math.hypot(px - points[0][0], py - points[0][1]) <= tolerance;
        return points.slice(1).some(([x, y], i) =>
            distanceToSegment(px, py, points[i][0], points[i][1], x, y) <= tolerance);
    }
    case 'line':
    case 'arrow':
        return distanceToSegment(px, py, shape.x1, shape.y1, shape.x2, shape.y2) <= reach;
    case 'rect':
    case 'pixelate':
        return edgesOnly ? nearBoxEdge(shape, px, py, reach) : insideBox(shape, px, py);
    case 'ellipse': {
        const [x, y, w, h] = shapeBox(shape);
        const rx = Math.max(w / 2, 1);
        const ry = Math.max(h / 2, 1);
        const d = Math.hypot((px - x - rx) / rx, (py - y - ry) / ry);
        return edgesOnly
            ? Math.abs(d - 1) * Math.min(rx, ry) <= reach
            : d <= 1;
    }
    case 'counter':
        if (Math.hypot(px - shape.x, py - shape.y) <= shape.radius)
            return true;
        return shape.tipX !== undefined &&
            distanceToSegment(px, py, shape.x, shape.y, shape.tipX, shape.tipY) <= reach;
    case 'text': {
        const [cx, cy] = textCenter(shape);
        const [ux, uy] = rotateAround(px, py, cx, cy, -(shape.angle ?? 0));
        return insideBox(shape, ux, uy);
    }
    default:
        return insideBox(shape, px, py);
    }
}

const BOX_HANDLES = {
    nw: [0, 0],
    n: [0.5, 0],
    ne: [1, 0],
    e: [1, 0.5],
    se: [1, 1],
    s: [0.5, 1],
    sw: [0, 1],
    w: [0, 0.5],
};

// Lines stretch by their ends. Text has two side handles that turn and scale it
// around each other, and a grip above it for moving. Everything else gets a box.
export function handlesOf(shape) {
    if (shape.type === 'line' || shape.type === 'arrow') {
        return [
            {id: 'p1', x: shape.x1, y: shape.y1},
            {id: 'p2', x: shape.x2, y: shape.y2},
        ];
    }
    if (shape.type === 'text') {
        const [bx, by, bw] = shapeBox(shape);
        const [cx, cy] = textCenter(shape);
        const angle = shape.angle ?? 0;
        const place = (id, px, py) => {
            const [x, y] = rotateAround(px, py, cx, cy, angle);
            return {id, x, y};
        };
        return [
            place('left', bx, cy),
            place('right', bx + bw, cy),
            place('grip', cx, by - GRIP_DISTANCE),
        ];
    }
    const [x, y, w, h] = shapeBox(shape);
    const handles = Object.entries(BOX_HANDLES).map(([id, [fx, fy]]) =>
        ({id, x: x + fx * w, y: y + fy * h}));
    if (shape.type === 'counter' && shape.tipX !== undefined)
        handles.push({id: 'tip', x: shape.tipX, y: shape.tipY});
    return handles;
}

// The number with its arrow pointing at (px, py), or with no arrow when that is too
// close to the circle to draw one. Shift keeps the arrow at 45-degree steps.
export function withTip(shape, px, py, straight = false) {
    const {tipX: _tipX, tipY: _tipY, ...plain} = shape;
    const [tipX, tipY] = straight ? constrainEnd('arrow', shape.x, shape.y, px, py) : [px, py];
    return Math.hypot(tipX - shape.x, tipY - shape.y) < shape.radius + MIN_COUNTER_ARROW
        ? plain : {...plain, tipX, tipY};
}

export function overCounterBadge(shape, px, py) {
    return shape.type === 'counter' && shape.tipX !== undefined &&
        Math.hypot(px - shape.x, py - shape.y) <= shape.radius;
}

// Moves the circle only, so the arrow keeps pointing at what it points at.
export function moveCounterBadge(shape, dx, dy) {
    return withTip({...shape, x: shape.x + dx, y: shape.y + dy}, shape.tipX, shape.tipY);
}

export function moveShape(shape, dx, dy) {
    switch (shape.type) {
    case 'pen':
    case 'marker':
        return {...shape, points: shape.points.map(([x, y]) => [x + dx, y + dy])};
    case 'text':
        return {...shape, x: shape.x + dx, y: shape.y + dy};
    case 'counter': {
        const moved = {...shape, x: shape.x + dx, y: shape.y + dy};
        if (shape.tipX !== undefined) {
            moved.tipX = shape.tipX + dx;
            moved.tipY = shape.tipY + dy;
        }
        return moved;
    }
    default:
        return {
            ...shape,
            x1: shape.x1 + dx,
            y1: shape.y1 + dy,
            x2: shape.x2 + dx,
            y2: shape.y2 + dy,
        };
    }
}

// Holding Shift keeps lines at 45-degree steps and boxes square, like Flameshot.
export function constrainEnd(type, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (type === 'rect' || type === 'ellipse' || type === 'pixelate') {
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        return [x1 + Math.sign(dx || 1) * side, y1 + Math.sign(dy || 1) * side];
    }
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    const length = Math.hypot(dx, dy);
    return [x1 + Math.cos(angle) * length, y1 + Math.sin(angle) * length];
}

function clampScale(scale, value, min, max) {
    return Math.max(min / value, Math.min(max / value, scale));
}

// The shape as if `handle` had been dragged to (px, py), computed from the shape
// as it was when the drag began. The opposite side stays where it is.
function snapAngle(angle, toSteps) {
    if (toSteps)
        return Math.round(angle / ANGLE_STEP) * ANGLE_STEP;
    const nearest = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
    return Math.abs(angle - nearest) <= ANGLE_MAGNET ? nearest : angle;
}

// The opposite handle stays pinned and the dragged one follows the pointer, so the
// line between them gives the angle and their distance gives the size. Shift turns
// in 15 degree steps.
function turnText(shape, handle, px, py, toSteps) {
    const [cx, cy] = textCenter(shape);
    const [, , boxWidth] = shapeBox(shape);
    const side = handle === 'right' ? 1 : -1;
    const oldAngle = shape.angle ?? 0;
    const pinX = cx - side * Math.cos(oldAngle) * boxWidth / 2;
    const pinY = cy - side * Math.sin(oldAngle) * boxWidth / 2;

    const dx = px - pinX;
    const dy = py - pinY;
    const distance = Math.hypot(dx, dy);
    const angle = snapAngle(Math.atan2(side * dy, side * dx), toSteps);

    // Width is linear in the font size, except for the outline's fixed reach, so
    // this settles at once and the handle lands exactly under the pointer.
    let fontPx = shape.fontPx;
    for (let i = 0; i < 4; i++) {
        const [, , width] = shapeBox({...shape, fontPx});
        fontPx = Math.max(MIN_FONT, Math.min(MAX_FONT, fontPx * distance / Math.max(width, 1)));
    }

    // Placed from the real resulting width, which keeps the pinned handle exact
    // even when the font hits its limits.
    const resized = resizeTextAroundCenter(shape, fontPx);
    const [, , width] = shapeBox(resized);
    const [rx, ry] = textCenter(resized);
    return {
        ...moveShape(resized,
            pinX + side * Math.cos(angle) * width / 2 - rx,
            pinY + side * Math.sin(angle) * width / 2 - ry),
        angle,
    };
}

export function resizeShape(shape, handle, px, py, keepAspect = false) {
    if (handle === 'left' || handle === 'right')
        return turnText(shape, handle, px, py, keepAspect);

    if (handle === 'tip')
        return withTip(shape, px, py, keepAspect);

    if (handle === 'p1' || handle === 'p2') {
        const [ax, ay, field] = handle === 'p1'
            ? [shape.x2, shape.y2, ['x1', 'y1']]
            : [shape.x1, shape.y1, ['x2', 'y2']];
        const [x, y] = keepAspect ? constrainEnd(shape.type, ax, ay, px, py) : [px, py];
        return {...shape, [field[0]]: x, [field[1]]: y};
    }

    const [bx, by, bw, bh] = shapeBox(shape);
    const [fx, fy] = BOX_HANDLES[handle];
    const anchorX = bx + (1 - fx) * bw;
    const anchorY = by + (1 - fy) * bh;
    const movesX = fx !== 0.5 && bw > 0;
    const movesY = fy !== 0.5 && bh > 0;

    let sx = movesX ? (px - anchorX) / (fx * bw - (1 - fx) * bw) : 1;
    let sy = movesY ? (py - anchorY) / (fy * bh - (1 - fy) * bh) : 1;

    const uniform = keepAspect || shape.type === 'counter';
    if (uniform) {
        // An edge handle only moves along one axis, and that axis decides.
        const scale = movesX && movesY
            ? Math.max(Math.abs(sx), Math.abs(sy))
            : Math.abs(movesX ? sx : sy);
        sx = sy = scale;
    }

    const mapX = x => anchorX + (x - anchorX) * sx;
    const mapY = y => anchorY + (y - anchorY) * sy;

    switch (shape.type) {
    case 'counter': {
        const s = clampScale(sx, shape.radius, MIN_RADIUS, MAX_RADIUS);
        const scaled = {
            ...shape,
            radius: shape.radius * s,
            x: anchorX + (shape.x - anchorX) * s,
            y: anchorY + (shape.y - anchorY) * s,
        };
        return shape.tipX === undefined ? scaled : withTip(scaled, shape.tipX, shape.tipY);
    }
    case 'pen':
    case 'marker':
        return {...shape, points: shape.points.map(([x, y]) => [mapX(x), mapY(y)])};
    default:
        return {
            ...shape,
            x1: mapX(shape.x1),
            y1: mapY(shape.y1),
            x2: mapX(shape.x2),
            y2: mapY(shape.y2),
        };
    }
}
