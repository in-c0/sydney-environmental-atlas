/* SHOWHAUS Studio core: pure functions shared by the walkthrough page, the kit recorder and the Node tests.
 * No DOM, no network. Geometry in local metres around the project centroid (equirectangular, fine at 1 km).
 * Everything this module returns is an ESTIMATE from mapped geometry: flat ground, no trees, no balconies. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.StudioCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const rad = Math.PI / 180, R = 6371008.8;
  const ASPECTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const ASPECT_WORD = { N: 'north', NE: 'north-east', E: 'east', SE: 'south-east', S: 'south', SW: 'south-west', W: 'west', NW: 'north-west' };

  function frame(data) {
    const pts = data.towers.flatMap(t => t.footprint);
    const lon0 = pts.reduce((s, p) => s + p[0], 0) / pts.length, lat0 = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const kx = rad * R * Math.cos(lat0 * rad), ky = rad * R;
    return { lon0, lat0, xy: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky], ll: (x, y) => [lon0 + x / kx, lat0 + y / ky] };
  }

  function levelBase(tower, level, f2f) { return level * (tower.floor_to_floor_m_est || f2f); }

  // One extrusion per level (gap of 0.35 m so the floors read), plus the roof/plant envelope up to the approved max RL.
  function floorFeatures(data) {
    const f2f = data.floor_to_floor_m_est, features = [];
    for (const t of data.towers) {
      const ring = [...t.footprint, t.footprint[0]], ff = t.floor_to_floor_m_est || f2f;
      for (let lv = 0; lv < t.levels; lv++) {
        features.push({ type: 'Feature', id: features.length, properties: { tower: t.id, level: lv, kind: 'floor', base: +(lv * ff).toFixed(2), top: +((lv + 1) * ff - 0.35).toFixed(2) }, geometry: { type: 'Polygon', coordinates: [ring] } });
      }
      const roofBase = t.levels * ff;
      if (t.height_m_est > roofBase + 0.5) features.push({ type: 'Feature', id: features.length, properties: { tower: t.id, level: t.levels, kind: 'roof', base: +roofBase.toFixed(2), top: t.height_m_est }, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
    return { type: 'FeatureCollection', features };
  }

  function obstacles(data, f) {
    const list = [];
    for (const b of data.context_buildings.features) list.push({ id: 'osm:' + b.id, h: b.h, ring: b.r.map(p => f.xy(p[0], p[1])) });
    for (const t of data.towers) list.push({ id: 'tower:' + t.id, tower: t.id, h: t.height_m_est, ring: t.footprint.map(p => f.xy(p[0], p[1])) });
    for (const o of list) {
      let r = 0; for (const [x, y] of o.ring) r = Math.max(r, Math.hypot(x, y)); o.reach = r;
    }
    return list;
  }

  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi || 1e-12) + xi) inside = !inside;
    }
    return inside;
  }

  // Distance along the ray (px,py)+t(dx,dy) where it first enters the polygon; Infinity if it never does.
  function entryDistance(px, py, dx, dy, ring) {
    if (pointInRing(px, py, ring)) return 0;
    let best = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j], [bx, by] = ring[i];
      const ex = bx - ax, ey = by - ay, den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((ax - px) * ey - (ay - py) * ex) / den, s = ((ax - px) * dy - (ay - py) * dx) / den;
      if (t > 0 && s >= 0 && s <= 1 && t < best) best = t;
    }
    return best;
  }

  const angleDiff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

  // Minutes of direct sun on one facade of one level on one day (est.).
  // Counted only when the sun is in front of the facade, above `minElevation`, and the ray towards it clears every mapped
  // building (and the project's other buildings). If the ray is still under `unknownTop` m at the edge of the mapped
  // radius, the minute is "uncertain" (unmapped or distant buildings may block it), never sun.
  function facadeSun(data, ctx, towerId, level, aspect, day, solarPosition, { step = 10, minElevation = 3, unknownTop = 30 } = {}) {
    const t = data.towers.find(x => x.id === towerId);
    const fp = t.facade_points[aspect], az = t.aspects[aspect];
    if (!fp || az == null) return null;
    const [px, py] = ctx.frame.xy(fp[0], fp[1]);
    const z0 = levelBase(t, level, data.floor_to_floor_m_est) + 1.6;
    const radius = data.context_buildings.radius_m;
    let sun = 0, front = 0, uncertain = 0, daylight = 0, first = null, last = null;
    for (let m = 0; m < 1440; m += step) {
      const p = solarPosition(ctx.lat, ctx.lng, day, m);
      if (p.elevation <= 0) continue;
      daylight += step;
      if (angleDiff(p.azimuth, az) >= 90) continue;
      front += step;
      if (p.elevation <= minElevation) { uncertain += step; continue; }
      const dx = Math.sin(p.azimuth * rad), dy = Math.cos(p.azimuth * rad), slope = Math.tan(p.elevation * rad);
      let blocked = false;
      for (const o of ctx.obs) {
        if (o.tower === towerId) continue;
        if (o.h <= z0) continue;                                    // can't reach above the eye
        const tEnter = entryDistance(px, py, dx, dy, o.ring);
        if (tEnter === Infinity || tEnter > radius * 2) continue;
        if (z0 + tEnter * slope < o.h) { blocked = true; break; }
      }
      if (blocked) continue;
      const edge = Math.max(0, radius - Math.hypot(px, py));
      if (z0 + edge * slope < unknownTop) { uncertain += step; continue; }
      sun += step; if (first == null) first = m; last = m + step;
    }
    return { sunMinutes: sun, frontMinutes: front, uncertainMinutes: uncertain, daylightMinutes: daylight, first, last };
  }

  function context(data) {
    const f = frame(data);
    return { frame: f, lat: f.lat0, lng: f.lon0, obs: obstacles(data, f) };
  }

  function sunTable(data, ctx, towerId, day, solarPosition, opts) {
    const t = data.towers.find(x => x.id === towerId), rows = [];
    for (let lv = 0; lv < t.levels; lv++) {
      const r = {};
      for (const a of Object.keys(t.aspects)) r[a] = facadeSun(data, ctx, towerId, lv, a, day, solarPosition, opts);
      rows.push(r);
    }
    return rows;
  }

  function sunriseSunset(lat, lng, day, solarPosition, step = 2) {
    let rise = null, set = null;
    for (let m = 0; m < 1440; m += step) {
      const up = solarPosition(lat, lng, day, m).elevation > 0;
      if (up && rise == null) rise = m;
      if (up) set = m;
    }
    return { rise, set };
  }

  function viewsAt(data, towerId, level) {
    const lv = data.views.by_tower[towerId]?.[level];
    if (!lv) return null;
    const label = Object.fromEntries(data.views.targets.map(t => [t.id, t.label]));
    return Object.fromEntries(Object.entries(lv).map(([a, ids]) => [a, ids.map(id => ({ id, label: label[id] }))]));
  }

  // Camera for "view from level N facing aspect": stand 1 m outside the facade midpoint, eye height above ground.
  // With a target id, the camera turns towards that target (it must be within the facade's field of view to be listed).
  function eyeCamera(data, towerId, level, aspect, targetId = null) {
    const t = data.towers.find(x => x.id === towerId), fp = t.facade_points[aspect];
    let bearing = t.aspects[aspect];
    const tg = targetId && data.views.targets.find(x => x.id === targetId);
    if (tg) {
      const lon = tg.points.reduce((s, p) => s + p[0], 0) / tg.points.length, lat = tg.points.reduce((s, p) => s + p[1], 0) / tg.points.length;
      bearing = bearingTo(fp, [lon, lat]);
    }
    return { lngLat: fp, altitude: levelBase(t, level, data.floor_to_floor_m_est) + 1.6, bearing };
  }
  function bearingTo(a, b) {
    const dx = (b[0] - a[0]) * Math.cos(a[1] * rad), dy = b[1] - a[1];
    return (Math.atan2(dx, dy) / rad + 360) % 360;
  }
  function distanceM(a, b) {
    const dx = (b[0] - a[0]) * rad * R * Math.cos((a[1] + b[1]) / 2 * rad), dy = (b[1] - a[1]) * rad * R;
    return Math.hypot(dx, dy);
  }
  // Pick the most rewarding outlook from the top floors for the walkthrough: most targets, CBD counts a little extra.
  function bestOutlook(data) {
    const score = ids => ids.length + (ids.includes('cbd') ? .5 : 0);
    let best = null;
    for (const t of data.towers) {
      const lv = t.levels - 1;
      for (const [a, ids] of Object.entries(data.views.by_tower[t.id][lv])) {
        const sc = score(ids);
        if (!best || sc > best.score || (sc === best.score && t.levels > best.t.levels)) best = { t, level: lv, a, ids, score: sc };
      }
    }
    let second = null;
    for (const [a, ids] of Object.entries(data.views.by_tower[best.t.id][best.level])) {
      if (a === best.a) continue;
      if (!second || score(ids) > second.score) second = { a, ids, score: score(ids) };
    }
    return { best, second };
  }

  const hm = mins => mins == null ? '—' : `${Math.floor(mins / 60)}:${String(Math.round(mins % 60)).padStart(2, '0')}`;
  const hours = mins => (Math.round(mins / 30) / 2).toFixed(1).replace(/\.0$/, '');

  return { ASPECTS, ASPECT_WORD, frame, context, floorFeatures, levelBase, pointInRing, entryDistance, facadeSun, sunTable, sunriseSunset, viewsAt, eyeCamera, bearingTo, distanceM, bestOutlook, angleDiff, hm, hours };
});
