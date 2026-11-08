# SHOWHAUS benchmark: what to copy structurally, what to beat

Research date: 2026-11-08. Scope: Sydney buy/rent search. Method: vendor help pages, product announcements, app-store listings, trade press; Reddit threads read one by one (see §2 for access notes). No listing data was scraped.

> **요약 (KO):** 구조는 REA/Domain의 지도+목록 분할·영역 그리기·학교명 검색, Homely의 동네 Q&A, Landchecker의 레이어 패널, Jitty의 자연어 진입점을 빌립니다. 이기는 지점은 "산 뒤에야 알게 되는 것"(서향 오후 열기, 도로·철도·하역장 소음, 비행경로, 침수, 오염부지)과 숨겨진 가격입니다. 우리 실데이터(도로 중심선, 수관/열, EPA, 태양·3D 그림자, VG 매매기록)가 바로 이 부분을 다룹니다. 단, NSW PSI 매매 데이터는 CC BY-NC-ND이므로 상업적으로 쓰려면 별도 라이선스가 필요합니다.

---

## 1. Five references

### (a) realestate.com.au (REA)

| Pattern | Evidence |
|---|---|
| Map view of buy/rent/sold with clustered pins that drill down (since 2012 for new homes) | [realestatebusiness, 2012](https://www.realestatebusiness.com.au/industry/5790-realestatecomau-launches-map-based-search-tool) |
| **Map draw** (Apr 2026): outline a custom area beyond suburb lines, "follow train lines", see nearby schools/parks/cafes | [Elite Agent, 9 Apr 2026](https://eliteagent.com/from-search-to-savings-realestate-com-aus-autumn-launch-showcases-five-new-features) |
| **AI Search / AI Assistant** (Aug 2026, "NextGen Now"): conversational query layer you can toggle back to filters. Early data: 59% of sessions start broad (lifestyle/commute), 32% include a commute radius, 18% an exact travel time, 40% ask about style/condition, 72% refine at least once | [IT Brief, 12 Aug 2026](https://itbrief.com.au/story/realestate-com-au-launches-ai-property-search-suite); [realestatebusiness](https://www.realestatebusiness.com.au/industry/32322-rea-bets-on-ai-assistance-to-bolster-property-search) |
| AI property assistant on tracked homes: realEstimate, value drivers, similar homes | Elite Agent, Apr 2026 |
| App: closest schools (ACARA data), sold search with auction results and rental history, property value and sales history, saved-search alerts, collections, notes, inspection planner. 4.8★ from 296K ratings | [App Store AU](https://apps.apple.com/au/app/id404667893?l=en-au) |
| Scale: 12.7M Australians per month (Ipsos iris, H2 2025) | Elite Agent, Apr 2026 |
| Self-reported #1 frustration: unpriced listings. 72% of buyers skip them (survey of 6,000+ users) | [OnlineMarketplaces, Oct 2023](https://www.onlinemarketplaces.com/articles/rea-group-survey-finds-missing-prices-to-be-biggest-search-frustration/) |

### (b) Domain

| Pattern | Evidence |
|---|---|
| **Combined map + list** in one view; **recently sold prices (last 6 months) appear as you zoom in**; "market insights" in search (median, change, days on market) | [Domain agent news, 7 Aug 2023](https://agent.domain.com.au/news/exciting-new-features-in-the-domain-app-enhancing-the-search-experience-1228364/); [Elite Agent](https://eliteagent.com/domain-launches-new-app-features-with-a-drive-to-reinvent-search/) |
| **Map finger search**: tap the finger button, draw a freeform shape or a straight line for one street; only listings inside appear | [Domain help](https://help.domain.com.au/hc/en-us/articles/360017457714-Map-finger-search-on-the-Domain-app) |
| **School as the search query**: type a school name to get listings in its catchment. If there is no catchment, fall back to a 5 km radius | [Domain help](https://help.domain.com.au/hc/en-us/articles/360033742314-Search-for-properties-by-school-zone); School Zone launched [Jan 2015](https://www.realestatebusiness.com.au/industry/8601-domain-takes-location-location-location-to-next-level) |
| **My Commutes** (desktop only, login required): save named destinations and modes once, then reuse them on every listing map | [Domain help](https://help.domain.com.au/hc/en-us/articles/36956599841177-My-Commutes) |
| **Perils on the property page**: bushfire-prone, flood-scheme and heritage flags compiled by Archistar from government sources. Labelled "starting point only", with a correction route to the source agency | [Domain help](https://help.domain.com.au/hc/en-us/articles/51577426934553-Understanding-Bushfire-Prone-Flood-Prone-and-Heritage-Zone-Area-Information-on-Domain) |
| Home Price Guide with low/mid/high and a confidence rating; off-market alerts (NSW/VIC/QLD); Research tab | [App Store](https://apps.apple.com/us/app/id319908646) (4.7★, 1.2K US-store ratings) |

### (c) Homely

| Pattern | Evidence |
|---|---|
| **Street and suburb reviews**: user-written, covering safety, community, amenities, schools, parks, transport, dining and medical | [Homely media release](https://homely.com.au/news/media-releases/the-house-is-only-half-of-it-the-key-to-homelys-success-is-hyperlocal-unique-content) |
| **Local Questions** ("ask the locals"): anyone can ask about a street, suburb or city; answers come from residents, agents and businesses; the asker is emailed when someone replies | [Homely help](https://www.homely.com.au/agent-help-centre/find-out-about-our-local-qa) |
| Corpus of 550K+ reviews and questions, dating back to StreetAdvisor (2007). Street, suburb and forum pages carry listing carousels and top local agents | same |

### (d) Jitty (UK). Fast-growth pick #1: AI-native, image-first search

- **Growth evidence:** 500,000 property searches by Nov 2025, growing **25% month on month since launch with zero acquisition spend** ("truly gone viral", per the CEO) ([The Negotiator, 13 Nov 2025](https://thenegotiator.co.uk/news/proptech/jitty-passes-half-a-million-property-searches-as-ai-reshapes-market/)). Up from 250K searches at the US$3.8M seed in Aug 2025, a round **led by REA Group (~10% stake)**, which licenses Jitty's technology to trial image search in Australia ([OnlineMarketplaces, 1 Aug 2025](https://www.onlinemarketplaces.com/articles/jitty-raises-3-8-million-seed-round-led-by-rea-group/)).
- **Structures:** describe the home you want (architectural style, lifestyle) in natural language; image-first results; shortlist, compare, annotate and **share with a partner**. Jitty says 75% of its users prefer natural-language search to filters. It charges agents nothing for listings or leads.

### (e) Landchecker (AU). Fast-growth pick #2: layered map with a parcel panel

- **Growth evidence:** **70% revenue growth in the last financial year**, serving 2,800 organisations and 8,000 paying end users when Tanarra Capital bought control. PEXA exited and RACV remains a minority investor ([Landchecker announcement](https://landchecker.com.au/articles/landchecker-acquisition-announcement/)). Shipping cadence is high: about 10 dated releases between Jun and Nov 2026 ([release notes](https://landchecker.com.au/release-notes)).
- **Structures (from release notes):** one "Map Layers" menu grouped into five categories plus a separate "Base Map"; a **property panel** for the selected parcel; **school catchments as a layer** (Sep 2026); "Proximity Analysis", which merges distance-to and radius tools; Street View pins in a split view with aerial imagery; drawn shapes that **snap to parcel boundaries**; ABS census as a colour-coded overlay; live team collaboration with live cursors. Hazards (flood, bushfire) and planning controls are refreshed daily or weekly from government sources ([careers page](https://landchecker.com.au/careers)).

*Considered but not picked:* Soho/SohoAI (AU) reports "1M+ property matches per week" but no user-growth trajectory ([OnlineMarketplaces, Oct 2026](https://www.onlinemarketplaces.com/articles/product-and-services-roundup-sohoai-idealista-kreedl-dubizzle-group/)). Zillow's ChatGPT app (Oct 2025) and its natural-language search are distribution moves, not evidence of growth. Microburbs has no public growth numbers, but its hidden-price research is cited in §2.

---

## 2. Reddit pain points (≥12, each thread read individually)

**Access note:** reddit.com and old.reddit.com returned 403 or permission timeouts from this environment. Each thread below was opened through a full-page archive of that specific thread: `reddit.sentinel-team.org/posts/<id>/snapshots/...`, plus one `lr.us.psf.lt` Redlib mirror. The original reddit.com URL is listed. Snapshots capture only part of each comment set. r/AusRenovation produced no on-topic thread reachable through a mirror, so r/AusProperty dominates. Paraphrases are mine; quotes are under 15 words.

| # | Pain point | Thread (original URL) | Paraphrase / short quote |
|---|---|---|---|
| P1 | No price guide; buyers resort to browser extensions or the page source to find the agent's hidden range | [r/AusProperty 1tnvvbx](https://reddit.com/r/AusProperty/comments/1tnvvbx/if_you_are_interested_in_a_property_without_a/) | Enquiries go unanswered. Commenters name Property Seeker, Real Estate Mate and Homer, or "view page source". |
| P2 | "Contact Agent" even on **sold** listings; the NSW sold register runs about 90 days behind | [r/AusProperty 1hpg649](https://reddit.com/r/AusProperty/comments/1hpg649/why_is_it_so_hard_to_find_property_prices) | One commenter narrows the price by filtering REA's sold map by price band. "It's normally delayed by 90 days." |
| P3 | Sold data shows homes that were never listed; family transfers appear as cheap "sales" | [r/perth 1rdg9an](https://reddit.com/r/perth/comments/1rdg9an/why_do_sold_prices_show_homes_i_never_saw_listed/) | "Most houses are sold before it hits market." Non-arm's-length sales pollute comparables. |
| P4 | Stale or fake listings stay up for weeks; portals hide listing and price history | [r/melbourne 1tjg50y](https://reddit.com/r/melbourne/comments/1tjg50y/melbourne_rentals_still_advertised_with_upcoming/) | "Some ads are totally fake and stay on market for 1 year". "Domain/RealEstate hide this info." |
| P5 | Wrong status labels persist ("sold at auction" after a private sale, uncorrected for 6 months); many auctions marked "price withheld" | [r/AusFinance 1u0mgpg](https://reddit.com/r/AusFinance/comments/1u0mgpg/sydney_home_listings_hit_17year_high_melbourne/) | An agent mislabel stayed up for six months despite reports. |
| P6 | Aircraft noise: buyers distrust online flight-path maps and want suburbs with low N70 counts near the metro | [r/AusProperty 1pmox2a](https://reddit.com/r/AusProperty/comments/1pmox2a/sydney_suburbs_with_minimal_plane_noise_that_are/) | North Ryde "very noisy". Commenters point to N60/N70 contours. Planes over Dulwich Hill pause Netflix. |
| P7 | Main-road living: noise, "black dust", one-way driveway access; one or two streets back makes a big difference | [r/sydney 1r7uqkw](https://reddit.com/r/sydney/comments/1r7uqkw/north_shore_pacific_highway_living/) | "A street or two back is a big difference." Advice: sit in the car at 10pm with the windows down. |
| P8 | Rail freight noise near an off-the-plan unit in Rhodes; double glazing only partly helps | [r/AusProperty 1r0wx0s](https://reddit.com/r/AusProperty/comments/1r0wx0s/double_glazing_vs_freight_trains/) | "Double glazing reduces noise; it doesn't stop it." Freight trains are "very loud and noticeable." |
| P9 | Non-road nuisance sources: a supermarket loading dock with 5 am deliveries, compactors and smell | [r/AusProperty 1ps49qt](https://reddit.com/r/AusProperty/comments/1ps49qt/how_bad_is_a_townhouse_directly_opposite_a/) | "I'd avoid buying near the loading dock at all costs". Check smell on bin day. |
| P10 | No usable flood map for the Inner West; council PDF reports are low-resolution; buyers fall back on insurance quotes | [r/AusProperty 1ql3vvo](https://reddit.com/r/AusProperty/comments/1ql3vvo/flood_map_for_the_inner_west_in_sydney/) | Not every council has online mapping. Insurers are "pretty reliable" flood signals. |
| P11 | Deal-breakers found late: a west-facing house that was dark inside, stormwater flooding with few insurers, **a contaminated-register site next door that vendors didn't have to disclose** | [r/AusProperty 1qik8yr](https://reddit.com/r/AusProperty/comments/1qik8yr/what_made_you_walk_away_from_a_place_you_actually/) | "Vendors weren't required to disclose it". Get insurance quotes early. |
| P12 | Schools: no single map of public, selective and private options by address; buyers want commute overlays, enrolment cut-offs and catchment-shift risk | [r/AusProperty 1tcl6qd](https://reddit.com/r/AusProperty/comments/1tcl6qd/i_couldnt_find_a_map_with_every_sydney_school/) | A user built a tool to fill the gap. A commenter wants travel-time overlays and catchment-shift risk. |
| P13 | West-facing heat: afternoon sun on black aluminium frames (54 °C) keeps the AC running constantly; NatHERS ratings aren't verified after construction | [r/AusProperty 1qkm6y3](https://reddit.com/r/AusProperty/comments/1qkm6y3/poor_thermal_standards_still/) | West windows plus dark frames: "will the government ever take this seriously?" |
| P14 | Orientation regret: rooms didn't get the right sun at the right time | [r/AusProperty 1sm39sd](https://reddit.com/r/AusProperty/comments/1sm39sd/whats_one_decision_during_your_home_build_that/) | Wanted "the right amount of sun at the right time of day". |
| P15 | Suburb data is paywalled (CoreLogic at $300+/month) or scattered across many government sources | [r/AusProperty 1shkbq5](https://reddit.com/r/AusProperty/comments/1shkbq5/i_built_a_free_property_research_tool_for_aussie/); [1shkfl4](https://reddit.com/r/AusProperty/comments/1shkfl4/most_suburb_data_in_australia_is_either_locked/) | Free government data is fragmented and hard to interpret without explanations. |
| P16 | Flight paths change over time; buyers need *future* contours (new runways) | [r/perth 1rgygtw](https://reddit.com/r/perth/comments/1rgygtw/buying_in_belmont_how_bad_is_the_perth_airport/); [r/brisbane 1ruxxbf](https://reddit.com/r/brisbane/comments/1ruxxbf/best_and_worst_suburbs_for_aircraftflight_path/) | Inside the N65/ANEF contour. "Flight paths tend to move around". A new runway is planned. |
| P17 | Treeless estates act as "massive heatsinks"; big west-facing glazing | [r/brisbane 1plbgu3](https://reddit.com/r/brisbane/comments/1plbgu3/black_roof_and_cladding_on_new_build_can_we_not/) | West glass faces "the blisteringly hot afternoon Western sun." |
| P18 | Flood maps alarm buyers; premiums jumped from $4,200 to $10,600 after a map update | [r/GoldCoast 1srinm2](https://reddit.com/r/GoldCoast/comments/1srinm2/question_about_this_flood_map/) | "Yes these streets flood. Often." Council maps and insurer maps differ. |

**Supplementary (not Reddit, AU, read directly):** OzBargain "most annoying pain point or top 2 wishlist on Domain/REA" ([node/923725](https://www.ozbargain.com.au/node/923725), Sep 2025): no-price filter, misleading wide-angle photos, no floor plan, bathroom counts inflated. OzBargain "features you wish existed" ([node/914181](https://www.ozbargain.com.au/node/914181), Jul 2025): configurable commute isochrones, "not within 100m of train tracks", **"outside of flood zones, bushfire prone area, flight path overlays"**, **shading through the year from nearby trees**, slope and elevation, PM2.5, a 200-pin map cap, hiding non-matching listings. Microburbs (Mar 2026): about 30% of active listings nationally hide price ([research](https://www.microburbs.com.au/research/hidden-prices-blog)).

**Pain frequency tally (threads above plus the OzBargain items):** price hidden or unreliable 6 · sun/orientation/heat 5 · road/rail/nuisance noise 4 (+HousingUK/Charlotte parallels) · flood 4 · aircraft 3 · stale or false listing status 3 · fragmented or paywalled data 3 · contamination 2 · schools/commute 2.

---

## 3. Borrow table (structures, never looks)

SHOWHAUS zones: **Hero** (the live 3D/2D map object) · **Command line** (where-field at the top) · **Lens rail** (Roads/Heat/Records/Trees/Sun toggles) · **Evidence drawer** (progressively revealed right/bottom sheet) · **Time scrubber** (sun/date) · **Pin cards** (listing and sale markers).

| Reference | Structural pattern | Where in SHOWHAUS |
|---|---|---|
| REA | Draw-to-search that can follow a train line | Hero: freehand draw, plus a "corridor" mode that buffers a rail/road line; filters everything in the drawn shape |
| REA | Conversational query that can be toggled back to filters (32% of AI sessions mention commute) | Command line: one input that accepts "3-bed under 1.6M, west-facing ok, <40 min to Central". Parsed chips appear as removable filters |
| REA | "Track this property" → value + drivers loop | Evidence drawer → "Watch" pins a property; re-surfaces new VG sales nearby and layer changes (e.g. new EPA notice) |
| Domain | Map + list in one view; sold pins appear as you zoom in | Hero + a collapsible list strip that never scrolls the page; sold dots (VG PSI) appear at street zoom |
| Domain | School name as the query → catchment, with a 5 km fallback | Command line accepts a school name → catchment polygon on the Hero (NSW DoE intake zones), with an explicit "no catchment, radius shown" state |
| Domain | Saved commutes reused on every listing | Lens rail: "My places" (up to 3 named anchors). Every pin card shows times to them |
| Domain | Perils panel with source attribution, "starting point only" and a correction route | Evidence drawer: every layer row = value · source · record date · "how to verify" link (council certificate, EPA register) |
| Domain | Low/mid/high price guide with confidence | Pin card: VG-sales-derived range with sample count *n* and window; "Not rated" when *n* is too small |
| Homely | Street/suburb reviews by category + ask-the-locals Q&A with reply notifications | Evidence drawer "Locals" tab, anchored to a **street segment**, not a suburb. Questions are prefilled from layer evidence ("Is the freight line loud at night?") |
| Jitty | Image-first natural-language results; shortlist + annotate + share with a partner | Shortlist tray with a shared link; each item keeps its evidence snapshot so a partner sees the same facts |
| Landchecker | Grouped layer menu (categories + separate base map) | Lens rail grouped as Sound / Sun & Heat / Ground & Water / Records / Market; base map switch is separate |
| Landchecker | Property panel for the selected parcel; shapes snap to parcels | Selection snaps to building/parcel (existing building-snap); the panel *is* the evidence drawer |
| Landchecker | Proximity analysis (distance + radius merged) | One "distance to…" ruler in the Hero (road centreline, rail, EPA point, school) replacing separate tools |
| Landchecker | Street View split with aerial imagery | Optional split: Hero 3D + ground-level view at the pin (licensed imagery only) |
| Landchecker | Dated, public release notes | "What changed" ticker in the HUD footer, linked to the data timestamp per layer |

---

## 4. Beat list: top 10 gaps

Score = **pain frequency** (§2 tally, 1–6) × **data fit** (3 = real data already in the atlas; 2 = public data to add, method clear; 1 = weak or indirect).

| Rank | Gap to beat | Freq | Fit | Score | Real data that drives it |
|---|---|---|---|---|---|
| 1 | **Sun and afternoon heat by orientation**: "what will this window get at 4pm in January and at noon in June?" No portal shows it | 5 | 3 | 15 | NOAA solar geometry + OSM `render_height` building shadows (existing, flat-ground, labelled estimate) + NSW 5 m DEM; time scrubber across date/hour; canopy H3 for shading context |
| 2 | **Road and rail proximity before inspection**: "one street back" answered on the map, plus exclusion filters like "not within 100 m of a main road or rail line" | 4 | 3 | 12 | NSW Spatial Services road centrelines (existing) with nearest distance and bearing; add rail centrelines from the same theme and OSM; TfNSW traffic-counter observations shown as counter facts, not dB |
| 3 | **A price signal without the agent**: hidden, stale or mislabelled prices replaced with recorded sales nearby | 6 | 2 | 12 | NSW Valuer General PSI (parser exists): contract date, price, area, with non-arm's-length outliers flagged. **Licence:** CC BY-NC-ND, so commercial use needs a VG PSI licence |
| 4 | **Street-level heat island**: treeless estates vs leafy streets, at the address rather than the suburb | 3 | 3 | 9 | NSW 2024–25 canopy H3 grid (existing); City of Sydney tree register for individual trees; Landsat/NSW urban heat data if licensed |
| 5 | **One screen instead of council PDFs and paywalls**: every fact with its source, date and limit, free | 3 | 3 | 9 | Existing evidence-drawer contract (source, timestamp, "Not rated" when evidence is insufficient); downloadable evidence snapshot (spec milestone 4) |
| 6 | **Flood, including stormwater**: one visible layer instead of council PDFs or insurer guesswork | 4 | 2 | 8 | NSW Planning Portal flood planning/hazard layers where councils publish them; NSW 5 m DEM relative-low-point context (labelled non-hydraulic); clear "council has no online map" state |
| 7 | **Aircraft noise now and in future**: N70/N60 and ANEF contours, plus Western Sydney Airport flight paths | 3 | 2 | 6 | Airservices / Sydney Airport ANEF and N-above contours; WSI flight-path EIS geometry. Show the contour membership the source publishes, never invented dB |
| 8 | **Undisclosed contamination nearby** | 2 | 3 | 6 | NSW EPA notified sites FeatureServer (existing): count within 1 km, nearest, management class, record date |
| 9 | **Listing truth check**: flag when a "for sale" or "price withheld" home already has a VG-recorded sale, or when a "sold" label disagrees with the record | 3 | 2 | 6 | PSI contract/settlement dates joined by Geocoded Addressing Theme (GNAF-quality) address points; only for listings received through legitimate feeds (§5) |
| 10 | **"Visit at 10pm" without driving there**: evidence by time of day for traffic and sun, using the existing time scrubber | 3 | 2 | 6 | TfNSW permanent traffic-counter hourly profiles (shown as the counter's observation, with distance to the counter); solar position by hour. Hourly sound predictions stay "not available" |

Just below the cut: schools (catchment with shift risk) plus personal commute times (freq 2 × fit 2 = 4). The data is NSW DoE school intake zones and TfNSW GTFS isochrones. It is a borrow (Domain/Landchecker already do it) rather than a beat.

**Honesty rule carried over from ENVIRONMENT_ATLAS_SPEC.md:** each beat shows geometry and published records, not a livability grade. Road distance ≠ dB. EPA point ≠ contaminated parcel. Shadow = flat-ground estimate. Missing data ≠ absence of risk.

---

## 5. Legal / ToS constraints and official listing routes

**What the portals forbid**

- **Domain Conditions of Use** ([link](https://www.domain.com.au/group/conditions-of-use/)): cl. 3.1(b)(ix) bans scraping or indexing the products, directly or indirectly, including "data mining, robots, or similar" extraction. Cl. 3.1(b)(x) bans using them to build a property database or derivative product, or to compete with Domain. Inserting tags or pixels is banned. The licence is limited and revocable, for use only under these terms. Framing and caching are expressly banned for Reuters/AP content.
- **realestate.com.au terms of use** and the **Homely terms of use**: the pages could not be fetched from this environment (permission timeout), so verify them by hand before launch. Assume the same no-scrape, no-database, no-frame position.
- **Implication:** do not ship anything like the browser-extension or page-source hidden-price tricks users describe (P1, P2). Do not embed or iframe portal listing pages. Do not mirror portal photos. Link out only.

**Official ways to get listings**

1. **Domain Developer API** ([developer portal](https://developer.domain.com.au/docs/latest/apis/), [FAQ](https://developer.domain.com.au/docs/v1/support/faq/)): 13 packages, including Agents & Listings, Listings Management, Price Estimation, Properties & Locations, Schools Data, Rental AVM and Webhooks. Registration requires a **corporate email**. Plans depend on industry and call volume and are agreed with an account manager; the fetched pages publish no tier names or prices (verify). Go-live conditions in the FAQ: show **"powered by Domain"**, send stats back to Domain, link users to the original listing with a UTM tag, keep agent contact free of paywalls and logins, and keep price estimates free of paywalls. Domain advises **against storing listing data** (about 4,000 updates a day). Agency stats and enquiries need the agency's OAuth authorisation. The API T&Cs page ([link](https://www.domain.com.au/group/api-terms-and-conditions/)) could not be fetched; read it before any build.
2. **REA**: listings reach REA through agency CRMs that upload **REAXML** (create/update/withdraw/sold, validated against a DTD) via the **Partner Portal** (partner.realestate.com.au). **PropTrack APIs** (Listings, Transactions, AVM, at data.proptrack.com) use OAuth2 client credentials and a **commercial agreement through an account manager**; a quota-limited trial exists ([apis.io summary](https://apis.io/providers/rea-group/), secondary source, confirm with REA). Note that REA invests in AI-search challengers (Jitty) instead of opening raw listing access.
3. **Agent-direct REAXML feed (most realistic for SHOWHAUS):** AU agency CRMs already export REAXML to several portals; feed services such as FeedSync consume it ([Easy Property Listings](https://easypropertylistings.com.au/extensions/feedsync-service/), [EAC](https://eac.com.au/real-estate-listing-feeds-third-party-uploads/)). SHOWHAUS becomes an **additional portal destination** that agencies opt into. Their consent covers the data, and price fields (including the "hidden" display-price range) arrive under the agency's terms rather than by scraping.
4. **Sold data:** NSW Valuer General PSI is **CC BY-NC-ND 4.0 (non-commercial)**. A paid product needs a separate PSI licence from Valuer General NSW (see the `scripts/psi-parse.mjs` header). Confirm the OEH licence on the canopy dataset before commercial repackaging (ENVIRONMENT_ATLAS_SPEC.md).

**Unverified items to check:** a Reddit claim that Victoria will require reserve prices a week before auction from Oct 2026 (r/AusFinance 1u0mgpg). The exact Domain API tier names and prices.

---

## 6. Sources that could not be reached (re-check manually)

old.reddit.com search pages · reddit.rtrace.io thread 1c4jhbn · developer.domain.com.au/docs/latest/introduction · domain.com.au/group/api-terms-and-conditions · about.realestate.com.au/terms-of-use · homely.com.au/terms-of-use · the Domain media release (robots-disallowed).
