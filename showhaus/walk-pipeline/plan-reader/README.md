# Floor-plan image → plan JSON (next card, scoped 17 Nov 2026)

Goal: a listing's floor-plan image (JPG/PNG/PDF page) becomes a plan JSON that `walkgen.py check` accepts and the arrange
page (`showhaus.app/arrange/`) opens — without a person or an agent reading the plan by hand. CPU or open-source only;
no hosted model API.

## Baseline measured today: `read_plan.py` (OpenCV + Tesseract, CPU)

```
python3 read_plan.py <plan.png> [--debug out.png] [--json out.json]     # GAP_K, MEASURE=ray are experiment knobs
```

Walls = dark pixels opened with a 3 px kernel (thin furniture/text lines drop out); rooms = free space with door openings
closed, inside the house outline; labels = Tesseract word boxes joined per line ("4.2 x 4.2", including OCR's lost dots
"42x42"); scale = median of region size / printed size; each room is then measured with the scale fitted on the other
rooms (leave-one-out) and compared with its printed size. Printed sizes are rounded to 0.1 m.

Two public builder plans (the ones our hand-made Erina and Avalon plans came from), 1000 × 1000 px:

| Plan | Size labels read | Rooms matched | Scale (px/m) | Room size error (median) | Within 0.30 m |
|---|---|---|---|---|---|
| Buildtec Erina | 12 of 14 rooms | 7 | 35.3 (by hand: ≈ 34.7) | 0.88 m | 2 / 7 |
| Buildtec Avalon | 13 | 6 | 34.9 | 1.17 m | 0 / 6 |

What works: **reading the printed sizes and the scale** (12–13 labels per plan, scale within ~2% of a hand measurement on
both plans; the two plans agree with each other). What does not: **room geometry from morphology** — rooms leak into
halls through doorways (Avalon's hall and entry merge into one 14 m region), open-plan zones have no walls between them,
and closing door gaps harder erases small rooms (robes, WIP, HER/HIS). Rays cast from each label to the nearest wall
(MEASURE=ray) were worse (median 1.3 m and 4.5 m). Not usable for "will my sofa fit" yet: the arrange page needs ≤ 0.1 m.

## The next card

1. **Walls and openings from a segmentation model, run on the CPU.** Candidates to try, licence first:
   - Raster-to-Vector (Liu et al., ICCV 2017; code public) — junction detection + integer programming gives clean rectilinear walls, doors, windows.
   - Models trained on CubiCasa5k — accurate on Nordic plans, but the dataset is CC BY-NC 4.0: **non-commercial only**, so weights trained on it cannot ship in SHOWHAUS. Check every checkpoint's training data.
   - FloorplanToBlender3d (open source, OpenCV) — same family as the baseline; useful for wall vectorisation after a better mask.
   - Train our own small U-Net on CPU-friendly sizes from plans we already transcribe by hand (each nightly plan JSON + its image is a labelled pair).
2. **Keep what already works:** Tesseract labels → scale and room names; snap every wall to the printed sizes (a room labelled
   3.4 × 3.2 must come out 3.4 × 3.2 within rounding) — this turns ~1 m errors into a constraint problem.
3. **Accuracy test (the gate for shipping it):** ≥ 10 public NSW plans (builders' sites, strata plans), per-room size error
   vs printed sizes, door/window count vs hand count, and `walkgen.py check` pass rate. Ship when the median room error is
   ≤ 0.10 m and ≥ 90% of rooms are within 0.15 m; below that, use it only to pre-fill the hand/agent transcription.
4. **Human check stays:** the arrange page shows the plan image under the extracted walls (toggle) so the person who sent
   it can see any mismatch before sharing.

Public plan images are fetched only to measure; they are not stored in this repo.
