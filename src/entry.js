// Deployed entry (wrangler.jsonc main). Kept apart from src/worker.js so Node tests and the local judge Worker can import
// worker.js without the Workers-only 'cloudflare:workers' module.
import { WorkerEntrypoint } from 'cloudflare:workers';
import worker from './worker.js';
import { summary as opsSummary } from './ops/summary.js';
export { AuRelay } from './au-relay.js';

// Read side for CVF without GitHub OIDC (Actions were retired 2026-11-18, so nothing can mint that token any more):
// a named entrypoint only a service binding from the owner's own Cloudflare account can reach (CVF ji-line binds it as
// SHOWHAUS_OPS, same pattern as Sumzup's OpsFeed). Returns exactly what /api/ops/summary returns.
export class OpsFeed extends WorkerEntrypoint {
  async summary(q = {}) {
    const u = new URL('https://showhaus.app/api/ops/summary');
    for (const k of ['from', 'to', 'since']) if (q[k]) u.searchParams.set(k, String(q[k]));
    const r = await opsSummary(new Request(u), this.env);
    return { status: r.status, body: await r.json() };
  }
}

export default worker;
