# SHOWHAUS listing kit

One street address → a hosted property page (`https://showhaus.app/p/?a=<slug>`), a 5-second walkthrough GIF, an MP4, a poster and a scene image, all recorded from that page by headless Chromium. Built 2026-11-08 for agent outreach (sprint showhaus-01).

```
npm i --no-save @mapbox/vector-tile@2.0.3 pbf@4.0.1 playwright@1.56.1   # plus ffmpeg on PATH
node scripts/showhaus-listing-kit.mjs "4/17 Flood Street, Clovelly NSW 2031" --slug 4-17-flood-st-clovelly --listing <agency URL>
node scripts/showhaus-kit-judge.mjs [--only <slug>] [--shots dir]
```

| On the page | Source (fetched by the generator, URL + date stored in `<slug>.json`) | Grade |
|---|---|---|
| Address point | NSW Geocoded Addressing Theme (exact string), Nominatim as cross-check | counted |
| Lot outline | NSW cadastre, Lot layer (strata plans show the whole parcel) | counted |
| 3D buildings | OSM API 0.6 `map` call, raw `height` / `building:levels` tags; no tag → 6 m (garage/shed 3 m), drawn pale and labelled estimated | mapped / est. |
| Sun today and 21 June | NOAA sun every 10 min, flat-ground shadows, median over open-ground points on the lot. **Unknown** unless every building within 30 m has a mapped height, and unknown if no footprint is mapped there at all | est. / unknown |
| Main road | OSM motorway/trunk/primary via OpenFreeMap z14 tiles, straight line | counted |
| Canopy | NSW 2024–25 canopy H3 cell | live at build |
| Zoning, bush fire, flood | NSW Planning Portal point queries (flood layer lacks many councils) | live at build |
| Aircraft noise | Sydney Airport ANEF 2039: no GIS layer → unknown. Western Sydney ANEC from the state layer | unknown / live |
| Rent | NSW Fair Trading rental bonds, whole postcode, SHOWHAUS medians (recounted by the judge from `rents.json`) | counted |

Tracking: the page uses the SHOWHAUS event contract (`POST /api/e`, `src/ops/events.js`): `view` with `props {kit, utm_source}` on load, `cta` with `props.cta = explore | listing` on clicks. Kit links carry `?src=agent-<slug>`, sent as `utm_source`. The page sends no anon id and sets no cookie or storage; the Worker never stores IPs or query strings. The recorder (`rec=1`, `scene=…`) never sends events.
