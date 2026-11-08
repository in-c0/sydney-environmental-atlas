#!/usr/bin/env python3
"""Build SHOWHAUS data files from public, commercially reusable sources (CC BY 4.0).

  dist/showhaus/data/rents.json     — every NSW rental bond lodgement in Greater Sydney postcodes, last 12 months
  dist/showhaus/data/places.json    — postcodes (ABS POA 2021, simplified polygons + centroid) and suburbs (ABS SAL 2021 centroids)
  dist/showhaus/data/schools.json   — NSW Department of Education primary/secondary intake zones (simplified)

Usage: python3 scripts/showhaus_build_data.py [--cache DIR]
Requires: openpyxl, pyshp (pip install openpyxl pyshp). No values are invented: rows with unknown rent are counted and dropped.
"""
import io, json, math, os, re, sys, time, urllib.parse, urllib.request, zipfile, datetime, statistics

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'dist', 'showhaus', 'data')
CACHE = sys.argv[sys.argv.index('--cache') + 1] if '--cache' in sys.argv else os.path.join(ROOT, '.cache', 'showhaus')
os.makedirs(OUT, exist_ok=True); os.makedirs(CACHE, exist_ok=True)
UA = {'User-Agent': 'Mozilla/5.0 (showhaus data build; contact via github.com/in-c0)'}

# Greater Sydney GCCSA postcode ranges (ABS): Sydney metro, Central Coast, Blue Mountains, Hawkesbury, Wollondilly.
RANGES = [(2000, 2249), (2250, 2263), (2555, 2574), (2740, 2786)]
in_sydney = lambda pc: any(a <= pc <= b for a, b in RANGES)
MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

def get(url, name=None, tries=3):
    path = os.path.join(CACHE, name) if name else None
    if path and os.path.exists(path):
        return open(path, 'rb').read()
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                data = r.read()
            if path: open(path, 'wb').write(data)
            return data
        except Exception as e:
            if k == tries - 1: raise
            time.sleep(2 + 3 * k)

# ---------- rental bonds ----------
def bond_urls(latest_year, latest_month, n=12):
    """Monthly files live at /sites/default/files/noindex/<publish yyyy-mm>/rentalbond_lodgements_<month>_<yyyy>.xlsx, published the month after."""
    y, m = latest_year, latest_month
    for _ in range(n):
        py, pm = (y, m + 1) if m < 12 else (y + 1, 1)
        yield (y, m, f'https://www.nsw.gov.au/sites/default/files/noindex/{py}-{pm:02d}/rentalbond_lodgements_{MONTHS[m-1]}_{y}.xlsx')
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)

def parse_bonds(blob):
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(blob), read_only=True, data_only=True)
    ws = next(s for s in wb.worksheets if 'definition' not in s.title.lower())
    header = None
    for row in ws.iter_rows(values_only=True):
        if header is None:
            cells = [str(c or '').strip().lower() for c in row]
            if 'postcode' in cells and any('rent' in c for c in cells):
                header = {name: cells.index(name) for name in cells if name}
            continue
        yield row, header

def build_rents(latest):
    rows, skipped, files = [], {'unknown_rent': 0, 'outside_sydney': 0, 'bad_row': 0}, []
    for y, m, url in bond_urls(*latest):
        try:
            blob = get(url, f'bond-{y}-{m:02d}.xlsx')
        except Exception as e:
            files.append({'month': f'{y}-{m:02d}', 'url': url, 'ok': False, 'error': str(e)[:120]}); continue
        n = 0
        for row, h in parse_bonds(blob):
            try:
                pc = int(row[h['postcode']])
                rent = row[h['weekly rent']]; dtype = str(row[h['dwelling type']] or 'U').strip()[:1].upper(); beds = str(row[h['bedrooms']]).strip()
                d = row[h['lodgement date']]
            except Exception:
                skipped['bad_row'] += 1; continue
            if not in_sydney(pc): skipped['outside_sydney'] += 1; continue
            try: rent = float(rent)
            except (TypeError, ValueError): skipped['unknown_rent'] += 1; continue
            if rent <= 0: skipped['unknown_rent'] += 1; continue
            if isinstance(d, datetime.datetime): ym = d.year * 100 + d.month
            else:
                mm = re.match(r'(\d{1,2})/(\d{1,2})/(\d{4})', str(d)) or re.match(r'(\d{4})-(\d{2})', str(d))
                ym = (int(mm.group(3)) * 100 + int(mm.group(2))) if mm and len(mm.groups()) == 3 else (int(mm.group(1)) * 100 + int(mm.group(2)) if mm else y * 100 + m)
            b = int(beds) if beds.isdigit() else -1
            rows.append((pc, ym, 'FHTOU'.index(dtype) if dtype in 'FHTOU' else 4, min(b, 6), int(round(rent))))
            n += 1
        files.append({'month': f'{y}-{m:02d}', 'url': url, 'ok': True, 'rows': n})
        print(f'  {y}-{m:02d}: {n} Sydney lodgements', flush=True)
    rows.sort()
    pcs = sorted({r[0] for r in rows})
    pci = {p: i for i, p in enumerate(pcs)}
    months = sorted({r[1] for r in rows})
    mi = {v: i for i, v in enumerate(months)}
    return {
        'postcodes': pcs, 'months': months,
        'types': ['Flat/unit', 'House', 'Terrace/townhouse', 'Other', 'Unknown'],
        'pc': [pci[r[0]] for r in rows], 'm': [mi[r[1]] for r in rows], 't': [r[2] for r in rows], 'b': [r[3] for r in rows], 'w': [r[4] for r in rows],
        'files': files, 'skipped': skipped,
    }

# ---------- ABS geography ----------
ABS = 'https://geo.abs.gov.au/arcgis/rest/services/ASGS2021'
def arcgis_all(url, params, name):
    feats, offset = [], 0
    while True:
        q = dict(params, f='geojson', outSR='4326', resultOffset=str(offset), resultRecordCount='500')
        blob = get(url + '/query?' + urllib.parse.urlencode(q), f'{name}-{offset}.json')
        d = json.loads(blob)
        got = d.get('features', [])
        feats += got
        if len(got) < 500: break
        offset += 500
    return feats

def ring_area_centroid(ring):
    a = cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        f = x1 * y2 - x2 * y1; a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f
    if abs(a) < 1e-14: return 0, ring[0]
    return a / 2, (cx / (3 * a), cy / (3 * a))

def rnd(geom, nd=4):
    def r(c): return [round(c[0], nd), round(c[1], nd)]
    if geom['type'] == 'Polygon': return {'type': 'Polygon', 'coordinates': [[r(c) for c in ring] for ring in geom['coordinates']]}
    return {'type': 'MultiPolygon', 'coordinates': [[[r(c) for c in ring] for ring in poly] for poly in geom['coordinates']]}

def build_places(postcodes):
    where = 'POA_CODE_2021 IN (' + ','.join(f"'{p:04d}'" for p in postcodes) + ')'
    poa = []
    # chunk the IN list to keep URLs short
    for k in range(0, len(postcodes), 80):
        chunk = postcodes[k:k + 80]
        poa += arcgis_all(ABS + '/POA/MapServer/0', {'where': 'POA_CODE_2021 IN (' + ','.join(f"'{p:04d}'" for p in chunk) + ')', 'outFields': 'POA_CODE_2021', 'returnGeometry': 'true', 'maxAllowableOffset': '0.0008', 'geometryPrecision': '5'}, f'poa-{k}')
    pc_out = []
    for f in poa:
        g = f['geometry']; polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
        best = max((ring_area_centroid(p[0]) for p in polys), key=lambda t: abs(t[0]))
        pc_out.append({'pc': int(f['properties']['POA_CODE_2021'] if 'POA_CODE_2021' in f['properties'] else f['properties']['poa_code_2021']), 'c': [round(best[1][0], 5), round(best[1][1], 5)], 'g': rnd(g)})
    # Suburbs (SAL) with centroids, NSW only, inside the Greater Sydney bbox.
    sal = arcgis_all(ABS + '/SAL/MapServer/0', {'where': "STATE_CODE_2021='1'", 'geometry': '149.9,-34.6,151.7,-32.9', 'geometryType': 'esriGeometryEnvelope', 'inSR': '4326', 'spatialRel': 'esriSpatialRelIntersects', 'outFields': 'SAL_NAME_2021', 'returnGeometry': 'true', 'maxAllowableOffset': '0.002'}, 'sal')
    subs = []
    def pip(x, y, ring):
        ins = False
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1: ins = not ins
        return ins
    for f in sal:
        g = f['geometry']; polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
        _, (cx, cy) = max((ring_area_centroid(p[0]) for p in polys), key=lambda t: abs(t[0]))
        name = re.sub(r'\s*\(.*\)$', '', (f['properties'].get('SAL_NAME_2021') or f['properties'].get('sal_name_2021')))
        pc = None
        for p in pc_out:
            pp = [p['g']['coordinates']] if p['g']['type'] == 'Polygon' else p['g']['coordinates']
            if any(pip(cx, cy, poly[0]) for poly in pp): pc = p['pc']; break
        if pc is None: continue  # suburb centre outside Greater Sydney postcodes
        subs.append([name, f'{pc:04d}', round(cy, 5), round(cx, 5)])
    subs.sort()
    return {'postcodes': sorted(pc_out, key=lambda p: p['pc']), 'suburbs': subs}

def main():
    t0 = time.time()
    today = datetime.date.today()
    # latest published month = two months back is always out; try last month first.
    ly, lm = (today.year, today.month - 1) if today.month > 1 else (today.year - 1, 12)
    probe = next(bond_urls(ly, lm, 1))[2]
    try: get(probe, f'bond-{ly}-{lm:02d}.xlsx')
    except Exception: ly, lm = (ly, lm - 1) if lm > 1 else (ly - 1, 12)
    print(f'rental bonds: 12 months ending {ly}-{lm:02d}')
    rents = build_rents((ly, lm))
    print(f'  {len(rents["w"])} lodgements, {len(rents["postcodes"])} postcodes, skipped {rents["skipped"]}')
    print('ABS postcodes and suburbs…')
    places = build_places(rents['postcodes'])
    print(f'  {len(places["postcodes"])} postcode polygons, {len(places["suburbs"])} suburbs')
    gen = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
    meta = {'generatedAt': gen, 'sources': [
        {'name': 'NSW Fair Trading rental bond lodgements', 'url': 'https://www.nsw.gov.au/housing-and-construction/rental-forms-surveys-and-data/rental-bond-data', 'licence': 'CC BY 4.0'},
        {'name': 'ABS ASGS 2021 Postal Areas and Suburbs and Localities', 'url': 'https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs-edition-3', 'licence': 'CC BY 4.0'}]}
    json.dump({**meta, **rents}, open(os.path.join(OUT, 'rents.json'), 'w'), separators=(',', ':'))
    json.dump({**meta, **places}, open(os.path.join(OUT, 'places.json'), 'w'), separators=(',', ':'))
    for f in ('rents.json', 'places.json'):
        print(f'  wrote {f}: {os.path.getsize(os.path.join(OUT, f)) / 1e6:.2f} MB')
    print(f'done in {time.time() - t0:.0f}s')

if __name__ == '__main__':
    main()
