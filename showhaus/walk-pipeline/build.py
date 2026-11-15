"""Avalon living-zone proxy: builds from avalon.json, renders each camera, ray-casts world XYZ per pixel."""
import bpy, json, math, sys, numpy as np
from mathutils import Vector

D = json.load(open('/home/claude/showhaus/avalon.json'))
OUT = '/home/claude/showhaus/'
W, H = 1200, 800
T = 0.11  # wall thickness

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene

def mat(name, rgb, rough=0.6):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    return m

M = {
    'wall': mat('wall', (0.86, 0.86, 0.85)), 'ceil': mat('ceil', (0.9, 0.9, 0.9)),
    'floor': mat('floor', (0.72, 0.58, 0.42), 0.45), 'white': mat('white', (0.88, 0.88, 0.87), 0.4),
    'stone': mat('stone', (0.93, 0.93, 0.92), 0.25), 'oak': mat('oak', (0.66, 0.52, 0.36), 0.5),
    'linen': mat('linen', (0.80, 0.78, 0.74), 0.9), 'rug': mat('rug', (0.78, 0.74, 0.68), 1.0),
    'grass': mat('grass', (0.22, 0.42, 0.14), 1.0), 'fence': mat('fence', (0.45, 0.44, 0.42), 0.8),
    'sky': mat('sky', (0.62, 0.76, 0.95), 1.0), 'pave': mat('pave', (0.70, 0.69, 0.66), 0.7), 'frame': mat('frame', (0.95, 0.95, 0.95), 0.4),
}

def box(name, x0, x1, y0, y1, z0, z1, m):
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    me = bpy.data.meshes.new(name); me.from_pydata(v, [], f); me.update()
    o = bpy.data.objects.new(name, me); sc.collection.objects.link(o); me.materials.append(M[m]); return o

def cbox(f):
    z = f.get('z', 0)
    return box(f['name'], f['x'] - f['sx'] / 2, f['x'] + f['sx'] / 2, f['y'] - f['sy'] / 2, f['y'] + f['sy'] / 2, z, z + f['sz'], f['mat'])

R, C = D['room'], D['cutout']
Wd, Dp = R['w'], R['d']
ZT = 4.0  # walls built tall; raked ceiling plane cuts the view

def wall_x(name, y, x0, x1, opens):
    """wall along x at depth y, split around openings"""
    cur = x0
    for o in sorted(opens, key=lambda o: o['x0']):
        if o['x0'] > cur: box(name, cur, o['x0'], y, y + T, 0, ZT, 'wall')
        if o['z0'] > 0: box(name + '_sill', o['x0'], o['x1'], y, y + T, 0, o['z0'], 'wall')
        box(name + '_head', o['x0'], o['x1'], y, y + T, o['z1'], ZT, 'wall')
        # white frame mullions every ~1.05 m
        n = max(2, round((o['x1'] - o['x0']) / 1.05))
        for i in range(n + 1):
            xm = o['x0'] + (o['x1'] - o['x0']) * i / n
            box(name + '_mull', xm - 0.025, xm + 0.025, y + 0.03, y + 0.08, o['z0'], o['z1'], 'frame')
        cur = o['x1']
    if cur < x1: box(name, cur, x1, y, y + T, 0, ZT, 'wall')

# floor, north wall, side walls, south walls with cut-out
box('floor', 0, Wd, 0, Dp, -0.05, 0, 'floor')
wall_x('north', Dp, -T, Wd + T, D['openings_north'])
box('west', -T, 0, 0, Dp, 0, ZT, 'wall'); box('east', Wd, Wd + T, 0, Dp, 0, ZT, 'wall')
wall_x('south', -T, C['x1'], Wd + T, D['openings_south'])
box('cut_block', C['x0'] - T, C['x1'], C['y0'] - T, C['y1'], 0, ZT, 'wall')   # butlers/WIL block
# raked ceiling (single slope, assumed)
me = bpy.data.meshes.new('ceil')
me.from_pydata([(-T, -T, R['ceil_south']), (Wd + T, -T, R['ceil_south']), (Wd + T, Dp + T, R['ceil_north']), (-T, Dp + T, R['ceil_north'])], [], [(0, 1, 2, 3)])
o = bpy.data.objects.new('ceil', me); sc.collection.objects.link(o); me.materials.append(M['ceil'])
box('roof_cap', -1, Wd + 1, -1, Dp + 1, 4.0, 4.1, 'ceil')  # stops sky light leaking over walls
# skirting
box('skirt_n', 0, Wd, Dp - 0.015, Dp, 0, 0.09, 'frame')
# alfresco + yard
A = D['alfresco']
box('alf_floor', A['x0'], A['x1'], Dp + T, Dp + T + A['depth'], -0.05, 0, 'pave')
box('alf_roof', A['x0'], A['x1'], Dp + T, Dp + T + A['depth'], A['roof_z'], A['roof_z'] + 0.15, 'ceil')
for px in (A['x0'] + 0.1, A['x1'] - 0.1):
    box('alf_post', px - 0.06, px + 0.06, Dp + T + A['depth'] - 0.12, Dp + T + A['depth'], 0, A['roof_z'], 'frame')
box('lawn', -60, Wd + 60, Dp + T, Dp + 16, -0.08, -0.05, 'grass')
box('fence', -60, Wd + 60, Dp + 12, Dp + 12.1, 0, 1.8, 'fence')
box('sky', -60, Wd + 60, Dp + 15.9, Dp + 16, 0, 14, 'sky')
# furniture
for f in D['furniture']: cbox(f)
S = D['stools']
for i in range(S['count']):
    y = S['y0'] + (S['y1'] - S['y0']) * i / (S['count'] - 1)
    box('stool', S['x'] - 0.19, S['x'] + 0.19, y - 0.19, y + 0.19, 0.6, 0.66, 'oak')
    box('stool_leg', S['x'] - 0.03, S['x'] + 0.03, y - 0.03, y + 0.03, 0, 0.6, 'oak')
tb = next(f for f in D['furniture'] if f['name'] == 'dining_table')
def chair(x, y, dx, dy):
    box('chair_seat', x - 0.23, x + 0.23, y - 0.23, y + 0.23, 0.40, 0.46, 'linen')
    bx, by = x + 0.2 * dx, y + 0.2 * dy          # back sits on the side away from the table
    hx, hy = (0.03, 0.23) if dx else (0.23, 0.03)
    box('chair_back', bx - hx, bx + hx, by - hy, by + hy, 0.46, 0.88, 'linen')
for i in range(3):
    y = tb['y'] - 0.75 + 0.75 * i
    chair(tb['x'] - 0.85, y, -1, 0); chair(tb['x'] + 0.85, y, 1, 0)
chair(tb['x'], tb['y'] - tb['sy'] / 2 - 0.35, 0, -1); chair(tb['x'], tb['y'] + tb['sy'] / 2 + 0.35, 0, 1)
box('table_leg', tb['x'] - 0.3, tb['x'] + 0.3, tb['y'] - 0.8, tb['y'] + 0.8, 0, 0.72, 'oak')
# pendants over island
for y in (3.2, 4.6):
    box('pendant', 3.9 - 0.16, 3.9 + 0.16, y - 0.16, y + 0.16, 1.75, 1.95, 'linen')
    box('pendant_cord', 3.9 - 0.005, 3.9 + 0.005, y - 0.005, y + 0.005, 1.95, 3.2, 'frame')

# light: sun from the north (Sydney), sky fill
sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = 4.0; sun.angle = math.radians(1.0)
so = bpy.data.objects.new('sun', sun); sc.collection.objects.link(so)
so.rotation_euler = (math.radians(-52), 0, math.radians(18))  # points south and down => light enters from north
wld = bpy.data.worlds.new('w'); wld.use_nodes = True
wld.node_tree.nodes['Background'].inputs[0].default_value = (0.62, 0.76, 0.95, 1)
wld.node_tree.nodes['Background'].inputs[1].default_value = 1.6
sc.world = wld

sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = 24
sc.cycles.use_denoising = True; sc.cycles.max_bounces = 6
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = W, H, 100
sc.view_settings.view_transform = 'Standard'; sc.view_settings.exposure = 0.8
sc.render.image_settings.file_format = 'PNG'

ONLY = [a for a in sys.argv if a.startswith('only=')]
for c in D['cameras']:
    if ONLY and c['name'] not in ONLY[0][5:].split(','): continue
    cam = bpy.data.cameras.new(c['name']); cam.sensor_fit = 'HORIZONTAL'; cam.angle = math.radians(c['hfov'])
    co = bpy.data.objects.new(c['name'], cam); sc.collection.objects.link(co)
    co.location = Vector(c['pos'])
    co.rotation_euler = (Vector(c['look']) - Vector(c['pos'])).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = co; bpy.context.view_layer.update()
    if 'noimg' not in sys.argv:
        sc.render.filepath = OUT + 'proxy_' + c['name'] + '.png'
        bpy.ops.render.render(write_still=True)
    # per-pixel world position by ray casting (exact proxy depth)
    dg = bpy.context.evaluated_depsgraph_get(); mw = co.matrix_world; org = mw.translation; rot = mw.to_3x3()
    tx = math.tan(math.radians(c['hfov']) / 2); ty = tx * H / W
    xyz = np.full((H, W, 3), np.nan, np.float32)
    for j in range(H):
        v = (1 - 2 * (j + 0.5) / H) * ty
        for i in range(W):
            u = (2 * (i + 0.5) / W - 1) * tx
            d = (rot @ Vector((u, v, -1))).normalized()
            hit, loc, *_ = sc.ray_cast(dg, org, d)
            if hit: xyz[j, i] = loc
    np.save(OUT + 'xyz_' + c['name'] + '.npy', xyz)
    print(c['name'], 'hit ratio', float(np.isfinite(xyz[..., 0]).mean()))

if 'export' in sys.argv:
    out = []
    for o in sc.collection.objects:
        if o.type != 'MESH' or o.name.startswith('roof_cap'): continue
        col = o.data.materials[0].node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value[:3]
        for p in o.data.polygons:
            vs = [o.data.vertices[i].co for i in p.vertices]
            for a, b, c2 in ((0, 1, 2), (0, 2, 3)) if len(vs) == 4 else ((0, 1, 2),):
                for v in (vs[a], vs[b], vs[c2]): out += [v.x, v.y, v.z, p.normal.x, p.normal.y, p.normal.z, *col]
    np.array(out, np.float32).tofile(OUT + 'mesh.bin'); print('mesh verts', len(out) // 9)
