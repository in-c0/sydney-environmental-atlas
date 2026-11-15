"""SHOWHAUS deliverable build: Buildtec 'Avalon' kitchen / dining / family + alfresco, from the published floor plan.
usage: python3 avalon.py preview | bake      (plan dimensions from avalon.json; assumptions listed there)
Outputs in avroom/: preview_*.png, atlas_<G>.npy, mesh_<G>.bin (pos3+uv2 float32 per vertex, z-up metres)"""
import bpy, bmesh, math, os, sys, random, numpy as np
from mathutils import Vector, Matrix
OUT = '/home/claude/showhaus/avroom/'; os.makedirs(OUT, exist_ok=True)
MODE = sys.argv[-1]
random.seed(11)
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
Wd, Dp, T = 12.7, 6.3, 0.11
CS, CN = 2.6, 3.5
def cz(y): return CS + (y + T) / (Dp + 2 * T) * (CN - CS)
ATLAS = {'ARCH': int(os.environ.get('ARCH_RES', '4096')), 'FURN': int(os.environ.get('FURN_RES', '3072')), 'ENV': 1024}
IMG = {g: bpy.data.images.new('atlas_' + g, s, s, alpha=False, float_buffer=True) for g, s in ATLAS.items()}
OBJS = {g: [] for g in ATLAS}
_mats = {}

def mat(g, name, c1, c2=None, scale=8.0, stretch=(1, 1, 1), kind='noise', rough=0.85, emit=None):
    key = (g, name)
    if key in _mats: return _mats[key]
    m = bpy.data.materials.new(g + '_' + name); m.use_nodes = True
    nt = m.node_tree; N = nt.nodes; L = nt.links
    bsdf = N.get('Principled BSDF'); out = N.get('Material Output')
    bsdf.inputs['Roughness'].default_value = rough
    for k in ('Specular IOR Level',):
        if k in bsdf.inputs: bsdf.inputs[k].default_value = 0.15
    col = bsdf.inputs['Base Color']; col.default_value = (*c1, 1)
    if c2 is not None:
        tc = N.new('ShaderNodeTexCoord'); mp = N.new('ShaderNodeMapping'); mp.inputs['Scale'].default_value = stretch
        L.new(tc.outputs['Object'], mp.inputs['Vector'])
        if kind == 'planks':
            br = N.new('ShaderNodeTexBrick'); br.offset = 0.5; br.inputs['Scale'].default_value = 1.0
            br.inputs['Mortar Size'].default_value = 0.0025; br.inputs['Brick Width'].default_value = 1.35; br.inputs['Row Height'].default_value = 0.15
            br.inputs['Mortar'].default_value = (c1[0] * .55, c1[1] * .55, c1[2] * .55, 1)
            nz = N.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = scale; nz.inputs['Detail'].default_value = 6
            mp2 = N.new('ShaderNodeMapping'); mp2.inputs['Scale'].default_value = (0.6, 14, 1); L.new(tc.outputs['Object'], mp2.inputs['Vector']); L.new(mp2.outputs['Vector'], nz.inputs['Vector'])
            r1 = N.new('ShaderNodeValToRGB'); r1.color_ramp.elements[0].color = (*c1, 1); r1.color_ramp.elements[1].color = (*c2, 1)
            r1.color_ramp.elements[0].position = 0.3; r1.color_ramp.elements[1].position = 0.7
            L.new(nz.outputs['Fac'], r1.inputs['Fac']); L.new(mp.outputs['Vector'], br.inputs['Vector'])
            L.new(r1.outputs['Color'], br.inputs['Color1']); br.inputs['Color2'].default_value = ((c1[0] + c2[0]) / 2 * 0.94, (c1[1] + c2[1]) / 2 * 0.94, (c1[2] + c2[2]) / 2 * 0.94, 1)
            L.new(br.outputs['Color'], col)
        else:
            nz = N.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = scale; nz.inputs['Detail'].default_value = 5
            r1 = N.new('ShaderNodeValToRGB'); r1.color_ramp.elements[0].color = (*c1, 1); r1.color_ramp.elements[1].color = (*c2, 1)
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
        L.new(em.outputs['Emission'], out.inputs['Surface'])
    ti = N.new('ShaderNodeTexImage'); ti.image = IMG[g]; N.active = ti
    _mats[key] = m; return m

def add(g, me, m):
    o = bpy.data.objects.new(me.name, me); sc.collection.objects.link(o); me.materials.append(m); OBJS[g].append(o); return o

def box(g, name, x0, x1, y0, y1, z0, z1, m, bevel=0.0, seg=2, rot=None):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts: v.co = Vector(((v.co.x) * (x1 - x0), (v.co.y) * (y1 - y0), (v.co.z) * (z1 - z0)))
    if bevel > 0: bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=seg, affect='EDGES', profile=0.5)
    c = Vector(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)); R = rot or Matrix()
    for v in bm.verts: v.co = (R @ v.co) + c
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); return add(g, me, m)

def cyl(g, name, x, y, z0, z1, r0, r1, m, segs=28, caps=True):
    bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=caps, segments=segs, radius1=r0, radius2=r1, depth=z1 - z0)
    for v in bm.verts: v.co += Vector((x, y, (z0 + z1) / 2))
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); return add(g, me, m)

# ---------- materials
WALL = mat('ARCH', 'wall', (0.80, 0.79, 0.76), (0.83, 0.82, 0.79), 2.5)
CEIL = mat('ARCH', 'ceil', (0.84, 0.84, 0.82))
TRIM = mat('ARCH', 'trim', (0.86, 0.86, 0.85), rough=0.5)
FLOOR = mat('ARCH', 'floor', (0.56, 0.41, 0.26), (0.70, 0.55, 0.37), 5.0, kind='planks', rough=0.55)
DECK = mat('ARCH', 'deck', (0.36, 0.30, 0.25), (0.46, 0.40, 0.33), 5.0, kind='planks', rough=0.8)
DOOR = mat('ARCH', 'door', (0.82, 0.82, 0.80), rough=0.5)
FRAME = mat('ARCH', 'frame', (0.06, 0.06, 0.065), rough=0.5)
ROOF = mat('ARCH', 'roof', (0.10, 0.11, 0.12), rough=0.7)
CAB = mat('FURN', 'cab', (0.80, 0.80, 0.78), rough=0.4)
STONE = mat('FURN', 'stone', (0.82, 0.81, 0.79), (0.88, 0.87, 0.86), 1.4, rough=0.3)
SPLASH = mat('FURN', 'splash', (0.66, 0.70, 0.67), (0.72, 0.76, 0.73), 3.0, rough=0.3)
STEEL = mat('FURN', 'steel', (0.42, 0.43, 0.44), rough=0.35)
KICK = mat('FURN', 'kick', (0.07, 0.07, 0.07))
LINEN = mat('FURN', 'linen', (0.60, 0.57, 0.52), (0.70, 0.67, 0.62), 260, rough=1.0)
LINEN2 = mat('FURN', 'linen2', (0.64, 0.61, 0.56), (0.72, 0.69, 0.64), 260, rough=1.0)
TEAL = mat('FURN', 'teal', (0.06, 0.26, 0.28), (0.09, 0.32, 0.34), 220, rough=1.0)
RUST = mat('FURN', 'rust', (0.42, 0.17, 0.08), (0.50, 0.22, 0.11), 220, rough=1.0)
CHAR = mat('FURN', 'charcoal', (0.09, 0.09, 0.10), (0.13, 0.13, 0.14), 220, rough=1.0)
OAK = mat('FURN', 'oak', (0.52, 0.36, 0.20), (0.64, 0.47, 0.28), 3.0, stretch=(0.5, 22, 22), rough=0.5)
RUG = mat('FURN', 'rug', (0.62, 0.58, 0.50), (0.76, 0.72, 0.64), 90, rough=1.0)
CERAMIC = mat('FURN', 'ceramic', (0.78, 0.76, 0.72), rough=0.4)
BLACK = mat('FURN', 'black', (0.03, 0.03, 0.03), rough=0.5)
PEND = mat('FURN', 'pend', (1.0, 0.84, 0.62), emit=1.4)
ART1 = mat('FURN', 'art', (0.72, 0.58, 0.44), (0.20, 0.30, 0.33), 1.6)
GREEN = mat('FURN', 'leaf', (0.05, 0.16, 0.05), (0.10, 0.26, 0.08), 30, rough=0.7)
GRASS = mat('ENV', 'grass', (0.07, 0.20, 0.03), (0.14, 0.32, 0.06), 6)
FENCE = mat('ENV', 'fence', (0.19, 0.22, 0.25), (0.25, 0.28, 0.31), 1.0, stretch=(26, 26, 0.2))
TREE = mat('ENV', 'tree', (0.04, 0.12, 0.03), (0.09, 0.22, 0.06), 3)
TRUNK = mat('ENV', 'trunk', (0.12, 0.09, 0.06))
SKY = mat('ENV', 'sky', (0.10, 0.28, 0.80), (0.60, 0.74, 0.95), emit=0.9)

# ---------- shell
CX1, CY1 = 6.6, 1.4                      # butlers / WIL block cut out of the south-west corner
HW = 3.6                                 # wall box height (the raked ceiling plane closes the room below this)
box('ARCH', 'floor', 0, Wd, CY1, Dp, -0.06, 0, FLOOR); box('ARCH', 'floor', CX1, Wd, 0, CY1, -0.06, 0, FLOOR)
me = bpy.data.meshes.new('ceil'); me.from_pydata([(-T, -T, cz(-T)), (-T, Dp + T, cz(Dp + T)), (Wd + T, Dp + T, cz(Dp + T)), (Wd + T, -T, cz(-T))], [], [(0, 1, 2, 3)]); add('ARCH', me, CEIL)
box('ARCH', 'cap', -T, Wd + T, -T, Dp + T, HW, HW + 0.05, ROOF)
def wall_x(y, yt, xa, xb, opens, h):
    cur = xa
    for (a, b, z0, z1) in sorted(opens):
        if a > cur: box('ARCH', 'wall', cur, a, y, yt, 0, h, WALL)
        if z0 > 0: box('ARCH', 'wall', a, b, y, yt, 0, z0, WALL)
        box('ARCH', 'wall', a, b, y, yt, z1, h, WALL); cur = b
    box('ARCH', 'wall', cur, xb, y, yt, 0, h, WALL)
SL = (0.6, 4.8, 0.0, 2.4); W1 = (6.2, 8.8, 0.6, 2.4); W2 = (9.6, 12.2, 0.6, 2.4); HD = (7.0, 8.2, 0.0, 2.4)
wall_x(Dp, Dp + T, -T, Wd + T, [SL, W1, W2], HW)
wall_x(-T, 0, CX1, Wd + T, [HD], HW)
box('ARCH', 'wall', -T, 0, CY1, Dp, 0, HW, WALL); box('ARCH', 'wall', Wd, Wd + T, 0, Dp, 0, HW, WALL)
box('ARCH', 'cutblock', -T, CX1, -T, CY1, 0, HW, WALL)
fy = Dp + 0.03
def frame(o, mull, sill=True):
    a, b, z0, z1 = o
    for (p, q, r, s) in ((a, b, z1 - 0.05, z1), (a, a + 0.05, z0, z1 - 0.05), (b - 0.05, b, z0, z1 - 0.05)) + (((a, b, z0, z0 + 0.05),) if z0 > 0 else ()):
        box('ARCH', 'frame', p, q, fy, fy + 0.05, r, s, FRAME)
    for xm in mull: box('ARCH', 'mull', xm - 0.022, xm + 0.022, fy, fy + 0.05, z0, z1 - 0.05, FRAME)
    if sill and z0 > 0: box('ARCH', 'sill', a - 0.04, b + 0.04, Dp - 0.05, Dp + 0.02, z0 - 0.03, z0, TRIM, bevel=0.006)
frame(SL, [0.72, 0.84])                                  # sliders stacked open against the west jamb
frame(W1, [W1[0] + 0.87, W1[0] + 1.73]); frame(W2, [W2[0] + 0.87, W2[0] + 1.73])
box('ARCH', 'track', SL[0], SL[1], Dp, Dp + T, -0.004, 0.004, FRAME)
# hall door (closed double door) + butlers door on the block
box('ARCH', 'door', HD[0] - 0.03, HD[1] + 0.03, -0.075, -0.035, -0.02, HD[3] + 0.03, DOOR)
box('ARCH', 'doorgap', (HD[0] + HD[1]) / 2 - 0.003, (HD[0] + HD[1]) / 2 + 0.003, -0.036, -0.033, 0, HD[3], FRAME)
for (a, b, c, d) in ((HD[0] - 0.07, HD[0], 0, HD[3] + 0.07), (HD[1], HD[1] + 0.07, 0, HD[3] + 0.07), (HD[0] - 0.07, HD[1] + 0.07, HD[3], HD[3] + 0.07)):
    box('ARCH', 'arch', a, b, 0, 0.018, c, d, TRIM, bevel=0.004)
box('ARCH', 'bdoor', 1.0, 1.82, CY1, CY1 + 0.012, 0, 2.1, DOOR)
for (a, b, c, d) in ((0.93, 1.0, 0, 2.17), (1.82, 1.89, 0, 2.17), (0.93, 1.89, 2.1, 2.17)): box('ARCH', 'arch', a, b, CY1, CY1 + 0.02, c, d, TRIM, bevel=0.004)
box('ARCH', 'bulkhead', 2.4, CX1, CY1, CY1 + 0.62, 2.3, HW, WALL)
sk = 0.09
for (a, b) in ((0, SL[0]), (SL[1], Wd)): box('ARCH', 'skirt', a, b, Dp - 0.014, Dp, 0, sk, TRIM, bevel=0.004)
for (a, b) in ((CX1, HD[0] - 0.07), (HD[1] + 0.07, Wd)): box('ARCH', 'skirt', a, b, 0, 0.014, 0, sk, TRIM, bevel=0.004)
box('ARCH', 'skirt', Wd - 0.014, Wd, 0, Dp, 0, sk, TRIM, bevel=0.004); box('ARCH', 'skirt', CX1, CX1 + 0.014, 0, CY1, 0, sk, TRIM, bevel=0.004)
for (a, b) in ((0.66, 0.93), (1.89, 2.4)): box('ARCH', 'skirt', a, b, CY1, CY1 + 0.014, 0, sk, TRIM, bevel=0.004)
# alfresco: deck, roof, posts, house fascia
AX0, AX1, AD, AZ = -0.3, 5.2, 3.0, 2.7; AY0 = Dp + T; AY1 = AY0 + AD
box('ARCH', 'deck', AX0, AX1, AY0, AY1, -0.06, 0, DECK)
box('ARCH', 'alf_roof', AX0, AX1, AY0, AY1, AZ, AZ + 0.14, CEIL)
box('ARCH', 'alf_fascia', AX0, AX1, AY1 - 0.03, AY1, AZ - 0.08, AZ + 0.14, FRAME)
for px in (AX0 + 0.08, AX1 - 0.08): box('ARCH', 'post', px - 0.06, px + 0.06, AY1 - 0.12, AY1, 0, AZ, FRAME)
box('ARCH', 'eave', -T - 0.3, Wd + T + 0.3, AY0, AY0 + 0.45, HW - 0.02, HW + 0.2, ROOF)

# ---------- outside
box('ENV', 'lawn', -1.7, Wd + 1.3, Dp - 2.0, Dp + 12.0, -0.10, -0.062, GRASS)
box('ENV', 'fence', -1.7, Wd + 1.3, Dp + 12.0, Dp + 12.06, 0, 1.8, FENCE)
box('ENV', 'fence', -1.76, -1.7, Dp - 2.0, Dp + 12.0, 0, 1.8, FENCE); box('ENV', 'fence', Wd + 1.3, Wd + 1.36, Dp - 2.0, Dp + 12.0, 0, 1.8, FENCE)
box('ENV', 'fence', -1.7, -T, Dp - 2.0, Dp - 1.94, 0, 1.8, FENCE); box('ENV', 'fence', Wd + T, Wd + 1.3, Dp - 2.0, Dp - 1.94, 0, 1.8, FENCE)
box('ENV', 'sky', -60, Wd + 60, Dp + 34.0, Dp + 34.1, -1, 30, SKY)
box('ENV', 'sky', -40.1, -40, -20, Dp + 34, -1, 30, SKY); box('ENV', 'sky', Wd + 40, Wd + 40.1, -20, Dp + 34, -1, 30, SKY)
for (tx, th, tr) in ((-0.5, 3.4, 1.2), (3.4, 4.0, 1.5), (7.2, 3.2, 1.1), (10.6, 3.8, 1.4), (14.4, 3.3, 1.2), (-4.0, 3.6, 1.3), (17.5, 3.5, 1.3)):
    cyl('ENV', 'trunk', tx, Dp + 13.6, 0, th - 0.5, 0.12, 0.09, TRUNK, 10)
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=2, radius=tr)
    for v in bm.verts: v.co = Vector((v.co.x * (1 + random.uniform(-.18, .18)), v.co.y * 0.8, v.co.z * (0.8 + random.uniform(-.12, .12)))) + Vector((tx, Dp + 13.6, th))
    me = bpy.data.meshes.new('crown'); bm.to_mesh(me); bm.free(); add('ENV', me, TREE)

# ---------- kitchen
BY0, BY1 = 1.75, 6.05
box('FURN', 'bench_kick', 0.0, 0.56, BY0, BY1, 0, 0.10, KICK)
box('FURN', 'bench', 0.0, 0.62, BY0, BY1, 0.10, 0.88, CAB, bevel=0.003)
box('FURN', 'bench_top', 0.0, 0.65, BY0 - 0.02, BY1 + 0.02, 0.88, 0.92, STONE, bevel=0.004)
box('FURN', 'splash', 0.0, 0.012, BY0, BY1, 0.92, 1.50, SPLASH)
box('FURN', 'overheads', 0.0, 0.36, BY0, BY1, 1.50, 2.25, CAB, bevel=0.003)
n = 7
for i in range(1, n):
    yy = BY0 + (BY1 - BY0) * i / n
    box('FURN', 'gap', 0.619, 0.624, yy - 0.002, yy + 0.002, 0.11, 0.87, KICK); box('FURN', 'gap', 0.359, 0.364, yy - 0.002, yy + 0.002, 1.51, 2.24, KICK)
box('FURN', 'cooktop', 0.08, 0.56, 3.55, 4.35, 0.92, 0.928, BLACK)
box('FURN', 'oven', 0.621, 0.628, 3.62, 4.28, 0.22, 0.80, BLACK)
IX0, IX1, IY0, IY1 = 3.43, 4.37, 2.40, 5.40
box('FURN', 'isl_kick', IX0 + 0.06, IX1 - 0.06, IY0 + 0.05, IY1 - 0.05, 0, 0.10, KICK)
box('FURN', 'island', IX0, IX1, IY0, IY1, 0.10, 0.88, CAB, bevel=0.003)
box('FURN', 'isl_top', IX0 - 0.05, IX1 + 0.05, IY0 - 0.05, IY1 + 0.05, 0.88, 0.92, STONE, bevel=0.004)
for yy in (IY0 - 0.05, IY1 + 0.01): box('FURN', 'waterfall', IX0 - 0.05, IX1 + 0.05, yy, yy + 0.04, 0, 0.88, STONE, bevel=0.004)
for i in range(1, 5):
    yy = IY0 + (IY1 - IY0) * i / 5; box('FURN', 'gap', IX0 - 0.004, IX0 + 0.001, yy - 0.002, yy + 0.002, 0.11, 0.87, KICK)
box('FURN', 'sink', IX0 + 0.12, IX0 + 0.56, 3.55, 4.30, 0.905, 0.924, STEEL)
cyl('FURN', 'tap', IX0 + 0.10, 3.92, 0.92, 1.22, 0.012, 0.012, BLACK, 12); box('FURN', 'tap_arm', IX0 + 0.10, IX0 + 0.30, 3.91, 3.93, 1.20, 1.22, BLACK)
cyl('FURN', 'fruit_bowl', 4.05, 4.85, 0.92, 0.99, 0.08, 0.16, CERAMIC, 28)
for i in range(4):
    yy = 2.85 + (4.95 - 2.85) * i / 3
    cyl('FURN', 'stool_seat', 4.78, yy, 0.63, 0.67, 0.17, 0.18, OAK, 28)
    for (lx, ly) in ((-1, -1), (1, -1), (-1, 1), (1, 1)): cyl('FURN', 'stool_leg', 4.78 + lx * 0.12, yy + ly * 0.12, 0, 0.63, 0.016, 0.012, BLACK, 8)
    cyl('FURN', 'stool_ring', 4.78, yy, 0.22, 0.235, 0.165, 0.165, BLACK, 20, caps=False)
PY0, PY1 = CY1, CY1 + 0.62
box('FURN', 'pantry', 2.4, CX1, PY0, PY1, 0, 2.3, CAB, bevel=0.003)
for i in range(1, 7):
    xx = 2.4 + (CX1 - 2.4) * i / 7; box('FURN', 'gap', xx - 0.002, xx + 0.002, PY1 - 0.001, PY1 + 0.004, 0.02, 2.28, KICK)
box('FURN', 'fridge', 4.22, 5.38, PY1, PY1 + 0.03, 0.03, 2.05, STEEL, bevel=0.004)
box('FURN', 'fridge_gap', 4.797, 4.803, PY1 + 0.029, PY1 + 0.033, 0.03, 2.05, KICK)
for xx in (4.74, 4.86): box('FURN', 'fridge_h', xx - 0.008, xx + 0.008, PY1 + 0.03, PY1 + 0.05, 0.9, 1.5, BLACK)
for yy in (3.2, 4.6):
    cyl('FURN', 'pendant', 3.9, yy, 1.72, 1.96, 0.15, 0.09, PEND, 32, caps=False)
    cyl('FURN', 'cord', 3.9, yy, 1.96, cz(yy), 0.004, 0.004, BLACK, 6)

# ---------- dining
TX, TY = 8.0, 3.4
box('FURN', 'table', TX - 0.525, TX + 0.525, TY - 1.2, TY + 1.2, 0.72, 0.765, OAK, bevel=0.008)
for (lx, ly) in ((-1, -1), (1, -1), (-1, 1), (1, 1)): box('FURN', 'tleg', TX + lx * 0.44 - 0.035, TX + lx * 0.44 + 0.035, TY + ly * 1.08 - 0.035, TY + ly * 1.08 + 0.035, 0, 0.72, OAK, bevel=0.004)
def chair(x, y, dx, dy):
    box('FURN', 'ch_seat', x - 0.22, x + 0.22, y - 0.22, y + 0.22, 0.42, 0.48, LINEN2, bevel=0.02)
    bx, by = x + 0.20 * dx, y + 0.20 * dy; hx, hy = (0.025, 0.22) if dx else (0.22, 0.025)
    box('FURN', 'ch_back', bx - hx, bx + hx, by - hy, by + hy, 0.48, 0.88, LINEN2, bevel=0.012)
    for (lx, ly) in ((-1, -1), (1, -1), (-1, 1), (1, 1)): cyl('FURN', 'ch_leg', x + lx * 0.18, y + ly * 0.18, 0, 0.42, 0.014, 0.011, BLACK, 8)
for i in range(3):
    yy = TY - 0.75 + 0.75 * i; chair(TX - 0.80, yy, -1, 0); chair(TX + 0.80, yy, 1, 0)
chair(TX, TY - 1.48, 0, -1); chair(TX, TY + 1.48, 0, 1)
cyl('FURN', 'vase', TX, TY, 0.765, 1.02, 0.065, 0.04, CERAMIC, 24)
def leaves(x, y, z, k, r, spread):
    for i in range(k):
        ang = i * 2.399; hh = z + spread * 0.9 * ((i % 4) / 3); rr = spread * (0.35 + 0.65 * ((i * 7) % 5) / 4)
        bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=1, radius=r)
        for v in bm.verts: v.co = Vector((v.co.x * 1.4, v.co.y, v.co.z * 0.8)) + Vector((x + rr * math.cos(ang), y + rr * math.sin(ang), hh))
        me = bpy.data.meshes.new('leaf'); bm.to_mesh(me); bm.free(); add('FURN', me, GREEN)
        cyl('FURN', 'stem', x + rr * 0.5 * math.cos(ang), y + rr * 0.5 * math.sin(ang), z - spread * 0.3, hh, 0.004, 0.003, GREEN, 6)
leaves(TX, TY, 1.12, 7, 0.055, 0.14)
cyl('FURN', 'dpend', TX, TY, 1.62, 1.92, 0.26, 0.12, PEND, 36, caps=False); cyl('FURN', 'cord', TX, TY, 1.92, cz(TY), 0.004, 0.004, BLACK, 6)

# ---------- family
def sofa(bx, by, ln, dp, facing, m=LINEN, c=LINEN2, seats=3):
    def lb(name, u0, u1, v0, v1, z0, z1, mm, bevel=0.03, seg=3):
        if facing == 'E': box('FURN', name, bx + v0, bx + v1, by + u0, by + u1, z0, z1, mm, bevel=bevel, seg=seg)
        else: box('FURN', name, bx + u0, bx + u1, by + v0, by + v1, z0, z1, mm, bevel=bevel, seg=seg)
    lb('sofa_base', 0, ln, 0, dp, 0.06, 0.30, m, 0.025, 2); lb('sofa_back', 0.195, ln - 0.195, 0, 0.20, 0.30, 0.80, m, 0.035)
    lb('sofa_arm', 0, 0.20, 0, dp, 0.30, 0.60, m, 0.035); lb('sofa_arm', ln - 0.20, ln, 0, dp, 0.30, 0.60, m, 0.035)
    cw = (ln - 0.40) / seats
    for i in range(seats):
        a = 0.20 + i * cw
        lb('seat', a + 0.006, a + cw - 0.006, 0.20, dp + 0.01, 0.30, 0.445, c, 0.04); lb('backc', a + 0.012, a + cw - 0.012, 0.19, 0.36, 0.44, 0.84, c, 0.06)
    for (u, v) in ((0.08, 0.08), (ln - 0.08, 0.08), (0.08, dp - 0.08), (ln - 0.08, dp - 0.08)):
        x, y = (bx + v, by + u) if facing == 'E' else (bx + u, by + v); cyl('FURN', 'sofa_leg', x, y, 0, 0.06, 0.02, 0.025, BLACK, 12)
    return lb
lb = sofa(9.50, 2.30, 2.40, 0.98, 'E'); lb('throw', 0.28, 0.70, 0.36, 0.50, 0.45, 0.85, TEAL, 0.06); lb('throw', 1.72, 2.12, 0.36, 0.49, 0.45, 0.82, RUST, 0.06)
lb = sofa(10.45, 0.12, 1.90, 0.95, 'N', seats=2); lb('throw', 0.30, 0.70, 0.36, 0.49, 0.45, 0.83, CHAR, 0.06)
box('FURN', 'rug', 10.0, 12.6, 1.7, 4.7, 0.0, 0.018, RUG, bevel=0.006)
cx, cy = 11.45, 3.3
box('FURN', 'ct_top', cx - 0.45, cx + 0.45, cy - 0.45, cy + 0.45, 0.31, 0.35, OAK, bevel=0.008)
box('FURN', 'ct_shelf', cx - 0.40, cx + 0.40, cy - 0.40, cy + 0.40, 0.10, 0.125, OAK, bevel=0.004)
for (lx, ly) in ((-1, -1), (1, -1), (-1, 1), (1, 1)): box('FURN', 'ct_leg', cx + lx * 0.40 - 0.025, cx + lx * 0.40 + 0.025, cy + ly * 0.40 - 0.025, cy + ly * 0.40 + 0.025, 0.018, 0.31, OAK, bevel=0.004)
box('FURN', 'book1', cx - 0.30, cx - 0.06, cy - 0.10, cy + 0.22, 0.35, 0.375, CERAMIC, bevel=0.004, rot=Matrix.Rotation(math.radians(12), 4, 'Z'))
box('FURN', 'book2', cx - 0.28, cx - 0.08, cy - 0.06, cy + 0.20, 0.375, 0.395, TEAL, bevel=0.004, rot=Matrix.Rotation(math.radians(-6), 4, 'Z'))
cyl('FURN', 'bowl', cx + 0.2, cy - 0.12, 0.35, 0.42, 0.07, 0.13, CERAMIC, 28)
ux1 = Wd - 0.02; ux0 = ux1 - 0.42
box('FURN', 'unit', ux0, ux1, 2.3, 4.5, 0.12, 0.50, OAK, bevel=0.006)
for yy in (3.03, 3.77): box('FURN', 'gap', ux0 - 0.001, ux0 + 0.004, yy - 0.003, yy + 0.003, 0.14, 0.48, BLACK)
for yy in (2.45, 4.35): box('FURN', 'unit_leg', ux0 + 0.05, ux1 - 0.05, yy - 0.02, yy + 0.02, 0, 0.12, BLACK)
box('FURN', 'tv', Wd - 0.035, Wd - 0.003, 2.72, 4.08, 0.86, 1.63, BLACK, bevel=0.004)
box('FURN', 'art_frame', 10.75, 12.05, 0.002, 0.03, 1.28, 2.08, BLACK, bevel=0.003); box('FURN', 'art', 10.80, 12.00, 0.03, 0.034, 1.33, 2.03, ART1)
cyl('FURN', 'pot', 12.2, 5.75, 0, 0.42, 0.17, 0.21, CERAMIC, 28); leaves(12.2, 5.75, 0.75, 24, 0.075, 0.36)
lx, ly = 9.75, 5.25
cyl('FURN', 'lamp_base', lx, ly, 0, 0.025, 0.15, 0.15, BLACK, 28); cyl('FURN', 'lamp_pole', lx, ly, 0.025, 1.45, 0.012, 0.012, BLACK, 12)
cyl('FURN', 'lamp_shade', lx, ly, 1.38, 1.68, 0.20, 0.15, PEND, 32, caps=False)

# ---------- alfresco setting
OX, OY = 2.6, AY0 + 1.6
box('FURN', 'otable', OX - 0.9, OX + 0.9, OY - 0.45, OY + 0.45, 0.72, 0.765, OAK, bevel=0.008)
for (lx, ly) in ((-1, -1), (1, -1), (-1, 1), (1, 1)): box('FURN', 'oleg', OX + lx * 0.8 - 0.03, OX + lx * 0.8 + 0.03, OY + ly * 0.36 - 0.03, OY + ly * 0.36 + 0.03, 0, 0.72, BLACK)
for s in (-1, 1):
    box('FURN', 'obench', OX - 0.8, OX + 0.8, OY + s * 0.78 - 0.17, OY + s * 0.78 + 0.17, 0.41, 0.45, OAK, bevel=0.006)
    for lx in (-0.7, 0.7): box('FURN', 'obleg', OX + lx - 0.025, OX + lx + 0.025, OY + s * 0.78 - 0.14, OY + s * 0.78 + 0.14, 0, 0.41, BLACK)
cyl('FURN', 'opot', 4.75, AY0 + 0.35, 0, 0.50, 0.19, 0.23, CHAR, 28); leaves(4.75, AY0 + 0.35, 0.85, 24, 0.075, 0.34)

# ---------- light: sun from the north (alfresco side), soft ceiling fills, sky
sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = float(os.environ.get('SUN', '6.0')); sun.angle = math.radians(1.2)
so = bpy.data.objects.new('sun', sun); sc.collection.objects.link(so); so.rotation_euler = (math.radians(-50), 0, math.radians(16))
for (fx_, fy_, e) in ((2.6, 3.9, 60), (7.6, 3.2, 60), (11.0, 2.6, 60), (8.6, 0.8, 22)):
    fill = bpy.data.lights.new('fill', 'AREA'); fill.energy = e * float(os.environ.get('FILL', '1.0')); fill.size = 2.4; fill.color = (1.0, 0.96, 0.9)
    fo = bpy.data.objects.new('fill', fill); sc.collection.objects.link(fo); fo.location = (fx_, fy_, cz(fy_) - 0.04)
wld = bpy.data.worlds.new('w'); wld.use_nodes = True; bg = wld.node_tree.nodes['Background']
bg.inputs[0].default_value = (0.55, 0.70, 0.95, 1); bg.inputs[1].default_value = 1.0; sc.world = wld
sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.use_denoising = True; sc.cycles.max_bounces = 5
sc.view_settings.view_transform = 'Standard'; sc.view_settings.exposure = 0.0; sc.view_settings.look = 'None'

if MODE == 'preview':
    sc.cycles.samples = 16; sc.render.resolution_x, sc.render.resolution_y = 660, 440; sc.render.image_settings.file_format = 'PNG'
    for nm, pos, look, fov in (('a', (9.3, 1.3, 1.5), (3.0, 4.9, 1.1), 78), ('b', (8.9, 0.7, 1.5), (11.7, 4.1, 1.0), 78), ('c', (2.2, 4.6, 1.5), (9.5, 2.6, 1.0), 85), ('d', (4.4, 9.0, 1.5), (5.5, 4.0, 1.2), 85)):
        cam = bpy.data.cameras.new(nm); cam.sensor_fit = 'HORIZONTAL'; cam.angle = math.radians(fov)
        co = bpy.data.objects.new(nm, cam); sc.collection.objects.link(co); co.location = pos
        co.rotation_euler = (Vector(look) - Vector(pos)).to_track_quat('-Z', 'Y').to_euler(); sc.camera = co
        sc.render.filepath = OUT + 'preview_' + nm + '.png'; bpy.ops.render.render(write_still=True)
else:
    sc.cycles.samples = int(os.environ.get('SPP', '32')); sc.render.bake.margin = 8
    vl = bpy.context.view_layer; GL = (os.environ.get('BAKE_GROUPS', 'ENV,FURN,ARCH')).split(',')
    for g in GL:
        for o in sc.collection.objects: o.select_set(False)
        for o in OBJS[g]: o.select_set(True)
        vl.objects.active = OBJS[g][0]; bpy.ops.object.join(); ob = vl.objects.active; ob.name = g
        if g == 'ARCH':   # drop faces nobody can see (outer skins, tops above the ceiling, undersides)
            bm = bmesh.new(); bm.from_mesh(ob.data)
            def hidden(c):
                north = c.y > Dp + T - 0.01
                if c.z < -0.02: return True
                if north: return c.z > HW + 0.19
                return c.z > cz(c.y) + 0.03 or c.x < -0.06 or c.x > Wd + 0.06 or c.y < -0.08 or (c.x < CX1 - 0.02 and c.y < CY1 - 0.02)
            bmesh.ops.delete(bm, geom=[f for f in bm.faces if hidden(f.calc_center_median())], context='FACES'); bm.to_mesh(ob.data); bm.free()
        bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.003, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
        bpy.ops.object.mode_set(mode='OBJECT'); OBJS[g] = [ob]
    for g in GL:
        ob = OBJS[g][0]
        for o in sc.collection.objects: o.select_set(False)
        ob.select_set(True); vl.objects.active = ob
        bpy.ops.object.bake(type='COMBINED', margin=8, use_clear=True)
        im = IMG[g]; s = ATLAS[g]; px = np.empty(s * s * 4, np.float32); im.pixels.foreach_get(px); np.save(OUT + 'atlas_' + g + '.npy', px.reshape(s, s, 4)[..., :3])
        me = ob.data; me.calc_loop_triangles(); uv = me.uv_layers.active.data; rows = []
        for t in me.loop_triangles:
            for li in t.loops:
                v = me.vertices[me.loops[li].vertex_index].co; rows += [v.x, v.y, v.z, uv[li].uv.x, uv[li].uv.y]
        np.array(rows, np.float32).tofile(OUT + 'mesh_' + g + '.bin'); print('BAKED', g, 'tris', len(me.loop_triangles), flush=True)
