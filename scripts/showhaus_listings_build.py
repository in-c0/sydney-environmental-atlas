"""Build the one shared SHOWHAUS asset model: listings, their worlds, renders, evidence cards.

    python3 scripts/showhaus_listings_build.py                 (no network: reads files already in dist/)
    (pip install shapely)

Reads
  dist/showhaus/p/<slug>.json                       the listing kits (10 addresses, public records)
  dist/showhaus/studio/data/<slug>.json             studio projects (off-the-plan; Arncliffe Central)
  $SHOWHAUS_ANEF or ../spatial-world-engine/data/anef/anef-sydney-approx.geojson   ANEF approx. (private; only per-listing results are published)
  showhaus/listings/<slug>.renders.json             render slots for a listing (hero + seasons), optional
  showhaus/listings/<slug>.world.json               the listing's pre-baked world (engine static export), optional
Writes
  dist/showhaus/data/listings.json                  every listing: pin, card, links (the map's pin layer and /agent, /agency)
  dist/showhaus/l/data/<slug>.json                  one listing page's full record (cards with sources)

The model (also documented in docs/showhaus-asset-model.md):
  Listing   { slug, kind: rental_kit | off_the_plan, name, address, lnglat, suburb, postcode, source_page, links }
  World     { status: none | manifest | baked, scene_contract (engine WorldManifest, origin stripped), url, tiles, bytes,
              appearance, photoreal: false }
  Renders   { hero: { status, label, media, seasons: [{ id, label, status, media }] } }   — every slot says "generated"
  Claim     handled live by src/claim.js (sh_claims); the model only names the claim route
  ShareLink /s/<slug>[/<code>] (src/claim.js)
"""
from __future__ import annotations

import glob
import json
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist", "showhaus")
SEASONS = [("summer", "Summer", "21 Dec"), ("autumn", "Autumn", "20 Mar"), ("winter", "Winter", "21 Jun"), ("spring", "Spring", "23 Sep")]


def load(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path) as fh:
        return json.load(fh)


def metres(a, b):
    kx = 111320 * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110540)


# ---------------------------------------------------------------- noise (ANEF approx. + what the records say)
def anef_card(lnglat, anef, stated=None):
    """Noise card: approximate ANEF position (never 'official'), plus a planning document's own statement when there is one."""
    from shapely.geometry import Point, shape
    p = Point(*lnglat)
    unc = anef["method"]["uncertainty_m"]
    out = {"id": "noise", "title": "Aircraft noise", "approx": True, "rows": [], "notes": []}
    for year in (2039, 2045):
        rings = sorted((f for f in anef["features"] if f["properties"]["year"] == year), key=lambda f: f["properties"]["anef"])
        inside = [f["properties"]["anef"] for f in rings if shape(f["geometry"]).contains(p)]
        edge = min(shape(f["geometry"]).exterior.distance(p) for f in rings)
        edge_m = edge * 111320 * math.cos(math.radians(lnglat[1]))   # degrees → metres (good enough at this scale)
        level = max(inside) if inside else None
        near = edge_m <= unc
        if level:
            text = f"Inside ANEF {level} (approx.)"
        else:
            text = "Outside ANEF 20 (approx.)"
        if near:
            text += f" — within {unc} m of a contour line, so this could go either way"
        out["rows"].append({"label": f"ANEF {year}", "value": text, "level": level, "near_line": near,
                            "distance_to_nearest_line_m": int(round(edge_m / 10.0) * 10)})
    out["notes"].append(anef["notice"])
    out["source"] = {"label": anef["source"]["document"], "url": anef["source"]["url"], "method": "scripts/showhaus_anef_digitise.py",
                     "uncertainty_m": unc}
    if stated:
        out["stated"] = stated
    return out


# ---------------------------------------------------------------- listing kits (rentals with public records)
def kit_listing(path, anef):
    k = load(path)
    g = k["geocode"].get("gat") or k["geocode"].get("nominatim")
    lnglat = [round(g["lng"], 6), round(g["lat"], 6)]
    parsed = k["geocode"].get("parsed") or {}
    zoning = (k["planning"].get("zoning") or {}).get("rows") or []
    flood = k["planning"].get("flood") or {}
    bush = k["planning"].get("bushfire") or {}
    canopy = (k.get("canopy") or {}).get("rows") or []
    main = ((k.get("roads") or {}).get("nearest") or {}).get("main") or {}
    rent = k.get("rent") or {}
    cards = [
        anef_card(lnglat, anef),
        {"id": "road", "title": "Main road", "rows": [{"label": "Nearest main road", "value": f"{main.get('name') or 'unnamed'} · {main.get('distance_m')} m (map distance)"}] if main else [],
         "source": {"label": k["roads"]["source"], "url": None}, "notes": ["Distance on the map, not a noise measurement."]},
        {"id": "satellite", "title": "From above", "rows": [{"label": "Tree canopy (H3 cell)", "value": f"{round(canopy[0]['Canopy_pc'] * 100)} % canopy"}] if canopy else [],
         "source": {"label": k["canopy"]["name"], "url": k["canopy"].get("url")}, "image": f"../p/{k['slug']}/poster.png",
         "notes": ["The picture is SHOWHAUS's 3D street scene (public map data), not a photo."]},
        {"id": "planning", "title": "Planning", "rows": (
            [{"label": "Zoning", "value": f"{zoning[0]['SYM_CODE']} {zoning[0]['LAY_CLASS']} · {zoning[0]['EPI_NAME']}"}] if zoning else []) + [
            {"label": "Flood planning", "value": "Mapped" if flood.get("rows") else ("Not mapped here" if flood.get("ok") else "Not checked")},
            {"label": "Bush fire prone", "value": "Mapped" if bush.get("rows") else ("Not mapped here" if bush.get("ok") else "Not checked")}],
         "source": {"label": "NSW Planning Portal (EPI Primary Planning Layers, hazard layers)", "url": (k["planning"].get("zoning") or {}).get("url")}},
    ]
    return {
        "slug": k["slug"], "kind": "rental_kit", "name": k["address"].split(",")[0], "address": k["address"], "lnglat": lnglat,
        "suburb": parsed.get("suburb"), "postcode": parsed.get("postcode"), "source_page": k.get("listing_url"),
        "facts": {"rent_median_week": (rent.get("all") or {}).get("median"), "rent_postcode": rent.get("postcode"), "kit_date": k.get("kit_date")},
        "world": {"status": "none", "photoreal": False, "url": None, "note": "No world built for this address yet."},
        "renders": {"hero": {"status": "placeholder", "label": "generated · 3D street scene from public map data, not a photo",
                             "media": {"video": f"../p/{k['slug']}/walkthrough.mp4", "poster": f"../p/{k['slug']}/poster.png"},
                             "seasons": [{"id": s, "label": l, "day": d, "status": "not rendered"} for s, l, d in SEASONS]}},
        "cards": cards,
        "links": {"page": f"/l/{k['slug']}", "claim": f"/l/{k['slug']}/claim", "legacy": f"/p/?a={k['slug']}"},
    }


# ---------------------------------------------------------------- studio projects (off the plan)
def studio_listing(path, anef):
    s = load(path)
    slug = s["slug"]
    from shapely.geometry import Polygon
    site = Polygon(s["site"]["boundary"])
    c = site.representative_point()
    lnglat = [round(c.x, 6), round(c.y, 6)]
    renders = load(os.path.join(ROOT, "showhaus", "listings", f"{slug}.renders.json"), {})
    world = load(os.path.join(ROOT, "showhaus", "listings", f"{slug}.world.json"), {"status": "none", "photoreal": False, "url": None})
    pc = (s.get("planning_controls") or [{}])[0]
    z = ((pc.get("zoning") or {}).get("features") or [{}])[0]
    hob = ((pc.get("height_of_buildings") or {}).get("features") or [{}])[0]
    n = s["noise"]
    stated = {"label": "Planning document", "value": n["aircraft"]["text"], "source": {"label": n["aircraft"]["source"], "url": n["aircraft"]["url"]},
              "grade": n["aircraft"]["grade"]}
    noise = anef_card(lnglat, anef, stated)
    noise["rows"] += [{"label": t["where"], "value": f"{t['day_laeq15h']} dB(A) day · {t['night_laeq9h']} dB(A) night (measured by the applicant's consultant)"}
                      for t in n["traffic"] + [n["rail"]]]
    noise["notes"].append(n["traffic_source"])
    cards = [
        noise,
        {"id": "satellite", "title": "From above", "rows": [{"label": "Site", "value": f"Lot {s['site']['lot']} · {s['site']['area_m2_cadastre']:,} m² (cadastre)"},
                                                             {"label": "Around it", "value": f"{s['context_buildings']['count']} mapped buildings within {s['context_buildings']['radius_m']} m"}],
         "source": {"label": "NSW Spatial Services cadastre (CC BY 4.0) · OpenStreetMap (ODbL)", "url": None},
         "image": f"../studio/{slug}/poster.png", "notes": ["The picture is SHOWHAUS's massing model among the mapped buildings, not a photo."]},
        {"id": "planning", "title": "Planning", "rows": [
            {"label": "Consent", "value": s["project"]["application"]},
            {"label": "Zoning", "value": f"{z.get('SYM_CODE', '?')} {z.get('LAY_CLASS', '')} · {z.get('EPI_NAME', '')}".strip()},
            {"label": "LEP height control", "value": f"{hob.get('MAX_B_H')} m" if hob.get("MAX_B_H") else "Not found"},
            *[{"label": t["name"], "value": f"{t['levels']} levels · max RL {t['max_rl_ahd_m']} m AHD (consent)"} for t in s["towers"]]],
         "source": {"label": "NSW Planning Portal — SSD-11429726 documents", "url": s["documents"]["project_page"]}},
    ]
    return {
        "slug": slug, "kind": "off_the_plan", "name": s["project"]["name"], "address": s["project"]["address"], "lnglat": lnglat,
        "suburb": "Arncliffe" if "Arncliffe" in s["project"]["address"] else None, "postcode": (s["project"]["address"].split()[-1] if s["project"]["address"][-4:].isdigit() else None),
        "source_page": s["documents"]["project_page"],
        "facts": {"towers": len(s["towers"]), "apartments_consent": s["project"]["description"].split(" ")[0]},
        "world": world, "renders": renders, "cards": cards,
        "endorsement": s["project"]["endorsement"],
        "links": {"page": f"/l/{slug}", "claim": f"/l/{slug}/claim", "legacy": f"/studio/?p={slug}", "studio": f"/studio/?p={slug}"},
    }


def main():
    anef = load(os.path.abspath(os.environ.get("SHOWHAUS_ANEF") or os.path.join(os.path.dirname(__file__), "..", "..", "spatial-world-engine", "data", "anef", "anef-sydney-approx.geojson")))
    if not anef:
        raise SystemExit("ANEF contours not found: check out in-c0/spatial-world-engine next to this repo or set SHOWHAUS_ANEF")
    listings = [studio_listing(p, anef) for p in sorted(glob.glob(os.path.join(DIST, "studio", "data", "*.json")))]
    listings += [kit_listing(p, anef) for p in sorted(glob.glob(os.path.join(DIST, "p", "*.json")))]
    os.makedirs(os.path.join(DIST, "l", "data"), exist_ok=True)
    for L in listings:
        with open(os.path.join(DIST, "l", "data", f"{L['slug']}.json"), "w") as fh:
            json.dump({"schema": "showhaus-listing-1", **L}, fh, indent=1)
    index = {"schema": "showhaus-listings-1", "generated_by": "scripts/showhaus_listings_build.py",
             "listings": [{k: L[k] for k in ("slug", "kind", "name", "address", "lnglat", "suburb", "postcode")}
                          | {"world": L["world"]["status"], "hero": (L["renders"].get("hero") or {}).get("status", "none"),
                             "noise": next(c for c in L["cards"] if c["id"] == "noise")["rows"][0]["value"],
                             "anef": {r["label"][-4:]: r.get("level") for r in next(c for c in L["cards"] if c["id"] == "noise")["rows"] if r["label"].startswith("ANEF ")},
                             "facts": L["facts"], "page": L["links"]["page"]} for L in listings]}
    with open(os.path.join(DIST, "data", "listings.json"), "w") as fh:
        json.dump(index, fh, separators=(",", ":"))
    print(f"{len(listings)} listings →", ", ".join(L["slug"] for L in listings))


if __name__ == "__main__":
    main()
