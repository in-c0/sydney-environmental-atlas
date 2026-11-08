// Owner-facing side effects of a Stripe event, run right after it is recorded:
//  1. entitlement ledger (sh_entitlements): a paid checkout opens an "owed" row, a refund marks it "refunded",
//     delivery is marked by CVF through /api/ops/entitlement. Paid-but-not-delivered is then a count, not a guess.
//  2. an immediate mail to the owner for production money events (no 30-minute polling delay). It goes to the
//     business inbox (OPS_ALERT_TO, default hello@showhaus.app, which Email Routing forwards to the owner) through
//     whichever mail route exists: Resend (RESEND_API_KEY) or a Cloudflare send_email binding (MAIL).
// No raw email, card or name is stored or mailed: pseudonymous customer, amount, currency, link id only.
import { getMeta, setMeta } from './store.js';

export const OWNER_ALERT = new Set(['payment_succeeded', 'payment_failed', 'refund', 'dispute']);
const KO = { payment_succeeded: '결제 성공', payment_failed: '결제 실패', refund: '환불', dispute: '분쟁' };

export function entitlementKey(e) {
  const o = e?.data?.object || {};
  return String(o.payment_intent || (o.object === 'payment_intent' ? o.id : null) || o.id || e?.id || '');
}

export async function updateEntitlement(d, e, name, { environment, customer, props }) {
  const key = entitlementKey(e);
  if (!key) return null;
  const now = new Date().toISOString();
  if (name === 'payment_succeeded') {
    await d.prepare(`INSERT INTO sh_entitlements (id, at, env, customer, amount, currency, payment_link, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'owed', ?) ON CONFLICT(id) DO NOTHING`)
      .bind(key, now, environment, customer, props.amount ?? null, props.currency ?? null, props.payment_link ?? null, now).run();
    return 'owed';
  }
  if (name === 'refund' || name === 'dispute') {
    const status = name === 'refund' ? 'refunded' : 'disputed';
    await d.prepare('UPDATE sh_entitlements SET status = ?, updated_at = ? WHERE id = ?').bind(status, now, key).run();
    return status;
  }
  return null;
}

const money = p => p.amount != null ? `${(p.amount / 100).toLocaleString('en-AU', { minimumFractionDigits: 2 })} ${p.currency || ''}`.trim() : '금액 미상';
export function alertMail(name, { props = {}, customer, at }) {
  const t = new Date(at || Date.now()).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour12: false });
  const subject = `[SHOWHAUS] ${KO[name] || name} ${money(props)}`;
  const text = [`${KO[name] || name}: ${money(props)}`, `시각: ${t} AEDT`, `고객(가명): ${customer || '—'}`,
    props.payment_link ? `결제 링크: ${props.payment_link}` : null, props.failure ? `실패 코드: ${props.failure}` : null,
    '', 'Stripe 대시보드: https://dashboard.stripe.com/payments', '— showhaus.app/hooks/stripe (자동 알림, 답장 불필요)'].filter(x => x != null).join('\n');
  return { subject, text };
}

export async function mailOwner(env, msg, fetchImpl = fetch) {
  const to = env.OPS_ALERT_TO || 'hello@showhaus.app';
  const from = env.ALERT_FROM || 'alerts@showhaus.app';
  if (env.RESEND_API_KEY) {
    const r = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: `SHOWHAUS alerts <${from}>`, to: [to], subject: msg.subject, text: msg.text }),
    });
    if (!r.ok) throw Object.assign(new Error('resend ' + r.status), { code: 'RESEND_' + r.status });
    return 'resend';
  }
  if (env.MAIL) { await env.MAIL.send({ to, from: { email: from, name: 'SHOWHAUS alerts' }, subject: msg.subject, text: msg.text }); return 'cloudflare'; }
  throw Object.assign(new Error('no mail route'), { code: 'E_NO_MAIL_ROUTE' });
}

// Called by recordStripeEvent after the event row is written. Never throws: an alert failure must not make
// Stripe retry a webhook we already recorded. The outcome is kept in meta for /api/ops/health.
export async function afterStripeEvent(env, d, e, name, ctx, fetchImpl = fetch) {
  let ent = null;
  try { ent = await updateEntitlement(d, e, name, ctx); } catch (err) { console.error('entitlement', err); }
  if (ctx.environment !== 'production' || !OWNER_ALERT.has(name)) return { entitlement: ent, mailed: false };
  try {
    const via = await mailOwner(env, alertMail(name, ctx), fetchImpl);
    await setMeta(d, 'alert_last_ok', new Date().toISOString());
    return { entitlement: ent, mailed: via };
  } catch (err) {
    await setMeta(d, 'alert_last_error', JSON.stringify({ at: new Date().toISOString(), code: err.code || 'E' })).catch(() => {});
    return { entitlement: ent, mailed: false };
  }
}

export async function entitlementSummary(d) {
  const rows = (await d.prepare("SELECT status, COUNT(*) AS n, MIN(at) AS oldest, SUM(amount) AS amount FROM sh_entitlements WHERE env = 'production' GROUP BY status").all()).results;
  const out = { owed: 0, delivered: 0, refunded: 0, disputed: 0, oldest_owed_at: null, owed_amount: 0 };
  for (const r of rows) { out[r.status] = r.n; if (r.status === 'owed') { out.oldest_owed_at = r.oldest; out.owed_amount = r.amount || 0; } }
  return out;
}

// POST /api/ops/entitlement {id, status: 'delivered'|'owed'} (OIDC). Marks fulfilment; refunds come from Stripe only.
export async function markEntitlement(d, body) {
  if (!body?.id || !['delivered', 'owed'].includes(body.status)) return { status: 400, body: { error: 'id and status delivered|owed' } };
  const r = await d.prepare("UPDATE sh_entitlements SET status = ?, updated_at = ? WHERE id = ? AND status IN ('owed','delivered')").bind(body.status, new Date().toISOString(), String(body.id)).run();
  return { status: r.meta?.changes ? 200 : 404, body: { ok: !!r.meta?.changes } };
}

export async function alertHealth(d) {
  return { alert_last_ok: await getMeta(d, 'alert_last_ok'), alert_last_error: JSON.parse(await getMeta(d, 'alert_last_error') || 'null')?.code ?? null };
}
