/* Exploratory road-geometry orientation — never acoustic sound pressure or measured noise. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AtlasDirectionalExposure = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SECTORS = 12;
  const RADIUS = 250;
  const STEP = 12;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Keep the data radius at 250 m while shrinking only its on-map glyph at
  // street-level zoom. The petals are a compass diagram, not a geographic
  // noise footprint; they should never obscure entire buildings.
  function visualScale(zoom, lat) {
    if (!Number.isFinite(zoom) || !Number.isFinite(lat)) return 1;
    const metresPerPixel = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    return clamp(112 * metresPerPixel / RADIUS, .13, 1);
  }

  // Every road segment is sampled at bounded intervals, avoiding a bias toward
  // the source dataset's vertex density. Bearings run clockwise from north.
  function profile(roads, lat, lng) {
    if (!Array.isArray(roads) || !roads.length) return null;
    const eastScale = 111320 * Math.cos(lat * Math.PI / 180);
    const northScale = 111320;
    const weights = Array(SECTORS).fill(0);
    let sampleCount = 0;
    for (const road of roads) {
      const pts = road.points;
      if (!Array.isArray(pts)) continue;
      for (let j = 1; j < pts.length; j++) {
        const a = pts[j - 1], b = pts[j];
        const ax = (a[1] - lng) * eastScale, ay = (a[0] - lat) * northScale;
        const bx = (b[1] - lng) * eastScale, by = (b[0] - lat) * northScale;
        const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
        if (!length || !Number.isFinite(length)) continue;
        // Reject segments definitely beyond the study radius.
        if (Math.min(ax, bx) > RADIUS || Math.max(ax, bx) < -RADIUS ||
            Math.min(ay, by) > RADIUS || Math.max(ay, by) < -RADIUS) continue;
        const steps = Math.ceil(length / STEP);
        for (let k = 0; k < steps; k++) {
          const t = (k + .5) / steps, x = ax + t * dx, y = ay + t * dy;
          const r = Math.hypot(x, y);
          if (r > RADIUS) continue;
          sampleCount++;
          const angle = (Math.atan2(x, y) + 2 * Math.PI) % (2 * Math.PI);
          const sector = angle * SECTORS / (2 * Math.PI);
          const primary = Math.floor(sector) % SECTORS;
          // Soft interpolation makes nearby segments read as broad directional
          // tendencies, not spurious laser-precise acoustic rays.
          const fraction = sector - Math.floor(sector);
          const influence = (length / steps) * Math.exp(-r / 115);
          weights[primary] += influence * (1 - fraction);
          weights[(primary + 1) % SECTORS] += influence * fraction;
        }
      }
    }
    if (!sampleCount) return {weights, relative: weights.slice(), peak: null, sampleCount: 0};
    const max = Math.max(...weights);
    const relative = weights.map(w => max > 0 ? clamp(w / max, 0, 1) : 0);
    return {weights, relative, peak: weights.indexOf(max), sampleCount};
  }

  function polygon(lat, lng, startBearing, endBearing, inner = 25, outer = RADIUS) {
    const eastScale = 111320 * Math.cos(lat * Math.PI / 180);
    const point = (bearing, distance) => {
      const rad = bearing * Math.PI / 180;
      return [lng + Math.sin(rad) * distance / eastScale, lat + Math.cos(rad) * distance / 111320];
    };
    const steps = 5, ring = [];
    for (let i = 0; i <= steps; i++) ring.push(point(startBearing + (endBearing - startBearing) * i / steps, outer));
    for (let i = steps; i >= 0; i--) ring.push(point(startBearing + (endBearing - startBearing) * i / steps, inner));
    ring.push(ring[0]);
    return ring;
  }

  function toGeoJSON(profileResult, lat, lng, pulse = 0, scale = 1) {
    if (!profileResult || profileResult.peak === null) return {type: 'FeatureCollection', features: []};
    const glyphScale=clamp(Number.isFinite(scale)?scale:1,.13,1);
    return {type: 'FeatureCollection', features: profileResult.relative.map((level, i) => ({
      type: 'Feature',
      properties: {
        sector: i, level,
        height: (7 + 72 * level * (1 + .035 * pulse)) * Math.pow(glyphScale, .7),
      },
      geometry: {type: 'Polygon', coordinates: [polygon(lat, lng, i * 30 - 15 + 1, i * 30 + 15 - 1, 24*glyphScale, RADIUS*glyphScale)]}
    }))};
  }

  // Road geometry has no defensible mapping to decibels or livability. Do not
  // turn proximity or direction weights into environmental or property scores.
  return {SECTORS, RADIUS, profile, polygon, toGeoJSON, visualScale};
});
