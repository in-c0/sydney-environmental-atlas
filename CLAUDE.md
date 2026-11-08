# sydney-environmental-atlas

Rules live in one place: [in-c0/Project-harness](https://github.com/in-c0/Project-harness) —
`POLICY.md` (what a session may do), `INFRA.md` (what is already provisioned), `NEEDS_JI.md`
(the only hand-back queue). Read `POLICY.md` before acting. This file carries no policy of its
own; only the facts below.

## This repo
- SHOWHAUS listing kits: `node scripts/showhaus-listing-kit.mjs "<address>" --slug <slug>` → `dist/showhaus/p/<slug>.json` + media; judge `node scripts/showhaus-kit-judge.mjs`. See `docs/showhaus-listing-kit.md`.
- Unit tests: `node --test scripts/showhaus-core.test.cjs scripts/shadow-geometry.test.cjs scripts/showhaus-worker.test.mjs scripts/showhaus-kit.test.cjs`.

Earlier rule files for this repo are archived under `docs/archive/rules/2026-11-08/` and expire
on 2027-02-06 (POLICY.md §8). Open one only if something in this repo stops making sense
without it, and if you did, say which file in your PR description in one line.

Reply to the owner in Korean. Code, commit messages and PR text stay in English.
