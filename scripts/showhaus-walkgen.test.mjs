// SHOWHAUS — the plan → walk builder (showhaus/walk-pipeline/walkgen.py): plan validation and the layout it hands the viewer.
// Runs the pure-Python `check` mode only; rendering and baking need Blender and are checked by hand (README there).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = new URL('../showhaus/walk-pipeline/', import.meta.url).pathname;
const check = file => spawnSync('python3', [DIR + 'walkgen.py', file, 'check'], { encoding: 'utf8' });
const layout = file => JSON.parse(spawnSync('python3', ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(DIR)}); import walkgen; print(json.dumps(walkgen.layout(walkgen.load_plan(sys.argv[1]))))`, file], { encoding: 'utf8' }).stdout);
const variant = (base, edit) => { const p = JSON.parse(readFileSync(DIR + 'plans/' + base, 'utf8')); edit(p); const f = join(mkdtempSync(join(tmpdir(), 'walkgen-')), 'p.json'); writeFileSync(f, JSON.stringify(p)); return f; };

test('walkgen: both shipped plans validate', () => {
  for (const f of ['buildtec-avalon.plan.json', 'fixture-studio.plan.json']) { const r = check(DIR + 'plans/' + f); assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /^ok /); }
});

test('walkgen: the Avalon layout matches what the live walk uses', () => {
  const lay = layout(DIR + 'plans/buildtec-avalon.plan.json');
  const live = JSON.parse(readFileSync(new URL('../dist/showhaus/walk/data/buildtec-avalon/room.js', import.meta.url), 'utf8').replace(/^window\.ROOM=/, '').replace(/;\s*$/, ''));
  assert.deepEqual(lay.plan.room, live.plan.room);
  assert.deepEqual(lay.plan.alfresco, live.plan.alfresco);
  const inWalk = (l, x, y) => l.walk.some(b => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) && !l.boxes.some(k => x > k[0] && x < k[2] && y > k[1] && y < k[3]);
  for (const v of live.views) assert.ok(inWalk(lay, ...v.pos), `live view "${v.name}" is walkable in the generated layout`);
  // every solid thing in the live walk is still solid: stand in the middle of each and you are blocked
  for (const k of live.solid) assert.ok(!inWalk(lay, (k[0] + k[2]) / 2, (k[1] + k[3]) / 2), `still blocked at ${k}`);
  // you can walk out through the sliders onto the alfresco and nowhere through a wall
  assert.ok(inWalk(lay, 2.7, 6.35), 'through the slider'); assert.ok(!inWalk(lay, 9.0, 6.35), 'not through the window wall'); assert.ok(!inWalk(lay, 3.0, 0.7), 'not into the butlers block');
});

test('walkgen: an L-shaped room gives touching walk areas, openings on any wall, and a way onto the deck', () => {
  const lay = layout(DIR + 'plans/fixture-studio.plan.json');
  assert.equal(lay.plan.openings.length, 4);
  assert.deepEqual(lay.plan.openings[1], [7, 0.6, 7, 3.2], 'the slider is on the east wall');
  const ok = (x, y) => lay.walk.some(b => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]);
  assert.ok(ok(2, 3.73), 'no seam between the two parts of the L'); assert.ok(ok(7.05, 2), 'through the slider'); assert.ok(!ok(5.5, 5.5), 'the notch is outside');
});

test('walkgen: a plan that guesses, overlaps a wall or is not a rectilinear room is refused with the reason', () => {
  const bad = (edit, re) => { const r = check(variant('fixture-studio.plan.json', edit)); assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, re); };
  bad(p => { p.assumptions = []; }, /assumptions/);
  bad(p => { p.outline.reverse(); }, /counter-clockwise/);
  bad(p => { p.outline[1] = [7, 1]; }, /not axis-aligned/);
  bad(p => { p.openings[0].b = 9; }, /does not fit on edge 0/);
  bad(p => { p.openings[1].head = 2.9; }, /above the ceiling/);
  bad(p => { p.items[0].type = 'jacuzzi'; }, /unknown type/);
  bad(p => { p.items[1].at = [20, 20]; }, /outside the room/);
  bad(p => { p.views[0].pos = [0.5, 1.8]; }, /stands inside a wall or an object/);
  bad(p => { p.source = 'plan'; }, /needs source_url/);
});
