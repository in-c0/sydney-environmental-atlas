"""SHOWHAUS walk builder: any plan JSON -> a baked, walkable scene for dist/showhaus/walk.

usage:  python3 walkgen.py <plan.json> check              validate the plan, print walk areas and collisions (no Blender)
        python3 walkgen.py <plan.json> preview [out_dir]  16-sample render of each view (fix exposure and layout here)
        python3 walkgen.py <plan.json> bake    [out_dir]  Cycles COMBINED bake to one atlas per group + meshes
        python3 walkgen.py <plan.json> pack    [out_dir] [site_dir]   atlases -> jpg, room.js, <slug>.json, index row

Plan JSON (metres; x = east, y = north, z = up; see README.md for the full schema):
  slug, name, by, type, rooms, source ("plan" | "estimate"), source_url, assumptions[]
  outline   [[x, y], ...]            rectilinear room outline, counter-clockwise
  ceiling   {"type": "flat", "h": 2.7} | {"type": "raked", "from": [x, y], "to": [x, y], "h0": 2.6, "h1": 3.5}
  openings  [{"edge": i, "type": "window" | "slider" | "door", "a": .., "b": .., "sill": .., "head": .., "mullions": n}]
            edge i runs outline[i] -> outline[i+1]; a..b is the absolute x (horizontal edge) or y (vertical edge)
  outdoor   [{"rect": [x0, y0, x1, y1], "roof": 2.7}]      covered deck outside a slider
  finishes  {"floor": "oak" | "tile" | "concrete" | "carpet", "wall": [r, g, b], "cabinet": [...], "stone": [...], "splash": [...]}
  items     [{"type": ..., "at": [x, y], "rot": 0 | 90 | 180 | 270, ...}]   see ITEMS below; "at" is the footprint centre,
            rot 0 = back to the south, facing north
  views     [{"name": "Kitchen", "pos": [x, y], "look": [x, y], "pitch": -0.1}]

The builder never guesses a dimension: everything the plan does not give is an explicit value in the JSON and a line in
"assumptions". Bake limits and dead ends: the plan-to-walkthrough skill."""
import json, math, os, sys

# ---------------------------------------------------------------- plan geometry (pure Python; used by `check` and tests)
T_DEFAULT = 0.11

def load_plan(path):
    p = json.load(open(path))
    errs = validate(p)
    if errs: raise SystemExit('plan errors:\n  ' + '\n  '.join(errs))
    return p

def edges(outline):
    n = len(outline)
    return [(outline[i], outline[(i + 1) % n]) for i in range(n)]

def area2(poly):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in edges(poly))

def offset(outline, e):
    """Rectilinear CCW polygon moved outward by e (inward when negative)."""
    n = len(outline); out = []
    for i in range(n):
        p0, p1, p2 = outline[i - 1], outline[i], outline[(i + 1) % n]
        na = out_normal(p0, p1); nb = out_normal(p1, p2)
        out.append([p1[0] + e * (na[0] + nb[0]), p1[1] + e * (na[1] + nb[1])])
    return out

def out_normal(a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dy)
    return (dy / L, -dx / L)

def inside(poly, x, y):
    c = False
    for (x0, y0), (x1, y1) in edges(poly):
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0): c = not c
    return c

def slab_rects(poly):
    """A rectilinear polygon as touching rectangles [x0, y0, x1, y1] (horizontal slabs, merged when the span repeats)."""
    ys = sorted({round(p[1], 4) for p in poly}); rows = []
    for y0, y1 in zip(ys, ys[1:]):
        ym = (y0 + y1) / 2
        xs = sorted(x0 + (ym - ya) * (x1 - x0) / (yb - ya) for (x0, ya), (x1, yb) in edges(poly) if (ya > ym) != (yb > ym))
        rows.append((y0, y1, [(round(xs[i], 4), round(xs[i + 1], 4)) for i in range(0, len(xs) - 1, 2)]))
    rects = []
    for y0, y1, spans in rows:
        for a, b in spans:
            for r in rects:
                if r[0] == a and r[2] == b and abs(r[3] - y0) < 1e-6: r[3] = y1; break
            else: rects.append([a, y0, b, y1])
    return rects

def ceiling_fn(p):
    c = p['ceiling']
    if c['type'] == 'flat': return lambda x, y: c['h']
    (x0, y0), (x1, y1) = c['from'], c['to']; dx, dy = x1 - x0, y1 - y0; L2 = dx * dx + dy * dy
    return lambda x, y: c['h0'] + ((x - x0) * dx + (y - y0) * dy) / L2 * (c['h1'] - c['h0'])   # linear, extrapolated past both ends

def wall_frames(p):
    """Per outline edge: start point, unit direction, inward normal, length, convex flags."""
    o = p['outline']; n = len(o); out = []
    for i in range(n):
        a, b = o[i], o[(i + 1) % n]; L = math.hypot(b[0] - a[0], b[1] - a[1]); d = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
        prev = o[i - 1]; nxt = o[(i + 2) % n]
        cross0 = (a[0] - prev[0]) * (b[1] - a[1]) - (a[1] - prev[1]) * (b[0] - a[0])
        cross1 = (b[0] - a[0]) * (nxt[1] - b[1]) - (b[1] - a[1]) * (nxt[0] - b[0])
        out.append({'a': a, 'd': d, 'n': (-d[1], d[0]), 'L': L, 'convex0': cross0 > 0, 'convex1': cross1 > 0, 'horizontal': abs(d[0]) > 0.5})
    return out

def opening_span(fr, o):
    """An opening's a..b (absolute x or y) as distances along its edge, start < end."""
    base = fr['a'][0] if fr['horizontal'] else fr['a'][1]; s = fr['d'][0] if fr['horizontal'] else fr['d'][1]
    u0, u1 = sorted(((o['a'] - base) * s, (o['b'] - base) * s))
    return u0, u1

def to_world(fr, u, v):
    """Wall-local (u along the edge, v into the room) -> plan x, y."""
    return (fr['a'][0] + fr['d'][0] * u + fr['n'][0] * v, fr['a'][1] + fr['d'][1] * u + fr['n'][1] * v)

def aabb(pts):
    xs = [q[0] for q in pts]; ys = [q[1] for q in pts]
    return [round(min(xs), 3), round(min(ys), 3), round(max(xs), 3), round(max(ys), 3)]

def rot_pt(at, rot, x, y):
    c, s = {0: (1, 0), 90: (0, 1), 180: (-1, 0), 270: (0, -1)}[rot % 360]
    return (at[0] + c * x - s * y, at[1] + s * x + c * y)

# footprint (length along local x, depth along local y) and whether it blocks walking
ITEMS = {
    'kitchen_run': lambda it: (it.get('len', 3.0), 0.65, True),
    'island': lambda it: (it.get('len', 2.6) + 0.10, it.get('depth', 0.94) + 0.10 + (0.62 if it.get('stools', 0) else 0), True),
    'tall': lambda it: (it.get('len', 1.8), it.get('depth', 0.62), True),
    'fridge': lambda it: (it.get('len', 0.92), 0.72, True),
    'dining': lambda it: (it.get('len', 2.4) + 0.9, it.get('depth', 1.05) + 1.1, True),
    'sofa': lambda it: (it.get('len', 2.4), it.get('depth', 0.98), True),
    'armchair': lambda it: (0.95, 0.92, True),
    'coffee_table': lambda it: (it.get('size', 0.9), it.get('size', 0.9), True),
    'rug': lambda it: (it.get('len', 2.6), it.get('depth', 3.0), False),
    'tv_unit': lambda it: (it.get('len', 2.2), 0.44, True),
    'art': lambda it: (it.get('len', 1.3), 0.04, False),
    'plant': lambda it: (0.42, 0.42, True),
    'floor_lamp': lambda it: (0.30, 0.30, True),
    'pendant': lambda it: (0.3, 0.3, False),
    'bed': lambda it: ({'single': 0.92, 'double': 1.38, 'queen': 1.53, 'king': 1.83}[it.get('size', 'queen')] + 0.06, 2.12, True),
    'bedside': lambda it: (0.45, 0.40, True),
    'desk': lambda it: (it.get('len', 1.4), 1.15, True),
    'outdoor_table': lambda it: (it.get('len', 1.8), 1.9, True),
    'box': lambda it: (it['size'][0], it['size'][1], it.get('solid', True)),
}

def footprint(it):
    ln, dp, solid = ITEMS[it['type']](it)
    return aabb([rot_pt(it['at'], it.get('rot', 0), sx * ln / 2, sy * dp / 2) for sx in (-1, 1) for sy in (-1, 1)]), solid

def layout(p):
    """Everything the viewer needs that is not pixels: where you can walk, what you bump into, the mini plan."""
    T = p.get('wall_t', T_DEFAULT); frs = wall_frames(p); o = p['outline']
    walk = slab_rects(offset(o, -0.25))
    for r in walk:   # touching slabs overlap a little so the walker never sticks on the seam
        for q in walk:
            if q is not r and min(r[2], q[2]) - max(r[0], q[0]) > 0.3:
                if abs(q[3] - r[1]) < 1e-6: r[1] = round(r[1] - 0.03, 3)
    outdoor = [d['rect'] for d in p.get('outdoor', [])]
    for d in outdoor: walk.append([round(d[0] + 0.25, 3), round(d[1] + 0.25, 3), round(d[2] - 0.25, 3), round(d[3] - 0.25, 3)])
    lines = []
    for op in p.get('openings', []):
        fr = frs[op['edge']]; u0, u1 = opening_span(fr, op)
        lines.append([round(v, 3) for v in (*to_world(fr, u0, 0), *to_world(fr, u1, 0))])
        if op['type'] == 'slider':   # a doorway you can walk through, when it leads onto an outdoor area
            mid = to_world(fr, (u0 + u1) / 2, -(T + 0.5))
            if any(d[0] <= mid[0] <= d[2] and d[1] <= mid[1] <= d[3] for d in outdoor):
                walk.append(aabb([to_world(fr, u0 + 0.25, 0.3), to_world(fr, u1 - 0.25, -(T + 0.5))]))
    solid = []
    for it in p.get('items', []):
        box, is_solid = footprint(it)
        if is_solid: solid.append(box)
    pad = 0.18
    return {'walk': walk, 'solid': solid, 'boxes': [[round(a - pad, 3), round(b - pad, 3), round(c + pad, 3), round(d + pad, 3)] for a, b, c, d in solid],
            'plan': {'room': o, 'alfresco': outdoor[0] if outdoor else None, 'openings': lines}}

def walkable(lay, x, y):
    return any(b[0] <= x <= b[2] and b[1] <= y <= b[3] for b in lay['walk']) and not any(k[0] < x < k[2] and k[1] < y < k[3] for k in lay['boxes'])

def validate(p):
    e = []
    for k in ('slug', 'name', 'by', 'source', 'outline', 'ceiling', 'views', 'assumptions'):
        if k not in p: e.append(f'missing "{k}"')
    if e: return e
    o = p['outline']
    if len(o) < 4 or area2(o) <= 0: e.append('outline must be counter-clockwise with 4+ corners')
    for a, b in edges(o):
        if abs(a[0] - b[0]) > 1e-6 and abs(a[1] - b[1]) > 1e-6: e.append(f'outline edge {a} -> {b} is not axis-aligned')
    if e: return e
    if p['source'] not in ('plan', 'estimate'): e.append('source must be "plan" or "estimate"')
    if p['source'] == 'plan' and not p.get('source_url'): e.append('a plan-based walk needs source_url')
    if not p['assumptions']: e.append('list every value the plan does not give under "assumptions"')
    c = p['ceiling']
    if c.get('type') not in ('flat', 'raked'): e.append('ceiling.type must be flat or raked')
    frs = wall_frames(p); cz = ceiling_fn(p) if not e else None
    for i, op in enumerate(p.get('openings', [])):
        if not (0 <= op.get('edge', -1) < len(frs)): e.append(f'opening {i}: edge out of range'); continue
        if op.get('type') not in ('window', 'slider', 'door'): e.append(f'opening {i}: unknown type'); continue
        fr = frs[op['edge']]; u0, u1 = opening_span(fr, op)
        if u0 < 0.05 or u1 > fr['L'] - 0.05 or u1 - u0 < 0.4: e.append(f'opening {i}: {op["a"]}..{op["b"]} does not fit on edge {op["edge"]} (length {fr["L"]:.2f})')
        if cz and op.get('head', 2.1) > min(cz(*to_world(fr, u0, 0)), cz(*to_world(fr, u1, 0))) - 0.05: e.append(f'opening {i}: head is above the ceiling')
    for i, it in enumerate(p.get('items', [])):
        if it.get('type') not in ITEMS: e.append(f'item {i}: unknown type "{it.get("type")}"'); continue
        if it.get('rot', 0) % 90: e.append(f'item {i}: rot must be 0, 90, 180 or 270'); continue
        box, _ = footprint(it); cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        zone = offset(o, 0.02)
        if not (inside(zone, cx, cy) or any(d['rect'][0] <= cx <= d['rect'][2] and d['rect'][1] <= cy <= d['rect'][3] for d in p.get('outdoor', []))):
            e.append(f'item {i} ({it["type"]}): centre {cx:.2f}, {cy:.2f} is outside the room and every outdoor area')
    if e: return e
    lay = layout(p)
    for i, v in enumerate(p['views']):
        if not walkable(lay, *v['pos']): e.append(f'view {i} ("{v.get("name")}"): the camera stands inside a wall or an object')
    if len(p['views']) < 2: e.append('give at least two views')
    return e

# ---------------------------------------------------------------- pack (numpy + PIL, no Blender)
def pack(p, out, site):
    import base64, numpy as np
    from PIL import Image
    slug = p['slug']; S = os.path.join(site, 'data', slug); os.makedirs(S, exist_ok=True)
    def srgb(x):
        x = np.clip(x * float(os.environ.get('GAIN', '1.08')), 0, 1); return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)
    room = {'groups': {}}
    for g in ('ARCH', 'FURN', 'ENV'):
        atlas = np.load(os.path.join(out, f'atlas_{g}.npy')); img8 = (srgb(atlas) * 255 + 0.5).astype(np.uint8)
        Image.fromarray(img8[::-1]).save(os.path.join(S, f'atlas_{g}.jpg'), 'JPEG', quality=88)
        m = np.fromfile(os.path.join(out, f'mesh_{g}.bin'), np.float32).reshape(-1, 3, 5)
        mesh = np.concatenate([np.stack([m[..., 0], m[..., 2], -m[..., 1]], -1), m[..., 3:]], -1).astype(np.float32)   # three.js axes
        room['groups'][g] = {'atlas': f'atlas_{g}.jpg', 'mesh': base64.b64encode(mesh.tobytes()).decode(), 'tris': int(len(m))}
    room.update(layout(p))
    room['views'] = [{'name': v['name'], 'pos': v['pos'], 'look': v['look'], 'pitch': v.get('pitch', -0.1)} for v in p['views']]
    room['listing'] = {'claimed': False, 'source': p['source']}
    open(os.path.join(S, 'room.js'), 'w').write('window.ROOM=' + json.dumps(room) + ';')
    poster = os.path.join(out, 'preview_0.png')
    if os.path.exists(poster): Image.open(poster).convert('RGB').save(os.path.join(S, 'poster.jpg'), 'JPEG', quality=86)
    listing = {'project': {'name': p['name'], 'address': p.get('address', '')},
               'listing': {'slug': slug, 'name': p['name'], 'by': p['by'], 'type': p.get('type', 'Home design'), 'rooms': p.get('rooms', ''), 'source': p['source'],
                           'source_url': p.get('source_url'), 'assumptions': p['assumptions'], 'lngLat': p.get('lngLat')}}
    json.dump(listing, open(os.path.join(site, 'data', slug + '.json'), 'w'), indent=2)
    row = {'slug': slug, 'kind': 'walk', 'name': p['name'], 'by': p['by'], 'type': p.get('type', 'Home design'), 'rooms': p.get('rooms', ''), 'tier': 'Base walk',
           'poster': f'data/{slug}/poster.jpg', 'lngLat': p.get('lngLat')}
    print('index row (add to walk/data/index.json, copying the field names of the existing rows):\n' + json.dumps(row))
    print('room.js MB', round(os.path.getsize(os.path.join(S, 'room.js')) / 1e6, 2))

# ---------------------------------------------------------------- scene (Blender)
def build(p, mode, out):
    import bpy, bmesh, random, numpy as np
    from mathutils import Vector, Matrix
    random.seed(11)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    T = p.get('wall_t', T_DEFAULT); O = p['outline']; cz = ceiling_fn(p); frs = wall_frames(p); F = p.get('finishes', {})
    xs = [q[0] for q in O]; ys = [q[1] for q in O]; X0, X1, Y0, Y1 = min(xs), max(xs), min(ys), max(ys)
    HW = max(cz(x, y) for x in (X0 - T, X1 + T) for y in (Y0 - T, Y1 + T)) + 0.1
    ATLAS = {'ARCH': int(os.environ.get('ARCH_RES', '3072')), 'FURN': int(os.environ.get('FURN_RES', '3072')), 'ENV': int(os.environ.get('ENV_RES', '1024'))}
    IMG = {g: bpy.data.images.new('atlas_' + g, s, s, alpha=False, float_buffer=True) for g, s in ATLAS.items()}
    OBJS = {g: [] for g in ATLAS}; _mats = {}; made = []

    def mat(g, name, c1, c2=None, scale=8.0, stretch=(1, 1, 1), kind='noise', rough=0.85, emit=None):
        key = (g, name)
        if key in _mats: return _mats[key]
        m = bpy.data.materials.new(g + '_' + name); m.use_nodes = True
        nt = m.node_tree; N = nt.nodes; L = nt.links
        bsdf = N.get('Principled BSDF'); outn = N.get('Material Output')
        bsdf.inputs['Roughness'].default_value = rough
        if 'Specular IOR Level' in bsdf.inputs: bsdf.inputs['Specular IOR Level'].default_value = 0.15
        col = bsdf.inputs['Base Color']; col.default_value = (*c1, 1)
        if c2 is not None and emit is None:
            tc = N.new('ShaderNodeTexCoord'); mp = N.new('ShaderNodeMapping'); mp.inputs['Scale'].default_value = stretch
            L.new(tc.outputs['Object'], mp.inputs['Vector'])
            nz = N.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = scale; nz.inputs['Detail'].default_value = 6 if kind == 'planks' else 5
            r1 = N.new('ShaderNodeValToRGB'); r1.color_ramp.elements[0].color = (*c1, 1); r1.color_ramp.elements[1].color = (*c2, 1)
            if kind in ('planks', 'tiles'):
                br = N.new('ShaderNodeTexBrick'); br.inputs['Scale'].default_value = 1.0
                if kind == 'planks': br.offset = 0.5; br.inputs['Mortar Size'].default_value = 0.0025; br.inputs['Brick Width'].default_value = 1.35; br.inputs['Row Height'].default_value = 0.15
                else: br.offset = 0.0; br.inputs['Mortar Size'].default_value = 0.004; br.inputs['Brick Width'].default_value = 0.6; br.inputs['Row Height'].default_value = 0.6
                br.inputs['Mortar'].default_value = (c1[0] * .55, c1[1] * .55, c1[2] * .55, 1)
                mp2 = N.new('ShaderNodeMapping'); mp2.inputs['Scale'].default_value = (0.6, 14, 1) if kind == 'planks' else (1, 1, 1)
                L.new(tc.outputs['Object'], mp2.inputs['Vector']); L.new(mp2.outputs['Vector'], nz.inputs['Vector'])
                r1.color_ramp.elements[0].position = 0.3; r1.color_ramp.elements[1].position = 0.7
                L.new(nz.outputs['Fac'], r1.inputs['Fac']); L.new(mp.outputs['Vector'], br.inputs['Vector'])
                L.new(r1.outputs['Color'], br.inputs['Color1']); br.inputs['Color2'].default_value = (*[(c1[i] + c2[i]) / 2 * 0.94 for i in range(3)], 1)
                L.new(br.outputs['Color'], col)
            else:
                r1.color_ramp.elements[0].position = 0.35; r1.color_ramp.elements[1].position = 0.65
                L.new(mp.outputs['Vector'], nz.inputs['Vector']); L.new(nz.outputs['Fac'], r1.inputs['Fac']); L.new(r1.outputs['Color'], col)
        if emit is not None:
            em = N.new('ShaderNodeEmission'); em.inputs['Strength'].default_value = emit
            if c2 is not None:   # vertical gradient for the sky
                tc = N.new('ShaderNodeTexCoord'); sp = N.new('ShaderNodeSeparateXYZ'); mr = N.new('ShaderNodeMapRange')
                mr.inputs['From Min'].default_value = 0; mr.inputs['From Max'].default_value = 14
                r2 = N.new('ShaderNodeValToRGB'); r2.color_ramp.elements[0].color = (*c2, 1); r2.color_ramp.elements[1].color = (*c1, 1)
                L.new(tc.outputs['Object'], sp.inputs['Vector']); L.new(sp.outputs['Z'], mr.inputs['Value']); L.new(mr.outputs['Result'], r2.inputs['Fac']); L.new(r2.outputs['Color'], em.inputs['Color'])
            else: em.inputs['Color'].default_value = (*c1, 1)
            L.new(em.outputs['Emission'], outn.inputs['Surface'])
        ti = N.new('ShaderNodeTexImage'); ti.image = IMG[g]; N.active = ti
        _mats[key] = m; return m

    def add(g, me, m):
        ob = bpy.data.objects.new(me.name, me); sc.collection.objects.link(ob); me.materials.append(m); OBJS[g].append(ob); made.append(ob); return ob

    def box(g, name, x0, x1, y0, y1, z0, z1, m, bevel=0.0, seg=2, rot=None):
        bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts: v.co = Vector((v.co.x * (x1 - x0), v.co.y * (y1 - y0), v.co.z * (z1 - z0)))
        if bevel > 0: bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=seg, affect='EDGES', profile=0.5)
        c = Vector(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)); R = rot or Matrix()
        for v in bm.verts: v.co = (R @ v.co) + c
        me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); return add(g, me, m)

    def cyl(g, name, x, y, z0, z1, r0, r1, m, segs=28, caps=True):
        bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=caps, segments=segs, radius1=r0, radius2=r1, depth=z1 - z0)
        for v in bm.verts: v.co += Vector((x, y, (z0 + z1) / 2))
        me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); return add(g, me, m)

    def ngon(g, name, pts, zf, m, up=True):
        me = bpy.data.meshes.new(name); vs = [(x, y, zf(x, y)) for x, y in pts]
        me.from_pydata(vs, [], [list(range(len(vs))) if up else list(range(len(vs) - 1, -1, -1))]); me.update(); return add(g, me, m)

    class placed:
        """Everything built inside the block is moved from a local frame into the plan by matrix M."""
        def __init__(self, M): self.M = M
        def __enter__(self): self.n = len(made)
        def __exit__(self, *a):
            for ob in made[self.n:]: ob.data.transform(self.M); ob.data.update()

    def frame_matrix(fr):   # wall-local: u along the edge, v into the room
        d, n = fr['d'], fr['n']
        return Matrix(((d[0], n[0], 0, fr['a'][0]), (d[1], n[1], 0, fr['a'][1]), (0, 0, 1, 0), (0, 0, 0, 1)))

    def item_matrix(it):
        return Matrix.Translation((it['at'][0], it['at'][1], 0)) @ Matrix.Rotation(math.radians(it.get('rot', 0)), 4, 'Z')

    # ---------- materials
    rgb = lambda k, d: tuple(F.get(k, d))
    wall_c = rgb('wall', (0.80, 0.79, 0.76))
    WALL = mat('ARCH', 'wall', wall_c, tuple(min(1, c + 0.03) for c in wall_c), 2.5)
    CEIL = mat('ARCH', 'ceil', (0.84, 0.84, 0.82)); TRIM = mat('ARCH', 'trim', (0.86, 0.86, 0.85), rough=0.5)
    FLOORS = {'oak': dict(c1=(0.56, 0.41, 0.26), c2=(0.70, 0.55, 0.37), scale=5.0, kind='planks', rough=0.55),
              'tile': dict(c1=(0.66, 0.65, 0.62), c2=(0.74, 0.73, 0.70), scale=3.0, kind='tiles', rough=0.35),
              'concrete': dict(c1=(0.48, 0.48, 0.47), c2=(0.58, 0.58, 0.57), scale=1.6, rough=0.5),
              'carpet': dict(c1=(0.52, 0.50, 0.46), c2=(0.60, 0.58, 0.54), scale=240, rough=1.0)}
    FLOOR = mat('ARCH', 'floor', **FLOORS[F.get('floor', 'oak')])
    DECK = mat('ARCH', 'deck', (0.36, 0.30, 0.25), (0.46, 0.40, 0.33), 5.0, kind='planks', rough=0.8)
    DOOR = mat('ARCH', 'door', (0.82, 0.82, 0.80), rough=0.5); FRAME = mat('ARCH', 'frame', (0.06, 0.06, 0.065), rough=0.5)
    cab_c = rgb('cabinet', (0.80, 0.80, 0.78)); stone_c = rgb('stone', (0.82, 0.81, 0.79)); splash_c = rgb('splash', (0.66, 0.70, 0.67))
    CAB = mat('FURN', 'cab', cab_c, rough=0.4)
    STONE = mat('FURN', 'stone', stone_c, tuple(min(1, c + 0.06) for c in stone_c), 1.4, rough=0.3)
    SPLASH = mat('FURN', 'splash', splash_c, tuple(min(1, c + 0.06) for c in splash_c), 3.0, rough=0.3)
    STEEL = mat('FURN', 'steel', (0.42, 0.43, 0.44), rough=0.35); KICK = mat('FURN', 'kick', (0.07, 0.07, 0.07))
    LINEN = mat('FURN', 'linen', (0.60, 0.57, 0.52), (0.70, 0.67, 0.62), 260, rough=1.0)
    LINEN2 = mat('FURN', 'linen2', (0.64, 0.61, 0.56), (0.72, 0.69, 0.64), 260, rough=1.0)
    WHITE = mat('FURN', 'white', (0.80, 0.80, 0.79), (0.85, 0.85, 0.84), 200, rough=1.0)
    TEAL = mat('FURN', 'teal', (0.06, 0.26, 0.28), (0.09, 0.32, 0.34), 220, rough=1.0)
    RUST = mat('FURN', 'rust', (0.42, 0.17, 0.08), (0.50, 0.22, 0.11), 220, rough=1.0)
    CHAR = mat('FURN', 'charcoal', (0.09, 0.09, 0.10), (0.13, 0.13, 0.14), 220, rough=1.0)
    OAK = mat('FURN', 'oak', (0.52, 0.36, 0.20), (0.64, 0.47, 0.28), 3.0, stretch=(0.5, 22, 22), rough=0.5)
    RUG = mat('FURN', 'rug', (0.62, 0.58, 0.50), (0.76, 0.72, 0.64), 90, rough=1.0)
    CERAMIC = mat('FURN', 'ceramic', (0.78, 0.76, 0.72), rough=0.4); BLACK = mat('FURN', 'black', (0.03, 0.03, 0.03), rough=0.5)
    PEND = mat('FURN', 'pend', (1.0, 0.84, 0.62), emit=1.4)
    ART1 = mat('FURN', 'art', (0.72, 0.58, 0.44), (0.20, 0.30, 0.33), 1.6)
    GREEN = mat('FURN', 'leaf', (0.05, 0.16, 0.05), (0.10, 0.26, 0.08), 30, rough=0.7)
    GRASS = mat('ENV', 'grass', (0.07, 0.20, 0.03), (0.14, 0.32, 0.06), 6)
    FENCE = mat('ENV', 'fence', (0.19, 0.22, 0.25), (0.25, 0.28, 0.31), 1.0, stretch=(26, 26, 0.2))
    TREE = mat('ENV', 'tree', (0.04, 0.12, 0.03), (0.09, 0.22, 0.06), 3); TRUNK = mat('ENV', 'trunk', (0.12, 0.09, 0.06))
    SKY = mat('ENV', 'sky', (0.10, 0.28, 0.80), (0.60, 0.74, 0.95), emit=0.9)
    NAMED = {'oak': OAK, 'black': BLACK, 'cabinet': CAB, 'stone': STONE, 'linen': LINEN, 'white': WHITE, 'teal': TEAL, 'rust': RUST, 'charcoal': CHAR, 'steel': STEEL, 'ceramic': CERAMIC}

    # ---------- shell
    ngon('ARCH', 'floor', O, lambda x, y: 0.0, FLOOR, up=True)
    ngon('ARCH', 'ceil', offset(O, T), cz, CEIL, up=False)
    by_edge = {}
    for op in p.get('openings', []): by_edge.setdefault(op['edge'], []).append(op)
    sk = 0.09
    for i, fr in enumerate(frs):
        L = fr['L']; ua = -T if fr['convex0'] else 0.0; ub = L + (T if fr['convex1'] else 0.0)
        ops = sorted((*opening_span(fr, op), op) for op in by_edge.get(i, []))
        with placed(frame_matrix(fr)):
            cur = ua; solid_runs = []
            for u0, u1, op in ops:
                sill = 0.0 if op['type'] != 'window' else op.get('sill', 0.6); head = op.get('head', 2.4 if op['type'] != 'door' else 2.1)
                if u0 > cur: box('ARCH', 'wall', cur, u0, -T, 0, 0, HW, WALL); solid_runs.append((max(cur, 0), u0))
                if sill > 0: box('ARCH', 'wall', u0, u1, -T, 0, 0, sill, WALL)
                box('ARCH', 'wall', u0, u1, -T, 0, head, HW, WALL); cur = u1
                if op['type'] in ('window', 'slider'):
                    fv = -0.08   # frame sits in the wall thickness, toward the outside
                    for (a, b, r, s) in ((u0, u1, head - 0.05, head), (u0, u0 + 0.05, sill, head - 0.05), (u1 - 0.05, u1, sill, head - 0.05)) + (((u0, u1, sill, sill + 0.05),) if sill > 0 else ()):
                        box('ARCH', 'frame', a, b, fv, fv + 0.05, r, s, FRAME)
                    n = op.get('mullions', max(0, round((u1 - u0) / 0.9) - 1))
                    for k in range(1, n + 1):
                        um = u0 + (u1 - u0) * k / (n + 1); box('ARCH', 'mull', um - 0.022, um + 0.022, fv, fv + 0.05, sill, head - 0.05, FRAME)
                    if sill > 0: box('ARCH', 'sill', u0 - 0.04, u1 + 0.04, -0.02, 0.05, sill - 0.03, sill, TRIM, bevel=0.006)
                    else: box('ARCH', 'track', u0, u1, -T, 0, -0.004, 0.004, FRAME)
                else:   # a closed door: the room behind it is not modelled
                    box('ARCH', 'door', u0 - 0.03, u1 + 0.03, -0.075, -0.035, -0.02, head + 0.03, DOOR)
                    if u1 - u0 > 1.0: box('ARCH', 'doorgap', (u0 + u1) / 2 - 0.003, (u0 + u1) / 2 + 0.003, -0.036, -0.033, 0, head, FRAME)
                    for (a, b, r, s) in ((u0 - 0.07, u0, 0, head + 0.07), (u1, u1 + 0.07, 0, head + 0.07), (u0 - 0.07, u1 + 0.07, head, head + 0.07)):
                        box('ARCH', 'arch', a, b, 0, 0.018, r, s, TRIM, bevel=0.004)
                    solid_runs.append((u0, u0))   # skirting stops at the architrave
            if cur < ub: box('ARCH', 'wall', cur, ub, -T, 0, 0, HW, WALL); solid_runs.append((cur, min(ub, L)))
            for a, b in solid_runs:
                if b - a > 0.12: box('ARCH', 'skirt', a + (0.07 if a > 0 else 0), b - (0.07 if b < L else 0), 0, 0.014, 0, sk, TRIM, bevel=0.004)
    for d in p.get('outdoor', []):
        x0, y0, x1, y1 = d['rect']; rz = d.get('roof', 2.7)
        box('ARCH', 'deck', x0, x1, y0, y1, -0.06, 0, DECK)
        if rz:
            box('ARCH', 'alf_roof', x0, x1, y0, y1, rz, rz + 0.14, CEIL)
            zone = offset(O, T + 0.35)
            for (px, py) in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
                if not inside(zone, px, py):
                    ix = px + (0.08 if px == x0 else -0.08); iy = py + (0.08 if py == y0 else -0.08)
                    box('ARCH', 'post', ix - 0.06, ix + 0.06, iy - 0.06, iy + 0.06, 0, rz, FRAME)

    # ---------- outside
    box('ENV', 'lawn', X0 - 14, X1 + 14, Y0 - 14, Y1 + 14, -0.10, -0.062, GRASS)
    for (a, b, c, d) in ((X0 - 12, X1 + 12, Y1 + 12, Y1 + 12.06), (X0 - 12, X1 + 12, Y0 - 12.06, Y0 - 12), (X0 - 12.06, X0 - 12, Y0 - 12, Y1 + 12), (X1 + 12, X1 + 12.06, Y0 - 12, Y1 + 12)):
        box('ENV', 'fence', a, b, c, d, 0, 1.8, FENCE)
    for (a, b, c, d) in ((X0 - 40, X1 + 40, Y1 + 34, Y1 + 34.1), (X0 - 40, X1 + 40, Y0 - 34.1, Y0 - 34), (X0 - 40.1, X0 - 40, Y0 - 34, Y1 + 34), (X1 + 40, X1 + 40.1, Y0 - 34, Y1 + 34)):
        box('ENV', 'sky', a, b, c, d, -1, 30, SKY)
    def tree(tx, ty):
        th = random.uniform(3.2, 4.0); tr = random.uniform(1.1, 1.5)
        cyl('ENV', 'trunk', tx, ty, 0, th - 0.5, 0.12, 0.09, TRUNK, 10)
        bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=2, radius=tr)
        for v in bm.verts: v.co = Vector((v.co.x * (1 + random.uniform(-.18, .18)), v.co.y * (1 + random.uniform(-.18, .18)), v.co.z * (0.8 + random.uniform(-.12, .12)))) + Vector((tx, ty, th))
        me = bpy.data.meshes.new('crown'); bm.to_mesh(me); bm.free(); add('ENV', me, TREE)
    x = X0 - 10
    while x < X1 + 10: tree(x, Y1 + 13.6); tree(x + 1.7, Y0 - 13.6); x += random.uniform(3.2, 4.2)
    y = Y0 - 10
    while y < Y1 + 10: tree(X0 - 13.6, y); tree(X1 + 13.6, y + 1.7); y += random.uniform(3.2, 4.2)

    # ---------- furniture (local frame: centred on the footprint, back at -depth/2, front toward +y)
    def leaves(x, y, z, k, r, spread):
        for i in range(k):
            ang = i * 2.399; hh = z + spread * 0.9 * ((i % 4) / 3); rr = spread * (0.35 + 0.65 * ((i * 7) % 5) / 4)
            bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=1, radius=r)
            for v in bm.verts: v.co = Vector((v.co.x * 1.4, v.co.y, v.co.z * 0.8)) + Vector((x + rr * math.cos(ang), y + rr * math.sin(ang), hh))
            me = bpy.data.meshes.new('leaf'); bm.to_mesh(me); bm.free(); add('FURN', me, GREEN)
            cyl('FURN', 'stem', x + rr * 0.5 * math.cos(ang), y + rr * 0.5 * math.sin(ang), z - spread * 0.3, hh, 0.004, 0.003, GREEN, 6)

    def chair(x, y, dx, dy):
        box('FURN', 'ch_seat', x - 0.22, x + 0.22, y - 0.22, y + 0.22, 0.42, 0.48, LINEN2, bevel=0.02)
        bx, by = x + 0.20 * dx, y + 0.20 * dy; hx, hy = (0.025, 0.22) if dx else (0.22, 0.025)
        box('FURN', 'ch_back', bx - hx, bx + hx, by - hy, by + hy, 0.48, 0.88, LINEN2, bevel=0.012)
        for (lx, ly) in ((-1, -1), (1, -1), (-1, 1), (1, 1)): cyl('FURN', 'ch_leg', x + lx * 0.18, y + ly * 0.18, 0, 0.42, 0.014, 0.011, BLACK, 8)

    def joinery_gaps(x0, x1, y, z0, z1, n):
        for i in range(1, n):
            xx = x0 + (x1 - x0) * i / n; box('FURN', 'gap', xx - 0.002, xx + 0.002, y - 0.001, y + 0.004, z0, z1, KICK)

    def b_kitchen_run(it):
        ln = it.get('len', 3.0); x0, x1, y0 = -ln / 2, ln / 2, -0.325
        box('FURN', 'bench_kick', x0, x1, y0, y0 + 0.56, 0, 0.10, KICK); box('FURN', 'bench', x0, x1, y0, y0 + 0.62, 0.10, 0.88, CAB, bevel=0.003)
        box('FURN', 'bench_top', x0 - 0.02, x1 + 0.02, y0, y0 + 0.65, 0.88, 0.92, STONE, bevel=0.004)
        # window_gap [u0, u1] (local x): no splash or overheads there, so a window over the sink stays open
        g = it.get('window_gap'); spans = [(x0, x1)] if not g else [(a, b) for a, b in ((x0, g[0]), (g[1], x1)) if b - a > 0.05]
        for a, b in spans: box('FURN', 'splash', a, b, y0, y0 + 0.012, 0.92, 1.50, SPLASH)
        n = max(2, round(ln / 0.6)); joinery_gaps(x0, x1, y0 + 0.62, 0.11, 0.87, n)
        if it.get('overheads', True):
            for a, b in spans: box('FURN', 'overheads', a, b, y0, y0 + 0.36, 1.50, 2.25, CAB, bevel=0.003); joinery_gaps(a, b, y0 + 0.36, 1.51, 2.24, max(1, round((b - a) / 0.6)))
        if it.get('cooktop', True):
            c = it.get('cooktop_at', 0.0); box('FURN', 'cooktop', c - 0.40, c + 0.40, y0 + 0.08, y0 + 0.56, 0.92, 0.928, BLACK); box('FURN', 'oven', c - 0.33, c + 0.33, y0 + 0.621, y0 + 0.628, 0.22, 0.80, BLACK)
        if it.get('sink', False):
            c = it.get('sink_at', ln / 4); box('FURN', 'sink', c - 0.37, c + 0.37, y0 + 0.10, y0 + 0.54, 0.905, 0.924, STEEL)
            cyl('FURN', 'tap', c, y0 + 0.07, 0.92, 1.22, 0.012, 0.012, BLACK, 12); box('FURN', 'tap_arm', c - 0.01, c + 0.01, y0 + 0.07, y0 + 0.27, 1.20, 1.22, BLACK)

    def b_island(it):
        ln = it.get('len', 2.6); dp = it.get('depth', 0.94); st = it.get('stools', 0); tot = dp + 0.10 + (0.62 if st else 0)
        x0, x1 = -ln / 2, ln / 2; y0 = -tot / 2 + 0.05; y1 = y0 + dp
        box('FURN', 'isl_kick', x0 + 0.05, x1 - 0.05, y0 + 0.06, y1 - 0.06, 0, 0.10, KICK); box('FURN', 'island', x0, x1, y0, y1, 0.10, 0.88, CAB, bevel=0.003)
        box('FURN', 'isl_top', x0 - 0.05, x1 + 0.05, y0 - 0.05, y1 + 0.05, 0.88, 0.92, STONE, bevel=0.004)
        if it.get('waterfall', True):
            for xx in (x0 - 0.05, x1 + 0.01): box('FURN', 'waterfall', xx, xx + 0.04, y0 - 0.05, y1 + 0.05, 0, 0.88, STONE, bevel=0.004)
        joinery_gaps(x0, x1, y0 - 0.004, 0.11, 0.87, max(2, round(ln / 0.6)))
        if it.get('sink', True):
            box('FURN', 'sink', -0.37, 0.38, y0 + 0.12, y0 + 0.56, 0.905, 0.924, STEEL)
            cyl('FURN', 'tap', 0.0, y0 + 0.10, 0.92, 1.22, 0.012, 0.012, BLACK, 12); box('FURN', 'tap_arm', -0.01, 0.01, y0 + 0.10, y0 + 0.30, 1.20, 1.22, BLACK)
        cyl('FURN', 'fruit_bowl', x1 - 0.55, y1 - 0.32, 0.92, 0.99, 0.08, 0.16, CERAMIC, 28)
        for i in range(st):
            xx = x0 + 0.45 + (ln - 0.9) * (i / (st - 1) if st > 1 else 0.5); yy = y1 + 0.41
            cyl('FURN', 'stool_seat', xx, yy, 0.63, 0.67, 0.17, 0.18, OAK, 28)
            for (lx, ly) in ((-1, -1), (1, -1), (-1, 1), (1, 1)): cyl('FURN', 'stool_leg', xx + lx * 0.12, yy + ly * 0.12, 0, 0.63, 0.016, 0.012, BLACK, 8)
            cyl('FURN', 'stool_ring', xx, yy, 0.22, 0.235, 0.165, 0.165, BLACK, 20, caps=False)

    def b_tall(it):
        ln = it.get('len', 1.8); dp = it.get('depth', 0.62); h = it.get('h', 2.3)
        box('FURN', 'tall', -ln / 2, ln / 2, -dp / 2, dp / 2, 0, h, CAB, bevel=0.003); joinery_gaps(-ln / 2, ln / 2, dp / 2, 0.02, h - 0.02, max(2, round(ln / 0.55)))

    def b_fridge(it):
        ln = it.get('len', 0.92)
        box('FURN', 'fridge', -ln / 2, ln / 2, -0.36, 0.33, 0.03, 1.80, STEEL, bevel=0.004); box('FURN', 'fridge_gap', -0.003, 0.003, 0.329, 0.333, 0.03, 1.80, KICK)
        for xx in (-0.06, 0.06): box('FURN', 'fridge_h', xx - 0.008, xx + 0.008, 0.33, 0.35, 0.8, 1.4, BLACK)

    def b_dining(it):
        ln = it.get('len', 2.4); w = it.get('depth', 1.05); seats = it.get('seats', 8)
        box('FURN', 'table', -ln / 2, ln / 2, -w / 2, w / 2, 0.72, 0.765, OAK, bevel=0.008)
        for (lx, ly) in ((-1, -1), (1, -1), (-1, 1), (1, 1)): box('FURN', 'tleg', lx * (ln / 2 - 0.12) - 0.035, lx * (ln / 2 - 0.12) + 0.035, ly * (w / 2 - 0.085) - 0.035, ly * (w / 2 - 0.085) + 0.035, 0, 0.72, OAK, bevel=0.004)
        side = max(1, (seats - (2 if seats >= 6 else 0)) // 2)
        for i in range(side):
            xx = (i - (side - 1) / 2) * min(0.75, (ln - 0.5) / max(1, side - 0.5) if side > 1 else 0); chair(xx, -w / 2 - 0.275, 0, -1); chair(xx, w / 2 + 0.275, 0, 1)
        if seats >= 6: chair(-ln / 2 - 0.28, 0, -1, 0); chair(ln / 2 + 0.28, 0, 1, 0)
        cyl('FURN', 'vase', 0, 0, 0.765, 1.02, 0.065, 0.04, CERAMIC, 24); leaves(0, 0, 1.12, 7, 0.055, 0.14)

    def b_sofa(it, ln=None, seats=None):
        ln = ln or it.get('len', 2.4); dp = it.get('depth', 0.98) if ln > 1 else 0.92; seats = seats or it.get('seats', 3); x0 = -ln / 2; y0 = -dp / 2
        def lb(name, u0, u1, v0, v1, z0, z1, mm, bevel=0.03, seg=3): box('FURN', name, x0 + u0, x0 + u1, y0 + v0, y0 + v1, z0, z1, mm, bevel=bevel, seg=seg)
        lb('sofa_base', 0, ln, 0, dp, 0.06, 0.30, LINEN, 0.025, 2); lb('sofa_back', 0.195, ln - 0.195, 0, 0.20, 0.30, 0.80, LINEN, 0.035)
        lb('sofa_arm', 0, 0.20, 0, dp, 0.30, 0.60, LINEN, 0.035); lb('sofa_arm', ln - 0.20, ln, 0, dp, 0.30, 0.60, LINEN, 0.035)
        cw = (ln - 0.40) / seats
        for i in range(seats):
            a = 0.20 + i * cw; lb('seat', a + 0.006, a + cw - 0.006, 0.20, dp + 0.01, 0.30, 0.445, LINEN2, 0.04); lb('backc', a + 0.012, a + cw - 0.012, 0.19, 0.36, 0.44, 0.84, LINEN2, 0.06)
        for (u, v) in ((0.08, 0.08), (ln - 0.08, 0.08), (0.08, dp - 0.08), (ln - 0.08, dp - 0.08)): cyl('FURN', 'sofa_leg', x0 + u, y0 + v, 0, 0.06, 0.02, 0.025, BLACK, 12)
        for k, name in enumerate(it.get('throws', ['teal'] if seats > 1 else [])):
            a = 0.28 if k == 0 else ln - 0.70; lb('throw', a, a + 0.42, 0.36, 0.50, 0.45, 0.84, NAMED.get(name, TEAL), 0.06)

    def b_coffee_table(it):
        s = it.get('size', 0.9) / 2
        box('FURN', 'ct_top', -s, s, -s, s, 0.31, 0.35, OAK, bevel=0.008); box('FURN', 'ct_shelf', -s + 0.05, s - 0.05, -s + 0.05, s - 0.05, 0.10, 0.125, OAK, bevel=0.004)
        for (lx, ly) in ((-1, -1), (1, -1), (-1, 1), (1, 1)): box('FURN', 'ct_leg', lx * (s - 0.05) - 0.025, lx * (s - 0.05) + 0.025, ly * (s - 0.05) - 0.025, ly * (s - 0.05) + 0.025, 0.018, 0.31, OAK, bevel=0.004)
        box('FURN', 'book1', -0.30, -0.06, -0.10, 0.22, 0.35, 0.375, CERAMIC, bevel=0.004, rot=Matrix.Rotation(math.radians(12), 4, 'Z'))
        box('FURN', 'book2', -0.28, -0.08, -0.06, 0.20, 0.375, 0.395, TEAL, bevel=0.004, rot=Matrix.Rotation(math.radians(-6), 4, 'Z'))
        cyl('FURN', 'bowl', 0.2, -0.12, 0.35, 0.42, 0.07, 0.13, CERAMIC, 28)

    def b_tv_unit(it):
        ln = it.get('len', 2.2); x0, x1 = -ln / 2, ln / 2; y0 = -0.22
        box('FURN', 'unit', x0, x1, y0 + 0.02, y0 + 0.44, 0.12, 0.50, OAK, bevel=0.006)
        for xx in (x0 + ln / 3, x0 + 2 * ln / 3): box('FURN', 'gap', xx - 0.003, xx + 0.003, y0 + 0.439, y0 + 0.444, 0.14, 0.48, BLACK)
        for xx in (x0 + 0.15, x1 - 0.15): box('FURN', 'unit_leg', xx - 0.02, xx + 0.02, y0 + 0.07, y0 + 0.39, 0, 0.12, BLACK)
        if it.get('tv', True): box('FURN', 'tv', -0.68, 0.68, y0 + 0.003, y0 + 0.035, 0.86, 1.63, BLACK, bevel=0.004)

    def b_art(it):
        ln = it.get('len', 1.3); h = it.get('h', 0.8); z = it.get('z', 1.28)
        box('FURN', 'art_frame', -ln / 2, ln / 2, -0.018, 0.010, z, z + h, BLACK, bevel=0.003); box('FURN', 'art', -ln / 2 + 0.05, ln / 2 - 0.05, 0.010, 0.014, z + 0.05, z + h - 0.05, ART1)

    def b_bed(it):
        w = {'single': 0.92, 'double': 1.38, 'queen': 1.53, 'king': 1.83}[it.get('size', 'queen')]; x0, x1 = -w / 2, w / 2; y0 = -1.06
        box('FURN', 'bedhead', x0 - 0.03, x1 + 0.03, y0, y0 + 0.07, 0, 1.10, LINEN, bevel=0.02)
        box('FURN', 'bedbase', x0, x1, y0 + 0.07, y0 + 2.10, 0.10, 0.32, LINEN, bevel=0.015); box('FURN', 'mattress', x0 + 0.01, x1 - 0.01, y0 + 0.08, y0 + 2.09, 0.32, 0.55, WHITE, bevel=0.05, seg=3)
        box('FURN', 'duvet', x0 - 0.02, x1 + 0.02, y0 + 0.75, y0 + 2.11, 0.50, 0.60, LINEN2, bevel=0.045, seg=3)
        for s in ((-1, 1) if w > 1.2 else (0,)):
            c = s * w / 4; box('FURN', 'pillow', c - min(0.33, w / 2 - 0.08), c + min(0.33, w / 2 - 0.08), y0 + 0.14, y0 + 0.56, 0.55, 0.68, WHITE, bevel=0.06, seg=3)
        box('FURN', 'throw', x0 - 0.02, x1 + 0.02, y0 + 1.55, y0 + 1.95, 0.585, 0.615, NAMED.get(it.get('throw', 'teal'), TEAL), bevel=0.012)
        for (lx, ly) in ((-1, 0.2), (1, 0.2), (-1, 2.0), (1, 2.0)): cyl('FURN', 'bed_leg', lx * (w / 2 - 0.08), y0 + ly, 0, 0.10, 0.025, 0.02, BLACK, 10)

    def b_bedside(it):
        box('FURN', 'bedside', -0.225, 0.225, -0.20, 0.20, 0.10, 0.50, OAK, bevel=0.006)
        for (lx, ly) in ((-1, -1), (1, -1), (-1, 1), (1, 1)): cyl('FURN', 'bs_leg', lx * 0.18, ly * 0.15, 0, 0.10, 0.014, 0.011, BLACK, 8)
        cyl('FURN', 'bs_lamp', 0, -0.04, 0.50, 0.62, 0.05, 0.03, CERAMIC, 20); cyl('FURN', 'bs_shade', 0, -0.04, 0.62, 0.80, 0.11, 0.08, PEND, 24, caps=False)

    def b_desk(it):
        ln = it.get('len', 1.4); y0 = -0.575
        box('FURN', 'desk', -ln / 2, ln / 2, y0, y0 + 0.62, 0.72, 0.75, OAK, bevel=0.006)
        for (lx, ly) in ((-1, 0.05), (1, 0.05), (-1, 0.57), (1, 0.57)): box('FURN', 'desk_leg', lx * (ln / 2 - 0.04) - 0.02, lx * (ln / 2 - 0.04) + 0.02, y0 + ly - 0.02, y0 + ly + 0.02, 0, 0.72, BLACK)
        box('FURN', 'screen', -0.30, 0.30, y0 + 0.10, y0 + 0.125, 0.86, 1.22, BLACK, bevel=0.003); box('FURN', 'screen_foot', -0.10, 0.10, y0 + 0.06, y0 + 0.20, 0.75, 0.762, BLACK)
        chair(0, y0 + 0.92, 0, 1)

    def b_outdoor_table(it):
        ln = it.get('len', 1.8)
        box('FURN', 'otable', -ln / 2, ln / 2, -0.45, 0.45, 0.72, 0.765, OAK, bevel=0.008)
        for (lx, ly) in ((-1, -1), (1, -1), (-1, 1), (1, 1)): box('FURN', 'oleg', lx * (ln / 2 - 0.1) - 0.03, lx * (ln / 2 - 0.1) + 0.03, ly * 0.36 - 0.03, ly * 0.36 + 0.03, 0, 0.72, BLACK)
        for s in (-1, 1):
            box('FURN', 'obench', -ln / 2 + 0.1, ln / 2 - 0.1, s * 0.78 - 0.17, s * 0.78 + 0.17, 0.41, 0.45, OAK, bevel=0.006)
            for lx in (-ln / 2 + 0.2, ln / 2 - 0.2): box('FURN', 'obleg', lx - 0.025, lx + 0.025, s * 0.78 - 0.14, s * 0.78 + 0.14, 0, 0.41, BLACK)

    def b_box(it):
        l, d, h = it['size']; z = it.get('z', 0.0); box('FURN', 'box', -l / 2, l / 2, -d / 2, d / 2, z, z + h, NAMED.get(it.get('mat', 'oak'), OAK), bevel=it.get('bevel', 0.005))

    LOCAL = {'kitchen_run': b_kitchen_run, 'island': b_island, 'tall': b_tall, 'fridge': b_fridge, 'dining': b_dining, 'sofa': b_sofa,
             'armchair': lambda it: b_sofa(it, 0.95, 1), 'coffee_table': b_coffee_table, 'tv_unit': b_tv_unit, 'art': b_art, 'bed': b_bed,
             'bedside': b_bedside, 'desk': b_desk, 'outdoor_table': b_outdoor_table, 'box': b_box,
             'rug': lambda it: box('FURN', 'rug', -it.get('len', 2.6) / 2, it.get('len', 2.6) / 2, -it.get('depth', 3.0) / 2, it.get('depth', 3.0) / 2, 0.0, 0.018, RUG, bevel=0.006)}
    for it in p.get('items', []):
        x, y = it['at']
        if it['type'] == 'plant':
            cyl('FURN', 'pot', x, y, 0, 0.42, 0.17, 0.21, CERAMIC if not it.get('dark') else CHAR, 28); leaves(x, y, 0.75, 24, 0.075, 0.36)
        elif it['type'] == 'floor_lamp':
            cyl('FURN', 'lamp_base', x, y, 0, 0.025, 0.15, 0.15, BLACK, 28); cyl('FURN', 'lamp_pole', x, y, 0.025, 1.45, 0.012, 0.012, BLACK, 12); cyl('FURN', 'lamp_shade', x, y, 1.38, 1.68, 0.20, 0.15, PEND, 32, caps=False)
        elif it['type'] == 'pendant':
            z = it.get('z', 1.72); r = it.get('r', 0.15); cyl('FURN', 'pendant', x, y, z, z + r * 1.6, r, r * 0.55, PEND, 32, caps=False); cyl('FURN', 'cord', x, y, z + r * 1.6, cz(x, y), 0.004, 0.004, BLACK, 6)
        else:
            with placed(item_matrix(it)): LOCAL[it['type']](it)

    # ---------- light: sun from the north, soft ceiling fills, sky
    sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = float(os.environ.get('SUN', '6.0')); sun.angle = math.radians(1.2)
    so = bpy.data.objects.new('sun', sun); sc.collection.objects.link(so)
    so.rotation_euler = (math.radians(-p.get('sun', {}).get('tilt', 50)), 0, math.radians(p.get('sun', {}).get('turn', 16)))
    inner = offset(O, -0.9); nx = max(1, round((X1 - X0) / 4.2)); ny = max(1, round((Y1 - Y0) / 4.2)); fills = 0
    for i in range(nx):
        for k in range(ny):
            fx = X0 + (X1 - X0) * (i + 0.5) / nx; fy = Y0 + (Y1 - Y0) * (k + 0.5) / ny
            if not inside(inner, fx, fy): continue
            fill = bpy.data.lights.new('fill', 'AREA'); fill.energy = 60 * float(os.environ.get('FILL', '1.0')); fill.size = 2.4; fill.color = (1.0, 0.96, 0.9)
            fo = bpy.data.objects.new('fill', fill); sc.collection.objects.link(fo); fo.location = (fx, fy, cz(fx, fy) - 0.04); fills += 1
    wld = bpy.data.worlds.new('w'); wld.use_nodes = True; bg = wld.node_tree.nodes['Background']
    bg.inputs[0].default_value = (0.55, 0.70, 0.95, 1); bg.inputs[1].default_value = 1.0; sc.world = wld
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.use_denoising = True; sc.cycles.max_bounces = 5
    sc.view_settings.view_transform = 'Standard'; sc.view_settings.exposure = 0.0; sc.view_settings.look = 'None'
    print('SCENE objects', {g: len(v) for g, v in OBJS.items()}, 'fills', fills, 'wall height', round(HW, 2), flush=True)

    if mode == 'preview':
        sc.cycles.samples = int(os.environ.get('SPP', '16')); sc.render.resolution_x, sc.render.resolution_y = 660, 440; sc.render.image_settings.file_format = 'PNG'
        for i, v in enumerate(p['views']):
            cam = bpy.data.cameras.new('c'); cam.sensor_fit = 'HORIZONTAL'; cam.angle = math.radians(v.get('fov', 82))
            co = bpy.data.objects.new('c', cam); sc.collection.objects.link(co); co.location = (*v['pos'], 1.5)
            d = math.hypot(v['look'][0] - v['pos'][0], v['look'][1] - v['pos'][1]); look = Vector((*v['look'], 1.5 + math.tan(v.get('pitch', -0.1)) * d))
            co.rotation_euler = (look - Vector(co.location)).to_track_quat('-Z', 'Y').to_euler(); sc.camera = co
            sc.render.filepath = os.path.join(out, f'preview_{i}.png'); bpy.ops.render.render(write_still=True)
        return
    sc.cycles.samples = int(os.environ.get('SPP', '32')); sc.render.bake.margin = 8
    vl = bpy.context.view_layer; GL = os.environ.get('BAKE_GROUPS', 'ENV,FURN,ARCH').split(',')
    keep_in = offset(O, T - 0.005); room = offset(O, 0.02); zones = [d['rect'] for d in p.get('outdoor', [])]
    for g in GL:
        for ob in sc.collection.objects: ob.select_set(False)
        for ob in OBJS[g]: ob.select_set(True)
        vl.objects.active = OBJS[g][0]; bpy.ops.object.join(); ob = vl.objects.active; ob.name = g
        if g == 'ARCH':   # drop faces nobody can see: undersides, everything above the ceiling, outer wall skins away from outdoor areas
            bm = bmesh.new(); bm.from_mesh(ob.data)
            def hidden(c):
                if c.z < -0.02: return True
                if any(z[0] - T - 0.6 <= c.x <= z[2] + T + 0.6 and z[1] - T - 0.6 <= c.y <= z[3] + T + 0.6 for z in zones) and not inside(room, c.x, c.y): return c.z > HW + 0.2
                if inside(room, c.x, c.y): return c.z > cz(c.x, c.y) + 0.03
                return not inside(keep_in, c.x, c.y) or c.z > cz(c.x, c.y) + 0.03
            bmesh.ops.delete(bm, geom=[f for f in bm.faces if hidden(f.calc_center_median())], context='FACES'); bm.to_mesh(ob.data); bm.free()
        bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.003, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
        bpy.ops.object.mode_set(mode='OBJECT'); OBJS[g] = [ob]
    for g in GL:   # one group at a time, saved at once: a crash loses one group, not all
        ob = OBJS[g][0]
        for o2 in sc.collection.objects: o2.select_set(False)
        ob.select_set(True); vl.objects.active = ob
        bpy.ops.object.bake(type='COMBINED', margin=8, use_clear=True)
        im = IMG[g]; s = ATLAS[g]; px = np.empty(s * s * 4, np.float32); im.pixels.foreach_get(px); np.save(os.path.join(out, f'atlas_{g}.npy'), px.reshape(s, s, 4)[..., :3])
        me = ob.data; me.calc_loop_triangles(); uv = me.uv_layers.active.data; rows = []
        for t in me.loop_triangles:
            for li in t.loops:
                v = me.vertices[me.loops[li].vertex_index].co; rows += [v.x, v.y, v.z, uv[li].uv.x, uv[li].uv.y]
        np.array(rows, np.float32).tofile(os.path.join(out, f'mesh_{g}.bin')); print('BAKED', g, 'tris', len(me.loop_triangles), flush=True)

if __name__ == '__main__':
    if len(sys.argv) < 3: raise SystemExit(__doc__)
    plan = load_plan(sys.argv[1]); mode = sys.argv[2]
    out = sys.argv[3] if len(sys.argv) > 3 else os.path.join('/tmp/walkgen', plan['slug']); os.makedirs(out, exist_ok=True)
    if mode == 'check':
        lay = layout(plan); print('ok', plan['slug'], '| walk', lay['walk'], '| solid', len(lay['solid']), '| openings', len(lay['plan']['openings']))
    elif mode == 'pack': pack(plan, out, sys.argv[4] if len(sys.argv) > 4 else os.path.join(out, 'site'))
    elif mode in ('preview', 'bake'): build(plan, mode, out)
    else: raise SystemExit('mode must be check, preview, bake or pack')
