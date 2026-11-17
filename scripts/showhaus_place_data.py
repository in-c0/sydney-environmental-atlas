#!/usr/bin/env python3
"""Compact lookups the Worker's address pages (src/place.js) read on every request, built from the same files the map uses.

  dist/showhaus/data/rents.json + places.json → dist/showhaus/data/place-lookup.json
    suburbs: [name, postcode, lat, lng] (NSW, from places.json)
    rent:    {postcode: {all, units, houses, b0..b4: [n, median, q1, q3]}}  (NSW Fair Trading bonds, last 12 months)
    months:  [first, last] YYYYMM, built: rents.json generatedAt
Medians use the same interpolated quantile as lib/core.js, so a page and the map agree to the dollar.
Run after scripts/showhaus_build_data.py: python3 scripts/showhaus_place_data.py
"""
import json, math, os
from collections import defaultdict
D = os.path.join(os.path.dirname(__file__), '..', 'dist', 'showhaus', 'data')

def q(v, p):
    if not v: return None
    pos = (len(v) - 1) * p; lo, hi = math.floor(pos), math.ceil(pos)
    x = v[lo] + (v[hi] - v[lo]) * (pos - lo)
    return int(math.floor(x + 0.5))  # Math.round

def stat(v):
    v = sorted(v)
    return [len(v), q(v, .5), q(v, .25), q(v, .75)]

def main():
    R = json.load(open(os.path.join(D, 'rents.json')))
    P = json.load(open(os.path.join(D, 'places.json')))
    g = defaultdict(lambda: defaultdict(list))
    for pc, t, b, w in zip(R['pc'], R['t'], R['b'], R['w']):
        k = R['postcodes'][pc]; g[k]['all'].append(w)
        if t == 0: g[k]['units'].append(w)
        if t == 1: g[k]['houses'].append(w)
        if b is not None and b >= 0: g[k]['b%d' % min(b, 4)].append(w)
    rent = {str(k): {kk: stat(vv) for kk, vv in d.items()} for k, d in g.items()}
    out = {'built': R['generatedAt'], 'months': [R['months'][0], R['months'][-1]], 'source': R['sources'][0],
           'suburbs': [[s[0], s[1], s[2], s[3]] for s in P['suburbs']], 'rent': rent}
    p = os.path.join(D, 'place-lookup.json')
    json.dump(out, open(p, 'w'), separators=(',', ':'))
    print(p, os.path.getsize(p) // 1024, 'KB', len(rent), 'postcodes')

if __name__ == '__main__':
    main()
