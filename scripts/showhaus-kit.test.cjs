// Unit tests for dist/showhaus/lib/kit.js (the listing-kit math shared by page, generator and judge).
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../dist/showhaus/lib/kit.js');

const lat = -33.9128, lng = 151.2611, kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 111320;
const square = (dx, dy, size) => { const x = lng + dx / kx, y = lat + dy / ky, s = size / kx, t = size / ky; return [[x, y], [x + s, y], [x + s, y + t], [x, y + t], [x, y]]; };
const lot = [{ label: 'Lot 1', rings: [square(-10, -10, 20)] }];
const kitWith = buildings => {
  const kit = { geocode: { lat, lng }, lot: { lots: lot }, buildings: { features: buildings } };
  kit.ground = K.openGroundPoints(lot[0] ? lot : [], buildings, { lat, lng });
  return kit;
};

test('open ground excludes footprints and stays inside the lot', () => {
  const house = { id: 'a', h: 7, src: 'height', ring: square(-5, -5, 10) };
  const g = K.openGroundPoints(lot, [house], { lat, lng });
  assert.equal(g.basis, 'lot');
  assert.ok(g.points.length > 5);
  for (const [x, y] of g.points) {
    const dx = (x - lng) * kx, dy = (y - lat) * ky;
    assert.ok(Math.abs(dx) <= 10.01 && Math.abs(dy) <= 10.01, 'inside lot');
    assert.ok(!(dx > -5 && dx < 5 && dy > -5 && dy < 5), 'outside the house');
  }
});

test('sun is unknown when no footprint is mapped next to the lot (missing data is not open sky)', () => {
  const s = K.groundSun(kitWith([]), '2026-11-08');
  assert.equal(s.known, false);
  assert.match(s.why, /no building footprints/);
});

test('sun is unknown when a neighbour within 30 m has no mapped height', () => {
  const s = K.groundSun(kitWith([{ id: 'n', h: 6, src: 'est', ring: square(12, -5, 8) }, { id: 'm', h: 9, src: 'height', ring: square(-25, -5, 8) }]), '2026-06-21');
  assert.equal(s.known, false);
  assert.match(s.why, /1 of 2 buildings/);
  assert.equal(s.ifEstimated, undefined, 'the model is not computed unless asked for');
});

test('a tall mapped building north of the lot cuts winter sun; known only with mapped heights', () => {
  const north = { id: 't', h: 30, src: 'height', ring: square(-10, 12, 20) }; // north of the lot (southern hemisphere: casts south in winter)
  const open = K.groundSun(kitWith([{ id: 'x', h: 4, src: 'levels', ring: square(-10, -40, 5) }]), '2026-06-21');
  const shaded = K.groundSun(kitWith([north]), '2026-06-21');
  assert.equal(shaded.known, true);
  assert.ok(shaded.minutes < shaded.daylight, 'some shade');
  assert.ok(open.known === false || open.minutes >= shaded.minutes);
});

test('nearest main road ignores minor roads; rent summary counts one postcode', () => {
  const lines = [{ cls: 'minor', pts: [[lng - 0.001, lat + 10 / ky], [lng + 0.001, lat + 10 / ky]] }, { cls: 'primary', name: 'Main Rd', pts: [[lng - 0.001, lat + 300 / ky], [lng + 0.001, lat + 300 / ky]] }];
  const r = K.nearestRoads({ lat, lng }, lines);
  assert.equal(Math.round(r.any.distance), 10);
  assert.equal(Math.round(r.main.distance), 300);
  assert.equal(r.main.name, 'Main Rd');
  const R = { postcodes: [2031, 2034], months: [202510, 202609], pc: [0, 0, 0, 1], t: [0, 1, 0, 0], w: [500, 900, 700, 1000], b: [1, 3, 2, 1] };
  const s = K.rentSummary(R, 2031);
  assert.deepEqual([s.all.n, s.all.median, s.units.n, s.units.median, s.houses.n], [3, 700, 2, 600, 1]);
});
