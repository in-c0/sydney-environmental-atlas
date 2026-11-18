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
