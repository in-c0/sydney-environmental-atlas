// A Durable Object placed in Oceania (locationHint 'oc') that fetches the one public GIS server SHOWHAUS needs from an
// Australian vantage: Randwick City Council's Sydney Airport ANEF 2039 MapServer resets connections from outside Australia,
// and a Worker request served in IAD or elsewhere egresses there. Only that host is allowed; the whole contour set (4 band
// layers as GeoJSON) is fetched at most once a month and kept in the object's storage.

export const ANEF_BASE = 'https://mapservices.randwick.nsw.gov.au/arcgis/rest/services/intPlanning/ANEF2039/MapServer';
const LAYERS = [[0, '35+'], [1, '30-35'], [2, '25-30'], [3, '20-25']];
const MAX_AGE = 30 * 864e5;

// Plain class (no cloudflare:workers import) so Node tests can load the Worker module.
export class AuRelay {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const want = new URL(request.url).pathname;
    if (want !== '/anef2039') return new Response('not found', { status: 404 });
    const kept = await this.ctx.storage.get('anef2039');
    if (kept && Date.now() - kept.at < MAX_AGE) return Response.json(kept.fc);
    // Randwick answers this relay with 403 (2026-11-17): a refusal is respected, not retried per visitor — one try a day.
    const failed = await this.ctx.storage.get('anef2039-failed');
    if (failed && Date.now() - failed.at < 864e5) return kept ? Response.json(kept.fc) : Response.json({ error: failed.error, since: new Date(failed.at).toISOString() }, { status: 502 });
    try {
      const features = [];
      for (const [layer, band] of LAYERS) {
        const q = new URLSearchParams({ where: '1=1', outFields: 'anef', outSR: '4326', returnGeometry: 'true', geometryPrecision: '6', f: 'geojson' });
        const r = await fetch(`${ANEF_BASE}/${layer}/query?${q}`, { headers: { accept: 'application/geo+json, application/json', 'user-agent': 'showhaus.app ANEF check (monthly)' }, signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error('layer ' + layer + ' http ' + r.status);
        const d = await r.json();
        if (d.error || !Array.isArray(d.features) || !d.features.length) throw new Error('layer ' + layer + ' empty');
        for (const f of d.features) features.push({ type: 'Feature', geometry: f.geometry, properties: { band, anef: f.properties && f.properties.anef, layer } });
      }
      const fc = { type: 'FeatureCollection', source: { name: 'Sydney Airport ANEF 2039 (Airservices-endorsed)', gis: ANEF_BASE, fetched: new Date().toISOString(), by: 'SHOWHAUS AuRelay (Oceania)' }, features };
      await this.ctx.storage.put('anef2039', { at: Date.now(), fc });
      return Response.json(fc);
    } catch (e) {
      await this.ctx.storage.put('anef2039-failed', { at: Date.now(), error: String(e && e.message || e).slice(0, 200) });
      if (kept) return Response.json(kept.fc); // stale beats nothing; the fetched date is in the file
      return Response.json({ error: String(e && e.message || e) }, { status: 502 });
    }
  }
}
