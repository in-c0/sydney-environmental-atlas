/*
 * Solar shadows for mapped building footprints, projected onto a level plane.
 * No invented storey heights: only source features with render_height are used.
 * This is intentionally not a terrain-aware or property-grade shadow study.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AtlasShadowGeometry = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const toRadians = degrees => degrees * Math.PI / 180;

  function movePoint(coordinate, bearing, distanceMeters) {
    const [longitude, latitude] = coordinate;
    const bearingRadians = toRadians(bearing);
    const cosLatitude = Math.cos(toRadians(latitude));
    if (Math.abs(cosLatitude) < 0.0001) return null;
    return [
      longitude + distanceMeters * Math.sin(bearingRadians) / (111320 * cosLatitude),
      latitude + distanceMeters * Math.cos(bearingRadians) / 111320
    ];
  }

  function exteriorRings(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return geometry.coordinates.length ? [geometry.coordinates[0]] : [];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates.filter(p => p.length).map(p => p[0]);
    return [];
  }

  function cleanedRing(raw) {
    if (!Array.isArray(raw)) return [];
    const points = raw.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]) points.pop();
    return points.length >= 3 && points.length <= 180 ? points : [];
  }

  function castBuilding(feature, sun, { maxLengthMeters = 220 } = {}) {
    const height = Number(feature?.properties?.render_height);
    const minHeight = Number(feature?.properties?.render_min_height || 0);
    // Elevated roofs, uncertain elevations and malformed source values are skipped.
    if (!Number.isFinite(height) || height <= 2 || height > 500 || minHeight > 0 || feature?.properties?.hide_3d === true) return null;
    if (!Number.isFinite(sun?.elevation) || !Number.isFinite(sun?.azimuth) || sun.elevation <= 6 || sun.elevation >= 90) return null;
    const distance = height / Math.tan(toRadians(sun.elevation));
    if (!Number.isFinite(distance) || distance > maxLengthMeters) return null;
    const direction = (sun.azimuth + 180) % 360;
    const polygons = [];
    for (const input of exteriorRings(feature.geometry)) {
      const ring = cleanedRing(input);
      if (!ring.length) continue;
      const shifted = ring.map(point => movePoint(point, direction, distance));
      if (shifted.some(point => !point)) continue;
      const footprint = [...shifted, shifted[0]];
      polygons.push([footprint]);
      for (let i = 0; i < ring.length; i++) {
        const next = (i + 1) % ring.length;
        polygons.push([[ring[i], ring[next], shifted[next], shifted[i], ring[i]]]);
      }
    }
    return polygons.length ? { type: 'Feature', properties: { height_m: height }, geometry: { type: 'MultiPolygon', coordinates: polygons } } : null;
  }

  function buildShadowGeoJSON(features, sun, { maxBuildings = 250, maxLengthMeters = 220 } = {}) {
    const used = new Set(), shadows = [];
    let omitted = 0;
    for (const feature of features || []) {
      const ring = exteriorRings(feature?.geometry)[0];
      const id = feature?.id ?? feature?.properties?.id;
      const first = ring?.[0];
      const fingerprint = id != null ? `id:${id}` : first ? `xy:${first[0].toFixed(5)},${first[1].toFixed(5)}:${feature?.properties?.render_height}` : null;
      if (fingerprint && used.has(fingerprint)) continue;
      if (fingerprint) used.add(fingerprint);
      const projected = castBuilding(feature, sun, { maxLengthMeters });
      if (!projected) { omitted++; continue; }
      if (shadows.length >= maxBuildings) { omitted++; continue; }
      shadows.push(projected);
    }
    return { type: 'FeatureCollection', features: shadows, omitted };
  }

  return { movePoint, castBuilding, buildShadowGeoJSON };
});
