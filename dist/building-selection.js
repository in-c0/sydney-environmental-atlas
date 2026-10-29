/* Click-to-building selection. Only real OSM building polygons can snap a pin. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.AtlasBuildingSelection=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const rad=Math.PI/180;
  function metres(a,b){
    const north=(b.lat-a.lat)*111320,east=(b.lng-a.lng)*111320*Math.cos(a.lat*rad);
    return Math.hypot(north,east);
  }
  function contains(ring,p){
    let inside=false;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++){
      const a=ring[i],b=ring[j];
      if((a.lat>p.lat)!==(b.lat>p.lat)&&p.lng<(b.lng-a.lng)*(p.lat-a.lat)/(b.lat-a.lat)+a.lng)inside=!inside;
    }
    return inside;
  }
  function edgeDistance(ring,p){
    const scale=111320*Math.cos(p.lat*rad),north=111320;
    let nearest=Infinity;
    for(let i=0;i<ring.length;i++){
      const a=ring[i],b=ring[(i+1)%ring.length];
      const ax=(a.lng-p.lng)*scale,ay=(a.lat-p.lat)*north,bx=(b.lng-p.lng)*scale,by=(b.lat-p.lat)*north;
      const vx=bx-ax,vy=by-ay,t=Math.max(0,Math.min(1,-(ax*vx+ay*vy)/(vx*vx+vy*vy||1)));
      nearest=Math.min(nearest,Math.hypot(ax+t*vx,ay+t*vy));
    }
    return nearest;
  }
  function interiorPoint(ring){
    // Area-weighted polygon centroid when it lies inside; otherwise the midpoint
    // of two vertices is a safe interior/on-edge fallback for a simple footprint.
    let area2=0,x=0,y=0;
    const origin=ring[0];
    for(let i=0;i<ring.length;i++){
      const a=ring[i],b=ring[(i+1)%ring.length];
      const ax=a.lng-origin.lng,ay=a.lat-origin.lat,bx=b.lng-origin.lng,by=b.lat-origin.lat;
      const cross=ax*by-bx*ay;
      area2+=cross;x+=(ax+bx)*cross;y+=(ay+by)*cross;
    }
    const center=Math.abs(area2)>1e-12?{lat:origin.lat+y/(3*area2),lng:origin.lng+x/(3*area2)}:null;
    if(center&&contains(ring,center))return center;
    const mid={lat:(ring[0].lat+ring[1].lat)/2,lng:(ring[0].lng+ring[1].lng)/2};
    return mid;
  }
  function nearestBuilding(elements,point,maxDistance=24){
    let best=null;
    for(const el of elements||[]){
      if(el.type!=='way'||!el.tags?.building||!Array.isArray(el.geometry)||el.geometry.length<4)continue;
      const ring=el.geometry.map(g=>({lat:Number(g.lat),lng:Number(g.lon)})).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng));
      if(ring.length<4)continue;
      if(metres(ring[0],ring[ring.length-1])<.25)ring.pop();
      if(ring.length<3)continue;
      const distance=contains(ring,point)?0:edgeDistance(ring,point);
      if(distance>maxDistance||(best&&distance>=best.distance))continue;
      const center=interiorPoint(ring);
      best={lat:center.lat,lng:center.lng,distance,id:el.id,outline:ring,source:'OpenStreetMap building footprint',name:el.tags.name||el.tags['addr:housename']||[el.tags['addr:housenumber'],el.tags['addr:street']].filter(Boolean).join(' ')||''};
    }
    return best;
  }
  function nearestVectorBuilding(features,point,maxDistance=24){
    const ways=[];
    for(const feature of features||[]){
      if(!feature?.geometry||!['Polygon','MultiPolygon'].includes(feature.geometry.type))continue;
      const polygon=feature.geometry.type==='Polygon'?feature.geometry.coordinates[0]:feature.geometry.coordinates[0]?.[0];
      if(!Array.isArray(polygon)||polygon.length<4)continue;
      const geometry=polygon.map(coords=>({lat:Number(coords[1]),lon:Number(coords[0])}));
      ways.push({type:'way',id:feature.id,tags:{building:'yes',name:feature.properties?.name||''},geometry});
    }
    return nearestBuilding(ways,point,maxDistance);
  }
  return {metres,contains,nearestBuilding,nearestVectorBuilding};
});
