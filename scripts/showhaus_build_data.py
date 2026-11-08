#!/usr/bin/env python3
"""Build SHOWHAUS data files from public, commercially reusable sources (CC BY 4.0).

  dist/showhaus/data/rents.json     — every NSW rental bond lodgement in NSW postcodes, last 12 months
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

# All of NSW: 2000–2999 except the ACT's 2600–2618 and 2900–2920. Rental bonds are lodged with NSW Fair Trading only.
in_sydney = lambda pc: 2000 <= pc <= 2999 and not (2600 <= pc <= 2618 or 2900 <= pc <= 2920)

# Everyday names people type that are not official boundaries. Each maps to councils (ABS LGA 2021 names)
# or ABS SA4 regions, or explicit postcodes; the app labels them "as commonly used".
COLLOQUIAL = [
    ('Sydney CBD', ['cbd', 'the city', 'city centre', 'sydney city', 'cbd sydney'], {'postcodes': [2000]}),
    ('Inner Sydney', ['inner city', 'inner sydney'], {'lga': ['Sydney']}),
    ('Eastern Suburbs', ['eastern suburbs', 'the eastern suburbs', 'east sydney'], {'lga': ['Waverley', 'Woollahra', 'Randwick']}),
    ('Inner West', ['inner west', 'the inner west'], {'lga': ['Inner West', 'Canada Bay', 'Burwood', 'Strathfield']}),
    ('Lower North Shore', ['lower north shore'], {'lga': ['North Sydney', 'Willoughby', 'Lane Cove', 'Hunters Hill', 'Mosman']}),
    ('Upper North Shore', ['upper north shore'], {'lga': ['Ku-ring-gai', 'Hornsby']}),
    ('North Shore', ['north shore', 'the north shore'], {'lga': ['North Sydney', 'Willoughby', 'Lane Cove', 'Hunters Hill', 'Mosman', 'Ku-ring-gai', 'Hornsby']}),
    ('Northern Beaches', ['northern beaches', 'the beaches'], {'lga': ['Northern Beaches']}),
    ('Sutherland Shire', ['the shire', 'sutherland shire'], {'lga': ['Sutherland Shire']}),
    ('Hills District', ['the hills', 'hills district', 'hills shire'], {'lga': ['The Hills Shire']}),
    ('St George', ['st george', 'saint george'], {'lga': ['Georges River', 'Bayside']}),
    ('Western Sydney', ['western sydney', 'greater western sydney', 'gws', 'west sydney'], {'sa4': ['Sydney - Parramatta', 'Sydney - Blacktown', 'Sydney - Outer West and Blue Mountains', 'Sydney - South West', 'Sydney - Outer South West']}),
    ('South West Sydney', ['south west sydney', 'southwest sydney', 'sw sydney'], {'sa4': ['Sydney - South West', 'Sydney - Outer South West']}),
]
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
    rows, skipped, files = [], {'unknown_rent': 0, 'outside_nsw': 0, 'bad_row': 0}, []
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
            if not in_sydney(pc): skipped['outside_nsw'] += 1; continue
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
        print(f'  {y}-{m:02d}: {n} NSW lodgements', flush=True)
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

def pip(x, y, ring):
    ins = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1: ins = not ins
    return ins
def polys_of(g): return [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
def inside(x, y, g): return any(pip(x, y, p[0]) for p in polys_of(g))

def build_places(postcodes):
    poa = []
    for k in range(0, len(postcodes), 80):
        chunk = postcodes[k:k + 80]
        poa += arcgis_all(ABS + '/POA/MapServer/0', {'where': 'POA_CODE_2021 IN (' + ','.join(f"'{p:04d}'" for p in chunk) + ')', 'outFields': 'POA_CODE_2021', 'returnGeometry': 'true', 'maxAllowableOffset': '0.0012', 'geometryPrecision': '5'}, f'poa-nsw-{k}')
    pc_out = []
    for f in poa:
        g = f['geometry']
        best = max((ring_area_centroid(p[0]) for p in polys_of(g)), key=lambda t: abs(t[0]))
        props = {k.lower(): v for k, v in f['properties'].items()}
        pc_out.append({'pc': int(props['poa_code_2021']), 'c': [round(best[1][0], 5), round(best[1][1], 5)], 'g': rnd(g)})
    # Suburbs (SAL), all of NSW, mapped to the postcode their centre falls in.
    sal = arcgis_all(ABS + '/SAL/MapServer/0', {'where': "STATE_CODE_2021='1'", 'outFields': 'SAL_NAME_2021', 'returnGeometry': 'true', 'maxAllowableOffset': '0.003'}, 'sal-nsw')
    subs = []
    for f in sal:
        g = f['geometry']
        if not g: continue
        _, (cx, cy) = max((ring_area_centroid(p[0]) for p in polys_of(g)), key=lambda t: abs(t[0]))
        props = {k.lower(): v for k, v in f['properties'].items()}
        name = re.sub(r'\s*\(.*\)$', '', props['sal_name_2021'])
        pc = next((p['pc'] for p in pc_out if inside(cx, cy, p['g'])), None)
        if pc is None: continue
        subs.append([name, f'{pc:04d}', round(cy, 5), round(cx, 5)])
    subs.sort()
    # Broad areas: state, Greater Sydney / Rest of NSW, ABS SA4 regions, councils (LGA), plus everyday names.
    def area_layer(svc, code_field, name_field, where, name):
        return [({k.lower(): v for k, v in f['properties'].items()}[name_field], f['geometry'])
                for f in arcgis_all(ABS + f'/{svc}/MapServer/0', {'where': where, 'outFields': f'{code_field},{name_field}', 'returnGeometry': 'true', 'maxAllowableOffset': '0.004'}, name) if f['geometry']]
    def postcodes_in(g): return sorted(p['pc'] for p in pc_out if inside(p['c'][0], p['c'][1], g))
    areas = []
    for nm, g in area_layer('STE', 'STATE_CODE_2021', 'state_name_2021', "STATE_CODE_2021='1'", 'ste'):
        areas.append({'name': nm, 'kind': 'state', 'aliases': ['nsw', 'new south wales'], 'pcs': [p['pc'] for p in pc_out]})
    for nm, g in area_layer('GCCSA', 'GCCSA_CODE_2021', 'gccsa_name_2021', "GCCSA_CODE_2021 IN ('1GSYD','1RNSW')", 'gccsa'):
        areas.append({'name': nm, 'kind': 'metro', 'aliases': ['sydney', 'sydney metro', 'greater sydney', 'sydney wide'] if 'Sydney' in nm else ['regional nsw', 'rest of nsw', 'country nsw'], 'pcs': postcodes_in(g)})
    sa4 = area_layer('SA4', 'SA4_CODE_2021', 'sa4_name_2021', "STATE_CODE_2021='1'", 'sa4')
    for nm, g in sa4:
        areas.append({'name': nm, 'kind': 'region', 'aliases': [nm.replace('Sydney - ', '').lower()] if nm.startswith('Sydney - ') else [], 'pcs': postcodes_in(g)})
    lga = area_layer('LGA', 'LGA_CODE_2021', 'lga_name_2021', "STATE_CODE_2021='1'", 'lga')
    lga_pcs = {}
    for nm, g in lga:
        clean = re.sub(r'\s*\(.*\)$', '', nm)
        lga_pcs[clean] = postcodes_in(g)
        areas.append({'name': clean + ' Council', 'kind': 'council', 'aliases': [clean.lower(), clean.lower() + ' council', 'city of ' + clean.lower()], 'pcs': lga_pcs[clean]})
    sa4_pcs = {nm: postcodes_in(g) for nm, g in sa4}
    for nm, aliases, rule in COLLOQUIAL:
        pcs = set(rule.get('postcodes', []))
        for l in rule.get('lga', []):
            if l not in lga_pcs: raise SystemExit(f'colloquial {nm}: unknown council {l}')
            pcs |= set(lga_pcs[l])
        for r in rule.get('sa4', []):
            if r not in sa4_pcs: raise SystemExit(f'colloquial {nm}: unknown SA4 {r}')
            pcs |= set(sa4_pcs[r])
        areas.append({'name': nm, 'kind': 'everyday', 'aliases': aliases, 'pcs': sorted(pcs), 'rule': rule})
    areas = [a for a in areas if a['pcs']]
    return {'postcodes': sorted(pc_out, key=lambda p: p['pc']), 'suburbs': subs, 'areas': areas}

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
    print('ABS postcodes, suburbs and areas…')
    places = build_places(rents['postcodes'])
    print(f'  {len(places["postcodes"])} postcode polygons, {len(places["suburbs"])} suburbs, {len(places["areas"])} areas')
    gen = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
    meta = {'generatedAt': gen, 'sources': [
        {'name': 'NSW Fair Trading rental bond lodgements', 'url': 'https://www.nsw.gov.au/housing-and-construction/rental-forms-surveys-and-data/rental-bond-data', 'licence': 'CC BY 4.0'},
        {'name': 'ABS ASGS 2021 Postal Areas, Suburbs and Localities, SA4, GCCSA, LGA, State', 'url': 'https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs-edition-3', 'licence': 'CC BY 4.0'}]}
    json.dump({**meta, **rents}, open(os.path.join(OUT, 'rents.json'), 'w'), separators=(',', ':'))
    json.dump({**meta, **places}, open(os.path.join(OUT, 'places.json'), 'w'), separators=(',', ':'))
    for f in ('rents.json', 'places.json'):
        print(f'  wrote {f}: {os.path.getsize(os.path.join(OUT, f)) / 1e6:.2f} MB')
    print(f'done in {time.time() - t0:.0f}s')

if __name__ == '__main__':
    main()
