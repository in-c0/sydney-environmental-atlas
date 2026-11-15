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

## Plan JSON

Metres; x = east, y = north, z = up. Nothing is guessed by the builder: every value the plan does not give is written
in the JSON and listed under `assumptions` (the page shows them).

| Key | Meaning |
|---|---|
| `slug`, `name`, `by`, `type`, `rooms` | What the gallery card and the viewer show. |
| `source`, `source_url` | `plan` (from a published floor plan; needs the URL) or `estimate`. Picks the basis line on the page. |
| `outline` | The room outline, rectilinear, counter-clockwise. One connected space (a living zone, a studio). |
| `ceiling` | `{"type": "flat", "h": 2.7}` or `{"type": "raked", "from": [x, y], "to": [x, y], "h0": 2.6, "h1": 3.5}`. |
| `openings` | `{"edge": i, "type": "window" \| "slider" \| "door", "a", "b", "sill", "head", "mullions"}`. Edge `i` runs `outline[i] → outline[i+1]`; `a..b` is the absolute x (horizontal wall) or y (vertical wall). Doors are closed: the room behind is not modelled. |
| `outdoor` | `{"rect": [x0, y0, x1, y1], "roof": 2.7}`: a covered deck. A slider that opens onto it becomes a doorway you can walk through. |
| `finishes` | `floor`: `oak` \| `tile` \| `concrete` \| `carpet`; `wall`, `cabinet`, `stone`, `splash`: `[r, g, b]`. This is where a claimant's real finishes go. |
| `items` | `{"type", "at": [x, y], "rot": 0 \| 90 \| 180 \| 270, …}`. `at` is the footprint centre; `rot` 0 = back to the south, facing north. Types: `kitchen_run`, `island`, `tall`, `fridge`, `dining`, `sofa`, `armchair`, `coffee_table`, `rug`, `tv_unit`, `art`, `plant`, `floor_lamp`, `pendant`, `bed`, `bedside`, `desk`, `outdoor_table`, `box`. `kitchen_run` takes `sink`, `sink_at`, `cooktop` and `window_gap: [u0, u1]` (local x, no splash or overheads there, so a window over the sink stays open); `island` takes `sink: false` when the plan's island is a plain bench. |
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
- Rooms that are not one rectilinear space: internal walls, curves, stairs, more than one level.
- Reading the plan is done by the nightly scheduled session (an agent with the plan image in front of it), not by code.

## Live homes built with walkgen

- `plans/buildtec-erina.plan.json` → `walk/?p=buildtec-erina` (15 Nov 2026): first home built end to end with `walkgen.py` (3072 atlases, 30 samples, one group per process).

## Queues

- Base: `/api/ops/summary` → `queue.base`, taken nightly (see the repo CLAUDE.md). Photoreal: `scripts/showhaus-photoreal-queue.mjs`.

The builder's plan image is theirs and is not stored here; the JSON records where it came from.
