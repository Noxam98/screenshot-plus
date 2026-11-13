// Where the tool groups go around the selection. Run with: gjs -m tests/layout-test.js
import {exit} from 'system';
import {placeGroups} from '../toolLayout.js';

let failed = 0;
function check(name, condition, detail = '') {
    if (!condition) {
        failed++;
        print(`FAIL ${name} ${detail}`);
    }
}

// Close to the real sizes on a 1080p panel.
const GROUPS = [
    {id: 'tools', row: [330, 40], column: [40, 330]},
    {id: 'colors', row: [440, 40], column: null},
    {id: 'actions', row: [170, 40], column: [40, 170]},
];
const AREA = {left: 8, top: 8, right: 1912, bottom: 845}; // above GNOME's panel
const GAP = 20;
const SPACING = 6;

const place = (rect, groups = GROUPS, area = AREA) =>
    placeGroups({groups, rect, area, gap: GAP, spacing: SPACING});

const boxOf = (layout, groups, id) => {
    const group = groups.find(g => g.id === id);
    const {x, y, vertical} = layout.get(id);
    const [width, height] = vertical ? group.column : group.row;
    return {x, y, width, height};
};
const overlap = (a, b) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// Every group placed once, inside the area, apart from the others, and either
// clear of the selection or inside it.
function sane(name, rect, groups = GROUPS, area = AREA) {
    const layout = place(rect, groups, area);
    check(`${name}: all placed`, layout.size === groups.length, JSON.stringify([...layout]));
    const boxes = groups.map(g => [g.id, boxOf(layout, groups, g.id)]);
    for (const [id, b] of boxes) {
        check(`${name}: ${id} in area`, b.x >= area.left - 1 && b.y >= area.top - 1 &&
            b.x + b.width <= area.right + 1 && b.y + b.height <= area.bottom + 1, JSON.stringify(b));
        check(`${name}: colors never upright`, id !== 'colors' || !layout.get(id).vertical);
        if (rect) {
            const [x, y, w, h] = rect;
            const sel = {x, y, width: w, height: h};
            // A row wider than the selection is centred on it instead.
            const across = b.width > w - 2 * GAP
                ? Math.abs(b.x + b.width / 2 - (x + w / 2)) <= 1
                : b.x >= x && b.x + b.width <= x + w;
            const inside = across && b.y >= y && b.y + b.height <= y + h;
            const near = {x: x - GAP + 1, y: y - GAP + 1, width: w + 2 * GAP - 2, height: h + 2 * GAP - 2};
            check(`${name}: ${id} clear of the selection or inside it`,
                inside || !overlap(b, near), `${JSON.stringify(b)} ${JSON.stringify(sel)}`);
        }
    }
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            check(`${name}: ${boxes[i][0]} and ${boxes[j][0]} apart`, !overlap(boxes[i][1], boxes[j][1]),
                JSON.stringify([boxes[i], boxes[j]]));
        }
    }
    return layout;
}

// Room under a wide selection: all three in a row there, in order.
let layout = sane('wide', [300, 200, 1200, 400]);
check('wide: one row under', [...layout.values()].every(p => p.y === 620 && !p.vertical),
    JSON.stringify([...layout]));
check('wide: in order', layout.get('tools').x < layout.get('colors').x &&
    layout.get('colors').x < layout.get('actions').x);
check('wide: centred', Math.abs((layout.get('tools').x + layout.get('actions').x + 170) / 2 - 900) <= 1,
    JSON.stringify([...layout]));

// Narrower: what fits stays under it, colors go on top, being a row only.
layout = sane('medium', [660, 300, 600, 300]);
check('medium: tools under', layout.get('tools').y === 620 && !layout.get('tools').vertical);
check('medium: actions under', layout.get('actions').y === 620 && !layout.get('actions').vertical);
check('medium: colors on top', layout.get('colors').y === 300 - GAP - 40, JSON.stringify([...layout]));

// No room under it: the right edge, then the top, then the left.
layout = sane('at the bottom', [700, 300, 500, 545]);
check('at the bottom: nothing under it', [...layout.values()].every(p => p.y < 845 - 40),
    JSON.stringify([...layout]));
check('at the bottom: tools upright on the right', layout.get('tools').vertical &&
    layout.get('tools').x === 1200 + GAP, JSON.stringify([...layout]));
check('at the bottom: colors on top', layout.get('colors').y === 300 - GAP - 40);

// The whole screen: inside, in a row above GNOME's panel.
layout = sane('whole screen', [0, 0, 1920, 1080]);
check('whole screen: one row inside at the bottom',
    [...layout.values()].every(p => p.y === 845 - 40 && !p.vertical), JSON.stringify([...layout]));

// Tiny: further out than the gap, never over each other or the selection.
layout = sane('tiny', [900, 400, 40, 30]);
check('tiny: someone right under it', [...layout.values()].some(p => p.y === 430 + GAP),
    JSON.stringify([...layout]));

// Only the buttons that stay in window mode, with no selection.
layout = place(null, [GROUPS[2]]);
check('no selection: bottom centre', layout.get('actions').y === 845 - 40 &&
    Math.abs(layout.get('actions').x - (960 - 85)) <= 1, JSON.stringify([...layout]));

// A taller colors group, as with the text settings under it.
const withText = [GROUPS[0], {id: 'colors', row: [720, 80], column: null}, GROUPS[2]];
sane('text settings', [660, 300, 600, 300], withText);

// Anywhere on the screen, any size.
let seed = 1;
const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
};
for (let i = 0; i < 2000; i++) {
    const w = Math.round(1 + random() * 1919);
    const h = Math.round(1 + random() * 1079);
    const x = Math.round(random() * (1920 - w));
    const y = Math.round(random() * (1080 - h));
    sane(`random ${i}`, [x, y, w, h], random() < 0.5 ? GROUPS : withText);
}

if (failed) {
    print(`${failed} failed`);
    exit(1);
}
print('all passed');
