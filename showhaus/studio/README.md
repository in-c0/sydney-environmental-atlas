# SHOWHAUS Studio — 3D walkthrough for project-marketing teams

Live: https://showhaus.app/studio/?p=arncliffe-central · pilot: https://showhaus.app/studio/pilot.html

**What it is:** a massing model from public planning documents, placed among the real surrounding buildings
(OpenStreetMap), lit by the real sun position (NOAA), with floor-by-floor sun hours and lines of sight.
**What it is not:** photoreal, an architect's model, or anything endorsed by the developer, architect or an agency.

## Demo project: Arncliffe Central (SSD-11429726)

All figures are in `arncliffe-central.source.json` with the document they came from:

| Building | Max height (consent MOD-10) | Levels (drawing list) | Ground datum (2022 report: RL − m) | Height above ground (est.) |
|---|---|---|---|---|
| A | RL 101.0 m AHD | 22 | 91.65 − 70 = 21.65 | 79.35 m |
| B | RL 101.3 m AHD | 23 | 94.9 − 71.5 = 23.4 | 77.9 m |
| C | RL 96.1 m AHD | 19 | 92.65 − 67.4 = 25.25 | 70.85 m |
| D | RL 93.6 m AHD | 21 | 91.2 − 60.6 = 30.6 | 63.0 m |

Footprints: traced from the approved Level 8–12 plan (DA2013, stamped plans part 1, sheet 18 of 238, 1:250) and
georeferenced to cadastre lot 1//DP1283907 with six boundary control points (max residual ≈ 1 m). The site lot area
(13,441 m²) matches the assessment report (13,440.3 m²).

Sources: [project page](https://www.planningportal.nsw.gov.au/major-projects/projects/eden-street-arncliffe-mixed-use-redevelopment) ·
consolidated consent MOD-10 · assessment report (Aug 2022) · stamped plans part 1 · noise and vibration assessment (EIS App. P).

## Grades

- **stated in planning documents:** heights (RL), levels, aircraft-noise statement (outside ANEF 20, Sydney Airport ANEF 2039), road and rail noise (measured by the applicant's consultant, Dec 2020).
- **est. (modelled by SHOWHAUS):** height above ground, floor heights, sun hours per facade, lines of sight, road distance.
- **not built yet:** photoreal exteriors/interiors; the world engine (in-c0/spatial-world-engine has not generated a scene).

## Add a project

1. Write `showhaus/studio/<slug>.source.json` (copy the Arncliffe file; every figure needs its document URL).
2. `python3 scripts/showhaus_studio_build.py <slug>` (needs `pip install mapbox-vector-tile shapely pillow`).
3. `node scripts/showhaus-studio-kit.mjs <slug>` → GIF/MP4/poster/stills in `dist/showhaus/studio/<slug>/`.
4. Extend the massing checks in `scripts/showhaus-studio-judge.mjs` with the new documents' figures.
