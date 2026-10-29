const test=require('node:test');
const assert=require('node:assert/strict');
const traffic=require('../dist/traffic-evidence.js');

const at=(lat,lng,attributes)=>({geometry:{x:lng,y:lat},attributes});

test('traffic context selects the nearest recent measured counter, not a distance-based dB estimate',()=>{
  const here={lat:-33.9093,lng:151.2224};
  const records=[
    at(-33.9098,151.2224,{src_stnid:'older',roadname:'Local Street',temporal_period:'2008 Calendar Year',bins01_class01to12:125000,direction:'Northbound'}),
    at(-33.9133,151.2224,{src_stnid:'recent',roadname:'Main Road',temporal_period:'2024 Calendar Year',bins01_class01to12:2150000,direction:'Southbound'}),
    at(-33.9133,151.2224,{src_stnid:'recent',roadname:'Main Road',temporal_period:'2022 Calendar Year',bins01_class01to12:4200000,direction:'Southbound'}),
  ];
  const selected=traffic.select(records,here.lat,here.lng,2026);
  assert.equal(selected.station,'recent');
  assert.equal(selected.year,2024);
  assert.equal(selected.observedCount,2150000);
  assert.ok(selected.distance>300);
  assert.equal(selected.applicability,'limited');
  assert.equal(selected.decibels,undefined);
});

test('no available counter is not zero traffic or a good noise score',()=>{
  assert.equal(traffic.select([], -33.91,151.22,2026),null);
  assert.equal(traffic.countValue({bins01_class01to12:null}),null);
  assert.equal(traffic.select([at(-33.9,151.5,{temporal_period:'2024 Calendar Year',bins01_class01to12:15})],-33.91,151.22,2026),null);
});

test('traffic query uses limited NSW spatial bounds and declares fields explicitly',()=>{
  const url=new URL(traffic.queryUrl(-33.91,151.22));
  assert.equal(url.searchParams.get('where'),"state = 'NSW'");
  assert.equal(url.searchParams.get('resultRecordCount'),'500');
  assert.equal(url.searchParams.get('geometryType'),'esriGeometryEnvelope');
  assert.equal(url.searchParams.get('f'),'json');
});
