# Walk pipeline (plan → base walk)

`walkgen.py` turns one plan JSON into a baked, walkable scene for `dist/showhaus/walk`. It replaces the scene script that
was written by hand for Avalon (`avalon.py`, kept for reference).

```
python3 walkgen.py plans/<slug>.plan.json check              # no Blender: validates, prints walk areas
python3 walkgen.py plans/<slug>.plan.json preview /tmp/out   # 16-sample render of every view; fix layout and exposure here
python3 walkgen.py plans/<slug>.plan.json bake    /tmp/out   # Cycles bake, one atlas per group, saved group by group
python3 walkgen.py plans/<slug>.plan.json pack    /tmp/out ../../dist/showhaus/walk   # atlases, room.js, <slug>.json, poster
```

Needs `pip install bpy numpy pillow` (checked with bpy 5.3, Python 3.13). `pack` prints the row to add to
`walk/data/index.json`. After a home goes live, `POST /api/ops/suggest-built {url, slug}` tells the people who asked for it.

## Homes suggested by address (no plan): `estimate.py`

```
python3 estimate.py "addr:199 FOREST ROAD ARNCLIFFE" --slug arncliffe-199-forest-road --out /tmp/est
#   → /tmp/est/<slug>.plan.json  (source "estimate", passes check)   /tmp/est/aerial.jpg   /tmp/est/estimate.json
python3 estimate.py ... --roof x0,x1,y0,y1      # after looking at aerial.jpg: override the roof box (lot metres)
```

All public NSW Spatial Services data, no account: the address register (GURAS) for the point, the cadastre lot under it,
the road with the address's street name (that lot edge is the front), and the NSW aerial mosaic clipped to the lot, where
the roof is the largest non-vegetation, non-shadow blob, measured in the lot's own axes (setbacks if that blob is not
plausible). `aerial.jpg` draws the lot (yellow), the front (blue) and the roof box (red): **look at it before baking**
and pass `--roof` if the box caught a neighbour, a carport or a tree shadow. The interior is one open
kitchen/dining/living space at the back of the roof footprint (wide layout from a 7.3 m roof width, otherwise a
front-to-back terrace layout); every guess is in `assumptions`, and the viewer shows the estimate basis line.
Then `preview` / `bake` / `pack` as for any plan. An address the register does not know (new lots) cannot be estimated:
skip it until the register has it.

Checked 16 Nov 2026: Arncliffe (detached), Randwick (narrow lot), Kellyville (new estate), a strata unit in Arncliffe —
lot, front and roof box all on target in the aerial clip; Arncliffe went estimate → preview → low-res bake → pack → the
real viewer (basis line "estimated from satellite imagery", unclaimed badge). Not published: nobody had asked for it.

## Plan JSON

Metres; x = east, y = north, z = up. Nothing is guessed by the builder: every value the plan does not give is written
in the JSON and listed under `assumptions` (the page shows them).

| Key | Meaning |
|---|---|
| `slug`, `name`, `by`, `type`, `rooms` | What the gallery card and the viewer show. |
| `source`, `source_url` | `plan` (from a published floor plan; needs the URL) or `estimate` (`estimate.py`: no plan, from the lot and aerial imagery; `source_url` null, `address_key` = the queue key). Picks the basis line on the page. |
| `outline` | The room outline, rectilinear, counter-clockwise. One connected space (a living zone, a studio). |
| `ceiling` | `{"type": "flat", "h": 2.7}` or `{"type": "raked", "from": [x, y], "to": [x, y], "h0": 2.6, "h1": 3.5}`. |
| `openings` | `{"edge": i, "type": "window" \| "slider" \| "door", "a", "b", "sill", "head", "mullions"}`. Edge `i` runs `outline[i] → outline[i+1]`; `a..b` is the absolute x (horizontal wall) or y (vertical wall). Doors are closed: the room behind is not modelled. |
| `outdoor` | `{"rect": [x0, y0, x1, y1], "roof": 2.7}`: a covered deck. A slider that opens onto it becomes a doorway you can walk through. |
| `finishes` | `floor`: `oak` \| `tile` \| `concrete` \| `carpet`; `wall`, `cabinet`, `stone`, `splash`: `[r, g, b]`. This is where a claimant's real finishes go. |
| `items` | `{"type", "at": [x, y], "rot": 0 \| 90 \| 180 \| 270, …}`. `at` is the footprint centre; `rot` 0 = back to the south, facing north. Types: `kitchen_run`, `island`, `tall`, `fridge`, `dining`, `sofa`, `armchair`, `coffee_table`, `rug`, `tv_unit`, `art`, `plant`, `floor_lamp`, `pendant`, `bed`, `bedside`, `desk`, `outdoor_table`, `box`. `kitchen_run` takes `sink`, `sink_at`, `cooktop` and `window_gap: [u0, u1]` (local x, no splash or overheads there, so a window over the sink stays open); `island` takes `sink: false` when the plan's island is a plain bench. |
| `walls` | Internal walls (multi-room plans): `{"from": [x, y], "to": [x, y], "t": 0.09, "doors": [{"a", "b", "head", "swing"}]}`, horizontal or vertical, inside the outline. `a..b` is the absolute x (horizontal wall) or y (vertical wall) of a doorway; doorways are open so you can walk between rooms (`swing` ±1 only draws the arc on the arrange plan). They block walking, get a header above each doorway, and show on both mini plans. |
| `spaces` | Room labels `{"name": "Bed 1", "at": [x, y]}` for the arrange plan and the walk's mini plan. |
| `views` | `{"name", "pos": [x, y], "look": [x, y], "pitch"}`: the room chips. A view standing in a wall or an object is refused. |

`check` refuses a plan that is not rectilinear, has an opening that does not fit its wall or rises above the ceiling,
places an item outside the room, puts a camera inside something, or lists no assumptions.

## What was checked (15 Nov 2026, 2 CPU cores)

- `plans/buildtec-avalon.plan.json` rebuilds Avalon from data: preview of six views in 1 min 36 s; its walk areas and
  collisions match the live walk (`scripts/showhaus-walkgen.test.mjs`).
- `plans/fixture-studio.plan.json` (an invented L-shaped studio, never published) went plan → preview → bake → pack →
  the real viewer: three views, walking, mini plan with openings on three walls. Low-resolution bake (1024 atlases,
  8 samples) took 51 s; a publishable bake (3072 atlases, 28–32 samples) is about 40 minutes by the earlier measurements.

## Not done

- A full-resolution Avalon bake with `walkgen.py` (the live Avalon still uses the `avalon.py` bake, which its photos and clips are aligned to).
- Reading a floor plan image into the JSON. That step is still done by a person or an agent with the plan in front of it.
- Curves, stairs and more than one level. (Internal walls and several rooms inside one rectilinear outline: `walls`, `spaces`, since 17 Nov 2026; `plans/fixture-apartment.plan.json` is the invented test plan.)
- Reading the plan is done by the nightly scheduled session (an agent with the plan image in front of it), not by code.

## Live homes built with walkgen

- `plans/buildtec-erina.plan.json` → `walk/?p=buildtec-erina` (15 Nov 2026): first home built end to end with `walkgen.py` (3072 atlases, 30 samples, one group per process).

## Queues

- Base: `/api/ops/summary` → `queue.base`, taken nightly (see the repo CLAUDE.md). Photoreal: `scripts/showhaus-photoreal-queue.mjs`.

The builder's plan image is theirs and is not stored here; the JSON records where it came from.

## Arrange (no bake)

`node scripts/showhaus-arrange-plans.mjs` copies the plans listed in its `PUBLISH` array to `dist/showhaus/arrange/plans/` and
writes the index. The arrange page (`showhaus.app/arrange/?p=<slug>`) builds the room in the browser from that JSON
(`dist/showhaus/walk/plan-core.js` geometry, `plan-room.js` three.js scene: hemisphere + sun light, contact shadows) — a plan
is usable there the moment its JSON passes `check`, long before (or without) a Cycles bake.
