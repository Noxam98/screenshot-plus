// Pure geometry checks. Run with: gjs -m tests/shapes-test.js
import {exit} from 'system';
import {
    hitTest, handlesOf, moveCounterBadge, moveShape, overCounterBadge, resizeShape, shapeBox,
    shapeBounds, textCenter, withTip,
} from '../shapes.js';

let failed = 0;
function check(name, condition, detail = '') {
    if (!condition) {
        failed++;
        print(`FAIL ${name} ${detail}`);
    }
}
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;

const rect = {type: 'rect', color: '#ff0000', width: 4, x1: 100, y1: 100, x2: 300, y2: 200};

let r = resizeShape(rect, 'se', 500, 300);
check('se keeps nw', r.x1 === 100 && r.y1 === 100, JSON.stringify(r));
check('se scales', near(r.x2, 500) && near(r.y2, 300), JSON.stringify(r));

r = resizeShape(rect, 'e', 400, 999);
check('edge moves one axis', near(r.x2, 400) && r.y1 === 100 && r.y2 === 200, JSON.stringify(r));

r = resizeShape(rect, 'nw', 50, 50);
check('nw keeps se', near(r.x2, 300) && near(r.y2, 200) && near(r.x1, 50) && near(r.y1, 50), JSON.stringify(r));

r = resizeShape(rect, 'se', 500, 150, true);
const [, , w1, h1] = shapeBox(r);
check('shift keeps aspect', near(w1 / h1, 2), `${w1}/${h1}`);

const line = {type: 'arrow', color: '#ff0000', width: 4, x1: 0, y1: 0, x2: 100, y2: 0};
r = resizeShape(line, 'p2', 50, 80);
check('arrow end only', r.x1 === 0 && r.x2 === 50 && r.y2 === 80);
check('arrow has two handles', handlesOf(line).length === 2);

const flat = {type: 'pen', color: '#ff0000', width: 4, points: [[10, 10], [110, 10]]};
r = resizeShape(flat, 'se', 210, 500);
check('zero height stroke survives', r.points.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1])), JSON.stringify(r.points));
check('stroke scales in x', near(r.points[1][0], 210), JSON.stringify(r.points));

const text = {
    type: 'text', color: '#ff0000', x: 200, y: 200, text: 'Привет', fontPx: 40,
    outlineColor: '#ffffff', outlineWidth: 2, bgColor: '#000000', bgAlpha: 0.8,
    bgPadX: 0.3, bgPadY: 0.1,
};
const [tx, ty, tw, th] = shapeBox(text);
const [tcx, tcy] = [tx + tw / 2, ty + th / 2];
check('text box has size', tw > 40 && th > 20, `${tw}x${th}`);

// Width must follow the font size smoothly: no steps, no rounding.
const plain = {type: 'text', color: '#ff0000', x: 0, y: 0, text: 'Широкий текст iiiWWW 123', fontPx: 10, outlineColor: null, outlineWidth: 0, bgColor: null, bgAlpha: 1};
const widthAt = fontPx => shapeBox({...plain, fontPx})[2] - 4; // Minus fixed padding.
const perPixel = widthAt(100) / 100;
let worstStep = 0;
let previous = widthAt(12);
for (let fontPx = 12.1; fontPx < 200; fontPx += 0.1) {
    const width = widthAt(fontPx);
    check('width only grows', width > previous, `${fontPx}`);
    worstStep = Math.max(worstStep, Math.abs(width - perPixel * fontPx));
    previous = width;
}
check('width is exactly proportional to font size', worstStep < 0.001, `off by ${worstStep}px`);

const ids = handlesOf(text).map(h => h.id).join();
check('text has side handles and a grip', ids === 'left,right,grip', ids);

const handle = (shape, id) => handlesOf(shape).find(h => h.id === id);
const pinned = (a, b) => near(a.x, b.x, 0.01) && near(a.y, b.y, 0.01);
const leftAtRest = handle(text, 'left');
const rightAtRest = handle(text, 'right');

r = resizeShape(text, 'right', leftAtRest.x + tw * 2, tcy);
check('right handle doubles', near(r.fontPx, 80, 2), `${r.fontPx}`);
check('right handle keeps it straight', near(r.angle, 0), `${r.angle}`);
check('right handle pins the left one', pinned(handle(r, 'left'), leftAtRest), JSON.stringify(handle(r, 'left')));
check('right handle lands under the pointer', near(handle(r, 'right').x, leftAtRest.x + tw * 2, 0.01), JSON.stringify(handle(r, 'right')));

r = resizeShape(text, 'left', rightAtRest.x - tw * 2, tcy);
check('left handle pins the right one', pinned(handle(r, 'right'), rightAtRest), JSON.stringify(handle(r, 'right')));
check('left handle at rest stays straight', near(Math.sin(r.angle), 0), `${r.angle}`);
check('left handle lands under the pointer', near(handle(r, 'left').x, rightAtRest.x - tw * 2, 0.01), JSON.stringify(handle(r, 'left')));

r = resizeShape(text, 'right', leftAtRest.x, leftAtRest.y + tw);
check('right handle down turns 90', near(r.angle, Math.PI / 2), `${r.angle}`);
check('turning alone keeps the size', near(r.fontPx, 40, 1), `${r.fontPx}`);
check('turning pins the left handle', pinned(handle(r, 'left'), leftAtRest), JSON.stringify(handle(r, 'left')));

r = resizeShape(text, 'left', rightAtRest.x, rightAtRest.y - tw);
check('left handle up turns the same way', near(r.angle, Math.PI / 2), `${r.angle}`);
check('that pins the right handle', pinned(handle(r, 'right'), rightAtRest), JSON.stringify(handle(r, 'right')));

r = resizeShape(text, 'right', leftAtRest.x + 200, tcy + 3);
check('angle sticks near straight', r.angle === 0, `${r.angle}`);
r = resizeShape(text, 'right', leftAtRest.x + 200, tcy + 60);
check('angle is free further away', r.angle > 0.2, `${r.angle}`);
r = resizeShape(text, 'right', leftAtRest.x + 200, tcy + 60, true);
check('shift snaps to 15 degrees', near(r.angle % (Math.PI / 12), 0) || near(r.angle % (Math.PI / 12), Math.PI / 12), `${r.angle}`);

r = resizeShape(text, 'right', tcx + 100000, tcy);
check('text may not explode', r.fontPx <= 300 && r.fontPx >= 8, `${r.fontPx}`);
const follows = resizeShape(text, 'right', leftAtRest.x + 300, leftAtRest.y + 170);
check('the handle is exactly under the pointer', near(handle(follows, 'right').x, leftAtRest.x + 300, 0.01) && near(handle(follows, 'right').y, leftAtRest.y + 170, 0.01), JSON.stringify(handle(follows, 'right')));
check('the pin holds at the size limit', pinned(handle(r, 'left'), leftAtRest), JSON.stringify(handle(r, 'left')));
r = resizeShape(text, 'right', leftAtRest.x, leftAtRest.y);
check('text may not vanish', r.fontPx >= 8 && Number.isFinite(r.x), `${r.fontPx}`);
check('the pin holds at zero distance', pinned(handle(r, 'left'), leftAtRest), JSON.stringify(handle(r, 'left')));

const turned = {...text, angle: Math.PI / 2};
const handles = Object.fromEntries(handlesOf(turned).map(h => [h.id, h]));
check('handles turn with the text', near(handles.right.x, tcx, 0.5) && near(handles.right.y, tcy + tw / 2, 0.5), JSON.stringify(handles.right));
check('grip turns with the text', handles.grip.x > tcx && near(handles.grip.y, tcy, 0.5), JSON.stringify(handles.grip));
check('hit follows the turn', hitTest(turned, tcx, tcy + tw / 2 - 3) && !hitTest(turned, tcx + tw / 2 - 3, tcy));
const [, , bw] = shapeBounds(turned);
check('bounds follow the turn', bw < tw, `${bw} vs ${tw}`);
const turnedMoved = moveShape(turned, 5, 5);
check('moving keeps the angle', turnedMoved.angle === turned.angle && turnedMoved.x === turned.x + 5);
const turnedLeft = handlesOf(turned).find(h => h.id === 'left');
const keep = resizeShape(turned, 'right', turnedLeft.x + 150, turnedLeft.y + 150);
check('turned text pins its handle too', pinned(handle(keep, 'left'), turnedLeft), JSON.stringify(handle(keep, 'left')));
const movedByGrip = moveShape(turned, 40, -10);
check('the grip keeps the handles in step', near(handle(movedByGrip, 'left').x, turnedLeft.x + 40) && near(handle(movedByGrip, 'left').y, turnedLeft.y - 10));

// The background's padding changes only its own axis and never moves the text.
const pads = {...text, outlineColor: null, bgPadX: 0, bgPadY: 0};
const [px0, py0, pw0, ph0] = shapeBox(pads);
check('bare background hugs the letters', ph0 > 36 && ph0 < 42, `${ph0} at 40px`);
const taller = shapeBox({...pads, bgPadY: 0.5});
check('height step grows up and down only',
    near(taller[3], ph0 + 40) && near(taller[1], py0 - 20) && near(taller[2], pw0) && near(taller[0], px0),
    JSON.stringify(taller));
const wider = shapeBox({...pads, bgPadX: 0.5});
check('width step grows sideways only',
    near(wider[2], pw0 + 40) && near(wider[0], px0 - 20) && near(wider[3], ph0) && near(wider[1], py0),
    JSON.stringify(wider));
const centerOf = shape => textCenter(shape).map(v => v.toFixed(6)).join();
check('padding leaves the centre alone', centerOf(pads) === centerOf({...pads, bgPadX: 1, bgPadY: 1}));
check('switching the background leaves the centre alone', centerOf(pads) === centerOf({...pads, bgColor: null}));
const boxFor = letters => shapeBox({...pads, text: letters});
check('ordinary letters share one box, so it does not jump while typing',
    near(boxFor('а')[3], boxFor('аул')[3]) && near(boxFor('а')[1], boxFor('аул')[1]),
    `${boxFor('а')} ${boxFor('аул')}`);
check('Й gets room for its mark', boxFor('Йод')[1] < boxFor('Иод')[1] - 4, `${boxFor('Йод')} ${boxFor('Иод')}`);
check('nothing typed yet still has the ordinary box', near(boxFor('')[3], boxFor('а')[3]), `${boxFor('')} ${boxFor('а')}`);
check('several lines stack', boxFor('а\nа')[3] > boxFor('а')[3] * 2, `${boxFor('а\nа')}`);
const scaled = resizeShape(pads, 'right', handle(pads, 'left').x + pw0 * 2, handle(pads, 'left').y);
check('bare background keeps its pinned handle when scaled', pinned(handle(scaled, 'left'), handle(pads, 'left')), JSON.stringify(handle(scaled, 'left')));

check('bounds are integers', shapeBounds(text).every(Number.isInteger), `${shapeBounds(text)}`);
check('empty text still has a box', shapeBox({...text, text: ''})[3] > 10);

const counter = {type: 'counter', color: '#ff0000', x: 100, y: 100, radius: 20, number: 1};
r = resizeShape(counter, 'se', 160, 160);
check('counter grows', near(r.radius, 40), `${r.radius}`);
check('counter hit', hitTest(counter, 110, 110) && !hitTest(counter, 200, 200));

// A number with an arrow.
check('plain number has no tip handle', !handle(counter, 'tip'));
check('a shaky click stays a plain number', withTip(counter, 105, 105).tipX === undefined);
const pointer = withTip(counter, 300, 100);
check('arrow reaches the pointer', pointer.tipX === 300 && pointer.tipY === 100 && handle(pointer, 'tip').x === 300);
check('shift keeps the arrow straight', near(withTip(counter, 300, 130, true).tipY, 100), JSON.stringify(withTip(counter, 300, 130, true)));
check('arrow can be grabbed', hitTest(pointer, 200, 103) && !hitTest(pointer, 200, 130));
const [bLeft, bTop, bWidth, bHeight] = shapeBounds(pointer);
check('bounds hold circle and whole head',
    bLeft <= 80 && bTop <= 80 && bLeft + bWidth >= 312 && bTop + bHeight >= 112, `${shapeBounds(pointer)}`);
const backwards = shapeBounds(withTip(counter, -100, -100));
check('bounds hold an arrow pointing back', backwards[0] <= -112 && backwards[1] <= -112 && backwards[0] + backwards[2] >= 120, `${backwards}`);
r = resizeShape(pointer, 'tip', 300, 400);
check('tip moves alone', r.tipX === 300 && r.tipY === 400 && r.x === 100 && r.y === 100, JSON.stringify(r));
check('tip dragged onto the number drops the arrow', resizeShape(pointer, 'tip', 105, 105).tipX === undefined);
r = moveCounterBadge(pointer, 0, 50);
check('number moves alone', r.y === 150 && r.tipX === 300 && r.tipY === 100, JSON.stringify(r));
check('number dragged onto the tip drops the arrow', moveCounterBadge(pointer, 195, 0).tipX === undefined);
r = moveShape(pointer, 10, 20);
check('whole thing moves together', r.x === 110 && r.y === 120 && r.tipX === 310 && r.tipY === 120, JSON.stringify(r));
check('plain number gains no tip by moving', moveShape(counter, 1, 1).tipX === undefined && !('tipX' in moveShape(counter, 1, 1)));
r = resizeShape(pointer, 'se', 160, 160);
check('resizing the circle leaves the tip', near(r.radius, 40) && r.tipX === 300 && r.tipY === 100, JSON.stringify(r));
check('badge detection', overCounterBadge(pointer, 110, 110) && !overCounterBadge(pointer, 200, 100) && !overCounterBadge(counter, 110, 110));

check('rect inside when free', hitTest(rect, 200, 150));
check('rect inside not when drawing', !hitTest(rect, 200, 150, true));
check('rect edge when drawing', hitTest(rect, 100, 150, true));
const ellipse = {...rect, type: 'ellipse'};
check('ellipse centre', hitTest(ellipse, 200, 150) && !hitTest(ellipse, 200, 150, true));
check('ellipse edge', hitTest(ellipse, 100, 150, true));
check('line hit', hitTest(line, 50, 2) && !hitTest(line, 50, 40));

const moved = moveShape(rect, 10, -5);
check('move', moved.x1 === 110 && moved.y2 === 195 && rect.x1 === 100);
const movedPen = moveShape(flat, 1, 1);
check('move is pure', flat.points[0][0] === 10 && movedPen.points[0][0] === 11);

print(failed ? `${failed} FAILED` : 'all shape checks passed');
exit(failed ? 1 : 0);
