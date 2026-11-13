# sydney-environmental-atlas

Rules live in one place: [in-c0/Project-harness](https://github.com/in-c0/Project-harness) —
`POLICY.md` (what a session may do), `INFRA.md` (what is already provisioned), `NEEDS_JI.md`
(the only hand-back queue). Read `POLICY.md` before acting. This file carries no policy of its
own; only the facts below.

## This repo
- SHOWHAUS Studio (exterior 3D massing model for agencies; never call it a walkthrough — that word is for interiors you walk, `walk/`): page `dist/showhaus/studio/` (showhaus.app/studio/?p=<slug>), embed `studio/embed.js`, pilot `studio/pilot.html`, Worker routes `src/studio.js` (`/pay/studio-pilot`, `/api/studio-config`).
- Studio data: `python3 scripts/showhaus_studio_build.py <slug>` reads `showhaus/studio/<slug>.source.json` (figures + URLs from the planning documents) → `dist/showhaus/studio/data/<slug>.json`. Email kit: `node scripts/showhaus-studio-kit.mjs <slug>` (Playwright + ffmpeg). Judge: `node scripts/showhaus-studio-judge.mjs`; unit tests: `node --test scripts/showhaus-studio.test.mjs`.
- SHOWHAUS listing kits: `node scripts/showhaus-listing-kit.mjs "<address>" --slug <slug>` → `dist/showhaus/p/<slug>.json` + media; judge `node scripts/showhaus-kit-judge.mjs`. See `docs/showhaus-listing-kit.md`.
- SHOWHAUS claim flow: page `dist/showhaus/claim/` (showhaus.app/claim/?p=<slug>), Worker `src/claim.js` (`/api/claim/*`, share links `/s/<slug>/<code>`; D1 tables `sh_claims`, `sh_claim_files`, `sh_claim_rate` in OPS_DB). Verified = emailed 6-digit code confirmed for that work address AND its domain matches the company website (domain match alone stays pending); pending claims + evidence files are on the CVF OIDC side (`/api/ops/summary` → `claims`, `/api/ops/claim-file?id=`). Tests: `node --test scripts/showhaus-claim.test.mjs`; click-through `node scripts/showhaus-claim-judge.mjs --base <url>` (`--explainer` re-records the 10 s video, `--email` re-renders the draft email previews in `showhaus/outreach/claim-arncliffe-central/`).
- SHOWHAUS walk (interior walkthroughs, base tier → photoreal tier): gallery `dist/showhaus/walk/` (showhaus.app/walk/), one home `showhaus.app/walk/?p=<slug>`. A listing is `walk/data/<slug>.json` (`project` for the claim flow, `listing.source` = `plan` | `estimate` picks the basis line) + `walk/data/<slug>/` (`room.js` baked mesh, `atlas_*.jpg`, photoreal `photo*.jpg` / clips named in `room.js` views, `poster.jpg`) + one row in `walk/data/index.json` (`lngLat` = map pin, `null` = gallery only). Scene files come from the plan-to-walkthrough pipeline (Blender bake, outside this repo). Claim reuses `src/claim.js` (a slug is a Studio project or a walk listing; `/api/claim/public?p=` drives the Owner-claimed badge). `upgrade_interest` events are the demand count for the photoreal tier (net of `upgrade_interest_cancel`), and the card promises visitors that homes with the most votes are made photoreal first — the render queue must follow that order; no price is shown until GPU cost per home is set. Tests: `node --test scripts/showhaus-walk.test.mjs`; click-through, desktop + phone: `node scripts/showhaus-walk-judge.mjs` (starts `scripts/showhaus-local-worker.mjs`, the real Worker on localhost; `--poster` re-renders the poster).
- Unit tests: `node --test scripts/showhaus-core.test.cjs scripts/shadow-geometry.test.cjs scripts/showhaus-worker.test.mjs scripts/showhaus-kit.test.cjs`.

Earlier rule files for this repo are archived under `docs/archive/rules/2026-11-08/` and expire
on 2027-02-06 (POLICY.md §8). Open one only if something in this repo stops making sense
without it, and if you did, say which file in your PR description in one line.

Reply to the owner in Korean. Code, commit messages and PR text stay in English.
