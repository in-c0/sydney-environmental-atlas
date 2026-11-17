"""Floor-plan image -> rooms in metres, CPU only (OpenCV + Tesseract). A measured first step toward plan JSON.

  python3 read_plan.py <plan.png> [--debug out.png] [--json out.json]

1. Walls: dark pixels, opened with a square kernel so thin lines (furniture, hatching, text) drop out and thick walls stay.
2. Rooms: free space between walls with door gaps closed (walls dilated), split into connected regions, grown back.
3. Labels: Tesseract word boxes; a room label is "NAME" with "W x D" under it (Australian builder plans print internal
   room sizes in metres). Each size label is matched to the region it sits in.
4. Scale: pixels per metre = median over rooms of region size / labelled size (both axes, both orientations tried).
5. Accuracy: every room's size measured from pixels with the scale fitted on the OTHER rooms (leave-one-out),
   compared with its printed size. Printed sizes are rounded to 0.1 m, so 0.05 m error is the floor.
No network, no API: everything runs on the CPU.
"""
import sys, re, json, argparse, statistics as st
import cv2, numpy as np, pytesseract

def walls_mask(gray):
    dark = (gray < 110).astype(np.uint8)
    k = max(3, round(min(gray.shape) / 330))           # ~3 px on a 1000 px plan: thinner than internal walls, thicker than lines
    return cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((k, k), np.uint8)), k

def footprint(walls):
    """The house outline: walls closed across window and door openings (up to ~2.5 m), outer contour filled."""
    span = max(31, round(min(walls.shape) / 10)) | 1
    shut = cv2.morphologyEx(walls, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (span, span)))
    cs, _ = cv2.findContours(shut, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    fp = np.zeros_like(walls); cv2.drawContours(fp, [max(cs, key=cv2.contourArea)], -1, 1, -1)
    return fp

def rooms(walls, gap, fp=None):
    closed = cv2.dilate(walls, np.ones((gap, gap), np.uint8))
    free = (1 - closed).astype(np.uint8)
    if fp is not None: free &= fp
    n, lab, stats, _ = cv2.connectedComponentsWithStats(free, 4)
    h, w = walls.shape; out = []
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        if x == 0 or y == 0 or x + bw >= w or y + bh >= h: continue      # outside the house
        if area < 0.0008 * w * h: continue
        out.append({'id': i, 'px': [int(x - gap // 2), int(y - gap // 2), int(bw + gap // 2 * 2), int(bh + gap // 2 * 2)], 'fill': round(area / (bw * bh), 2)})
    return out, lab

GAP_K = int(__import__("os").environ.get("GAP_K", "15"))
PAIR = re.compile(r'(\d{1,2}\.?\d)[xX×](\d{1,2}\.?\d)')
def num(t):  # "42" -> 4.2 (the dot is often lost by OCR at this size); "12.5" stays
    return float(t) if '.' in t else float(t[:-1] + '.' + t[-1])
def ocr_words(gray, fx):
    big = cv2.resize(gray, None, fx=fx, fy=fx, interpolation=cv2.INTER_CUBIC)
    d = pytesseract.image_to_data(big, config='--psm 11', output_type=pytesseract.Output.DICT)
    return [{'t': d['text'][i].strip(), 'x': d['left'][i] / fx, 'y': d['top'][i] / fx, 'w': d['width'][i] / fx, 'h': d['height'][i] / fx}
            for i in range(len(d['text'])) if d['text'][i].strip()]
def labels(gray):
    """Room size labels "W x D" (metres) with the room name above. Tesseract at two scales, words joined per line."""
    out = []
    for fx in (2, 3):
        words = sorted(ocr_words(gray, fx), key=lambda w: (round(w['y'] / 6), w['x']))
        names = [w for w in words if re.match(r"^[A-Z][A-Z'’]{1,}$", w['t'])]
        used = set()
        for i, a in enumerate(words):
            if i in used or not re.match(r'^\d', a['t']): continue
            line, j = [a], i + 1   # neighbours on the same line, close together
            while j < len(words) and abs(words[j]['y'] - a['y']) < a['h'] * 0.8 and words[j]['x'] - (line[-1]['x'] + line[-1]['w']) < a['h'] * 1.5: line.append(words[j]); j += 1
            text = re.sub(r'[:\s]', '', ''.join(w['t'] for w in line)).replace('%', 'x')
            m = PAIR.search(text)
            if not m: continue
            used.update(range(i, j))
            x0, x1 = line[0]['x'], line[-1]['x'] + line[-1]['w']; cx, cy = (x0 + x1) / 2, a['y'] + a['h'] / 2
            above = [w for w in names if 0 < cy - w['y'] < 3 * w['h'] + 8 and abs(w['x'] + w['w'] / 2 - cx) < 50]
            L = {'w': num(m[1]), 'd': num(m[2]), 'x': cx, 'y': cy, 'name': min(above, key=lambda w: cy - w['y'])['t'] if above else '?'}
            if 0.5 <= L['w'] <= 15 and 0.5 <= L['d'] <= 15 and not any(abs(o['x'] - cx) < 25 and abs(o['y'] - cy) < 10 for o in out): out.append(L)
    return out

def ray_size(walls, x, y, fp):
    """Room size around a label by casting rays to the nearest wall: median over parallel rays offset across the room,
    so one door or window on one ray does not decide it. Returns (width px, height px)."""
    h, w = walls.shape; x, y = int(x), int(y)
    def run(x0, y0, dx, dy):
        n = 0
        while 0 <= x0 < w and 0 <= y0 < h and not walls[y0, x0] and fp[y0, x0]: x0 += dx; y0 += dy; n += 1
        return n if 0 <= x0 < w and 0 <= y0 < h and walls[y0, x0] else None
    def span(horiz):
        vals = []
        for off in range(-24, 25, 4):
            a = run(x, y + off, -1, 0) if horiz else run(x + off, y, 0, -1)
            b = run(x, y + off, 1, 0) if horiz else run(x + off, y, 0, 1)
            if a is not None and b is not None: vals.append(a + b)
        if not vals: return None
        vals.sort(); top = vals[len(vals) // 2:]   # the longer half: rays that slipped under furniture text are not shorter
        return st.median(top)
    return span(True), span(False)

def fit(pairs):
    """pairs: (region w px, region h px, label w m, label d m) -> px per metre (median, orientation chosen per room)."""
    ks = []
    for pw, ph, lw, ld in pairs:
        a = [pw / lw, ph / ld]; b = [pw / ld, ph / lw]
        ks.extend(a if abs(a[0] - a[1]) <= abs(b[0] - b[1]) else b)
    return st.median(ks) if ks else None

def read(path):
    gray = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    W, k = walls_mask(gray)
    regs, lab = rooms(W, gap=GAP_K * k + 1, fp=footprint(W))   # closes door openings (~0.9-1.1 m) without merging rooms
    L = labels(gray)
    matched = []
    for l in L:
        x, y = int(l['x']), int(l['y'])
        if not (0 <= y < lab.shape[0] and 0 <= x < lab.shape[1]): continue
        rid = lab[y, x]
        r = next((r for r in regs if r['id'] == rid), None)
        if r is None:   # the label sits on a wall-ish pixel: take the region whose box contains it and is smallest
            cand = [r for r in regs if r['px'][0] <= x <= r['px'][0] + r['px'][2] and r['px'][1] <= y <= r['px'][1] + r['px'][3]]
            r = min(cand, key=lambda r: r['px'][2] * r['px'][3]) if cand else None
        if r: matched.append({**l, 'region': r})
    FP = footprint(W)
    for m in (matched if __import__('os').environ.get('MEASURE') == 'ray' else []):   # experimental: rays from the label (worse, 17 Nov)
        rw, rh = ray_size(W, m['x'], m['y'], FP)
        if rw and rh: m['region'] = {**m['region'], 'px': [0, 0, rw, rh], 'fill': 1.0}
        else: m['region'] = {**m['region'], 'fill': 0}
    rows = []
    for i, m in enumerate(matched):
        others = [(o['region']['px'][2], o['region']['px'][3], o['w'], o['d']) for j, o in enumerate(matched) if j != i and o['region']['fill'] > 0.8]
        s = fit(others)
        if not s: continue
        pw, ph = m['region']['px'][2] / s, m['region']['px'][3] / s
        a = (abs(pw - m['w']), abs(ph - m['d'])); b = (abs(pw - m['d']), abs(ph - m['w']))
        e = a if max(a) <= max(b) else b
        rows.append({'room': m['name'], 'printed': [m['w'], m['d']], 'measured': [round(pw, 2), round(ph, 2)], 'err': round(max(e), 2), 'rect_fill': m['region']['fill']})
    return {'px_per_m': fit([(m['region']['px'][2], m['region']['px'][3], m['w'], m['d']) for m in matched if m['region']['fill'] > 0.8]),
            'labels_read': len(L), 'rooms_matched': len(matched), 'rooms': rows}, W, regs

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('png'); ap.add_argument('--debug'); ap.add_argument('--json'); a = ap.parse_args()
    res, W, regs = read(a.png)
    errs = [r['err'] for r in res['rooms']]
    res['summary'] = {'median_err_m': st.median(errs) if errs else None, 'within_0_15m': f"{sum(e <= 0.15 for e in errs)}/{len(errs)}", 'within_0_30m': f"{sum(e <= 0.30 for e in errs)}/{len(errs)}"}
    print(json.dumps(res['summary']), 'px/m', res['px_per_m'] and round(res['px_per_m'], 1), 'labels', res['labels_read'], 'matched', res['rooms_matched'])
    for r in res['rooms']: print(f"  {r['room']:<8} printed {r['printed'][0]:>4} x {r['printed'][1]:<4} measured {r['measured'][0]:>5} x {r['measured'][1]:<5} err {r['err']:.2f} fill {r['rect_fill']}")
    if a.json: json.dump(res, open(a.json, 'w'), indent=1)
    if a.debug:
        img = cv2.cvtColor(cv2.imread(a.png, cv2.IMREAD_GRAYSCALE), cv2.COLOR_GRAY2BGR); img[W > 0] = (40, 40, 200)
        for r in regs: x, y, w, h = r['px']; cv2.rectangle(img, (x, y), (x + w, y + h), (0, 160, 0), 1)
        cv2.imwrite(a.debug, img)
