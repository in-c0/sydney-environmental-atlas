// SHOWHAUS Room: what a sentence turns into, and what each step does to the room.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, apply, emptyState, describe } from '../dist/showhaus/room/intent.js';

const items = [{ uid: 'a', name: 'Sofa', label: 'couch' }, { uid: 'b', name: 'Reading lamp', label: null, light: true }, { uid: 'c', name: 'Chair', label: 'chair' }];
const ops = (t, sel) => parse(t, { items, selected: sel }).ops;

test('moves the named thing by the amount said (Korean and English)', () => {
  assert.deepEqual(ops('소파 30cm 왼쪽으로'), [{ op: 'nudge', uid: 'a', dir: 'left', m: 0.3 }]);
  assert.deepEqual(ops('move the chair 1.2m right'), [{ op: 'nudge', uid: 'c', dir: 'right', m: 1.2 }]);
  assert.deepEqual(ops('sofa against the wall'), [{ op: 'toWall', uid: 'a' }]);
});
test('turns, resizes and removes', () => {
  assert.deepEqual(ops('의자 45도 돌려'), [{ op: 'rotate', uid: 'c', by: -45 }]);
  assert.deepEqual(ops('sofa width 1.8m'), [{ op: 'size', uid: 'a', dim: 'w', m: 1.8 }]);
  assert.equal(ops('make it bigger', 'c')[0].uid, 'c');
  assert.deepEqual(ops('remove the chair'), [{ op: 'remove', uid: 'c' }]);
});
test('lights, walls, floor, time of day', () => {
  assert.deepEqual(ops('조명 꺼줘'), [{ op: 'light', uid: 'b', on: false }]);
  assert.deepEqual(parse('lights off', { items: [items[0]] }).ops, [{ op: 'lights', on: false }], 'a sofa never becomes a light by accident');
  assert.deepEqual(ops('turn all lights on'), [{ op: 'lights', on: true }]);
  assert.deepEqual(ops('벽지 세이지 줄무늬로'), [{ op: 'wall', colour: 'sage', pattern: 'stripes' }]);
  assert.deepEqual(ops('floor tile'), [{ op: 'floor', floor: 'tile' }]);
  assert.deepEqual(ops('night').map(o => o.op), ['sun']);
});
test('says nothing for a sentence with no change', () => { assert.deepEqual(ops('hello there'), []); });

test('steps are pure and every earlier state survives', () => {
  const s0 = apply(emptyState(), { op: 'space', space: { kind: 'tape', w: 4, d: 3 } });
  const s1 = apply(s0, { op: 'add', uid: 'x', obj: 'o', name: 'Lamp', light: true, dims: { w: 0.4, d: 0.4, h: 1.5 }, x: 2, y: 1.5 });
  const s2 = apply(s1, { op: 'light', uid: 'x', on: false });
  const s3 = apply(s2, { op: 'size', uid: 'x', dim: 'h', m: 1.8 });
  assert.equal(s1.items[0].on, true); assert.equal(s2.items[0].on, false); assert.equal(s1.items[0].on, true);
  assert.ok(Math.abs(s3.items[0].k - 1.2) < 1e-9);
  assert.equal(apply(s3, { op: 'rotate', uid: 'x', by: -90 }).items[0].r, 270);
  assert.match(describe({ op: 'add', name: 'Lamp' }), /Placed Lamp/);
});

import { estimate, shapeOf } from '../dist/showhaus/room/mesh.js';
test('sizes: everyday things have real sizes, unknown things ask instead of inventing one', () => {
  assert.equal(estimate('remote', 400, 100).w, 0.2);           // was 2.55 m wide (probe, 27 Nov)
  assert.equal(estimate('cat', 300, 260).h, 0.3);              // was 80 cm tall
  const u = estimate(null, 300, 200); assert.equal(u.basis, 'unknown'); assert.equal(u.h, null);
  const r = estimate(null, 300, 200, 0.15); assert.equal(r.basis, 'rough'); assert.equal(r.h, 0.15); assert.ok(r.w < 0.3);
  assert.equal(shapeOf('couch'), 'sofa'); assert.equal(shapeOf('cat'), null);
});

import { fitLine, fitVerdict, footprint } from '../dist/showhaus/room/fit.js';
import { roomPlan } from '../dist/showhaus/walk/plan-core.js';
test('fit: says whether a thing fits where it stands, and when a walkway is too narrow', () => {
  const plan = roomPlan(4.2, 3.6), sofa = (x, y, r = 0) => ({ uid: 's', name: 'Sofa', x, y, r, k: 1, dims: { w: 2.2, d: 1.0, h: 0.9 } });
  const b = plan.outline.reduce((a, [x, y]) => [Math.min(a[0], x), Math.min(a[1], y), Math.max(a[2], x), Math.max(a[3], y)], [9, 9, -9, -9]);
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  assert.equal(fitLine(plan, [sofa(cx, cy)], 's').tone, 'ok');
  assert.equal(fitLine(plan, [sofa(b[2] - 0.5, cy)], 's').tone, 'no');                       // half through the east wall
  assert.match(fitLine(plan, [sofa(b[0] + 1.1 + 0.3, cy)], 's').text, /tight: 30 cm to walk past/); // 30 cm from the west wall
  const bed = { uid: 'b', name: 'Bed', x: cx, y: cy, r: 0, k: 1, dims: { w: 1.6, d: 2.0, h: 1 } };
  assert.equal(fitLine(plan, [sofa(cx, cy), bed], 's').text, 'Overlaps the bed');
  assert.ok(Math.abs(footprint(sofa(0, 0, 90)).w - 1.0) < 1e-9);                               // turned 90°: footprint swaps
});
test('fit verdict: an unmeasured side is checked at the largest it could be', () => {
  const plan = roomPlan(4.2, 3.6), b = plan.outline.reduce((a, [x, y]) => [Math.min(a[0], x), Math.min(a[1], y), Math.max(a[2], x), Math.max(a[3], y)], [9, 9, -9, -9]);
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, at = (w, d) => [{ uid: 's', name: 'Sofa', x: cx, y: cy, r: 0, k: 1, dims: { w, d, h: 0.9 } }];
  assert.equal(fitVerdict(plan, at(2.2, 1.0), 's', { w: 1, d: 1 }).tone, 'ok');                // all measured: the plain verdict
  const v = fitVerdict(plan, at(4.0, 1.0), 's', { w: 1.35, d: 1 });                            // 4.0 m fits a 4.2 m wall, 5.4 m does not
  assert.equal(v.tone, 'tight'); assert.match(v.text, /^Fits if its width is under 4\.\d+ m\. Measure its width$/);
  assert.ok(v.limit.w > 4.0 && v.limit.w < 4.25 && v.limit.d === 1.0, 'the limit is on the unmeasured side only: ' + JSON.stringify(v.limit));
  assert.equal(fitVerdict(plan, at(2.2, 1.0), 's', { w: 1, d: 1.35 }).unsure, undefined);       // deeper still fits: no hedge
  assert.equal(fitVerdict(plan, at(5.0, 1.0), 's', { w: 1.35, d: 1 }).tone, 'no');              // too big at the guess stays a no
});
