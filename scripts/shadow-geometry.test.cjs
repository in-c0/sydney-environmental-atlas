const test = require('node:test');
const assert = require('node:assert/strict');
const { movePoint, castBuilding, buildShadowGeoJSON } = require('../dist/shadow-geometry.js');

const square = (height = 10) => ({
  type: 'Feature',
  properties: { render_height: height, render_min_height: 0 },
  geometry: { type: 'Polygon', coordinates: [[[151.2224, -33.9093], [151.2225, -33.9093], [151.2225, -33.9092], [151.2224, -33.9092], [151.2224, -33.9093]]] }
});

test('sun from east casts a 10m-high building shadow west by 10m at 45° elevation', () => {
  const result = castBuilding(square(), { azimuth: 90, elevation: 45 });
  assert.equal(result.geometry.type, 'MultiPolygon');
  const displaced = result.geometry.coordinates[0][0][0];
  const before = square().geometry.coordinates[0][0];
  const metresWest = (before[0] - displaced[0]) * 111320 * Math.cos(-33.9093 * Math.PI / 180);
  assert.ok(Math.abs(metresWest - 10) < 0.01);
  assert.ok(Math.abs(displaced[1] - before[1]) < 1e-9);
});

test('northbound direction retains longitude at Sydney latitude', () => {
  const moved = movePoint([151.22, -33.91], 0, 12);
  assert.ok(Math.abs(moved[0] - 151.22) < 1e-12);
  assert.ok(moved[1] > -33.91);
});

test('skips missing, false, elevated, or implausibly long geometry', () => {
  const unknown = square(); delete unknown.properties.render_height;
  assert.equal(castBuilding(unknown, { azimuth: 120, elevation: 45 }), null);
  const elevated = square(); elevated.properties.render_min_height = 5;
  assert.equal(castBuilding(elevated, { azimuth: 120, elevation: 45 }), null);
  assert.equal(castBuilding(square(35), { azimuth: 120, elevation: 6 }), null);
  assert.equal(castBuilding(square(100), { azimuth: 120, elevation: 10 }, { maxLengthMeters: 220 }), null);
});

test('uses explicit building-height features, de-duplicates identifiers and caps output', () => {
  const a = square(13); a.id = 11;
  const b = square(13); b.id = 11;
  const c = square(7); c.id = 12;
  const sun = { azimuth: 0, elevation: 60 };
  const result = buildShadowGeoJSON([a, b, c], sun);
  assert.equal(result.features.length, 2);
  const capped = buildShadowGeoJSON([a, b, c], sun, { maxBuildings: 1 });
  assert.equal(capped.features.length, 1);
  assert.equal(capped.omitted, 1);
});

test('multi-polygons project every exterior, preserving closeable shadow rings', () => {
  const feature = square(7);
  feature.geometry = { type: 'MultiPolygon', coordinates: [square().geometry.coordinates, square().geometry.coordinates] };
  const projected = castBuilding(feature, { azimuth: 45, elevation: 60 });
  assert.equal(projected.geometry.coordinates.length, 10);
  for (const polygon of projected.geometry.coordinates) {
    const ring = polygon[0];
    assert.deepEqual(ring[0], ring[ring.length - 1]);
  }
});
