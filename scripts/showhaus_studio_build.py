#!/usr/bin/env python3
"""SHOWHAUS Studio — build the recorded evidence file for one walkthrough project.

  python3 scripts/showhaus_studio_build.py arncliffe-central

Reads   showhaus/studio/<slug>.source.json   (figures copied from the public planning documents, with URLs)
Writes  dist/showhaus/studio/data/<slug>.json (towers, nearby OSM buildings, road distance, planning controls,
                                                 terrain, and the view analysis per tower / level / aspect)

Network sources (all public, no key): OpenFreeMap vector tiles (OpenStreetMap, ODbL), Mapzen/AWS Terrain Tiles
(terrarium, SRTM-derived), NSW Planning EPI_Primary_Planning_Layers (CC BY). Everything fetched is recorded
with its URL pattern and the fetch date. Nothing here is measured by SHOWHAUS; views are computed estimates.

Deps: pip install mapbox-vector-tile shapely pillow
"""
import gzip, io, json, math, sys, time, urllib.parse, urllib.request
from datetime import date
from pathlib import Path

import mapbox_vector_tile
from PIL import Image
from shapely.geometry import LineString, Point, Polygon, shape
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parent.parent
UA = {"User-Agent": "showhaus-studio-build/1.0 (+https://showhaus.app)", "Referer": "https://showhaus.app/"}
TILES = "https://tiles.openfreemap.org/planet/20261101_080013_pt/{z}/{x}/{y}.pbf"
DEM = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png"
EPI = "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/EPI_Primary_Planning_Layers/MapServer"
R_EARTH = 6371008.8
CLUTTER_M = 8.0  # conservative floor for unmapped houses / trees on land


def get(url, tries=3):
    for i in range(tries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(2 + 2 * i)


def tile_xy(lon, lat, z):
    n = 2 ** z
    return int((lon + 180) / 360 * n), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)


def tile_lonlat(x, y, z, px, py, ext):
    n = 2 ** z
    lon = (x + px / ext) / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + py / ext) / n))))
    return lon, lat


class Local:
    """Equirectangular metres around a reference point (good to <0.1 % over 15 km)."""

    def __init__(self, lon0, lat0):
        self.lon0, self.lat0 = lon0, lat0
        self.kx = math.pi / 180 * R_EARTH * math.cos(math.radians(lat0))
        self.ky = math.pi / 180 * R_EARTH

    def xy(self, lon, lat):
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)

    def ll(self, x, y):
        return (self.lon0 + x / self.kx, self.lat0 + y / self.ky)


def vector_tiles(bbox, z=14):
    x0, y1 = tile_xy(bbox[0], bbox[1], z)
    x1, y0 = tile_xy(bbox[2], bbox[3], z)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            raw = get(TILES.format(z=z, x=x, y=y))
            try:
                raw = gzip.decompress(raw)
            except OSError:
                pass
            yield x, y, z, mapbox_vector_tile.decode(raw, default_options={"y_coord_down": True})


def rings_of(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


class Terrain:
    def __init__(self, bbox, z=13):
        self.z, self.img = z, {}
        x0, y1 = tile_xy(bbox[0], bbox[1], z)
        x1, y0 = tile_xy(bbox[2], bbox[3], z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                self.img[(x, y)] = Image.open(io.BytesIO(get(DEM.format(z=z, x=x, y=y)))).convert("RGB")

    def at(self, lon, lat):
        n = 2 ** self.z
        fx = (lon + 180) / 360 * n
        fy = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
        im = self.img.get((int(fx), int(fy)))
        if im is None:
            return None
        px, py = min(255, int((fx % 1) * 256)), min(255, int((fy % 1) * 256))
        r, g, b = im.getpixel((px, py))
        return r * 256 + g + b / 256 - 32768


def epi_query(layer, lon, lat):
    q = urllib.parse.urlencode({"geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "inSR": 4326,
                                "spatialRel": "esriSpatialRelIntersects", "outFields": "*", "returnGeometry": "false", "f": "json"})
    url = f"{EPI}/{layer}/query?{q}"
    try:
        feats = json.loads(get(url)).get("features", [])
    except Exception:  # noqa: BLE001
        return {"status": "unavailable", "url": url}
    keep = ("EPI_NAME", "LAY_CLASS", "SYM_CODE", "MAX_B_H", "UNITS", "FSR", "H_NAME", "SIG", "CURRENCY_DATE", "AMENDMENT")
    out = []
    for f in feats:
        a = {k: v for k, v in f["attributes"].items() if k in keep and v not in (None, "")}
        if "CURRENCY_DATE" in a and isinstance(a["CURRENCY_DATE"], (int, float)):
            a["CURRENCY_DATE"] = time.strftime("%Y-%m-%d", time.gmtime(a["CURRENCY_DATE"] / 1000))
        out.append(a)
    return {"status": "ok", "features": out, "url": url}


def main(slug):
    src = json.loads((ROOT / "showhaus/studio" / f"{slug}.source.json").read_text())
    towers = src["towers"]
    allpts = [p for t in towers for p in t["footprint"]]
    lon0 = sum(p[0] for p in allpts) / len(allpts)
    lat0 = sum(p[1] for p in allpts) / len(allpts)
    loc = Local(lon0, lat0)
    targets = src["view_targets"]
    tlons = [p[0] for t in targets for p in t["points"]] + [lon0]
    tlats = [p[1] for t in targets for p in t["points"]] + [lat0]
    bbox = (min(tlons) - .01, min(tlats) - .01, max(tlons) + .01, max(tlats) + .01)

    # ---- OSM buildings (OpenFreeMap) ----
    print("tiles…", file=sys.stderr)
    seen, buildings, roads = set(), [], []
    near_r = src.get("context_radius_m", 650)
    site_poly = Polygon([loc.xy(*p) for p in src["site"]["boundary"]])
    for x, y, z, t in vector_tiles(bbox):
        ext = 4096
        for f in t.get("building", {}).get("features", []):
            h = f["properties"].get("render_height")
            hmin = f["properties"].get("render_min_height", 0) or 0
            fid = f.get("id")
            for poly in rings_of(f["geometry"]):
                ring = [loc.xy(*tile_lonlat(x, y, z, px, py, ext)) for px, py in poly[0]]
                if len(ring) < 3:
                    continue
                P = Polygon(ring)
                if not P.is_valid or P.area < 4:
                    continue
                key = (fid, round(P.centroid.x), round(P.centroid.y))
                if key in seen:
                    continue
                seen.add(key)
                if site_poly.intersection(P).area > 0.5 * P.area:
                    continue  # demolished site buildings never count
                buildings.append({"id": fid, "h": float(h) if h else None, "hmin": float(hmin), "poly": P})
        if x == tile_xy(lon0, lat0, z)[0] and y == tile_xy(lon0, lat0, z)[1] or True:
            for f in t.get("transportation", {}).get("features", []):
                p = f["properties"]
                if p.get("class") not in ("motorway", "trunk", "primary") or p.get("brunnel") == "tunnel":
                    continue
                g = f["geometry"]
                lines = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"] if g["type"] == "MultiLineString" else []
                for ln in lines:
                    pts = [loc.xy(*tile_lonlat(x, y, z, px, py, ext)) for px, py in ln]
                    if len(pts) > 1:
                        L = LineString(pts)
                        if L.distance(Point(0, 0)) < 1500:
                            roads.append({"cls": p["class"], "line": L})
        names = []
        for f in t.get("transportation_name", {}).get("features", []):
            p = f["properties"]
            if p.get("class") in ("motorway", "trunk", "primary") and p.get("name"):
                g = f["geometry"]
                lines = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"] if g["type"] == "MultiLineString" else []
                for ln in lines:
                    pts = [loc.xy(*tile_lonlat(x, y, z, px, py, ext)) for px, py in ln]
                    if len(pts) > 1:
                        names.append({"name": p["name"], "cls": p["class"], "line": LineString(pts)})
        for r in roads:
            if "name" not in r:
                best = min(names, key=lambda n: n["line"].distance(r["line"].interpolate(.5, normalized=True)), default=None)
                if best and best["line"].distance(r["line"].interpolate(.5, normalized=True)) < 25:
                    r["name"] = best["name"]
    with_h = [b for b in buildings if b["h"] and b["h"] > 2]
    print(f"buildings {len(buildings)} (with height {len(with_h)}), road segments {len(roads)}", file=sys.stderr)

    # ---- terrain ----
    print("terrain…", file=sys.stderr)
    terr = Terrain(bbox)
    site_ground_dem = terr.at(lon0, lat0)

    # ---- towers in local metres ----
    T = []
    for t in towers:
        poly = Polygon([loc.xy(*p) for p in t["footprint"]])
        T.append({**t, "poly": poly})

    # ---- view analysis ----
    tree = STRtree([b["poly"] for b in with_h])

    def obstruction(x, y):
        """Max building top (m above its ground) at local point, or 0."""
        top = 0.0
        for i in tree.query(Point(x, y)):
            b = with_h[int(i)]
            if b["poly"].contains(Point(x, y)):
                top = max(top, b["h"])
        return top

    def line_clear(ex, ey, ez_amsl, tlon, tlat, tz_amsl, skip_polys):
        tx, ty = loc.xy(tlon, tlat)
        d = math.hypot(tx - ex, ty - ey)
        if d < 1:
            return True, None
        s = 4.0
        first_block = None
        while s < d - 30:
            f = s / d
            x, y = ex + (tx - ex) * f, ey + (ty - ey) * f
            curve = s * (d - s) / (2 * R_EARTH) * 0.87  # earth curvature + standard refraction
            ray = ez_amsl + (tz_amsl - ez_amsl) * f - curve
            lon, lat = loc.ll(x, y)
            g = terr.at(lon, lat)
            if g is None:
                return None, "outside terrain tiles"
            if any(p.contains(Point(x, y)) for p in skip_polys):
                top = g + max(tp for tp, p in skip_polys_h if p.contains(Point(x, y)))
            else:
                top = g + obstruction(x, y)
            # Unmapped houses and street trees: on land, assume at least CLUTTER_M above ground beyond the first 20 m.
            if g > 0.5 and s > 20:
                top = max(top, g + CLUTTER_M)
            if top > ray:
                first_block = ("terrain" if top - g < 1 else "building", round(s))
                return False, first_block
            s += 6 if s < 600 else 20 if s < 3000 else 45
        return True, None

    levels_out = []
    f2f = src["floor_to_floor_m_est"]
    for ti, t in enumerate(T):
        others = [(o["height_m_est"], o["poly"]) for oj, o in enumerate(T) if oj != ti]
        skip_polys_h = others
        skip_polys = [p for _, p in others]
        # facade aspects = outward normals of the four longest edge directions
        ring = list(t["poly"].exterior.coords)[:-1]
        if t["poly"].exterior.is_ccw:
            ring = ring[::-1]
        edges = []
        for i in range(len(ring)):
            (x1, y1), (x2, y2) = ring[i], ring[(i + 1) % len(ring)]
            L = math.hypot(x2 - x1, y2 - y1)
            if L < 6:
                continue
            nx, ny = -(y2 - y1) / L, (x2 - x1) / L  # outward normal for a clockwise ring
            az = (math.degrees(math.atan2(nx, ny)) + 360) % 360
            edges.append({"mid": ((x1 + x2) / 2 + nx * .6, (y1 + y2) / 2 + ny * .6), "az": az, "len": L})
        aspects = {}
        for e in edges:
            name = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][int(((e["az"] + 22.5) % 360) // 45)]
            if name not in aspects or e["len"] > aspects[name]["len"]:
                aspects[name] = e
        t["aspects"] = aspects
        n_levels = t["levels"]
        tower_levels = []
        for lv in range(n_levels):
            eye = t["ground_rl_m"] + lv * t.get("floor_to_floor_m_est", f2f) + 1.6
            per = {}
            for name, e in aspects.items():
                seen_t = []
                for tg in targets:
                    for (tlon, tlat) in tg["points"]:
                        tx, ty = loc.xy(tlon, tlat)
                        bearing = (math.degrees(math.atan2(tx - e["mid"][0], ty - e["mid"][1])) + 360) % 360
                        off = abs((bearing - e["az"] + 540) % 360 - 180)
                        if off > tg.get("fov_deg", 60):
                            continue
                        tz = (terr.at(tlon, tlat) or 0) + tg.get("height_amsl_offset_m", 0)
                        ok, why = line_clear(e["mid"][0], e["mid"][1], eye, tlon, tlat, tz, skip_polys)
                        if ok:
                            seen_t.append(tg["id"])
                            break
                per[name] = sorted(set(seen_t))
            tower_levels.append(per)
        levels_out.append(tower_levels)
        print(f"tower {t['id']}: views done", file=sys.stderr)

    # ---- road distance ----
    road_out = []
    for t in T:
        best = None
        for r in roads:
            d = t["poly"].distance(r["line"])
            if best is None or d < best["d"]:
                best = {"d": d, "cls": r["cls"], "name": r.get("name")}
        road_out.append({"tower": t["id"], "distance_m": round(best["d"]) if best else None,
                         "class": best and best["cls"], "name": best and best["name"]})

    # ---- planning controls at each tower centroid ----
    planning = []
    for t in T:
        c = loc.ll(t["poly"].centroid.x, t["poly"].centroid.y)
        planning.append({"tower": t["id"], "point": [round(c[0], 6), round(c[1], 6)],
                         "zoning": epi_query(2, *c), "height_of_buildings": epi_query(5, *c),
                         "fsr": epi_query(1, *c), "heritage": epi_query(0, *c)})

    # ---- context buildings for the browser (sun + view rays), compact ----
    ctx = []
    for b in with_h:
        if b["poly"].distance(Point(0, 0)) > near_r:
            continue
        ring = [list(map(lambda v: round(v, 6), loc.ll(x, y))) for x, y in list(b["poly"].exterior.coords)]
        ctx.append({"id": b["id"], "h": round(b["h"], 1), "r": ring})

    out = {
        "slug": slug,
        "generated": date.today().isoformat(),
        "project": src["project"],
        "site": src["site"],
        "towers": [{k: v for k, v in t.items() if k not in ("poly", "aspects")} | {
            "aspects": {k: round(v["az"]) for k, v in t["aspects"].items()},
            "facade_points": {k: list(map(lambda v: round(v, 7), loc.ll(*v["mid"]))) for k, v in t["aspects"].items()},
            "area_m2": round(t["poly"].area)} for t in T],
        "floor_to_floor_m_est": f2f,
        "views": {"method": src["view_method"], "targets": [{k: v for k, v in tg.items()} for tg in targets],
                  "by_tower": {T[i]["id"]: levels_out[i] for i in range(len(T))}},
        "road": road_out,
        "planning_controls": planning,
        "terrain": {"site_ground_dem_m": round(site_ground_dem, 1) if site_ground_dem is not None else None,
                    "source": "AWS Terrain Tiles (terrarium, z13; SRTM/GA-derived), " + DEM},
        "context_buildings": {"radius_m": near_r, "count": len(ctx), "source": "OpenStreetMap via OpenFreeMap tiles " + TILES,
                              "licence": "ODbL © OpenStreetMap contributors", "features": ctx},
        "documents": src["documents"],
        "noise": src["noise"],
        "sources": src["sources"],
        "notes": src["notes"],
    }
    dst = ROOT / "dist/showhaus/studio/data" / f"{slug}.json"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {dst} ({dst.stat().st_size // 1024} KB)", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "arncliffe-central")
