"""SHOWHAUS — estimate a plan JSON for a home that was suggested by address only (no floor plan on file).

    python3 estimate.py "199 Forest Rd, Arncliffe"            --slug arncliffe-199-forest --out /tmp/est
    python3 estimate.py "addr:199 FOREST ROAD ARNCLIFFE"      --slug arncliffe-199-forest --out /tmp/est

Everything comes from public NSW Spatial Services data, no account:
  1. the NSW address register (GURAS) for the address point,
  2. the cadastre lot that contains it (NSW_Land_Parcel_Property_Theme / Lot),
  3. the road with the address's street name (NSW_Transport_Theme / RoadSegment) — that side of the lot is the front,
  4. the NSW aerial mosaic (maps.six.nsw.gov.au NSW_Imagery) clipped to the lot: the roof is the largest non-vegetation,
     non-shadow blob inside the lot, measured in the lot's own axes. If that blob is implausible, setbacks are used.

Out (in --out): <slug>.plan.json (source "estimate", every guess under "assumptions", passes `walkgen.py check`),
aerial.jpg (the clip with the lot and the roof estimate drawn on it — the nightly builder looks at it and may correct the
roof box before baking), estimate.json (the measured numbers). Then: walkgen.py preview | bake | pack as for any plan.

The interior is one open kitchen/dining/living space at the rear of the roof footprint (walkgen models one rectilinear
space). Rooms behind it are closed doors. Nothing here claims to know the real interior; the page says so (BASIS.estimate).
"""
import argparse, io, json, math, os, re, sys, urllib.parse, urllib.request

import numpy as np
from PIL import Image, ImageDraw

NSW = 'https://portal.spatial.nsw.gov.au/server/rest/services'
GURAS = NSW + '/NSW_Geocoded_Addressing_Theme/FeatureServer/1/query'
LOT = NSW + '/NSW_Land_Parcel_Property_Theme/MapServer/8/query'
ROAD = NSW + '/NSW_Transport_Theme/MapServer/5/query'
AERIAL = 'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Imagery/MapServer/export'
ROADS = {'RD': 'ROAD', 'ST': 'STREET', 'AVE': 'AVENUE', 'AV': 'AVENUE', 'PDE': 'PARADE', 'HWY': 'HIGHWAY', 'CRES': 'CRESCENT',
         'CR': 'CRESCENT', 'CL': 'CLOSE', 'CT': 'COURT', 'DR': 'DRIVE', 'PL': 'PLACE', 'TCE': 'TERRACE', 'LN': 'LANE',
         'CCT': 'CIRCUIT', 'BVD': 'BOULEVARD', 'BLVD': 'BOULEVARD', 'GR': 'GROVE', 'GRV': 'GROVE', 'SQ': 'SQUARE',
         'ESP': 'ESPLANADE', 'WY': 'WAY', 'PKWY': 'PARKWAY'}
ROAD_WORDS = set(ROADS.values()) | {'WAY', 'CIRCUS', 'GLEN', 'GREEN', 'PATH', 'PROMENADE', 'QUAY', 'RETREAT', 'TRACK',
                                    'VISTA', 'RISE', 'ROW', 'LOOP', 'MEWS', 'TRAIL', 'ARCADE', 'ALLEY', 'GARDENS', 'HEIGHTS',
                                    'VIEW', 'WALK'}


# ---------- address ----------
def normalize(raw):
    """Same rules as src/suggest.js normalizeAddress (keep the two in step)."""
    s = str(raw or '').strip()
    if s.lower().startswith('addr:'):
        s = s[5:]
    s = s.upper().replace('‘', "'").replace('’', "'")
    s = re.sub(r'[,.;]', ' ', s)
    s = re.sub(r'\bAUSTRALIA\b', ' ', s)
    s = re.sub(r'\bN\s*S\s*W\b|\bNEW SOUTH WALES\b', ' ', s)
    s = re.sub(r'\b2\d{3}\s*$', ' ', s.strip())
    s = re.sub(r'\s*/\s*', '/', s)
    s = re.sub(r'^(UNIT|APT|APARTMENT|LOT|SHOP|SUITE)\s+(\d+[A-Z]?)\s+', r'\2/', s)
    s = re.sub(r"[^A-Z0-9 '/-]", ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    if not re.match(r"^\d+[A-Z]?(/\d+[A-Z]?)?(-\d+[A-Z]?)? [A-Z']", s):
        return None
    return ' '.join(ROADS.get(w, w) if i else w for i, w in enumerate(s.split(' ')))


def street_of(addr):
    """('199 FOREST ROAD ARNCLIFFE') → ('FOREST', 'ROAD')."""
    w = addr.split(' ')[1:]
    for i in range(len(w) - 1, -1, -1):
        if w[i] in ROAD_WORDS and i > 0:
            return ' '.join(w[:i]), w[i]
    return (w[0] if w else ''), ''


def title(a):
    w = a.split(' ')
    cut = max([i for i, x in enumerate(w) if i > 1 and x in ROAD_WORDS and i < len(w) - 1] or [-1])
    t = lambda x: re.sub(r"(^|[\s'-])([a-z])", lambda m: m.group(1) + m.group(2).upper(), x.lower())
    return (t(' '.join(w[:cut + 1])) + ', ' + t(' '.join(w[cut + 1:]))) if cut >= 0 else t(a)


# ---------- http ----------
def get(url, params, binary=False):
    req = urllib.request.Request(url + '?' + urllib.parse.urlencode(params), headers={'User-Agent': 'showhaus-estimate/1'})
    for attempt in range(3):  # the NSW servers time out now and then
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                data = r.read()
            break
        except (TimeoutError, OSError):
            if attempt == 2:
                raise
    if binary:
        return data
    d = json.loads(data)
    if 'error' in d:
        raise RuntimeError(f"{url}: {d['error']}")
    return d


def q(url, **kw):
    return get(url, {'f': 'json', 'outSR': '4326', **kw})


# ---------- geometry (local metres around the address point) ----------
class Local:
    def __init__(self, lng, lat):
        self.lng0, self.lat0, self.k = lng, lat, math.cos(math.radians(lat))

    def m(self, lng, lat):
        return np.array([(lng - self.lng0) * 111320.0 * self.k, (lat - self.lat0) * 110574.0])

    def ll(self, x, y):
        return self.lng0 + x / (111320.0 * self.k), self.lat0 + y / 110574.0


def seg_dist(p, a, b):
    ab = b - a
    t = 0.0 if not ab.any() else max(0.0, min(1.0, float(np.dot(p - a, ab) / np.dot(ab, ab))))
    return float(np.linalg.norm(p - (a + t * ab)))


def poly_area(P):
    x, y = P[:, 0], P[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def inside_mask(P, X, Y):
    """Even-odd point-in-polygon for grids X, Y."""
    m = np.zeros(X.shape, bool)
    n = len(P)
    for i in range(n):
        (x1, y1), (x2, y2) = P[i], P[(i + 1) % n]
        c = ((y1 > Y) != (y2 > Y)) & (X < (x2 - x1) * (Y - y1) / ((y2 - y1) or 1e-12) + x1)
        m ^= c
    return m


def components(mask):
    from collections import deque
    lab = np.zeros(mask.shape, np.int32)
    sizes, cur = [0], 0
    H, W = mask.shape
    for sy, sx in zip(*np.nonzero(mask)):
        if lab[sy, sx]:
            continue
        cur += 1
        n, dq = 0, deque([(sy, sx)])
        lab[sy, sx] = cur
        while dq:
            y, x = dq.popleft(); n += 1
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                yy, xx = y + dy, x + dx
                if 0 <= yy < H and 0 <= xx < W and mask[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = cur; dq.append((yy, xx))
        sizes.append(n)
    return lab, sizes


def erode(m, r):
    out = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out &= np.roll(np.roll(m, dy, 0), dx, 1)
    return out


def dilate(m, r):
    out = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= np.roll(np.roll(m, dy, 0), dx, 1)
    return out


# ---------- the estimate ----------
def survey(raw):
    norm = normalize(raw)
    if not norm:
        raise SystemExit('Not an address (it must start with the house number): ' + str(raw))
    hit = q(GURAS, where=f"address = '{norm.replace(chr(39), chr(39) * 2)}'", outFields='address', resultRecordCount=1)
    feats = hit.get('features') or []
    if not feats:
        raise SystemExit(f'Not in the NSW address register yet: {norm}. An address the register does not know has no lot to '
                         'measure; wait for the register, or ask for the floor plan.')
    g = feats[0]['geometry']
    lng, lat = g['x'], g['y']
    L = Local(lng, lat)
    lots = q(LOT, geometry=f'{lng},{lat}', geometryType='esriGeometryPoint', inSR='4326', spatialRel='esriSpatialRelIntersects',
             outFields='lotnumber,planlabel,shape_Area').get('features') or []
    if not lots:
        raise SystemExit('No cadastre lot under the address point.')
    lot = max(lots, key=lambda f: len(f['geometry']['rings'][0]))
    ring = np.array([L.m(x, y) for x, y in lot['geometry']['rings'][0][:-1]])
    base, rtype = street_of(norm)
    roads = q(ROAD, geometry=f'{lng},{lat}', geometryType='esriGeometryPoint', inSR='4326', distance=90,
              units='esriSRUnit_Meter', spatialRel='esriSpatialRelIntersects',
              outFields='roadnamebase,roadnametype').get('features') or []
    named = [f for f in roads if (f['attributes'].get('roadnamebase') or '').upper() == base] or roads
    paths = [np.array([L.m(x, y) for x, y in p]) for f in named for p in f['geometry']['paths']]
    # Front = the lot edge closest to the named road (by its midpoint).
    best, front = 1e9, 0
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        if np.linalg.norm(b - a) < 2.0:
            continue
        mid = (a + b) / 2
        d = min((seg_dist(mid, pa[j], pa[j + 1]) for pa in paths for j in range(len(pa) - 1)), default=1e9)
        if d < best:
            best, front = d, i
    a, b = ring[front], ring[(front + 1) % len(ring)]
    ex = (b - a) / np.linalg.norm(b - a)
    ey = np.array([-ex[1], ex[0]])
    if np.dot(ring.mean(0) - (a + b) / 2, ey) < 0:
        ey = -ey
    # lot frame: origin at the front edge's start, x along the street, y into the lot (front → rear)
    to_lot = lambda P: np.stack([(P - a) @ ex, (P - a) @ ey], -1)
    lot_f = to_lot(ring)
    return dict(norm=norm, lng=lng, lat=lat, L=L, lot=lot, ring=ring, front=front, road_named=bool(named is not roads),
                road_dist=round(best, 1), a=a, ex=ex, ey=ey, to_lot=to_lot, lot_f=lot_f, street=(base, rtype))


def aerial_roof(s, px_per_m=8):
    L, ring = s['L'], s['ring']
    lo, hi = ring.min(0) - 8, ring.max(0) + 8
    w, h = int((hi[0] - lo[0]) * px_per_m), int((hi[1] - lo[1]) * px_per_m)
    (lng0, lat0), (lng1, lat1) = L.ll(*lo), L.ll(*hi)
    img = Image.open(io.BytesIO(get(AERIAL, {'bbox': f'{lng0},{lat0},{lng1},{lat1}', 'bboxSR': '4326', 'imageSR': '4326',
                                            'size': f'{w},{h}', 'format': 'jpg', 'f': 'image'}, binary=True))).convert('RGB')
    if img.size != (w, h):
        img = img.resize((w, h))
    A = np.asarray(img).astype(np.int16)
    R, G, B = A[..., 0], A[..., 1], A[..., 2]
    yy, xx = np.mgrid[0:h, 0:w]
    X, Y = lo[0] + (xx + 0.5) / px_per_m, hi[1] - (yy + 0.5) / px_per_m
    in_lot = inside_mask(ring, X, Y)
    v = A.max(-1)
    veg = (G > R + 6) & (G >= B - 4) | ((G > R) & (G > B) & (v < 110))
    shadow = v < 55
    roof = in_lot & ~veg & ~shadow
    roof = dilate(erode(roof, int(0.9 * px_per_m)), int(0.9 * px_per_m)) & in_lot   # drop driveways and paths (< ~2 m wide)
    lab, sizes = components(roof)
    est = None
    if len(sizes) > 1:
        k = int(np.argmax(sizes))
        pts = np.stack([X[lab == k], Y[lab == k]], -1)
        f = s['to_lot'](pts)
        x0, x1 = np.percentile(f[:, 0], [3, 97]); y0, y1 = np.percentile(f[:, 1], [3, 97])
        est = dict(x0=float(x0), x1=float(x1), y0=float(y0), y1=float(y1), px=int(sizes[k]),
                   fill=round(sizes[k] / px_per_m ** 2 / max(1e-6, (x1 - x0) * (y1 - y0)), 2))
    return img, est, (lo, hi, px_per_m)


def setback_box(lot_f):
    xs, ys = lot_f[:, 0], lot_f[:, 1]
    x0, x1 = xs.min() + 0.9, xs.max() - 0.9
    y0 = ys.min() + 6.0
    y1 = min(ys.max() - 8.0, y0 + 18.0)
    return dict(x0=float(x0), x1=float(min(x1, x0 + 14.0)), y0=float(y0), y1=float(y1))


def draw(img, s, box, frame, path):
    lo, hi, k = frame
    pix = lambda p: ((p[0] - lo[0]) * k, (hi[1] - p[1]) * k)
    d = ImageDraw.Draw(img)
    ring = s['ring']
    d.line([pix(p) for p in list(ring) + [ring[0]]], fill=(255, 214, 0), width=3)
    a, b = ring[s['front']], ring[(s['front'] + 1) % len(ring)]
    d.line([pix(a), pix(b)], fill=(0, 200, 255), width=5)
    if box:
        corners = [(box['x0'], box['y0']), (box['x1'], box['y0']), (box['x1'], box['y1']), (box['x0'], box['y1'])]
        pts = [pix(s['a'] + x * s['ex'] + y * s['ey']) for x, y in corners]
        d.line(pts + [pts[0]], fill=(255, 64, 64), width=3)
    img.save(path, quality=88)


# ---------- the plan ----------
def living_zone(box):
    """Open kitchen/dining/living at the rear of the roof box: width, depth (m) and whether it is a narrow (terrace) layout."""
    W_house, D_house = box['x1'] - box['x0'], box['y1'] - box['y0']
    if W_house < 7.3:   # terrace / narrow cottage: one line front to back (the wide layout needs 7 m)
        return round(max(4.2, min(W_house - 0.3, 6.0)), 1), round(max(8.4, min(D_house * 0.6, 9.6)), 1), True
    return round(min(W_house - 0.3, 8.4), 1), round(max(7.2, min(D_house * 0.5, 8.6)), 1), False


def narrow_items(W, D):
    c = round(W / 2, 2)
    return [
        {"type": "kitchen_run", "at": [c, round(D - 0.325, 3)], "rot": 180, "len": round(min(2.8, W - 1.0), 1), "cooktop": True,
         "sink": True, "sink_at": 0.4, "window_gap": [0.0, 0.9]},
        {"type": "pendant", "at": [c, round(D - 2.6, 2)], "z": 1.62, "r": 0.26},
        {"type": "dining", "at": [c, round(D - 2.6, 2)], "rot": 0, "len": 1.6, "seats": 4},
        {"type": "sofa", "at": [c, 2.55], "rot": 180, "len": round(min(2.4, W - 1.4), 1), "throws": ["teal", "rust"]},
        {"type": "rug", "at": [c, 1.6], "len": round(min(2.4, W - 1.4), 1), "depth": 2.0},
        {"type": "coffee_table", "at": [c, 1.45]},
        {"type": "tv_unit", "at": [c, 0.22], "rot": 0, "len": round(min(1.8, W - 1.6), 1)},
        {"type": "plant", "at": [0.3, 0.3]},
        {"type": "outdoor_table", "at": [c, D + 1.5], "rot": 0},
    ]


def plan_json(slug, name, s, box, how, W, D, narrow=False):
    k = 0.0  # kitchen on the right, living on the left (mirror-free; the side is a guess and says so)
    cx_l = round(min(2.2, W * 0.3), 2)
    items = [
        {"type": "kitchen_run", "at": [round(W - 1.65, 2), round(D - 0.325, 3)], "rot": 180, "len": 2.6, "cooktop": False,
         "sink": True, "sink_at": 0.15, "window_gap": [-0.5, 0.8]},
        {"type": "kitchen_run", "at": [round(W - 0.325, 3), round(D - 2.75, 2)], "rot": 90, "len": 1.8},
        {"type": "island", "at": [round(W - 1.65, 2), round(D - 2.3, 2)], "rot": 0, "len": 1.8, "depth": 0.9, "sink": False},
        {"type": "pendant", "at": [round(W - 2.05, 2), round(D - 2.3, 2)]},
        {"type": "pendant", "at": [round(W - 1.25, 2), round(D - 2.3, 2)]},
        {"type": "dining", "at": [cx_l, round(D - 2.2, 2)], "rot": 90, "len": 1.8, "seats": 6},
        {"type": "pendant", "at": [cx_l, round(D - 2.2, 2)], "z": 1.62, "r": 0.26},
        {"type": "sofa", "at": [cx_l, 2.55], "rot": 180, "len": 2.4, "throws": ["teal", "rust"]},
        {"type": "rug", "at": [cx_l, 1.6], "len": 2.4, "depth": 2.0},
        {"type": "coffee_table", "at": [cx_l, 1.45]},
        {"type": "tv_unit", "at": [cx_l, 0.22], "rot": 0, "len": 1.8},
        {"type": "plant", "at": [0.3, 0.3]},
        {"type": "floor_lamp", "at": [0.3, 3.2]},
        {"type": "outdoor_table", "at": [cx_l, D + 1.5], "rot": 0},
        {"type": "plant", "at": [round(W - 0.3, 2), D + 0.4], "dark": True},
    ]
    openings = [
        {"edge": 0, "type": "door", "a": round(W - 1.3, 2), "b": round(W - 0.5, 2), "head": 2.1},
        {"edge": 2, "type": "slider", "a": 0.3, "b": round(min(3.9, W - 3.4), 2), "head": 2.4, "mullions": 3},
        {"edge": 2, "type": "window", "a": round(W - 2.3, 2), "b": round(W - 1.1, 2), "sill": 1.05, "head": 2.1, "mullions": 1},
        {"edge": 3, "type": "window", "a": 1.0, "b": 2.6, "sill": 0.9, "head": 2.1, "mullions": 1},
        {"edge": 1, "type": "door", "a": 0.6, "b": 1.4, "head": 2.1},
    ]
    views = [
        {"name": "Living", "pos": [round(W * 0.55, 2), 1.0], "look": [0.6, 2.8], "pitch": -0.12},
        {"name": "Dining", "pos": [round(W * 0.55, 2), 3.4], "look": [0.6, round(D - 1.0, 2)], "pitch": -0.08},
        {"name": "Kitchen", "pos": [round(W * 0.55, 2), round(D - 3.4, 2)], "look": [round(W - 1.4, 2), round(D - 0.2, 2)], "pitch": -0.1},
        {"name": "Outdoor", "pos": [round(W - 0.8, 2), round(D + 2.6, 2)], "look": [1.5, round(D - 1.0, 2)], "pitch": -0.04},
    ]
    if narrow:
        items = narrow_items(W, D)
        openings = [
            {"edge": 0, "type": "door", "a": round(W - 1.2, 2), "b": round(W - 0.4, 2), "head": 2.1},
            {"edge": 2, "type": "slider", "a": 0.25, "b": round(W * 0.5 - 1.6, 2), "head": 2.4, "mullions": 1} if W >= 5.6 else None,
            {"edge": 2, "type": "window", "a": round(W / 2 - 0.9, 2), "b": round(W / 2, 2), "sill": 1.05, "head": 2.1, "mullions": 0},  # over the sink: the run is turned 180, so its window_gap [0, 0.9] lands at x = c - 0.9 .. c
            {"edge": 3, "type": "window", "a": round(D - 5.4, 2), "b": round(D - 4.2, 2), "sill": 0.9, "head": 2.1, "mullions": 0},
        ]
        openings = [o for o in openings if o]
        if W < 5.6:  # no room for a slider beside the kitchen: the yard door is on the side wall
            openings.append({"edge": 1, "type": "door", "a": round(D - 1.4, 2), "b": round(D - 0.6, 2), "head": 2.1})
        views = [
            {"name": "Living", "pos": [round(W / 2 + 0.5, 2), round(D - 4.6, 2)], "look": [round(W / 2 - 0.4, 2), 0.2], "pitch": -0.12},
            {"name": "Kitchen", "pos": [round(W / 2 - 0.6, 2), round(D - 4.6, 2)], "look": [round(W / 2, 2), round(D - 0.2, 2)], "pitch": -0.08},
            {"name": "From the hall", "pos": [round(W - 0.8, 2), 0.7], "look": [0.6, round(D - 1.0, 2)], "pitch": -0.06},
        ]
    w_h, d_h = box['x1'] - box['x0'], box['y1'] - box['y0']
    lot_area = poly_area(s['lot_f'])
    return {
        "slug": slug, "name": name, "by": "", "type": "Home", "rooms": "Kitchen · Dining · Living · Outdoor",
        "source": "estimate", "source_url": None,
        "address_key": 'addr:' + s['norm'],
        "assumptions": [
            f"No floor plan on file. Lot {s['lot']['attributes'].get('lotnumber')} {s['lot']['attributes'].get('planlabel')} "
            f"({lot_area:.0f} m²) from the NSW cadastre; the front is the side facing {title(' '.join(['0', *s['street']])).split(' ', 1)[1]}.",
            (f"Roof footprint measured from NSW aerial imagery: about {w_h:.1f} x {d_h:.1f} m." if how == 'aerial' else
             f"Roof not readable from the aerial image; footprint assumed from typical setbacks: {w_h:.1f} x {d_h:.1f} m."),
            f"Single storey assumed. The living space is assumed to be one open {'front-to-back ' if narrow else ''}kitchen, dining and living area of {W} x {D} m "
            "at the back of the house, opening to the yard; kitchen side, room sizes and every other room are guesses.",
            "Ceiling assumed flat at 2.7 m. Sliding door 0-2.4 m, windows 0.9-2.1 m, kitchen window 1.05-2.1 m.",
            "Hall and bedroom doors are shown closed; the rooms behind them are not modelled.",
            "Finishes and furniture are placeholders.",
        ],
        "lngLat": [round(s['lng'], 6), round(s['lat'], 6)],
        "outline": [[0, 0], [W, 0], [W, D], [0, D]],
        "ceiling": {"type": "flat", "h": 2.7},
        "openings": openings,
        "outdoor": [{"rect": [-0.25, D + 0.11, W + 0.25, D + 3.0], "roof": 2.7}],
        "finishes": {"floor": "oak"},
        "items": items,
        "views": views,
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('address')
    ap.add_argument('--slug', required=True)
    ap.add_argument('--name')
    ap.add_argument('--out', required=True)
    ap.add_argument('--roof', help='override the roof box in lot metres: x0,x1,y0,y1 (after looking at aerial.jpg)')
    a = ap.parse_args(argv)
    if not re.match(r'^[a-z0-9-]{3,80}$', a.slug):
        raise SystemExit('slug: a-z 0-9 -')
    os.makedirs(a.out, exist_ok=True)
    s = survey(a.address)
    img, est, frame = aerial_roof(s)
    if a.roof:
        x0, x1, y0, y1 = map(float, a.roof.split(','))
        box, how = dict(x0=x0, x1=x1, y0=y0, y1=y1), 'aerial'
    else:
        ok = est and 5.5 <= est['x1'] - est['x0'] <= 22 and 7 <= est['y1'] - est['y0'] <= 30 and est['fill'] >= 0.45
        box, how = (est, 'aerial') if ok else (setback_box(s['lot_f']), 'setbacks')
    draw(img, s, box, frame, os.path.join(a.out, 'aerial.jpg'))
    W, D, narrow = living_zone(box)
    name = a.name or title(s['norm'])
    plan = plan_json(a.slug, name, s, box, how, W, D, narrow)
    with open(os.path.join(a.out, a.slug + '.plan.json'), 'w') as f:
        json.dump(plan, f, indent=2, ensure_ascii=False)
    meta = dict(address=s['norm'], lngLat=plan['lngLat'], lot=s['lot']['attributes'], front_edge=s['front'],
                road_named=s['road_named'], road_dist_m=s['road_dist'], roof_measured=est, roof_used=box, roof_from=how,
                living=[W, D], narrow=narrow)
    with open(os.path.join(a.out, 'estimate.json'), 'w') as f:
        json.dump(meta, f, indent=2)
    print(json.dumps(meta))
    return plan


if __name__ == '__main__':
    main()
