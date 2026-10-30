# Noise source intelligence: provenance and baking plan

This is the engineering specification for the **Noise** layer in [Sydney Environmental Atlas](https://map.lifeos.studio). It must stay distinct from the **Roads** layer. A location near a road, construction tag, railway or flight route is **not** a measured sound exposure and must never be presented as dB or an overall home score.

## Already implemented in the client

- **Roads:** NSW spatial road centreline proximity and geometry, with explicit *not a sound measurement* labels.
- **Noise:** an independent, opt-in OpenStreetMap Overpass query around the selected pin (1,200 m) for `landuse/building/highway=construction`, selected `railway` tags, `amenity=bar/pub/nightclub` and `leisure=stadium`. Approximate straight-line distances to OSM objects' points or centres, not acoustic measurements. OSM points are mapped on 2D and 3D, with source and uncertainty labels.
- **Aircraft:** link to Airservices WebTrak as the official source to examine flight routes, past days/times and noise monitors. **No WebTrak tracks are imported**.
- **Construction approvals:** link to NSW Planning Portal; no development-application feed is imported until an authorized API key is available.
- **Loading:** layer buttons become fully filled only after their required data have loaded; partial moving wave and reflection indicate indeterminate loading. Errors remain visually distinct.
- **Overall rating:** visible but intentionally unscored until properly validated evidence exists.

## Data acquisition and permissible reuse

| Layer | Preferred source | Update candidate | Permission/status | Interpretation |
| --- | --- | --- | --- | --- |
| Mapped construction candidates, rail, venues | OpenStreetMap / Overpass | Weekly spatial snapshots | Respect ODbL attribution and server rate limits. Do not query every grid cell in Sydney directly against a public Overpass API. | Map labels are leads; source may be out-of-date. |
| Development applications (DA) and consent | [NSW Planning Portal Open DA Data API](https://www.planningportal.nsw.gov.au/opendata/dataset/online-da-data-api) | Daily after authorized API access | Subscription key / data broker access required. Confirm reuse terms. | Proposed, in review or approved **does not imply construction is underway**. |
| Roadworks | [Transport for NSW Open Data](https://opendata.transport.nsw.gov.au/) / Live Traffic Hazards | Every 15–60 min when authorized | API access, correct licensing, throttling and source expiry required. | Work may be scheduled or active; follow source status. |
| Aircraft activity and time of day | [Airservices WebTrak](https://www.airservicesaustralia.com/community/environment/aircraft-noise/webtrak/) | Only after explicit reusable/licensed dataset obtained | **Do not scrape, copy, redistribute or pre-bake WebTrak.** Its terms restrict copying/redistribution; link visitors to the official site instead. | Historical tracks and monitors vary by hour, wind and runway. No flight-track bake currently authorized. |
| Actual acoustics | Official verified monitoring stations, recordings or documented calibrated models | Appropriate to provider | License, calibration and temporal coverage must be checked. | Only this can support statements about observed or modelled sound; not street geometry. |

## Future baked artifact schema

One immutable, versioned GeoJSON feature per detected source:

```json
{
  "type": "Feature",
  "id": "source:external-id",
  "geometry": {"type": "Point", "coordinates": [151.2, -33.9]},
  "properties": {
    "source_type": "construction_candidate",
    "source_provider": "osm",
    "source_url": "https://www.openstreetmap.org/...",
    "license_id": "ODbL-1.0",
    "record_status": "mapped_unverified",
    "observed_at": null,
    "valid_from": null,
    "valid_until": null,
    "retrieved_at": "2026-10-30T00:00:00Z",
    "last_verified_at": null,
    "confidence": "unverified",
    "time_buckets": null,
    "measurement_db": null,
    "measurement_method": null
  }
}
```

Use `source_type` such as `construction_candidate`, `roadworks`, `rail`, `venue`, `aircraft_limited`; use statuses such as `proposed`, `approved`, `scheduled`, `confirmed_active`, `completed`, `mapped_unverified`. A DA approval never automatically becomes `confirmed_active`. Explicitly carry provider, license, URL, as-of date, validity and geometry precision. Preserve original official IDs and timestamps.

## Proposed deployment architecture (not yet enabled)

1. Obtain authorized feeds and written reuse permissions; do not distribute restricted datasets.
2. A low-cost, bounded server-side fetch checks changed records only, using provider-specific ETags/cursors; geospatial normalization and deduplication happen outside the browser.
3. Produce validated static tile chunks (e.g. metro zones by source and day/week) and a manifest: `schema_version`, `generated_at`, per-source `latest_update`, `expires_at`, `coverage`, `license`, `errors`.
4. Publish atomically to the existing static hosting/data storage, keep previous working snapshot, and mark individual stale sources instead of showing them as current.
5. In the client, fetch only chunks intersecting the visible neighbourhood and filter by selected time bucket, distance and valid dates. Distinguish **reported source**, **active source**, **historical route**, and **measurement** in the legend.
6. Run source-level monitors for missing records, geometry drift, duplicates and expired construction. Reconcile source counts and review samples before extending coverage.

**Deployment gate:** No background cron/action has been enabled. The user has previously hit GitHub Actions billing limits; use the existing infrastructure only after permissions, operating cost and source licenses are resolved. Prefer static hosting with bounded requests, not browser-wide live Overpass traffic. Do not create a ChatGPT scheduled task.

## Quality gates for publishing estimates

- Source and temporal coverage visible in the map UI, including unavailable or expired sources.
- Zero conflation of roads and measured noise, and no claim that DA approval = construction.
- Do not infer acoustic impact simply from OSM distance; verified model must specify equipment, operating times, barriers, elevation, meteorology and calibration.
- Day, evening, night and weekend categories only where source data support them.
- Tests: invalid geometry, duplicate external IDs, daylight-saving time, future/expired approvals, missing permissions, provider outages and stale tile fallback.
