# Walk pipeline source (plan → base walk)

The scripts that produced `dist/showhaus/walk/data/buildtec-avalon/`. They are kept here so a new session can
re-run or extend them; before this they lived only in one chat's workspace.

| File | What it does |
|---|---|
| `avalon.json` | The plan as data: room outline, openings, joinery, furniture boxes, cameras, and every assumption the plan does not give. |
| `build.py` | Blender (`bpy`): proxy boxes from the JSON, one render per camera, per-pixel world XYZ (`.npy`) for generative steps. |
| `avalon.py` | Blender: the full living-zone scene; `preview` (16 samples, fix exposure here) or `bake` (Cycles COMBINED to UV atlases per group). |
| `avgen.py` | Baked atlases + meshes → `room.js` (`window.ROOM`) and `atlas_*.jpg` for the viewer. |

Run with Blender's Python (`blender -b -P avalon.py -- preview`). Paths at the top of each script point at the original
workspace (`/home/claude/showhaus/…`); change them first. Bake limits and known dead ends are in the
`plan-to-walkthrough` skill.

**Not automated yet:** `avalon.py` is written for this one plan. A second home needs its own plan JSON and scene script;
the generic "any plan JSON → scene" builder does not exist. The order of homes to build is `/api/ops/summary` → `queue.base`.

The plan image itself is the builder's and is not stored here; `avalon.json` records its source.
