import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

// Sydney Eastern Suburbs + CBD. Source: © State of NSW (Spatial Services), CC BY 4.0.
// Run manually to refresh static geometry; never query the government service per visitor.
const run = promisify(execFile);
const outDir = path.resolve('dist/data');
const bounds = { south: -33.960, north: -33.840, west: 151.170, east: 151.290 };
const rows = 6, cols = 6;
const tiles = [];
await fs.mkdir(outDir, { recursive: true });

async function fetchTile(i, j) {
  const s = bounds.south + (bounds.north - bounds.south) * i / rows;
  const n = bounds.south + (bounds.north - bounds.south) * (i + 1) / rows;
  const w = bounds.west + (bounds.east - bounds.west) * j / cols;
  const e = bounds.west + (bounds.east - bounds.west) * (j + 1) / cols;
  const box = [s, w, n, e].map(x => +x.toFixed(6));
  const args = [
    '-fsSL', '--retry', '2', '--max-time', '35', '-G',
    'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Land_Parcel_Property_Theme/FeatureServer/1/query',
    '--data-urlencode', 'where=1=1',
    '--data-urlencode', `geometry=${w},${s},${e},${n}`,
    '--data-urlencode', 'geometryType=esriGeometryEnvelope',
    '--data-urlencode', 'inSR=4326',
    '--data-urlencode', 'spatialRel=esriSpatialRelIntersects',
    '--data-urlencode', 'outFields=roadnamelabel',
    '--data-urlencode', 'returnGeometry=true',
    '--data-urlencode', 'outSR=4326',
    '--data-urlencode', 'resultRecordCount=2000',
    '--data-urlencode', 'f=geojson',
  ];
  const { stdout } = await run('curl', args, { maxBuffer: 25 * 1024 * 1024 });
  const source = JSON.parse(stdout);
  if (source.error) throw new Error(source.error.message);
  if (!Array.isArray(source.features)) throw new Error('Expected GeoJSON FeatureCollection');
  if (source.features.length >= 1950) throw new Error('Truncated road response; subdivide tile ' + i + '-' + j);
  const roads = [];
  for (const feature of source.features) {
    const geo = feature.geometry;
    if (!geo) continue;
    const lines = geo.type === 'MultiLineString' ? geo.coordinates : geo.type === 'LineString' ? [geo.coordinates] : [];
    for (const line of lines) {
      if (line.length < 2) continue;
      roads.push({ type: 'unclassified', points: line.map(p => [+p[1].toFixed(6), +p[0].toFixed(6)]) });
    }
  }
  const name = `roads-${i}-${j}.json`;
  await fs.writeFile(path.join(outDir, name), JSON.stringify({ roads }));
  return { id: `${i}-${j}`, url: `data/${name}`, bbox: box, count: roads.length };
}

const jobs = [];
for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) jobs.push([i, j]);
let cursor = 0;
async function worker() {
  while (cursor < jobs.length) {
    const [i, j] = jobs[cursor++];
    const tile = await fetchTile(i, j);
    tiles.push(tile);
    process.stdout.write(`tile ${tile.id}: ${tile.count} roads\n`);
  }
}
await Promise.all(Array.from({ length: 3 }, () => worker()));
tiles.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify({
  source: 'NSW Spatial Services Road Centreline, cadastral road-corridor geometry',
  licence: 'CC BY 4.0',
  attribution: '© State of New South Wales (Spatial Services, a business unit of the Department of Customer Service NSW).',
  derived: 'Coordinates rounded to 6 decimal places; simplified into browser-friendly line segments.',
  downloaded_at: new Date().toISOString(),
  bounds,
  tiles,
}));
console.log(`Completed ${tiles.length} tiles, ${tiles.reduce((n, t) => n + t.count, 0)} road segments`);
