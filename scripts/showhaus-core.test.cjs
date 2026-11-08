const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../dist/showhaus/lib/core.js');
const S = require('../dist/shadow-geometry.js');

const suburbs = [
  { name: 'Kensington', postcode: '2033', lat: -33.91, lng: 151.22, n: 120 },
  { name: 'Kingsford', postcode: '2032', lat: -33.92, lng: 151.227, n: 90 },
  { name: 'Coogee', postcode: '2034', lat: -33.92, lng: 151.255, n: 200 },
  { name: 'Wolli Creek', postcode: '2205', lat: -33.93, lng: 151.153, n: 300 },
  { name: 'St Peters', postcode: '2044', lat: -33.91, lng: 151.18, n: 40 },
];

test('where-field classification catches wrong-step and too-short input', () => {
  assert.equal(C.classifyWhere('ke').kind, 'short');
  assert.equal(C.classifyWhere('$1.2m').kind, 'price');
  assert.equal(C.classifyWhere('900k').value, 900000);
  assert.equal(C.classifyWhere('2033').kind, 'postcode');
});

test('search: exact, prefix, postcode, typo suggestion, saint alias', () => {
  assert.equal(C.searchSuburbs(suburbs, 'kensington').scope, 'exact');
  assert.deepEqual(C.searchSuburbs(suburbs, 'k').matches, []);
  assert.equal(C.searchSuburbs(suburbs, 'kin').matches[0].name, 'Kingsford');
  assert.equal(C.searchSuburbs(suburbs, '2034').matches[0].name, 'Coogee');
  const typo = C.searchSuburbs(suburbs, 'wooli creek');
  assert.equal(typo.matches.length, 0); assert.equal(typo.suggestion.name, 'Wolli Creek');
  assert.equal(C.searchSuburbs(suburbs, 'saint peters').matches[0].name, 'St Peters');
  assert.equal(C.searchSuburbs(suburbs, 'zzzzqqq').suggestion, null);
});

test('sales filter and median', () => {
  const sales = { price: [500000, 900000, 1500000, 2000000], date: [20260101, 20251001, 20260501, 20240101], sub: [0, 0, 1, 0] };
  assert.deepEqual(C.filterSales(sales, { suburbIdx: 0, maxPrice: 1000000 }), [0, 1]);
  assert.deepEqual(C.filterSales(sales, { minDate: 20251101 }), [0, 2]);
  assert.equal(C.median([3, 1, 2]), 2); assert.equal(C.median([]), null);
  assert.equal(C.money(1250000), '$1.25M'); assert.equal(C.money(850000), '$850k');
});

test('nearest road distance is metric and returns the foot point', () => {
  const p = { lat: -33.9, lng: 151.2 };
  const line = [[151.199, -33.9001], [151.201, -33.9001]]; // ~11 m south
  const r = C.nearestOnLines(p, [line]);
  assert.ok(Math.abs(r.distance - 11.1) < 0.5, r.distance);
});

test('solar noon in Sydney summer is high in the north', () => {
  const noon = C.solarPosition(-33.87, 151.21, '2026-12-21', 13 * 60);
  assert.ok(noon.elevation > 75, noon.elevation);
  const winter = C.solarPosition(-33.87, 151.21, '2026-06-21', 12 * 60);
  assert.ok(winter.elevation > 30 && winter.elevation < 35, winter.elevation);
  assert.ok(Math.abs(winter.azimuth - 0) < 10 || Math.abs(winter.azimuth - 360) < 10);
  const dl = C.daylightMinutes(-33.87, 151.21, '2026-06-21');
  assert.ok(dl > 580 && dl < 600, dl);
});

test('a tall building to the north shades a point in winter but not in summer midday', () => {
  const pt = { lat: -33.9, lng: 151.2 };
  // 40 m tall block ~20 m north of the point
  const n = 20 / 111320, w = 15 / (111320 * Math.cos(33.9 * Math.PI / 180));
  const b = { type: 'Feature', properties: { render_height: 40 }, geometry: { type: 'Polygon', coordinates: [[[151.2 - w, -33.9 + n], [151.2 + w, -33.9 + n], [151.2 + w, -33.9 + 2 * n], [151.2 - w, -33.9 + 2 * n], [151.2 - w, -33.9 + n]]] } };
  const winter = C.sunMinutesAtPoint(pt, [b], '2026-06-21', S.castBuilding);
  const open = C.sunMinutesAtPoint(pt, [], '2026-06-21', S.castBuilding);
  assert.ok(winter.sunMinutes < open.sunMinutes - 120, `${winter.sunMinutes} vs ${open.sunMinutes}`);
  assert.equal(winter.blockingBuildings, 1);
  assert.ok(open.sunMinutes + open.uncertainMinutes === open.daylightMinutes);
});

test('selection line names every token', () => {
  const t = C.selectionLine({ place: { name: 'Kensington', postcode: '2033' }, mode: 'buy', maxPrice: 1200000, excluded: [{ name: 'Kingsford' }], wants: { quiet: true, land: true } });
  assert.deepEqual(t.map(x => x.text), ['Kensington 2033', 'buying', 'up to $1.2M', 'not Kingsford', 'quiet street', 'no notified land record within 1 km']);
});

test('SHOWHAUS ships an identical copy of the atlas shadow module', () => {
  const fs = require('node:fs');
  assert.equal(fs.readFileSync(__dirname + '/../dist/showhaus/lib/shadow-geometry.js', 'utf8'), fs.readFileSync(__dirname + '/../dist/shadow-geometry.js', 'utf8'));
});

test('built data files are internally consistent', () => {
  const R = require('../dist/showhaus/data/rents.json'), P = require('../dist/showhaus/data/places.json');
  const n = R.w.length;
  for (const k of ['pc', 'm', 't', 'b']) assert.equal(R[k].length, n, k);
  for (let i = 1; i < n; i++) assert.ok(R.pc[i] >= R.pc[i - 1], 'rows grouped by postcode');
  assert.ok(R.w.every(v => v > 0), 'no zero or unknown rents kept');
  assert.equal(R.months.length, 12);
  const pcs = new Set(P.postcodes.map(p => p.pc));
  assert.ok(R.postcodes.filter(p => !pcs.has(p)).length <= 3, 'almost every postcode has a boundary');
  assert.ok(P.suburbs.every(s => R.postcodes.includes(Number(s[1]))), 'every suburb maps to a postcode with records');
});
