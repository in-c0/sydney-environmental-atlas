# sydney-environmental-atlas

Rules live in one place: [in-c0/Project-harness](https://github.com/in-c0/Project-harness) —
`POLICY.md` (what a session may do), `INFRA.md` (what is already provisioned), `NEEDS_JI.md`
(the only hand-back queue). Read `POLICY.md` before acting. This file carries no policy of its
own; only the facts below.

## This repo
- SHOWHAUS Studio (3D walkthrough for agencies): page `dist/showhaus/studio/` (showhaus.app/studio/?p=<slug>), embed `studio/embed.js`, pilot `studio/pilot.html`, Worker routes `src/studio.js` (`/pay/studio-pilot`, `/api/studio-config`, `/api/e`).
- Studio data: `python3 scripts/showhaus_studio_build.py <slug>` reads `showhaus/studio/<slug>.source.json` (figures + URLs from the planning documents) → `dist/showhaus/studio/data/<slug>.json`. Email kit: `node scripts/showhaus-studio-kit.mjs <slug>` (Playwright + ffmpeg). Judge: `node scripts/showhaus-studio-judge.mjs`; unit tests: `node --test scripts/showhaus-studio.test.mjs`.

Earlier rule files for this repo are archived under `docs/archive/rules/2026-11-08/` and expire
on 2027-02-06 (POLICY.md §8). Open one only if something in this repo stops making sense
without it, and if you did, say which file in your PR description in one line.

Reply to the owner in Korean. Code, commit messages and PR text stay in English.
