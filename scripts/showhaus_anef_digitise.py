"""Digitise Sydney Airport's published ANEF contours into a small, clearly-approximate GeoJSON.

    python3 scripts/showhaus_anef_digitise.py [--pdf path/to/Section_03.pdf] [--out ../spatial-world-engine/data/anef/anef-sydney-approx.geojson]  (private; see that folder's README)
    (pip install pymupdf shapely numpy mapbox-vector-tile)

Source: Sydney Airport Master Plan 2045, Section 3 "Airport Planning Framework", page 163, Map 15-2
"ANEF 2045 and ANEF 2039". The contours are vector paths in the PDF (2039 = light-blue stroke, 2045 = dark-blue
stroke), so they are read straight out of the file, not traced by eye. They are georeferenced with an affine fit
from the three runways drawn on the same map to the runway centrelines in OpenStreetMap (OpenFreeMap tiles):
six runway ends -> six control points. The residuals (~100 m RMS) are recorded in the output.

This is NOT the official ANEF. The official contours are the ones endorsed by Airservices Australia and published
by Sydney Airport; this file is a SHOWHAUS approximation of a map figure, for context only. Never present it as
official, and never use it to say a home is inside or outside a contour when it is within the stated error of a
line (the noise card treats anything within `uncertainty_m` of a line as "near the line").
"""
from __future__ import annotations

import argparse
import json
import math
import os
import urllib.request

import numpy as np

PDF_URL = ("https://downloads.ctfassets.net/v228i5y5k0x4/7dPzn8WhzMJPJjsYa03YPp/718247286210425c7eb4ba23429af64b/"
           "SYD_Master_Plan_2045_Section_03_Airport_Planning_Framework_FA.pdf")
DOWNLOADS_PAGE = "https://www.sydneyairport.com.au/corporate/planning-and-projects/master-plan/master-plan-2045-downloads"
TILES = "https://tiles.openfreemap.org/planet/20261101_080013_pt/{z}/{x}/{y}.pbf"
UA = {"User-Agent": "showhaus-anef-digitise/0.1 (+https://github.com/in-c0/sydney-environmental-atlas)"}
PAGE = 21                      # 0-based: printed page 163 (spread 162-163)
MAP_X_MIN = 595                # Map 15-2 is the right half of the spread
STROKE = {"2039": (0.243, 0.612, 0.996), "2045": (0.082, 0.216, 0.345)}
RUNWAY_QUADS = {"16R/34L": (22428, ("16R/34L", "34L/16R")), "07/25": (22430, ("07/25",)), "16L/34R": (22432, ("16L/34R", "16L"))}
LEVELS = (20, 25, 30, 35)      # nested contours, outermost first (labels on the map: 20 outermost)
LAT0, LON0 = -33.94, 151.18
KX, KY = 111320 * math.cos(math.radians(LAT0)), 110540


def xy(lon, lat):
    return ((lon - LON0) * KX, (lat - LAT0) * KY)


def lonlat(x, y):
    return (LON0 + x / KX, LAT0 + y / KY)


def osm_runways(cache):
    if os.path.exists(cache):
        return json.load(open(cache))
    import mapbox_vector_tile
    z = 14

    def tile(lon, lat):
        n = 2 ** z
        return int((lon + 180) / 360 * n), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    (x0, y0), (x1, y1) = tile(151.15, -33.92), tile(151.20, -33.97)
    out = []
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            raw = urllib.request.urlopen(urllib.request.Request(TILES.format(z=z, x=x, y=y), headers=UA), timeout=60).read()
            layer = mapbox_vector_tile.decode(raw).get("aeroway", {})
            ext = layer.get("extent", 4096)
            for f in layer.get("features", []):
                if f["properties"].get("class") != "runway" or f["geometry"]["type"] != "LineString":
                    continue
                pts = []
                for px, py in f["geometry"]["coordinates"]:
                    n = 2 ** z
                    yy = (y + 1 - py / ext) / n
                    pts.append([(x + px / ext) / n * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy))))])
                out.append({"ref": f["properties"].get("ref"), "pts": pts})
    json.dump(out, open(cache, "w"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", default=".cache/syd-mp2045-s3.pdf")
    ap.add_argument("--out", default=os.environ.get("SHOWHAUS_ANEF") or os.path.join(os.path.dirname(__file__), "..", "..", "spatial-world-engine", "data", "anef", "anef-sydney-approx.geojson"))
    ap.add_argument("--tolerance-m", type=float, default=20.0)
    a = ap.parse_args()
    import pymupdf
    from shapely.geometry import Polygon, mapping

    os.makedirs(os.path.dirname(a.pdf) or ".", exist_ok=True)
    if not os.path.exists(a.pdf):
        urllib.request.urlretrieve(PDF_URL, a.pdf)
    page = pymupdf.open(a.pdf)[PAGE]
    drawings = page.get_drawings()

    def quad_pts(i):
        pts = []
        for it in drawings[i]["items"]:
            if it[0] == "l":
                pts += [it[1], it[2]]
            elif it[0] == "qu":
                q = it[1]
                pts += [q.ul, q.ur, q.lr, q.ll]
        return np.array([(p.x, p.y) for p in pts])

    def axis_ends(pts):
        c = pts.mean(0)
        _, _, vt = np.linalg.svd(pts - c)
        t = (pts - c) @ vt[0]
        return pts[t < np.percentile(t, 30)].mean(0), pts[t > np.percentile(t, 70)].mean(0)

    rw = osm_runways(os.path.join(os.path.dirname(a.pdf) or ".", "syd-runways-osm.json"))
    pairs = []
    for name, (qid, refs) in RUNWAY_QUADS.items():
        p0, p1 = axis_ends(quad_pts(qid))
        g = np.array([xy(*q) for r in rw if r["ref"] in refs for q in r["pts"]])
        c = g.mean(0)
        _, _, vt = np.linalg.svd(g - c)
        t = (g - c) @ vt[0]
        g0, g1 = g[t.argmin()], g[t.argmax()]
        # page y grows downward: the page end with the smaller y is the ground end further north (larger y);
        # 07/25 is nearly east-west, so it is matched on x instead.
        if name == "07/25":
            if (p0[0] < p1[0]) != (g0[0] < g1[0]):
                g0, g1 = g1, g0
        elif (p0[1] < p1[1]) != (g0[1] > g1[1]):
            g0, g1 = g1, g0
        pairs += [(name, p0, g0), (name, p1, g1)]
    P = np.array([[*p, 1.0] for _, p, _ in pairs])
    G = np.array([g for _, _, g in pairs])
    A, *_ = np.linalg.lstsq(P, G, rcond=None)
    res = np.hypot(*(P @ A - G).T)
    rms = float(np.sqrt((res ** 2).mean()))

    def to_ll(x, y):
        gx, gy = np.array([x, y, 1.0]) @ A
        return lonlat(gx, gy)

    def path_pts(d):
        out = []
        for it in d["items"]:
            if it[0] == "l":
                out += [(it[1].x, it[1].y), (it[2].x, it[2].y)]
            elif it[0] == "c":   # Bézier: endpoints are enough at this scale (control points sit within ~1 pt)
                out += [(it[1].x, it[1].y), (it[4].x, it[4].y)]
        return [out[0]] + [q for k, q in enumerate(out[1:]) if q != out[k]]

    features = []
    for year, colour in STROKE.items():
        polys = []
        for d in drawings:
            col = tuple(round(v, 3) for v in (d.get("color") or ()))
            if d["type"] == "s" and d["rect"].x0 >= MAP_X_MIN and col == colour and len(d["items"]) > 500:
                ring = [xy(*to_ll(x, y)) for x, y in path_pts(d)]
                polys.append(Polygon(ring).buffer(0))
        polys.sort(key=lambda p: -p.area)
        if len(polys) != len(LEVELS):
            raise SystemExit(f"ANEF {year}: expected {len(LEVELS)} closed contours, found {len(polys)}")
        for poly, level in zip(polys, LEVELS):
            simple = poly.simplify(a.tolerance_m, preserve_topology=True)
            ring = [[round(v, 5) for v in lonlat(x, y)] for x, y in simple.exterior.coords]
            features.append({"type": "Feature",
                             "properties": {"anef": level, "year": int(year), "label": f"ANEF {year} {level} (approx.)",
                                            "area_km2_approx": round(poly.area / 1e6, 1)},
                             "geometry": {"type": "Polygon", "coordinates": [ring]}})

    out = {
        "type": "FeatureCollection",
        "name": "Sydney Airport ANEF contours — approximate (digitised by SHOWHAUS)",
        "status": "approx.",
        "official": False,
        "notice": ("Approximate. Digitised by SHOWHAUS from a map figure in Sydney Airport's Master Plan 2045; not the "
                   "official ANEF. Use the endorsed ANEF published by Sydney Airport / Airservices Australia for any decision."),
        "source": {
            "document": "Sydney Airport Master Plan 2045 — Section 3 Airport Planning Framework, p. 163, Map 15-2 'ANEF 2045 and ANEF 2039'",
            "publisher": "Sydney Airport Corporation",
            "url": PDF_URL,
            "downloads_page": DOWNLOADS_PAGE,
            "retrieved": "2026-11-10",
            "note": "The document text describes ANEF 2045 as contained in the draft Master Plan 2045; ANEF 2039 is the contour the Arncliffe Central EIS (2021) assessed against.",
        },
        "method": {
            "contours": "vector paths read from the PDF (no tracing by eye); 2039 = light-blue stroke, 2045 = dark-blue stroke; levels assigned by nesting (outermost = ANEF 20)",
            "georeference": "affine fit, 6 control points = the ends of runways 16R/34L, 07/25 and 16L/34R on the map vs. OpenStreetMap runway centrelines (OpenFreeMap tiles, ODbL)",
            "control_residuals_m": [round(float(r)) for r in res],
            "rms_m": round(rms),
            "simplified_m": a.tolerance_m,
            "uncertainty_m": int(math.ceil((2 * rms + a.tolerance_m + 40) / 50.0) * 50),   # 2×RMS + simplification + line width at map scale
            "script": "scripts/showhaus_anef_digitise.py",
        },
        "features": features,
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {a.out}: {len(features)} contours, control RMS {rms:.0f} m, {os.path.getsize(a.out) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
