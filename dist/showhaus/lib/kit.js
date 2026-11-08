/* SHOWHAUS listing kit: pure functions shared by the property page, the kit generator and the kit judge.
 * No DOM, no network. Needs ShowhausCore (core.js) and AtlasShadowGeometry (shadow-geometry.js). */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const C = isNode ? require('./core.js') : root.ShowhausCore;
  const SG = isNode ? require('./shadow-geometry.js') : root.AtlasShadowGeometry;
  const api = factory(C, SG);
  if (isNode) module.exports = api;
  if (root) root.ShowhausKit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, SG) {
  const rad = Math.PI / 180;
  const SUN_WINDOW = [270, 1260]; // 04:30–21:00 local, same window as core.sunMinutesAtPoint
  const NEAR_M = 30;               // an unmapped building this close to the lot makes ground sun "unknown"

  const asFeature = b => ({ type: 'Feature', id: b.id, properties: { render_height: b.h, render_min_height: b.min || 0 }, geometry: { type: 'Polygon', coordinates: [b.ring] } });

  // Points on the lot's open ground: a grid inside the lot, outside every mapped footprint.
  function openGroundPoints(lots, buildings, center, { spacing = 3, max = 40, fallbackRadius = 10 } = {}) {
    const rings = (lots || []).flatMap(l => l.rings.slice(0, 1));
    const inBuilding = (lng, lat) => buildings.some(b => C.pointInRing(lng, lat, b.ring));
    const kx = 111320 * Math.cos(center.lat * rad), ky = 111320;
    const pts = [];
    let basis = 'lot';
    let bbox;
    if (rings.length) {
      const all = rings.flat();
      bbox = [Math.min(...all.map(p => p[0])), Math.min(...all.map(p => p[1])), Math.max(...all.map(p => p[0])), Math.max(...all.map(p => p[1]))];
    } else {
      basis = 'radius';
      bbox = [center.lng - fallbackRadius / kx, center.lat - fallbackRadius / ky, center.lng + fallbackRadius / kx, center.lat + fallbackRadius / ky];
    }
    const inside = (lng, lat) => rings.length ? rings.some(r => C.pointInRing(lng, lat, r)) : C.metres(center, { lng, lat }) <= fallbackRadius;
    let sp = spacing;
    for (let tries = 0; tries < 6; tries++) {
      pts.length = 0;
      for (let y = bbox[1] + sp / ky / 2; y < bbox[3]; y += sp / ky)
        for (let x = bbox[0] + sp / kx / 2; x < bbox[2]; x += sp / kx)
          if (inside(x, y) && !inBuilding(x, y)) pts.push([+x.toFixed(7), +y.toFixed(7)]);
      if (pts.length <= max) break;
      sp *= 1.4;
    }
    return { basis, points: pts, spacing: +sp.toFixed(2) };
  }

  // Minutes of direct sun at each point for one day (flat ground; shadows from the given buildings only).
  function sunOverPoints(points, buildings, lat, lng, day, { step = 10, minElevation = 6, maxLength = 220 } = {}) {
    // Only buildings whose longest possible shadow (sun at minElevation, capped at maxLength) can reach a point matter.
    const reach = b => Math.min(maxLength, (b.h || 0) / Math.tan(minElevation * rad));
    const feats = buildings.filter(b => b.ring.some(v => points.some(p => C.metres({ lng: p[0], lat: p[1] }, { lng: v[0], lat: v[1] }) <= reach(b) + 1))).map(asFeature);
    const tallest = buildings.reduce((m, b) => Math.max(m, b.h || 0), 0);
    const sun = new Array(points.length).fill(0);
    let daylight = 0, uncertain = 0;
    for (let mnt = SUN_WINDOW[0]; mnt <= SUN_WINDOW[1]; mnt += step) {
      const p = C.solarPosition(lat, lng, day, mnt);
      if (p.elevation <= 0) continue;
      daylight += step;
      if (p.elevation <= minElevation || tallest / Math.tan(p.elevation * rad) > maxLength) { uncertain += step; continue; }
      const rings = [];
      for (const f of feats) {
        const s = SG.castBuilding(f, p, { maxLengthMeters: maxLength });
        if (s) for (const poly of s.geometry.coordinates) rings.push(poly[0]);
      }
      points.forEach((pt, i) => { if (!rings.some(r => C.pointInRing(pt[0], pt[1], r))) sun[i] += step; });
    }
    const sorted = sun.slice().sort((a, b) => a - b);
    return { median: sorted.length ? C.quantile(sorted, 0.5) : null, min: sorted[0] ?? null, max: sorted.at(-1) ?? null, daylight, uncertain, n: points.length };
  }

  // Ground sun for the kit: "known" only when every building within NEAR_M of the lot has a mapped height.
  function groundSun(kit, day, { modelUnknown = false } = {}) {
    const { lat, lng } = kit.geocode;
    const blds = kit.buildings.features;
    const pts = kit.ground.points;
    const near = blds.filter(b => b.ring.some(v => pts.some(p => C.metres({ lng: p[0], lat: p[1] }, { lng: v[0], lat: v[1] }) <= NEAR_M)) || pts.some(p => C.pointInRing(p[0], p[1], b.ring)));
    const unmapped = near.filter(b => b.src === 'est').length;
    const mapped = blds.filter(b => b.src !== 'est');
    const daylight = C.daylightMinutes(lat, lng, day, 5);
    if (!pts.length) return { known: false, why: 'no open ground found on the lot', day, daylight, nearUnmapped: unmapped, nearTotal: near.length };
    // No footprint mapped next to the lot is missing data in a suburb, not open sky.
    if (!near.length) return { known: false, why: `no building footprints are mapped within ${NEAR_M} m of the lot`, day, daylight, nearUnmapped: 0, nearTotal: 0 };
    if (unmapped) return { known: false, why: `${unmapped} of ${near.length} buildings within ${NEAR_M} m have no mapped height`, day, daylight, nearUnmapped: unmapped, nearTotal: near.length, ifEstimated: modelUnknown ? sunOverPoints(pts, blds, lat, lng, day).median : undefined };
    const r = sunOverPoints(pts, mapped, lat, lng, day);
    return { known: true, day, daylight, minutes: r.median, min: r.min, max: r.max, uncertain: r.uncertain, n: r.n, nearUnmapped: 0, nearTotal: near.length };
  }

  // Shadow polygons for a moment (all buildings, estimated heights included — the page labels them).
  function shadowsAt(kit, day, minutes) {
    const { lat, lng } = kit.geocode;
    const sun = C.solarPosition(lat, lng, day, minutes);
    return { sun, fc: SG.buildShadowGeoJSON(kit.buildings.features.map(asFeature), sun, { maxBuildings: 2000, maxLengthMeters: 220 }) };
  }

  function sunriseSunset(lat, lng, day) {
    let rise = null, set = null;
    for (let m = 240; m <= 1290; m++) {
      const up = C.solarPosition(lat, lng, day, m).elevation > 0;
      if (up && rise == null) rise = m;
      if (up) set = m;
    }
    return { rise, set };
  }

  // Nearest road distances from stored OSM lines.
  const MAIN = new Set(['motorway', 'trunk', 'primary']);
  function nearestRoads(point, lines) {
    let any = null, main = null;
    for (const l of lines) {
      const r = C.nearestOnLines(point, [l.pts]); if (!r) continue;
      const hit = { distance: r.distance, at: r.at, cls: l.cls, name: l.name || null };
      if (!any || r.distance < any.distance) any = hit;
      if (MAIN.has(l.cls) && (!main || r.distance < main.distance)) main = hit;
    }
    return { any, main };
  }

  // Rent context for one postcode from the columnar rental bond file (rents.json).
  function rentSummary(R, postcode) {
    const pci = R.postcodes.indexOf(Number(postcode));
    if (pci < 0) return null;
    const pick = types => { const v = C.filterRents(R, { pcSet: new Set([pci]), types: types ? new Set(types) : null }).map(i => R.w[i]).sort((a, b) => a - b); return { n: v.length, median: C.quantile(v, 0.5), q1: C.quantile(v, 0.25), q3: C.quantile(v, 0.75) }; };
    return { postcode: Number(postcode), months: [R.months[0], R.months.at(-1)], all: pick(null), units: pick([0]), houses: pick([1]) };
  }

  const hm = m => m == null ? '—' : `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min`;
  const clock = m => { const h = Math.floor(m / 60), mm = String(Math.round(m % 60)).padStart(2, '0'); return `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? 'am' : 'pm'}`; };

  return { openGroundPoints, sunOverPoints, groundSun, shadowsAt, sunriseSunset, nearestRoads, rentSummary, hm, clock, NEAR_M, MAIN };
});
