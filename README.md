# Sydney Environmental Atlas

An interactive, evidence-aware map for exploring environmental context around buildings and places in Sydney, NSW.

**[Try the live atlas](https://sydney-sound-atlas-ava.wldud5192.chatgpt.site/)**

## Explore

- **Map / Aerial / Hybrid**, with 2D and 3D perspectives where WebGL2 is available.
- Independently toggle **Roads**, **Heat**, **Records**, and **Trees**.
- Select a nearby building first; switch to **Pin exact point** for unsnapped coordinates.
- Inspect source context, published observations and uncertainty progressively.

## An important distinction

This is an exploratory environmental evidence viewer, **not an acoustic measurement instrument, an address-level decibel predictor, or a validated five-star livability rating**.

Directional road petals show relative mapped road geometry, not measured noise direction or intensity. Road proximity alone is neither proof of noise exposure nor a livability penalty. Traffic-counter observations describe measurements at the counter, not sound at the selected home. Missing regulatory records do not prove absence of environmental risk.

The interface deliberately shows **Not rated** and data uncertainty where the evidence is insufficient to support an overall livability score.

## Run locally

No build step is needed. Serve the `dist` directory rather than opening the HTML file directly, because the map loads local data assets.

```sh
python3 -m http.server 4173 --directory dist
```

Open [http://localhost:4173](http://localhost:4173).

## Tests

Requires a recent Node.js version.

```sh
node --test scripts/*.test.cjs
```

The tests cover building-point selection, directional geometry, source assumptions, layer toggles, lens transitions, 3D helpers, sun shadows, traffic evidence, and registered tree dimensions. Browser visual verification on a WebGL2-capable device is still needed for full 3D confidence.

## Cloudflare Pages deployment

For Git-connected Cloudflare Pages, this repository is a static site:

- Framework preset: **None**
- Build command: **None**
- Build output directory: **dist**
- Production branch: **main**

The site loads public external map and environmental services at runtime; those services can be unavailable, out of date, or incomplete.

## Source and attribution

See [ENVIRONMENT_ATLAS_SPEC.md](./ENVIRONMENT_ATLAS_SPEC.md) and the atlas's **Information** control for source coverage, interpretation, and limitations. Map attribution remains visible in the app.

No open-source licence has been granted by this repository's publication alone.
