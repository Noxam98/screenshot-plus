// Where the tool groups go when they are spread around the selection (the
// tools-around-selection setting), the way Flameshot places its buttons: along
// the bottom edge first, then the right, the top and the left, each group whole
// on one edge. What finds no room goes round again further out, so a small
// selection gets its groups further from its edges. When no edge has room at
// all, as with the whole screen, they go inside the selection in rows along its
// bottom.
//
// Pure geometry, checked without a shell: gjs -m tests/layout-test.js

const SIDES = ['bottom', 'right', 'top', 'left'];
const MAX_ROUNDS = 12;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function lineLength(lengths, spacing) {
    return lengths.reduce((sum, length) => sum + length, 0) +
        spacing * Math.max(0, lengths.length - 1);
}

// The size a group takes on a side: a row along the bottom and the top, a
// column along the right and the left. One that has no column stands there as
// it is.
function sizeOn(group, side) {
    return side === 'bottom' || side === 'top' ? group.row : group.column ?? group.row;
}

const overlaps = (a, b, spacing) =>
    a.x < b.x + b.width + spacing && b.x < a.x + a.width + spacing &&
    a.y < b.y + b.height + spacing && b.y < a.y + a.height + spacing;

// Puts as many of `groups` as fit on one side of `box`, in their order, and
// returns the rest. A group that does not fit is skipped, so a later and
// smaller one can still take the side.
function fillSide(side, groups, {box, selection, area, gap, spacing, reach, unturned}, placed) {
    const horizontal = side === 'bottom' || side === 'top';
    // Rows may reach past the corners by as much as a column takes.
    const start = horizontal ? Math.max(area.left, box.left - reach) : Math.max(area.top, box.top);
    const end = horizontal ? Math.min(area.right, box.right + reach) : Math.min(area.bottom, box.bottom);
    // Centred on the part of the selection inside the area.
    const center = horizontal
        ? (Math.max(selection.left, area.left) + Math.min(selection.right, area.right)) / 2
        : (Math.max(selection.top, area.top) + Math.min(selection.bottom, area.bottom)) / 2;

    const within = item => item.x >= area.left && item.y >= area.top &&
        item.x + item.width <= area.right && item.y + item.height <= area.bottom;

    // Where each group of the line goes, or null when the line is too long.
    const lay = line => {
        const sizes = line.map(group => sizeOn(group, side));
        const length = lineLength(sizes.map(([width, height]) => horizontal ? width : height), spacing);
        if (length > end - start)
            return null;
        let along = clamp(center - length / 2, start, end - length);
        return line.map((group, i) => {
            const [width, height] = sizes[i];
            let x, y;
            switch (side) {
            case 'bottom': [x, y] = [along, box.bottom + gap]; break;
            case 'top': [x, y] = [along, box.top - gap - height]; break;
            case 'right': [x, y] = [box.right + gap, along]; break;
            default: [x, y] = [box.left - gap - width, along];
            }
            along += (horizontal ? width : height) + spacing;
            return {group, side, x, y, width, height};
        });
    };

    let line = [];
    let items = [];
    const rest = [];
    for (const group of groups) {
        // One that does not turn waits for the pass that lets it stand here.
        const tried = horizontal || unturned || group.column ? lay([...line, group]) : null;
        if (tried && tried.every(item => within(item) &&
            placed.every(other => !overlaps(item, other, spacing)))) {
            line = [...line, group];
            items = tried;
        } else {
            rest.push(group);
        }
    }
    placed.push(...items);
    return rest;
}

// Rows inside `box`, from its bottom up, each centred on it. A row wider than
// the box stays centred, as far as the area lets it.
function rowsInside(groups, box, area, spacing, placed) {
    let bottom = box.bottom;
    let row = [];
    const flush = () => {
        const length = lineLength(row.map(g => g.row[0]), spacing);
        let x = clamp(box.left + (box.right - box.left - length) / 2, area.left, area.right - length);
        for (const group of row) {
            const [width, height] = group.row;
            placed.push({group, side: 'inside', x, y: bottom - height, width, height});
            x += width + spacing;
        }
        bottom -= Math.max(...row.map(g => g.row[1])) + spacing;
        row = [];
    };
    for (const group of groups) {
        if (row.length > 0 &&
            lineLength([...row, group].map(g => g.row[0]), spacing) > box.right - box.left)
            flush();
        row.push(group);
    }
    if (row.length > 0)
        flush();
}

// The rounds keep groups apart but can leave an empty round between a group
// and the selection. Each group then comes in as close as the others let it.
function pullIn(placed, selection, area, gap, spacing) {
    const offsetOf = item => {
        switch (item.side) {
        case 'bottom': return item.y - selection.bottom;
        case 'top': return selection.top - item.y - item.height;
        case 'right': return item.x - selection.right;
        default: return selection.left - item.x - item.width;
        }
    };
    const moveTo = (item, offset) => {
        switch (item.side) {
        case 'bottom': return {...item, y: selection.bottom + offset};
        case 'top': return {...item, y: selection.top - offset - item.height};
        case 'right': return {...item, x: selection.right + offset};
        default: return {...item, x: selection.left - offset - item.width};
        }
    };
    // The offset at which `item` clears `other` along its own direction.
    const beyond = (item, other) => {
        switch (item.side) {
        case 'bottom': return other.y + other.height + spacing - selection.bottom;
        case 'top': return selection.top - other.y + spacing;
        case 'right': return other.x + other.width + spacing - selection.right;
        default: return selection.left - other.x + spacing;
        }
    };

    for (let i = 0; i < placed.length; i++) {
        const item = placed[i];
        if (item.side === 'inside')
            continue;
        const current = offsetOf(item);
        // Not so close that it leaves the area, as above a selection that is
        // lower than the area reaches.
        const least = {
            bottom: area.top - selection.bottom,
            top: selection.top - area.bottom,
            right: area.left - selection.right,
            left: selection.left - area.right,
        }[item.side];
        let offset = Math.max(gap, least);
        for (;;) {
            const candidate = moveTo(item, offset);
            const blocking = placed.filter(other => other !== item && overlaps(candidate, other, spacing));
            if (blocking.length === 0) {
                placed[i] = candidate;
                break;
            }
            offset = Math.max(...blocking.map(other => beyond(item, other)));
            if (offset >= current)
                break;
        }
    }
}

// groups: [{id, row: [width, height], column: [width, height] or null}] in
//   order. A group without a column stands on the right and the left unturned.
// rect: the selection as [x, y, width, height], or null when there is none.
// area: {left, top, right, bottom} the groups stay within.
// gap: between the selection's edge and a group, outside or inside.
// spacing: between two groups.
// Returns a Map from id to {x, y, vertical}.
export function placeGroups({groups, rect, area, gap, spacing}) {
    const placed = [];
    if (groups.length > 0 && !rect) {
        rowsInside(groups, area, area, spacing, placed);
    } else if (groups.length > 0) {
        const [x, y, width, height] = rect;
        const selection = {left: x, top: y, right: x + width, bottom: y + height};
        const columnWidth = Math.max(0, ...groups.filter(g => g.column).map(g => g.column[0]));
        const reach = gap + columnWidth;
        // Each round is further out than the thickest group.
        const step = spacing + Math.max(...groups.map(g => Math.max(g.row[1], g.column?.[0] ?? 0)));

        // A group that does not turn goes on the right or the left only when
        // neither the bottom nor the top has room for it at any distance.
        let remaining = groups;
        for (const unturned of [false, true]) {
            for (let round = 0; round < MAX_ROUNDS && remaining.length > 0; round++) {
                const grow = round * step;
                const box = {
                    left: selection.left - grow,
                    top: selection.top - grow,
                    right: selection.right + grow,
                    bottom: selection.bottom + grow,
                };
                for (const side of SIDES) {
                    remaining = fillSide(side, remaining,
                        {box, selection, area, gap, spacing, reach, unturned}, placed);
                }
            }
        }
        pullIn(placed, selection, area, gap, spacing);

        if (remaining.length > 0) {
            rowsInside(remaining, {
                left: Math.max(selection.left + gap, area.left),
                top: Math.max(selection.top + gap, area.top),
                right: Math.min(selection.right - gap, area.right),
                bottom: Math.min(selection.bottom - gap, area.bottom),
            }, area, spacing, placed);
        }
    }

    return new Map(placed.map(({group, side, x, y}) => [group.id, {
        x: Math.round(x),
        y: Math.round(y),
        vertical: (side === 'right' || side === 'left') && group.column !== null,
    }]));
}
