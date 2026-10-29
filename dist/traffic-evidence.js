/* A nearby counter is evidence about traffic at THAT counter, never dB at a home. */
(function (root, factory) {
  const api=factory();
  if (typeof module==='object' && module.exports) module.exports=api;
  if (root) root.AtlasTrafficEvidence=api;
})(typeof globalThis!=='undefined'?globalThis:this, function () {
  const SERVICE='https://spatial.infrastructure.gov.au/server/rest/services/Hosted/Harmonised_Traffic_Counts/FeatureServer/1/query';
  const metres=(lat1,lng1,lat2,lng2)=>{
    const p=Math.PI/180,dLat=(lat2-lat1)*p,dLng=(lng2-lng1)*p;
    const a=Math.sin(dLat/2)**2+Math.cos(lat1*p)*Math.cos(lat2*p)*Math.sin(dLng/2)**2;
    return 6371000*2*Math.asin(Math.min(1,Math.sqrt(a)));
  };
  function countValue(a){
    const bins=[['bins01_class01to12'],['bins02_class01to02','bins02_class03to12'],['bins04_class01to02','bins04_class03to05','bins04_class06to09','bins04_class10to12'],Array.from({length:12},(_,i)=>'bins12_class'+String(i+1).padStart(2,'0'))];
    for(const group of bins){const v=group.map(k=>Number(a[k]));if(group.every((k,i)=>a[k]!=null&&Number.isFinite(v[i]))&&v.some(n=>n>0))return v.reduce((x,y)=>x+y,0)}
    return null;
  }
  function queryUrl(lat,lng){
    const dLat=2.5/111,dLng=2.5/(111*Math.cos(lat*Math.PI/180));
    const params=new URLSearchParams({where:"state = 'NSW'",geometry:[lng-dLng,lat-dLat,lng+dLng,lat+dLat].map(n=>n.toFixed(6)).join(','),geometryType:'esriGeometryEnvelope',inSR:'4326',outSR:'4326',spatialRel:'esriSpatialRelIntersects',outFields:'src_stnid,roadname,temporal_period,temporal_coverage_from,temporal_coverage_to,counter_type,bins01_class01to12,bins02_class01to02,bins02_class03to12,bins04_class01to02,bins04_class03to05,bins04_class06to09,bins04_class10to12,direction,source_data',orderByFields:'temporal_coverage_to DESC',resultRecordCount:'500',f:'json'});
    return SERVICE+'?'+params;
  }
  function select(features,lat,lng,nowYear=new Date().getFullYear()){
    const candidates=[];
    const seen=new Set();
    for(const f of features||[]){
      const a=f.attributes||f.properties||{},g=f.geometry||{};
      const x=Number(g.x??g.coordinates?.[0]),y=Number(g.y??g.coordinates?.[1]);
      const year=Number(String(a.temporal_period||'').match(/(?:19|20)\d{2}/)?.[0]);
      if(!Number.isFinite(x)||!Number.isFinite(y)||!year||year>nowYear||year<2000)continue;
      const distance=metres(lat,lng,y,x);if(distance>2500)continue;
      const observedCount=countValue(a);if(observedCount===null)continue;
      const station=String(a.src_stnid||'')+'|'+String(a.roadname||'')+'|'+String(a.direction||'');
      if(seen.has(station))continue;seen.add(station); // API orders newest observations first.
      candidates.push({station:station.split('|')[0],road:String(a.roadname||'Unknown road'),direction:String(a.direction||''),year,period:String(a.temporal_period),distance,observedCount,source:String(a.source_data||''),lat:y,lng:x});
    }
    const recent=candidates.filter(x=>nowYear-x.year<=7);
    const pool=recent.length?recent:candidates;
    pool.sort((a,b)=>a.distance-b.distance||b.year-a.year);
    const best=pool[0]||null;
    return best?{...best,applicability:best.distance<=300&&nowYear-best.year<=4?'nearby counter, unverified road match':'limited',sampleAge:nowYear-best.year}:null;
  }
  return {SERVICE,queryUrl,select,countValue};
});
