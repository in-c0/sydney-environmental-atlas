# Synthetic panel ledger

Predictions are recorded before real traffic and checked against it afterwards. Running hit rate: 0 of 0 checked (12 predictions open, no real traffic compared yet).

## 2026-11-13 · SHOWHAUS walk: viewer, upgrade card, claim (Quick, 12 personas × 2 models)

Stimulus: screenshots of /walk/, /walk/?p=buildtec-avalon (base walk, AI walk clip, upgrade card) and the claim page. Personas: `personas-showhaus-walk.json`. Responses: `r1.txt` (card v1), `r2.txt` (card v2, 6 personas, one model). Scoring: `ssr.py`.

Predictions to check against PostHog / D1 events (`walk_open`, `walk_room`, `upgrade_open`, `upgrade_interest`, `claim_started`, `claim_submitted`):

1. Home seekers use the base walk for layout but do not pay for a photoreal walk of an unclaimed home. Predicted weakest step: paying before the home is claimed.
2. After the card change ("Vote for this home — free", no "credits"), the share of card openers who tap the vote rises. Panel: 0 of 6 said they would tap before, 4 of 6 after (1 more "might").
3. Of builder-side visitors, small custom builders and marketing staff claim; a volume builder's sales manager does not and refers it to legal.
4. Ranking of who would pay once a price exists: small custom builder > builder marketing > home seeker with own plan > home seeker browsing a catalogue design > renter.

Not yet checked. SSR note: with `bge-small-en-v1.5` the distributions bunch around the middle and did not separate clear refusals from clear yeses, so the counts above come from the stated actions in the text, not from SSR means.

## 2026-11-13 · SHOWHAUS walk: cancel vote (Quick, 12 personas × 2 models, between-subjects)

Variants: N = card without cancel (live at the time), C = "You can cancel it any time" before voting and "Cancel vote" after. Each persona saw one variant per model; 6 per variant per model. Responses: `r3.txt`; 4-persona re-check of the changed wording: `r4.txt`.

Stated actions: 8 of 12 would tap the vote in N, 8 of 12 in C (Sonnet 5/6 and 5/6, Haiku 3/6 and 3/6). 4 of the 8 C voters gave "I can cancel" as a reason. Nobody said they would cancel. SSR means: Sonnet 2.76 vs 2.76, Haiku 2.84 vs 2.93 (same flat shape as before).

Predictions to check against `upgrade_interest` and `upgrade_interest_cancel`:

5. Adding cancel does not change the share of card openers who vote (ranking: C ≈ N).
6. Cancels are rare: well under one cancel per ten votes.
7. Predicted weakest step after voting: "nothing happens next". Voters leave the card without claiming or returning unless a price or a date appears.
8. Builder-side visitors do not vote on an unclaimed home; they go to claim (or to legal).

Not yet checked.

## 2026-11-15 · SHOWHAUS walk: whole visit, with the vote promise (Quick, 12 personas × 2 models)

Funnel and quotes: `journey-2026-11-15.md`. Decision: ship the promise and two wording changes (AI clip label says what is real and what is imagined; limits and refunds fold under one line).

Predictions to check against real events:

9. Of visitors who open a walk, most reach an AI walk; the largest drop is at the upgrade card, not in the viewer.
10. Return visits stay low while the gallery holds one home: the top reason given is "only one home / not a home I am considering".
11. The vote promise does not by itself bring voters back; a price or a date would.
12. Of builder-side visitors who open the claim form, about half submit; the ones who do not want to know what claiming changes on the page first.

Not yet checked.

## 2026-11-15 — no-login inputs on the walk (suggest a home / report a mistake), wording A vs B
- Panel: 12 personas (`personas-showhaus-walk.json`), 6 per wording, between-subjects; 6 sonnet + 6 haiku; counted stated actions (no SSR).
- A ("Want to walk another home? Paste a link to its floor plan." / "Something wrong? Tell us"): box 2 paste, 2 maybe, 2 ignore; report 1 send, 4 maybe, 1 ignore.
- B ("Which home should we build next? Paste its floor plan link." / "Spot a mistake? Fix it in one line"): box 3 paste, 1 maybe, 2 ignore; report 1 send, 4 maybe, 1 ignore.
- Prediction: wording makes no measurable difference (shipped A). The suggest box gets more use than the report link; reports arrive only when a room is visibly wrong. Low tech-comfort visitors skip the box (they do not know what a plan link is); builders paste their own designs.
- Check against: `/api/ops/summary` → `suggestions.homes` vs `suggestions.fixes` counts and `home_suggested` / `fix_reported` events once real traffic exists. Result: open.
