// SHOWHAUS Pro — the monthly plan for agencies and builders (page dist/showhaus/pro/, showhaus.app/pro/).
//   GET  /pay/pro?plan=<id>&src=<tag>  302 → that plan's Stripe Payment Link (subscription mode) when PRO_LINK_<ID> is set
//                                      (observeCheckout records checkout_started and adds client_reference_id); otherwise
//                                      a `cta` event and back to the page's free-listing form, so the button always works.
//   GET  /api/pro-config               { plans: [{ id, name, price_label, listings, payable }], contact }
//   POST /api/pro/start                { plan, company, email, website?, listing?, plan_url?, src? } — "first listing free":
//                                      the request a business makes before paying anything. Stored in D1 sh_pro_requests
//                                      (the work email is kept only there, never in events); event `pro_start` (server).
// Read side for CVF (OIDC): /api/ops/summary → pro { requests, by_plan, subscriptions } (src/ops/summary.js → proSummary).
// Payment Links are public URLs, not secrets: they live in wrangler.jsonc vars, written by scripts/showhaus-stripe-setup.mjs.
import { db, pseudo } from './ops/store.js';
import { track, environmentOf } from './ops/events.js';
import { hit } from './claim.js';

// One source of truth for what the page and the Worker say a plan is. Prices are AUD per month (shown as the total charged).
export const PLANS = [
  { id: 'agent', name: 'Agent', amount: 14900, listings: 4, line: '4 listings a month' },
  { id: 'agency', name: 'Agency', amount: 50000, listings: 20, line: '20 listings a month for the whole office' },
  { id: 'builder', name: 'Builder', amount: 50000, listings: null, line: 'Every design in your range, kept live' },
];
export const planById = id => PLANS.find(p => p.id === id) || null;
export const priceLabel = p => `AUD ${(p.amount / 100).toLocaleString('en-AU')} a month`;

const PAY_HOSTS = /^(buy|checkout)\.stripe\.com$/;
export function proLink(env, id) {
  const raw = (env && env['PRO_LINK_' + String(id).toUpperCase()]) || '';
  try { const u = new URL(raw); return u.protocol === 'https:' && PAY_HOSTS.test(u.hostname) ? u.toString() : null; } catch { return null; }
}
const pageBase = url => `${url.origin}${url.hostname.endsWith('showhaus.app') ? '' : '/showhaus'}/pro/`;
const tag = s => String(s || 'direct').replace(/[^\w.-]/g, '').slice(0, 60) || 'direct';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sh_claim_rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL, window_start INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sh_pro_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, env TEXT NOT NULL, plan TEXT NOT NULL,
     company TEXT NOT NULL, email TEXT NOT NULL, website TEXT, listing TEXT, plan_url TEXT, src TEXT, status TEXT NOT NULL DEFAULT 'new')`,
];
let ready = null;
async function pdb(env) {
  const d = await db(env);
  if (!d) return null;
  if (!ready) ready = d.batch(SCHEMA.map(s => d.prepare(s))).catch(e => { ready = null; throw e; });
  await ready;
  return d;
}
export function resetProForTests() { ready = null; }
export const STARTS_PER_HOUR = 5;

const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$/i;
const FREE_MAIL = /@(gmail|hotmail|outlook|live|yahoo|icloud|bigpond|optusnet)\./i;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
function httpsUrl(s) { try { const u = new URL(String(s || '').trim()); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().slice(0, 400) : null; } catch { return null; } }

// Pure: validate a free-listing request. Returns { ok, row } or { ok: false, error }.
export function cleanStart(body = {}) {
  const plan = planById(body.plan) ? body.plan : 'agency';
  const company = clip(body.company, 120), email = clip(body.email, 254).toLowerCase();
  if (!company) return { ok: false, error: 'Add your agency or company name.' };
  if (!EMAIL.test(email)) return { ok: false, error: 'Add a work email we can send the finished listing to.' };
  const listing = clip(body.listing, 200) || null, plan_url = httpsUrl(body.plan_url), website = httpsUrl(body.website);
  if (!listing && !plan_url) return { ok: false, error: 'Add the listing address or a link to its floor plan.' };
  return { ok: true, row: { plan, company, email, website, listing, plan_url, src: tag(body.src), free_mail: FREE_MAIL.test(email) } };
}

const j = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function handlePro(request, env, ctx) {
  const url = new URL(request.url), path = url.pathname;
  const later = p => { if (ctx && ctx.waitUntil) ctx.waitUntil(p.catch(() => {})); };
  if (path === '/pay/pro') {
    const plan = planById(url.searchParams.get('plan')) || planById('agency');
    const link = proLink(env, plan.id), src = tag(url.searchParams.get('src'));
    if (!link) later(track(env, { name: 'cta', env: environmentOf(request), source: 'server', actor: null, path, props: { cta: 'pro-' + plan.id, utm_source: src } }));
    const to = link || `${pageBase(url)}?plan=${plan.id}&src=${src}#start`;
    return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  }
  if (path === '/api/pro-config') {
    const contact = EMAIL.test((env && env.STUDIO_CONTACT_EMAIL) || '') ? env.STUDIO_CONTACT_EMAIL : 'hello@showhaus.app';
    return j({ plans: PLANS.map(p => ({ id: p.id, name: p.name, price_label: priceLabel(p), listings: p.listings, line: p.line, payable: !!proLink(env, p.id) })), contact });
  }
  if (path === '/api/pro/start') {
    if (request.method !== 'POST') return j({ error: 'method' }, 405);
    try {
      const d = await pdb(env);
      if (!d) return j({ error: 'This form is not available here. Email hello@showhaus.app instead.' }, 503);
      const c = cleanStart(await request.json().catch(() => ({})));
      if (!c.ok) return j({ error: c.error }, 400);
      const ip = await pseudo(d, 'ip', request.headers.get('cf-connecting-ip') || 'local');
      if (!(await hit(d, 'pro:' + ip, STARTS_PER_HOUR, 3600e3))) return j({ error: 'Too many requests this hour. Email hello@showhaus.app instead.' }, 429);
      const r = c.row, environment = environmentOf(request), now = new Date().toISOString();
      await d.prepare('INSERT INTO sh_pro_requests (at, env, plan, company, email, website, listing, plan_url, src) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(now, environment, r.plan, r.company, r.email, r.website, r.listing, r.plan_url, r.src).run();
      later(track(env, { name: 'pro_start', env: environment, source: 'server', actor: 'b:' + await pseudo(d, 'business', r.email), path,
        props: { kind: r.plan, cta: r.plan_url ? 'plan_url' : 'listing', utm_source: r.src, free_mail: r.free_mail ? 1 : 0 } }));
      return j({ ok: true, plan: r.plan });
    } catch (e) {
      console.error('pro', e && e.message);
      return j({ error: 'Something went wrong. Email hello@showhaus.app instead.' }, 500);
    }
  }
  return null;
}

// CVF read side (called from src/ops/summary.js). Business emails stay out: counts, plans, sources and the open queue
// with company + listing only (CVF needs them to build the free listing; the email is read with /api/ops/pro-request?id=).
export async function proSummary(env) {
  const d = await pdb(env);
  if (!d) return null;
  const rows = (await d.prepare("SELECT id, at, plan, company, listing, plan_url, src, status FROM sh_pro_requests WHERE env = 'production' ORDER BY at DESC LIMIT 200").all()).results;
  const subs = (await d.prepare("SELECT name, COUNT(*) AS n FROM sh_events WHERE env = 'production' AND name IN ('subscription_started','subscription_renewed','subscription_cancelled') GROUP BY name").all()).results;
  const by_plan = {};
  for (const r of rows) by_plan[r.plan] = (by_plan[r.plan] || 0) + 1;
  return { requests: rows.length, open: rows.filter(r => r.status === 'new'), by_plan,
    subscriptions: Object.fromEntries(subs.map(s => [s.name, s.n])) };
}

export async function proRequest(env, id) {
  const d = await pdb(env);
  return d ? await d.prepare('SELECT * FROM sh_pro_requests WHERE id = ?').bind(Number(id) || 0).first() : null;
}
