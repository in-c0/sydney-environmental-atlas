const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '../dist/index.html'), 'utf8');

test('one map overlay selector owns both layer visibility and left-side details', () => {
  assert.equal((page.match(/class="overlay-toggle"/g) || []).length, 4);
  assert.doesNotMatch(page, /class="atlas-lenses"/);
  assert.doesNotMatch(page, /Combine or clear/);
  assert.match(page, /function syncInspectorToOverlays\(\)/);
  assert.match(page, /const overlayLens=\{noise:'noise',heat:'heat',land:'land',trees:'heat'\}/);
  assert.match(page, /if\(overlays\[key\]\)overlayFocusOrder\.push\(key\)/);
});

function sourceBetween(start, end) {
  const a = page.indexOf(start);
  const b = page.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Could not find source boundaries for ${start}`);
  return page.slice(a, b);
}

test('a map click moves the selected pin before an external building lookup responds', () => {
  const fn = sourceBetween('  async function chooseMapLocation(lat,lng){', '\n  function colorFor(type)');
  assert.match(page, /pointMarker=L\.marker\(\[lat,lng\],\{interactive:false,keyboard:false/);
  const events = [];
  const run = new Function('events', `
    let current={lat:-33.9,lng:151.2,selectionKind:'point'};
    let selectionRequest=0,precisionMode=false,buildingAbort=null;
    const buildingCache=new Map(),buildingModel=null,map3dReady=false;
    const map={panTo:pos=>events.push(['pan',pos])};
    const fetch=()=>new Promise(()=>{});
    const $=()=>({set textContent(v){events.push(['status',v])}});
    function inspect(lat,lng){current={lat,lng,selectionKind:'point'};++selectionRequest;events.push(['inspect',lat,lng]);}
    ${fn}
    chooseMapLocation(-33.91,151.22);
    return {current,selectionRequest};
  `);
  const result=run(events);
  assert.deepEqual(result.current,{lat:-33.91,lng:151.22,selectionKind:'point'});
  assert.deepEqual(events[0],['inspect',-33.91,151.22]);
  assert.deepEqual(events[1],['pan',[-33.91,151.22]]);
  assert.match(events[2][1],/Point selected/);
});

test('the first card distinguishes location-specific observations from an overall livability score', () => {
  assert.match(page, /number\.textContent=mapped\?`\$\{Math\.round\(canopy\*100\)\}%`/);
  assert.match(page, /Tree canopy\\nnot a rating/);
  assert.match(page, /overall livability are not rated/);
});

test('3D Noise draws a source-derived ring, nearest-road path and metre label', () => {
  const fn = sourceBetween('  function sync3dNoiseContext(metric){', '\n  function sync3dCanopy(){');
  const sources = Object.fromEntries(['atlas-noise-area', 'atlas-noise-nearest', 'atlas-noise-label', 'atlas-noise-wedges'].map(name => [name, {setData(data) { this.data = data; }}]));
  const map3d = {getSource: name => sources[name],getZoom:()=>16.2};
  const point = {lat: -33.911, lng: 151.221};
  const metric = {distance: 48, nearestCoord: [-33.9107, 151.2213]};
  const directionalProfile = {peak: 0, relative: Array(12).fill(.5)};
  const directionModel = require('../dist/directional-exposure.js');
  const make = noise => new Function('map3d', 'map3dReady', 'overlays', 'current', 'roadLayerVisible', 'metricsAt', 'emptyGeoJSON', 'directionalProfile', 'directionModel', `${fn}; return sync3dNoiseContext;`)(map3d, true, {noise}, point, true, () => metric, () => ({type: 'FeatureCollection', features: []}), directionalProfile, directionModel);

  make(true)(metric);
  const ring = sources['atlas-noise-area'].data.features[0].geometry.coordinates[0];
  assert.equal(ring.length, 97);
  assert.deepEqual(ring[0], ring.at(-1));
  assert.ok(Math.abs((ring[0][0] - point.lng) * 111320 * Math.cos(point.lat * Math.PI / 180) - 200) < 0.01);
  assert.deepEqual(sources['atlas-noise-nearest'].data.features[0].geometry.coordinates[0], [point.lng, point.lat]);
  assert.deepEqual(sources['atlas-noise-nearest'].data.features[0].geometry.coordinates[1], [metric.nearestCoord[1], metric.nearestCoord[0]]);
  assert.equal(sources['atlas-noise-label'].data.features[0].properties.text, '48 m to road');
  assert.equal(sources['atlas-noise-wedges'].data.features.length, 12);
  assert.ok(sources['atlas-noise-wedges'].data.features[0].properties.height > 10);

  make(false)(metric);
  for (const source of Object.values(sources)) assert.deepEqual(source.data.features, []);
});

test('lens transitions zoom out, never in, and retain selected coordinates', () => {
  const fn = sourceBetween('  function lensZoomLimit(mode){', '\n  manifestPromise.then(');
  const make = (mobile, use3d, cameraZoom) => {
    const calls = [];
    const center = {lat: -33.92, lng: 151.22};
    const map = {
      getCenter: () => center, getZoom: () => cameraZoom,
      setView: (coords, zoom) => calls.push(['setView', coords, zoom]),
      flyTo: (coords, zoom) => calls.push(['flyTo', coords, zoom]),
    };
    const map3d = {
      jumpTo: options => calls.push(['jumpTo', options]),
      easeTo: options => calls.push(['easeTo', options]),
    };
    const window = {matchMedia: () => ({matches: mobile})};
    const current = {lat: -33.911, lng: 151.221};
    const {transitionLensCamera, lensZoomLimit} = new Function('window', 'map', 'map3d', 'map3dPreferred', 'map3dReady', 'current', `${fn};return {transitionLensCamera,lensZoomLimit};`)(window, map, map3d, use3d, true, current);
    return {calls, transitionLensCamera, lensZoomLimit, current, center};
  };

  const desktop = make(false, false, 18);
  desktop.transitionLensCamera('land');
  const outgoing = desktop.calls.find(call => call[0] === 'flyTo');
  assert.deepEqual(outgoing.slice(1), [[desktop.current.lat, desktop.current.lng], 14.35]);

  const wide = make(true, false, 12);
  wide.transitionLensCamera('land');
  assert.ok(!wide.calls.some(call => call[0] === 'flyTo'));
  wide.transitionLensCamera('land', null, true);
  assert.equal(wide.calls.find(call => call[0] === 'flyTo')[2], 12);

  const perspective = make(false, true, 20);
  perspective.transitionLensCamera('noise', {lat: -33.92, lng: 151.22, zoom: 20});
  assert.equal(perspective.calls.find(call => call[0] === 'jumpTo')[1].zoom, 18.5);
  const ease = perspective.calls.find(call => call[0] === 'easeTo')[1];
  assert.equal(ease.zoom, 16.7);
  assert.deepEqual(ease.center, [perspective.current.lng, perspective.current.lat]);
});
