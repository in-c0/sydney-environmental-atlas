"""Baked Avalon scene -> site3/ (atlas_<G>.jpg + room.js with meshes, walk areas, plan outline, viewpoints). three.js coords (x, z, -y)."""
import base64, json, os, numpy as np
from PIL import Image
B = '/home/claude/showhaus/avroom/'; S = '/home/claude/showhaus/site3/'; os.makedirs(S, exist_ok=True)
def srgb(x):
    x = np.clip(x * float(os.environ.get('GAIN', '1.08')), 0, 1); return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)
out = {'groups': {}}
for g in ('ARCH', 'FURN', 'ENV'):
    atlas = np.load(B + 'atlas_' + g + '.npy'); img8 = (srgb(atlas) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(img8[::-1]).save(S + 'atlas_' + g + '.jpg', 'JPEG', quality=88)
    m = np.fromfile(B + 'mesh_' + g + '.bin', np.float32).reshape(-1, 3, 5)
    mesh = np.concatenate([np.stack([m[..., 0], m[..., 2], -m[..., 1]], -1), m[..., 3:]], -1).astype(np.float32)
    out['groups'][g] = {'atlas': 'atlas_' + g + '.jpg', 'mesh': base64.b64encode(mesh.tobytes()).decode(), 'tris': int(len(m))}
    print(g, 'tris', len(m), 'atlas KB', os.path.getsize(S + 'atlas_' + g + '.jpg') // 1024)
p = 0.18; AY0 = 6.41
solid = [[0, 1.75, 0.65, 6.05], [3.38, 2.35, 4.96, 5.45], [2.4, 1.4, 6.6, 2.02], [6.95, 1.70, 9.05, 5.10], [9.5, 2.3, 10.48, 4.7], [10.45, 0.12, 12.35, 1.07],
         [11.0, 2.85, 11.9, 3.75], [12.26, 2.3, 12.7, 4.5], [11.99, 5.54, 12.41, 5.96], [9.6, 5.1, 9.9, 5.4], [1.7, 7.06, 3.5, 8.96], [4.52, 6.53, 4.98, 6.99]]
out['solid'] = solid
out['boxes'] = [[a - p, b - p, c + p, d + p] for a, b, c, d in solid]
out['walk'] = [[0.25, 1.65, 12.45, 6.05], [6.85, 0.25, 12.45, 1.70], [0.85, 6.0, 4.55, 6.75], [-0.05, 6.70, 4.95, 9.15]]
out['plan'] = {'room': [[0, 1.4], [6.6, 1.4], [6.6, 0], [12.7, 0], [12.7, 6.3], [0, 6.3]], 'alfresco': [-0.3, AY0, 5.2, AY0 + 3.0],
               'openings': [[0.6, 4.8], [6.2, 8.8], [9.6, 12.2]]}
out['views'] = [
    {'name': 'Kitchen', 'pos': [5.7, 4.3], 'look': [1.6, 3.6], 'pitch': -0.10},
    {'name': 'Dining', 'pos': [6.1, 5.5], 'look': [8.6, 3.0], 'pitch': -0.14},
    {'name': 'Family', 'pos': [10.7, 5.6], 'look': [11.9, 2.3], 'pitch': -0.16},
    {'name': 'Alfresco', 'pos': [0.4, 9.0], 'look': [4.2, 5.4], 'pitch': -0.04},
    {'name': 'Photo 1', 'pos': [9.3, 1.3], 'look': [3.0, 4.9], 'pitch': -0.055, 'photo': 'photo1.jpg'},
    {'name': 'Photo 2', 'pos': [8.9, 0.7], 'look': [11.7, 4.1], 'pitch': -0.113, 'photo': 'photo2.jpg'}]
out['listing'] = {'claimed': False, 'source': 'plan'}   # source: 'plan' = published floor plan, 'estimate' = satellite imagery + world model
open(S + 'room.js', 'w').write('window.ROOM=' + json.dumps(out) + ';')
for i, n in ((1, 'photo_c1.png'), (2, 'photo_c2.png')): Image.open('/home/claude/showhaus/' + n).convert('RGB').save(S + 'photo%d.jpg' % i, 'JPEG', quality=88)
print('room.js MB', round(os.path.getsize(S + 'room.js') / 1e6, 2), Image.open(S + 'photo1.jpg').size)
