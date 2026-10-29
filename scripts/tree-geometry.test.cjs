const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTreeShapes } = require('../dist/tree-geometry.js');

test('uses source height and north-south canopy dimension without fallback estimates', () => {
  const result = makeTreeShapes({ features: [{
    geometry: { type: 'Point', coordinates: [151.21, -33.87] },
    properties: { OBJECTID: 42, TreeHeight: 12, TreeCanopyNS: 8, CommonName: 'Brush box' }
  }] });
  assert.equal(result.features.length, 5);
  assert.equal(result.features.at(-1).properties.top, 12);
  assert.equal(result.features[0].properties.name, 'Brush box');
  assert.equal(result.features[0].properties.key, '42');
  assert.equal(result.features[1].geometry.coordinates[0].length, 11);
  assert.deepEqual(result.features[1].geometry.coordinates[0][0], result.features[1].geometry.coordinates[0].at(-1));
});

test('skips missing dimensions and caps individual representations', () => {
  const features = [{ geometry: { type: 'Point', coordinates: [151, -34] }, properties: { TreeHeight: 9 } }];
  for (let i = 0; i < 10; i++) features.push({ geometry: { type: 'Point', coordinates: [151, -34] }, properties: { TreeHeight: 9, TreeCanopyNS: 4, OBJECTID: i } });
  assert.equal(makeTreeShapes({ features }, 3).features.length, 15);
});

test('rejects nonfinite/out-of-range inputs and impossible geometry', () => {
  const features = [
    { geometry: { type: 'Point', coordinates: [151, -34] }, properties: { TreeHeight: 1, TreeCanopyNS: 3 } },
    { geometry: { type: 'Point', coordinates: [Infinity, -34] }, properties: { TreeHeight: 5, TreeCanopyNS: 3 } },
    { geometry: { type: 'LineString', coordinates: [[151, -34]] }, properties: { TreeHeight: 5, TreeCanopyNS: 3 } }
  ];
  assert.equal(makeTreeShapes({ features }).features.length, 0);
});
