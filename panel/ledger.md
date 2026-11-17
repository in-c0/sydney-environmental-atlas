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

## 2026-11-15 — price of "real finishes" per home design (paid by the claimant)
- Panel: the 4 payer personas (3 builders, 1 designer) x 2 models (sonnet, haiku) = 8 answers; price-sensitivity questions (too cheap / good deal / getting expensive / too expensive), no price shown.
- Medians (AUD): too cheap 75, good deal 325, getting expensive 750, too expensive 1200. Haiku answers ran about half of sonnet's. The volume-builder persona named 600-1500 as fair but would not buy from an unknown start-up at any price.
- Stated blocker in 8 of 8: a wrong finish under their brand — they want to see or approve the result before it is public.
- Prediction: a first price near A$290 is inside every payer's acceptable band except the volume builder's "too cheap" line (sonnet: 300); the first paying claimant is a small or mid-size builder with no display home, not a volume builder; nobody pays without an approval step.
- Check against: `claims.finishes` (requests vs paid) once a price is live. Result: open.

## 2026-11-16 — suggest a home by address (autocomplete), then the wording fix
- Panel: 12 personas (`personas-showhaus-walk.json`), one context each, 6 sonnet + 6 haiku, stimulus = live /walk/ (desktop) + the phone autocomplete list; stated actions counted (no SSR, same reason as above). Re-check of the changed wording: 4 personas (S1, S4, S5, S7), 2 sonnet + 2 haiku.
- Round 1 (address-first box): 7 of 12 would submit (6 an address, 1 a plan link), 5 would not (low tech comfort, already has a builder, both builder-side personas). Earlier link-only box (2026-11-15): 2 of 6 would paste, 2 maybe.
- Top objections: (1) "the address of a house that is there, or of my empty block?" (4 of 7 who would type: S1, S3, S5, S7 — land buyers would type their vacant block); (2) "what do I get back, and when?" (S2, S5, O1, B3); (3) the email field reads like spam (S3, S4, S7, B3).
- Shipped: note says a built home is modelled from aerial photos and block owners should paste a plan link; email placeholder "one email, no spam"; success line says the address is modelled from aerial photos and the lot map, the inside is estimated, most-asked first, and it appears in the gallery. Re-check: S1 and S5 now type a built home's address and expect days, not minutes; S4 and S7 (low tech comfort) still would not type anything.
- Predictions: (13) most address suggestions are existing homes near the visitor, but a visible share are vacant blocks or new lots the register does not know yet (`verified:false`); (14) the address box gets several times the use of the link-only box; (15) low tech-comfort visitors still do not use it.
- Check against: `/api/ops/summary` → `suggestions.homes` (`kind`, `verified`) and `home_suggested` events (`method`: address / address:unverified / link). Result: open.

## 2026-11-16 — whole site E2E from the live homepage (Quick, 12 personas, 6 sonnet + 6 haiku)
- Stimulus: 10 live screenshots of showhaus.app in order (homepage map → suburb → budget → what matters → place card → Walk gallery → Avalon → AI walk → upgrade card → claim → Studio). Personas `personas-showhaus-walk.json`, one context each. Scored with SSR (`ssr.py`, bge-small, 4 anchor sets): `r5.txt`.
- Before: 12 of 12 read the homepage as a rental tool ("Find your place in the city"). 4 of 12 left before ever seeing a walk (S2, S3, B3 at budget; S4 at place card). Of those who reached a walk, 4 left at the upgrade card ("One price, in dollars" with no price, "Not open yet", unclear what a vote does). B2 (volume builder) went to legal; B1 would claim. SSR keep-using mean 2.88 (seekers 2.74), claim 2.56.
- Shipped: homepage start screen (walk a home design / check a suburb's rents / builders) with walk posters; "planned" nav items removed; unmeasured "what matters" chips hidden instead of "not measured yet"; trend caption names its months; walk gallery legend (base walk / AI preview / photoreal) and a builders section (claim free, sign-off, private, contact); upgrade card says "not open yet — no price, no date" and takes an optional "email me when it's ready" (`/api/suggest/notify`, key `photoreal:<slug>`); clip chips renamed "AI preview".
- Predictions: (16) share of homepage visits that open a walk rises several-fold vs before (event `start_path` cta=walk + `walk_open` with src=home-start); (17) `start_path` splits walk > rent > builder; (18) emails left on the upgrade card are a small fraction of upgrade_open, but more than zero within two weeks of real traffic.
- Check against: `start_path`, `walk_open`, `upgrade_open`, `upgrade_notify` events. Result: open.
- Re-check (same 12 personas, same model split, after #45): 11 of 12 now read the homepage as "walk NSW home designs in 3D"; paths chosen: walk 8, builders 3, rents 1; 11 of 12 reached a walk (the renter chose rents and got his answer). New weakest step: the upgrade card (8 of 9 walk-path personas stop there: "no price, no date", won't leave an email or vote) and content (only two homes, one builder; "finishes imagined" is not trusted for a decision). SSR barely moved (keep-using 2.88 → 2.76, claim 2.56 → 2.69; bge-small anchors are noisy here), so the gain is in reach, not in intent: `r6.txt`. B2 (volume builder) still wants it private; B1 and B3 would claim.
- Shipped with the re-check: overall room size in metres on the mini plan (the measured fact S3, S6 and O2 asked for).

## 2026-11-17 — retention: what brings people back (24 personas, 6 concepts, order shuffled per persona)
- Panel: the 12 walk personas + 12 new (renters R1–R3, established buyers E1–E3, owners H1–H2, off-the-plan N2, sceptic X1, low-tech X2, sales agent X3) in `/panel` style JSON; sonnet/haiku split; each saw six text concepts in its own order. SSR not run this round (per-concept text not re-entered); counts below are forced single choices, not ratings.
- "The one feature that brings me back": My Build 7 (every build persona, builders, designer), paste-any-listing 5, Hunt board 3, Place watch 3, new-walk alerts 3, rent fair 1, none 2. Reading: people return only while a job is in progress, so SHOWHAUS follows the home lifecycle: hunting (board + paste + alerts), building (My Build, #50), living (Place watch, #51).
- Shipped: Hunt board (#48, canopy fix #52). Re-check on the shipped screens (12 hunting-stage personas): 4 of 12 would return several times a week (R1, R3, E1 and the renewal case R2 around renewal), 5 once or twice a month, 2 not (X1 happy with REA, N2 needs Sydney Airport noise), 1 only for the walks (O1). 9 of 12 would send the share link (partner, flatmates, family).
- Top gaps named: Sydney Airport (Mascot) ANEF noise (N2, R1, X1, E2), road noise and orientation (E1), sold prices for buyers (X1, E2), alerts so they don't paste each listing (R1, E2), a walk of the actual listing (R3, E2).
- Predictions: (19) among visitors who add ≥2 homes, ≥40% return within 14 days; (20) ≥25% of boards with ≥2 homes get shared; (21) renters return more than buyers.
- Check against: `hunt_add`, `hunt_share`, `hunt_comment`, `hunt_view` cta=returning. Result: open.

## 2026-11-17 — the return test: what people do on day 5 and day 20 (12 personas, sonnet/haiku, live site)
- Method change: instead of "would you come back?", each persona follows its own day 0 → day 5 → day 20 after arriving from a Reddit comment, with SHOWHAUS unable to contact them. Asked the old way an hour earlier, 4 of 12 said "several times a week"; walked through their days, 0 of 12 came back. **Stated return intent is worthless here; only the day-by-day walk is used from now on for retention.**
- v1 (board only in the browser): saved the link 0/12, returned day 5 0/12, day 20 0/12. Why: no name recall, the board is trapped in one phone browser, nothing reminds them.
- v2 (#54: board link in the address bar from the first home, send-to-myself / copy / add to home screen): saved or shared the link **11/12** (notes app, email to self, WhatsApp to partner, flatmate group chat); returned day 5 **0/12**, day 20 0/12 (2 "might, for one new address"). The link is now findable, but nobody looks for it.
- What would have pulled them back, in their words: a message when one of their homes changes (rent drop, relisted, leased/sold, new flag) — 6/12; the checks delivered inside what they already use (REA alerts, their spreadsheet, the group chat) — 3/12; a walk of the actual listing — 2/12; a person to call — 1/12.
- Decision: retention needs an outbound trigger. Blocked on a delivery channel: production has no mail route (`/api/auth/me` → `available:false`), and no web-push keys. Change data needs the listing crawl (CVF #604, first run 2026-11-18 03:45) or the Domain API.
- Prediction (22): once alerts exist, day-5 return among people who saved the link > 25%; without them ≤ 5%.

## 2026-11-17 — 10-second gates (new skill protocol): 12 personas × 17 live phone moments, order shuffled per persona
- Real data first: farm-state events 8–17 Nov, 1–19 visitors/day, almost all direct (largely Ji, agents and tests); about 5 visitors did anything; acted sessions lasted 18–63 s. No exit signal existed for view-only visits (fixed: `leave` beacon, #56).
- Pass = stay / tap / open within 10 s. Consumers n=9 (R1 R3 E1 E2 N2 X1 X2 O1 S5), property pros n=3 (B1 B2 X3).
  | Gate | Pass |
  |---|---|
  | E7 listing-kit page (/p/, from an agent's text) | **9/12** — best page; "zoning and flood context is the one thing I don't get from REA" |
  | E2 /hunt/ from a friend's link | 7/12 (consumers 7/9) |
  | E3 walk gallery from Google → E4 viewer | 7/12 → 7/12 |
  | E1 landing from Reddit | **6/12** (consumers 6/9) — "a map of numbers with no clear answer"; buyers read it as a renter site |
  | E5 Studio | 6/12 |
  | F1 map place card | consumers 5/9 — PRO tags read as a paywall (4 mentions) |
  | R2a partner's WhatsApp link → R2b | consumers 8/9 → 7/9 |
  | R3a home-screen icon | consumers 7/9 |
  | R1a self-sent email in inbox → R1b | consumers 8/9 → 5/9 (fixed below: the owner link opened on the empty form, cards below the fold) |
  | E6 claim (pros) / F0 outreach email (pros) | 1/3 / 2/3 |
  | P1 pilot page (pros) | read: B1 stays, X3 leaves (no price shown), B2 leaves |
  | P2 upgrade card | glance: mostly ignore; read: 2 vote, 2 claim, rest leave |
  | P3 Stripe checkout | **0/12** — personal name "Ji Young Kim" as merchant (4 mentions), USD shown first (sandbox IP; adaptive currency), no ABN/invoice/scope (B1) |
- Cross-gate objection: Sydney Airport (Mascot) noise "not checked" — named by 6 personas on R2b/E7/N2 paths; the single most repeated reason a useful screen fails.
- Caveat: R1a/R3a open rates here (8/9, 7/9) are first-impression only; the day-walk test the same morning had 0/12 returning on their own. Gates measure the 10 s after a trigger, not whether the trigger happens.
- Shipped with this entry: owner board opens on its homes (cards first, add box below) — fixes R1b.
- Predictions: (23) real `leave` secs on `/` median < 15 s; on `/p/` pages median > 30 s; (24) once `/p/` pages exist for many addresses, search-landing visitors bounce less than `/` visitors.
