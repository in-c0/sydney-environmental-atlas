# SHOWHAUS — spec v0 (2026-11-08)

Owner request (verbatim): "realestate.com.au, domain, homely 등을 대체할 플랫폼을 만들어줘. 기존 플랫폼들을 벤치마킹 하고 더 낫게 개선하자. 특히 realestate.com.au 의 Map 기능과 이미 만들어진 sydney noise atlas 를 합하고, /living-data-hud 를 적극 활용해"

## 0. Ambition (be-ambitious)

- **Goal beyond the goal:** a Sydney buyer or renter never again learns about the flight path, the afternoon sun, the main road or the flood line *after* signing. The listing portals sell attention to agents; SHOWHAUS sells certainty to the person moving in.
- **Altitude ladder:** (1) REA-style map search + the atlas's evidence lenses on one screen; (2) every place on the map answers "what will living here feel like at 7 am, 3 pm and 11 pm, in July and January" from public records, with sources; (3) agents and developers list on SHOWHAUS because the evidence card sells the property better than a portal ad (this is the sales sprint's offer).
- **Depth:** start from raw public records (NSW Valuer General sales, NSW spatial services, EPA, canopy H3, OSM heights, NOAA sun), not portal summaries. Hard target: any pin → full evidence card in < 1.5 s on a 4G phone; every number recounted by the judge.
- **Range:** surveyor (cadastre, parcel truth), acoustician (what road distance does *not* tell you), conveyancer (what to check before contract: zoning, flood, bushfire, EPA), cartographer (honest symbology).
- **Outside judge:** `scripts/showhaus-judge.mjs` (Playwright) at 1440×900, 1280×720, 390×844 + independent recount of every displayed number from the raw files.

## 1. Identity

This app looks like a **surveyor's cadastral plan on Sydney sandstone** because the subject is land, title and light in Sydney: sandstone paper ground, ink-blue linework, terracotta for roofs and price, jacaranda for selection, harbour blue for water/flood, auction-sticker red used only for SOLD. Units are real (m, m², AUD, dB never invented, minutes of sun).

### 2026-11-11 experience direction — A as default, B/C by function

Ji's visual architecture decision: **A · Living Atlas** is the default map-first experience. **B · Architectural Journal (Discover)** and **C · Urban Intelligence (Analyse)** are separate functional destinations, not visual modes mixed into Explore.

- **Explore (A):** the city map stays visible while an opaque editorial panel guides area, budget, preferences and evidence. The existing four acts are now steps within this panel rather than centred map-blocking dialogs. On mobile, use a bottom-sheet layout.
- **Discover (B):** future neighbourhood stories, architecture, local character and human-scale discovery; unreleased until real content and functionality exist.
- **Analyse (C):** future comparative urban data, planning and research tools; unreleased until real analytical workflows exist.
- Keep Discover/Analyse visibly marked as **planned** and noninteractive until shipped; do not imply these destinations already function.
- Source-linked rental aggregates must remain legible even when map/WebGL support is unavailable. The map and exact-point evidence can be unavailable, but should fail explicitly rather than leaving empty controls.
- Treat `dist/showhaus/explore.css` as the Explore design layer. Do not introduce placeholder vector art, faux 3D scenes or unsupported certainty claims to decorate it.

### 2026-11-11 visual comfort correction

Ji's direct feedback on the dense lease-point map: **"환공포증.."**

- **No dense circular data clouds in the default map, including after zooming/searching.** Do not assume that thousands of small lease markers are an acceptable visual representation.
- Render postcode-level rental medians through restrained area shading and collision-managed price labels. A postcode is the truthful geographic resolution of the rental records; individual bond lodgements have no address and must not look like exact property locations.
- Preserve source data, filters, counts and evidence cards. This changes only the map's visual encoding, with no fabricated map geometry or placeholder assets.
- Keep the selected-place marker singular and use legible text for evidence. Reintroducing a dense-dot mode would require explicit user opt-in and independent visual verification.

### 2026-11-11 quantity clusters and modern type

Ji's subsequent feedback (verbatim):

> 근데 그러면 그냥 한개인거랑 구분이 안되자네
>
> 음... 미니멀하면서도 좀더 대략 몇개가 클러스터에 있는지 직관적으로 표시되면 좋겠어
>
> 응
>
> 그리고 폰트 좀 모던하고 가독성 좋은걸로

- One collision-managed rounded capsule per visible postcode cluster, **not a dot cloud**. The main number is an approximate count of **lease records** (e.g. `≈20`, `≈600`, `≈7.1k`), and font scale increases gently with count. A single record reads `1` and remains distinguishable from a cluster.
- Clusters sum the `n` count of postcode rent records with `clusterProperties.leases`. Never mistake the default MapLibre `point_count` (number of grouped postcode features) for the number of leases; never fabricate property locations. The marker means records in nearby postcodes at the current zoom.
- A tap zooms into the grouped region; at detailed zoom, one capsule remains per postcode. Colour continues to encode **postcode median weekly rent**; exact counts and median prices stay in filters and evidence cards. Changing budgets/bedrooms recomputes clusters.
- Explore typography uses **Manrope** for headings and **Inter** for prose, controls, and data. Increase tiny labels and use tabular numeric alignment without shrinking the touch targets. Font loading must be verified at desktop and mobile sizes.

## 2. Acts (one decision at a time)

1. **Where?** One input (suburb, postcode or region). Hero colours Sydney postcodes by the median rent of new leases; the recorded-lease counter reacts per keystroke. Min 3 chars; typo → closest suburb (Tab to accept); a price typed here is offered to act 2.
2. **Buy, rent or just looking — and up to how much?** One control (mode + budget slider). Postcode shading and approximate lease-count clusters update with the filter; exact counts and median react instantly. Buying prices remain unavailable until licensing is resolved.
3. **What matters at home?** Chips with include/exclude: quiet street · morning sun · afternoon shade · trees · away from flight path · no flood/bushfire overlay · near station. Each chip turns on its evidence lens on the map; selection line states everything in words, every token removable.
4. **The HUD.** Map (2D/3D) + one place card: sale history, road geometry, canopy, sun now/at chosen time, land records, planning overlays; A/B compare; presets remembered.

## 3. Data (see docs/showhaus-data-sources.md, verified per source)

counted = from records; live = fetched in the browser with timestamp; est. = modelled and labelled. Unknown shows as unknown. For-sale/for-rent listings only from agents who list with us or an official feed — never scraped.

**v0 decision (2026-11-08):** NSW Valuer General sales (PSI) are CC BY-NC-ND — not usable in a commercial product without a separate PSI licence, and the download is behind a bot challenge. v0 therefore runs on:

| Layer | Source | Licence | How |
|---|---|---|---|
| Rents (hero) | NSW Fair Trading rental bond lodgements, 12 months | CC BY 4.0 | `scripts/showhaus_build_data.py` → `dist/showhaus/data/rents.json` (counted; monthly CI rebuild) |
| Postcodes, suburbs | ABS ASGS 2021 POA + SAL | CC BY 4.0 | same build → `places.json` |
| Road distance | OpenStreetMap via OpenFreeMap tiles | ODbL | measured in the browser |
| Ground sun (est.) | NOAA solar position + OSM explicit building heights | ODbL | atlas shadow module, flat ground |
| Canopy | NSW 2024–25 canopy H3 | OEH (check before commercial reuse) | live query |
| Land records | NSW EPA notified sites | CC BY 4.0 | live query, 1 km |
| Zoning, bushfire, flood, WSA ANEC | NSW Planning Portal | CC BY / RFS | live point query |
| Sydney Airport ANEF | not connected | — | shown as unknown |
| Sold prices | NSW VG PSI | NC-ND | **not shown** until licensed; buying mode says so |

## 4. Hero object

**Rent terrain:** every Greater Sydney postcode coloured (2D) or extruded (3D) by the median weekly rent of new leases matching the visitor's bedroom/type/budget filters — the whole city re-colours as they choose. Act 4 explodes the chosen place into strata planes (rent postcode · road geometry · canopy · sun path · land records) joined by drop lines (vault 07/10); the Time lens shows concentric months × bedroom sectors (vault 08).

## 5. Lenses

Map (2D) · Perspective (3D buildings + shadows) · Strata (exploded layers at the pin) · Time (concentric rings of sales around the pin by age).

## 6. Failure list → handling

See living-data-hud "Predictable failures"; each one has an assertion in the judge.

## 7. Judge checks

No scroll/overflow in any act at 3 viewports · counters equal recount from data · bad inputs handled · first counter < 300 ms · hero points > threshold and change with input · presets survive reload · zero console errors.
