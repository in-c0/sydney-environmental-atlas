/* Schematic 3D shapes from City of Sydney's published tree asset dimensions.
 * TreeHeight is total height in metres; TreeCanopyNS is north-south canopy spread
 * in metres. Round crowns/trunk proportions are purely cartographic, not surveys.
 */
(function (root) {
  'use strict';
  const RAD = Math.PI / 180;
  const collection = features => ({ type: 'FeatureCollection', features });

  function disc(lon, lat, radius, sides = 10) {
    const north = radius / 111320;
    const east = radius / (111320 * Math.cos(lat * RAD));
    const coordinates = [];
    for (let i = 0; i < sides; i++) {
      const angle = (2 * Math.PI * i) / sides;
      coordinates.push([lon + east * Math.cos(angle), lat + north * Math.sin(angle)]);
    }
    coordinates.push([...coordinates[0]]);
    return { type: 'Polygon', coordinates: [coordinates] };
  }

  function makeTreeShapes(input, limit = 350) {
    if (!Array.isArray(input?.features)) return collection([]);
    const output = [];
    let renderedTrees = 0;
    for (const tree of input.features) {
      if (renderedTrees >= limit) break;
      if (tree.geometry?.type !== 'Point') continue;
      const [lon, lat] = tree.geometry.coordinates || [];
      const p = tree.properties || {};
      const height = Number(p.TreeHeight);
      const canopy = Number(p.TreeCanopyNS);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 70 ||
          !Number.isFinite(height) || height < 2 || height > 70 ||
          !Number.isFinite(canopy) || canopy < 1 || canopy > 65) continue;

      const key = String(p.OBJECTID ?? p.asset_id ?? renderedTrees);
      const parts = [
        ['trunk', Math.min(.33, Math.max(.12, canopy * .025)), 0, .56],
        ['crown-base', canopy * .34, .50, .66],
        ['crown-wide', canopy * .50, .64, .81],
        ['crown-upper', canopy * .36, .79, .93],
        ['crown-tip', canopy * .17, .91, 1]
      ];
      for (const [part, radius, bottom, top] of parts) {
        output.push({
          type: 'Feature',
          properties: { key, part, base: height * bottom, top: height * top,
            height, canopy, species: String(p.SpeciesName || ''), name: String(p.CommonName || '') },
          geometry: disc(lon, lat, radius)
        });
      }
      renderedTrees++;
    }
    return collection(output);
  }
  const api = { disc, makeTreeShapes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AtlasTreeGeometry = api;
})(typeof window !== 'undefined' ? window : globalThis);
