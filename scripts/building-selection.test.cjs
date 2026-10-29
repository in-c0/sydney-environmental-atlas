const test=require('node:test');
const assert=require('node:assert/strict');
const {nearestBuilding,nearestVectorBuilding,metres}=require('../dist/building-selection.js');
const square=(id,lat,lng,half=.00007)=>({id,type:'way',tags:{building:'yes'},geometry:[
  {lat:lat-half,lon:lng-half},{lat:lat-half,lon:lng+half},
  {lat:lat+half,lon:lng+half},{lat:lat+half,lon:lng-half},
  {lat:lat-half,lon:lng-half}]});
test('snaps a nearby road-side click to a real building footprint',()=>{
  const lat=-33.90,lng=151.22;
  const hit=nearestBuilding([square(42,lat,lng)],{lat:lat+.00012,lng});
  assert.equal(hit.id,42);
  assert.ok(metres(hit,{lat,lng})<1);
});
test('does not invent a building when the click is far from any footprint',()=>{
  assert.equal(nearestBuilding([square(1,-33.90,151.22)],{lat:-33.901,lng:151.22}),null);
});
test('rejects nonbuilding polygons and incomplete footprints',()=>{
  assert.equal(nearestBuilding([{type:'way',tags:{highway:'residential'},geometry:square(2,-33.9,151.22).geometry}],{lat:-33.9,lng:151.22}),null);
});
test('can snap to genuine building polygons from the already loaded 3D vector map',()=>{
  const polygon=square(91,-33.9,151.22).geometry.map(p=>[p.lon,p.lat]);
  const hit=nearestVectorBuilding([{id:91,properties:{name:'Test house'},geometry:{type:'Polygon',coordinates:[polygon]}}],{lat:-33.9,lng:151.22});
  assert.equal(hit.id,91);
  assert.equal(hit.name,'Test house');
  assert.ok(metres(hit,{lat:-33.9,lng:151.22})<1);
});
