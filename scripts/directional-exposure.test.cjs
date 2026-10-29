const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../dist/directional-exposure.js');
const lat = -33.911, lng = 151.221;

test('road geometry east of the pin dominates eastern petals, not western petals', () => {
  const metresToLng = m => m / (111320 * Math.cos(lat * Math.PI / 180));
  const metresToLat = m => m / 111320;
  const roads = [{type: 'unclassified',points: [[lat-metresToLat(90),lng+metresToLng(80)],[lat+metresToLat(90),lng+metresToLng(80)]]}];
  const p = model.profile(roads,lat,lng);
  assert.ok(p.sampleCount > 5);
  assert.ok(p.relative[3] > .45,'east is active');
  assert.equal(p.relative[9],0,'west is empty');
  const shape = model.toGeoJSON(p,lat,lng);
  assert.equal(shape.features.length,12);
  assert.deepEqual(shape.features[0].geometry.coordinates[0][0],shape.features[0].geometry.coordinates[0].at(-1));
  assert.ok(shape.features.some(f=>f.properties.height>75));
});

test('relative road petals do not pretend to be acoustic readings when no road geometry is found', () => {
  const p = model.profile([{points:[[lat+1,lng+1],[lat+1.001,lng+1.001]]}],lat,lng);
  assert.equal(p.peak,null);
  assert.equal(model.toGeoJSON(p,lat,lng).features.length,0);
  assert.equal(model.profile([],lat,lng),null);
});

test('road-centreline distance cannot produce a livability score', () => {
  assert.equal(model.previewRating,undefined);
});

test('the visual petals shrink dramatically at street zoom while the evidence radius stays 250 m', () => {
  const p={relative:Array(12).fill(.8),peak:0};
  const distant=model.visualScale(14,lat),close=model.visualScale(18.5,lat);
  assert.equal(distant,1);
  assert.ok(close>.13&&close<.23);
  const features=model.toGeoJSON(p,lat,lng,0,close).features;
  const ring=features[0].geometry.coordinates[0];
  const maxDistance=Math.max(...ring.map(([x,y])=>Math.hypot((x-lng)*111320*Math.cos(lat*Math.PI/180),(y-lat)*111320)));
  assert.ok(maxDistance<60,'petals must not cover a full building block at close zoom');
  assert.equal(model.RADIUS,250,'sampling still covers the same 250m study context');
});
