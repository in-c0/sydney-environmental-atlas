// Read side for CVF's revenue loop (GitHub OIDC only): aggregates, alertable events since a cursor,
// and pseudonymous journeys for the morning brief's user cases. Plus a public, boolean-only health check.
import { db, getMeta } from './store.js';
import { ALERT_EVENTS } from './events.js';
import { recordStripeEvent } from './stripe.js';

const FUNNEL = ['view', 'search', 'place_card', 'signin_open', 'signup', 'login', 'checkout_started', 'payment_succeeded'];
const j = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const parse = r => ({ ...r, props: r.props ? JSON.parse(r.props) : null });

// Fold an anonymous browser into the account it became (the 'became:u:…' marker written at sign-in).
export function buildJourneys(rows, { limit = 20, maxSteps = 30 } = {}) {
  const alias = new Map();
  for (const r of rows) if (r.name === 'cta' && r.props?.cta?.startsWith('became:')) alias.set(r.actor, r.props.cta.slice(7));
  const by = new Map();
  for (const r of rows) {
    if (!r.actor || (r.name === 'cta' && r.props?.cta?.startsWith('became:'))) continue;
    const who = alias.get(r.actor) || r.actor;
    if (!by.has(who)) by.set(who, []);
    by.get(who).push({ at: r.at, name: r.name, path: r.path, props: r.props || undefined });
  }
  const weight = s => (s.some(x => x.name === 'payment_succeeded') ? 50 : 0) + (s.some(x => x.name === 'checkout_started') ? 40 : 0)
    + (s.some(x => x.name === 'payment_failed' || x.name === 'checkout_abandoned') ? 45 : 0)
    + (s.some(x => x.name === 'signup') ? 20 : 0) + (s.some(x => x.name === 'pro_interest') ? 10 : 0) + Math.min(s.length, 10);
  return [...by.entries()]
    .map(([actor, steps]) => ({ actor, steps: steps.sort((a, b) => a.at.localeCompare(b.at)).slice(-maxSteps) }))
    .filter(x => x.steps.length >= 2 || x.steps.some(s => s.name !== 'view'))
    .sort((a, b) => weight(b.steps) - weight(a.steps) || b.steps.length - a.steps.length)
    .slice(0, limit);
}

export function funnelOf(rows) {
  const out = {};
  for (const step of FUNNEL) out[step] = new Set(rows.filter(r => r.name === step && r.actor).map(r => r.actor)).size;
  out.events_without_actor = rows.filter(r => !r.actor).length;
  return out;
}

export async function health(env) {
  const d = await db(env).catch(() => null);
  return {
    store: !!d,
    mail_binding: !!env.MAIL,
    webhook_secret: !!env.STRIPE_WEBHOOK_SECRET,
    payment_link: !!env.STUDIO_PAYMENT_LINK,
    mail_last_ok: d ? await getMeta(d, 'mail_last_ok') : null,
    mail_last_error: d ? JSON.parse(await getMeta(d, 'mail_last_error') || 'null')?.code ?? null : null,
  };
}

export async function summary(request, env) {
  const d = await db(env);
  if (!d) return j({ store: false, error: 'store not bound' }, 503);
  const u = new URL(request.url);
  const to = u.searchParams.get('to') ? new Date(u.searchParams.get('to')) : new Date();
  const from = u.searchParams.get('from') ? new Date(u.searchParams.get('from')) : new Date(to.getTime() - 24 * 3600e3);
  const since = u.searchParams.get('since') ? new Date(u.searchParams.get('since')) : from;
  const [fromIso, toIso] = [from.toISOString(), to.toISOString()];
  const counts = {};
  const c = await d.prepare('SELECT env, name, COUNT(*) AS n FROM events WHERE at >= ? AND at <= ? GROUP BY env, name').bind(fromIso, toIso).all();
  for (const r of c.results) (counts[r.env] ||= {})[r.name] = r.n;
  const prodRows = (await d.prepare("SELECT id, at, name, actor, path, props FROM events WHERE env = 'production' AND at >= ? AND at <= ? ORDER BY at LIMIT 5000").bind(fromIso, toIso).all()).results.map(parse);
  const alertRows = (await d.prepare(`SELECT id, at, name, env, actor, path, props FROM events WHERE at > ? AND name IN (${[...ALERT_EVENTS].map(() => '?').join(',')}) ORDER BY at LIMIT 200`)
    .bind(since.toISOString(), ...ALERT_EVENTS).all()).results.map(parse);
  const users = await d.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS new FROM users WHERE env = 'production'").bind(fromIso).first();
  const last = await d.prepare('SELECT MAX(at) AS at FROM events').first();
  return j({
    now: new Date().toISOString(), window: { from: fromIso, to: toIso }, store: true,
    counts, funnel: funnelOf(prodRows),
    alerts: alertRows, // all environments; the reader keeps only production for owner pings
    journeys: buildJourneys(prodRows),
    accounts: { production_total: users?.total || 0, production_new: users?.new || 0 },
    last_event_at: last?.at || null,
    health: await health(env),
    webhook_last_event_at: await getMeta(d, 'stripe_last_event_at'),
  });
}

export async function replay(request, env) {
  const e = await request.json().catch(() => null);
  if (!e) return j({ error: 'bad json' }, 400);
  const r = await recordStripeEvent(env, e, { forceEnv: 'synthetic' });
  return j(r.body, r.status);
}
