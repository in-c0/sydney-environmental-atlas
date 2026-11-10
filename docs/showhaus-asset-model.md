# SHOWHAUS integrated preview — one asset model, five surfaces

Phase 1 of merging the showhaus.app rent-terrain map (this repo, `dist/showhaus/`) with the Site Walk viewer
(in-c0/spatial-world-engine, `services/viewer/`). Built on branch `claude/showhaus-integrated-preview`; **not deployed**:
the walk stays off the site until it looks like the real place.

## Routes (src/listing.js; on other hosts the same paths sit under `/showhaus/`)

| Route | What it is |
|---|---|
| `/` | The rent-terrain map plus `lib/pins.js`: a pin per listing (`data/listings.json`), a listing card on tap, and an **Aircraft noise** lens (ANEF 2039 / 2045, approx.) |
| `/l/<slug>` | One listing: hero slot for the 10 s sunrise→sunset render with 4 season buttons (computed sun path over it), **Walk the street** / **Go inside** (Site Walk viewer in static mode, enabled only once the listing's world is published), then noise / from-above / planning cards with sources |
| `/l/<slug>/claim` | The existing claim flow (`dist/showhaus/claim/`, `src/claim.js`) for that listing: "is this yours or your agency's?" → sign up (existing email-code login) or claim as guest → share link. No new accounts or providers |
| `/agent`, `/agency` | One read-only page over the same listings; the path only changes the wording |
| `/p/?a=<slug>`, `/studio/?p=<slug>` | 301 → `/l/<slug>` (other query parameters kept). `/studio/?p=…&embed=1` and `/studio/pilot.html` are unchanged |
| `/s/<slug>[/<code>]` | Share links now land on `/l/<slug>` (claimant line shown only for verified claims) |

## The model (`scripts/showhaus_listings_build.py` → `dist/showhaus/data/listings.json`, `dist/showhaus/l/data/<slug>.json`)

- **Listing**: slug, kind (`off_the_plan` | `rental_kit`), name, address, pin, links. Sources: studio data
  (`dist/showhaus/studio/data/*.json`) and listing kits (`dist/showhaus/p/*.json`).
- **World**: `showhaus/listings/<slug>.world.json`: status (`none` | `baked` | `published`), the engine's scene-contract
  manifest (origin stripped), tile count, bytes, interiors, `photoreal: false`. `hosted: false` keeps the walk buttons off.
- **Renders**: `showhaus/listings/<slug>.renders.json`: hero + four season slots; every slot is labelled *generated*.
  Arncliffe's hero is the CVF interior bake-off walkthrough as a **placeholder** (spring slot); the other seasons say "not rendered".
- **Claim / ShareLink**: live in `src/claim.js` (D1 `sh_claims`); the model names the routes only.

## Aircraft noise (approx.)

`scripts/showhaus_anef_digitise.py` → `../spatial-world-engine/data/anef/anef-sydney-approx.geojson` (private: the source map's redistribution terms are unchecked, so only per-listing results are published, never the contours): ANEF 2039 and 2045 contours read
as vector paths from Sydney Airport Master Plan 2045, Section 3, p. 163, Map 15-2, georeferenced with an affine fit from
the three runways on that map to OpenStreetMap runway centrelines (6 control points, ~100 m RMS; stated uncertainty ±300 m).
The file and every card say *approx.* and *not the official ANEF*. A place within the uncertainty of a line is shown as
"could go either way". Cross-check: Arncliffe Central comes out outside ANEF 20 (2039) by ~440 m, matching its own EIS.

## Checks

```sh
python3 scripts/showhaus_anef_digitise.py && python3 scripts/showhaus_listings_build.py
node --test scripts/showhaus-listing.test.mjs                     # routes, redirects, model, ANEF
node scripts/showhaus-listing-judge.mjs [--shots dir]             # real Worker + Chromium: pins, lens, /l, claim, agent
node scripts/showhaus-listing-judge.mjs --engine ../spatial-world-engine --world <export dir>   # + the walk, local only
```
