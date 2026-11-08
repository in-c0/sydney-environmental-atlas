#!/usr/bin/env python3
"""Per-postcode "what matters at home" measures for SHOWHAUS, so filters can count leases honestly.

Method: every ABS 2021 SA1 (statistical area of ~200–800 residents, so SA1 centres roughly follow where people live)
is assigned to the postcode its centre falls in. For each SA1 centre we measure straight-line distance to the nearest
supermarket, park, station and school, and to the nearest motorway/trunk/primary road; canopy is read from the
NSW 2024–25 canopy grid hexagon under the SA1 centre (Greater Sydney only). A postcode's value is the share of its
SA1 centres meeting the threshold (e.g. "62% of neighbourhoods within 1 km of a supermarket").

  dist/showhaus/data/amenities.json

Sources: ABS ASGS 2021 SA1 (CC BY 4.0); OpenStreetMap via Overpass (ODbL) for supermarkets, parks, stations, main roads;
NSW Spatial Services Features of Interest for train stations and schools (CC BY 4.0); NSW canopy H3 grid; NSW Planning
Portal Western Sydney Airport ANEC contours (CC BY). Usage: python3 scripts/showhaus_build_amenities.py
"""
import json, math, os, sys, time, urllib.parse, urllib.request, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from showhaus_build_data import get, arcgis_all, ABS, OUT, CACHE, ring_area_centroid, polys_of, inside, UA  # noqa: E402

THRESH = {'supermarket': 1000, 'park': 400, 'station': 800, 'school': 800, 'quiet': 150}
OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
NSW_BBOX = (-37.6, 140.9, -28.1, 153.7)

def overpass(q, name):
    path = os.path.join(CACHE, name)
    if os.path.exists(path): return json.load(open(path))
    last = None
    for url in OVERPASS:
        for k in range(2):
            try:
                req = urllib.request.Request(url, data=urllib.parse.urlencode({'data': q}).encode(), headers=UA)
                with urllib.request.urlopen(req, timeout=400) as r: d = json.loads(r.read())
                json.dump(d, open(path, 'w')); return d
            except Exception as e:
                last = e; time.sleep(20 * (k + 1))
    raise SystemExit(f'Overpass failed for {name}: {last}')

def osm_points(selectors, name):
    s, w, n, e = NSW_BBOX
    body = ''.join(f'{t}{sel}({s},{w},{n},{e});' for sel in selectors for t in ('node', 'way', 'relation'))
    d = overpass(f'[out:json][timeout:360];({body});out center;', name)
    pts = []
    for el in d['elements']:
        if 'lat' in el: pts.append((el['lon'], el['lat']))
        elif 'center' in el: pts.append((el['center']['lon'], el['center']['lat']))
    return pts

def osm_road_vertices():
    s, w, n, e = NSW_BBOX
    d = overpass(f'[out:json][timeout:360];way["highway"~"^(motorway|trunk|primary)$"]({s},{w},{n},{e});out geom;', 'osm-main-roads.json')
    pts = []
    for el in d['elements']:
        g = el.get('geometry') or []
        for a, b in zip(g, g[1:]):  # densify to ~50 m so vertex distance ≈ line distance
            steps = max(1, int(math.hypot((b['lon'] - a['lon']) * 92000, (b['lat'] - a['lat']) * 111000) // 50))
            for k in range(steps): pts.append((a['lon'] + (b['lon'] - a['lon']) * k / steps, a['lat'] + (b['lat'] - a['lat']) * k / steps))
        if g: pts.append((g[-1]['lon'], g[-1]['lat']))
    return pts

def nsw_foi(url, name):
    feats = arcgis_all(url, {'where': '1=1', 'outFields': 'generalname', 'returnGeometry': 'true'}, name)
    return [tuple(f['geometry']['coordinates'][:2]) for f in feats if f.get('geometry')]

class Grid:
    """Points bucketed in ~1.1 km cells; nearest distance searched in a growing ring of cells, capped."""
    def __init__(self, pts, cell=0.01):
        self.cell, self.b = cell, {}
        for x, y in pts: self.b.setdefault((int(x // cell), int(y // cell)), []).append((x, y))
    def nearest(self, x, y, cap_m):
        cx, cy, best = int(x // self.cell), int(y // self.cell), None
        kx = 111320 * math.cos(math.radians(y))
        rings = int(cap_m / (self.cell * 111320)) + 2
        for r in range(rings + 1):
            for i in range(cx - r, cx + r + 1):
                for j in range(cy - r, cy + r + 1):
                    if max(abs(i - cx), abs(j - cy)) != r: continue
                    for px, py in self.b.get((i, j), ()):
                        d = math.hypot((px - x) * kx, (py - y) * 111320)
                        if best is None or d < best: best = d
            if best is not None and best < (r) * self.cell * 111320: break
        return best if best is not None else float('inf')

def main():
    t0 = time.time()
    places = json.load(open(os.path.join(OUT, 'places.json')))
    pcs = places['postcodes']
    print('ABS SA1 centres…', flush=True)
    sa1 = arcgis_all(ABS + '/SA1/MapServer/0', {'where': "STATE_CODE_2021='1'", 'outFields': 'SA1_CODE_2021', 'returnGeometry': 'true', 'maxAllowableOffset': '0.002', 'geometryPrecision': '5'}, 'sa1-nsw')
    centres = []
    for f in sa1:
        g = f['geometry']
        if not g: continue
        _, (x, y) = max((ring_area_centroid(p[0]) for p in polys_of(g)), key=lambda t: abs(t[0]))
        centres.append((x, y))
    # assign each SA1 centre to a postcode (bbox prefilter)
    boxes = []
    for p in pcs:
        xs = [c[0] for poly in polys_of(p['g']) for c in poly[0]]; ys = [c[1] for poly in polys_of(p['g']) for c in poly[0]]
        boxes.append((min(xs), min(ys), max(xs), max(ys)))
    by_pc = {p['pc']: [] for p in pcs}
    for x, y in centres:
        for p, (a, b, c, d) in zip(pcs, boxes):
            if a <= x <= c and b <= y <= d and inside(x, y, p['g']): by_pc[p['pc']].append((x, y)); break
    print(f'  {len(centres)} SA1 centres, {sum(map(len, by_pc.values()))} inside a postcode', flush=True)

    print('Amenities…', flush=True)
    layers = {
        'supermarket': osm_points(['["shop"="supermarket"]'], 'osm-supermarkets.json'),
        'park': osm_points(['["leisure"="park"]', '["leisure"="nature_reserve"]'], 'osm-parks.json'),
        'station': osm_points(['["railway"="station"]', '["railway"="halt"]', '["station"="subway"]', '["railway"="tram_stop"]'], 'osm-stations.json')
                   + nsw_foi('https://portal.spatial.nsw.gov.au/server/rest/services/NSW_FOI_Transport_Facilities/FeatureServer/1', 'foi-train'),
        'school': nsw_foi('https://portal.spatial.nsw.gov.au/server/rest/services/NSW_FOI_Education_Facilities/FeatureServer/0', 'foi-primary')
                  + nsw_foi('https://portal.spatial.nsw.gov.au/server/rest/services/NSW_FOI_Education_Facilities/FeatureServer/1', 'foi-combined')
                  + nsw_foi('https://portal.spatial.nsw.gov.au/server/rest/services/NSW_FOI_Education_Facilities/FeatureServer/2', 'foi-high'),
        'road': osm_road_vertices(),
    }
    for k, v in layers.items(): print(f'  {k}: {len(v)} points', flush=True)
    grids = {k: Grid(v) for k, v in layers.items()}

    # Western Sydney Airport ANEC contours (polygons) — a postcode share inside any contour.
    anec = arcgis_all('https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/Protection/MapServer/2', {'where': '1=1', 'outFields': 'ANEF_CODE', 'returnGeometry': 'true'}, 'anec')

    # Canopy: hexagon under each SA1 centre, Greater Sydney grid only (batched multipoint queries).
    canopy_url = 'https://mapprod2.environment.nsw.gov.au/arcgis/rest/services/UHGC/GSR_2024_VegStrata_H3Z11/MapServer/0/query'
    gs = next(a for a in places['areas'] if a['name'] == 'Greater Sydney')
    gs_pcs = set(gs['pcs'])
    canopy_at = {}
    todo = [pt for pc in gs_pcs for pt in by_pc.get(pc, [])]
    for k in range(0, len(todo), 60):
        batch = todo[k:k + 60]
        geom = json.dumps({'points': [[x, y] for x, y in batch], 'spatialReference': {'wkid': 4326}})
        q = urllib.parse.urlencode({'where': '1=1', 'geometry': geom, 'geometryType': 'esriGeometryMultipoint', 'inSR': '4326', 'outSR': '4326', 'spatialRel': 'esriSpatialRelIntersects', 'outFields': 'Canopy_pc', 'returnGeometry': 'true', 'f': 'geojson'})
        try:
            d = json.loads(urllib.request.urlopen(urllib.request.Request(canopy_url, data=q.encode(), headers=UA), timeout=90).read())
        except Exception as e:
            print(f'  canopy batch {k} failed: {e}', flush=True); continue
        for f in d.get('features', []):
            for x, y in batch:
                if (x, y) not in canopy_at and f.get('geometry') and inside(x, y, f['geometry']): canopy_at[(x, y)] = f['properties']['Canopy_pc']
        if k % 1200 == 0: print(f'  canopy {k}/{len(todo)}', flush=True)

    out = {}
    for p in pcs:
        pts = by_pc.get(p['pc'], [])
        if not pts: continue
        n = len(pts)
        share = lambda key, lim: round(sum(1 for x, y in pts if grids[key].nearest(x, y, lim) <= lim) / n, 3)
        rec = {'n': n,
               'supermarket': share('supermarket', THRESH['supermarket']),
               'park': share('park', THRESH['park']),
               'station': share('station', THRESH['station']),
               'school': share('school', THRESH['school']),
               'quiet': round(sum(1 for x, y in pts if grids['road'].nearest(x, y, THRESH['quiet']) > THRESH['quiet']) / n, 3),
               'anec': round(sum(1 for x, y in pts if any(inside(x, y, f['geometry']) for f in anec if f.get('geometry'))) / n, 3)}
        cv = [canopy_at[pt] for pt in pts if pt in canopy_at]
        rec['canopy'] = round(sum(cv) / len(cv), 3) if p['pc'] in gs_pcs and len(cv) >= max(1, n // 2) else None
        rec['s'] = [v for x, y in pts for v in (round(x, 4), round(y, 4))]  # SA1 centres: where people live, for the dot map
        out[p['pc']] = rec
    meta = {'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
            'method': 'Share of ABS 2021 SA1 centres in each postcode meeting each threshold (straight-line metres). Canopy = mean NSW 2024–25 hexagon canopy under SA1 centres, Greater Sydney only.',
            'thresholds_m': THRESH,
            'sources': [{'name': 'ABS ASGS 2021 SA1', 'licence': 'CC BY 4.0'}, {'name': 'OpenStreetMap contributors (Overpass)', 'licence': 'ODbL'},
                        {'name': 'NSW Spatial Services Features of Interest', 'licence': 'CC BY 4.0'}, {'name': 'NSW 2024–25 canopy H3 grid', 'licence': 'see data.nsw'},
                        {'name': 'NSW Planning Portal — Western Sydney Airport ANEC', 'licence': 'CC BY 4.0'}],
            'counts': {k: len(v) for k, v in layers.items()}}
    json.dump({**meta, 'postcodes': out}, open(os.path.join(OUT, 'amenities.json'), 'w'), separators=(',', ':'))
    print(f'wrote amenities.json for {len(out)} postcodes in {time.time() - t0:.0f}s')

if __name__ == '__main__':
    main()
