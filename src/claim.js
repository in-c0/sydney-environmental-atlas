// SHOWHAUS "claim this property": an agent, agency or developer registers a walkthrough as theirs and gets a share link.
//   GET  /api/claim/state?p=<slug>   { property, mine: [claim…], auth } — claims held by this browser (cookie) or account
//   POST /api/claim/submit           multipart: p, mode (guest|signup), role, company, licence (ABN or licence no.), website,
//                                    email, file? (≤ 2 MB PDF/JPG/PNG), anon?, src?, env? → { claim, manage_url }
//   POST /api/claim/manage {token}   the claim behind a private manage link (also re-sets the browser cookie)
//   POST /api/claim/release {token}  the claimant withdraws the claim (share link stops showing their branding)
//   GET  /api/claim/brand?c=<code>   { company } only for a verified claim — what the public walkthrough may show
//   GET  /s/<slug>[/<code>]          the share link → the walkthrough page (with the claimant's line when verified)
//   POST /api/claim/private {id|token, on}   a VERIFIED claimant makes the listing private (or public again). A private walk
//                                    listing shows only "made private at the builder's request": the Worker stops serving its
//                                    scene files (src/worker.js) and /api/claim/public reports { private: true }.
//                                    submit with intent=private asks for the same thing; it applies the moment the claim verifies.
//   POST /api/claim/finishes {id|token}      the claimant asks for their real finishes on the walk. Paid by the claimant
//                                    (storage + AI render); this only records the request and returns the offer
//                                    { price, pay }. Nothing is uploaded, stored or rendered before a price is shown and paid.
//   GET  /pay/finishes?c=<code>&p=<slug>   302 → FINISHES_PAYMENT_LINK (Stripe) when it and FINISHES_PRICE_LABEL are set. The link
//                                    carries client_reference_id=fin_<claim id>; the Stripe webhook (src/ops/stripe.js →
//                                    finishesPaid) marks the request paid, which opens the upload.
//   POST /api/claim/finishes-file    multipart {id|token, file}: one finish photo or schedule (PDF/JPG/PNG ≤ 2 MB, up to 12),
//                                    only for a PAID request. Files are read on the CVF side (/api/ops/claim-file?id=&f=).
// Verification is automatic and never waits on a person, and needs BOTH: the claimant proved the work mailbox with the
// 6-digit email code (src/ops/auth.js session for exactly that address) AND its domain matches the company website's
// domain (free-mail domains never match). Until then the claim is "pending": the share link works, unbranded. A pending
// domain-match claim upgrades by itself the first time that address signs in. Pending claims are listed for CVF in
// /api/ops/summary. Only verified claims ever show the claimant's name (share link, data-by embed).
// Stored: business details the claimant typed (company, ABN/licence, website host), the work-email DOMAIN and an
// HMAC of the address (never the address), a hash of the guest token, the optional evidence file (D1, chunked).
import { db, pseudo, sha256 } from './ops/store.js';
import { track, environmentOf } from './ops/events.js';
import { currentUser, cookieOf, mailMode } from './ops/auth.js';

export const ROLES = { listing_agent: 'Listing agent', principal: 'Agency principal', developer: 'Developer', marketing: 'Marketing agency', builder: 'Home builder' };
export const MAX_FILE = 2 * 1024 * 1024;
const CHUNK = 512 * 1024;                     // D1 caps a row at ~2 MB; files are stored in 512 KB rows
const FILE_BUDGET = 250 * 1024 * 1024;        // all evidence files together (shared free-plan D1); past it, claims save without the file
const PER_IP_HOUR = 6, PER_DAY = 400;
const COOKIE = 'sh_claim', COOKIE_DAYS = 365, MAX_TOKENS = 8;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sh_claims (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, slug TEXT NOT NULL, at TEXT NOT NULL,
     updated_at TEXT NOT NULL, env TEXT NOT NULL, mode TEXT NOT NULL, owner TEXT, token_h TEXT NOT NULL, role TEXT NOT NULL,
     company TEXT NOT NULL, licence TEXT NOT NULL, licence_kind TEXT NOT NULL, website_host TEXT NOT NULL, email_h TEXT NOT NULL,
     email_domain TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, file_name TEXT, file_type TEXT, file_bytes INTEGER,
     actor TEXT, src TEXT)`,
  `CREATE INDEX IF NOT EXISTS sh_claims_slug ON sh_claims (slug, status)`,
  `CREATE TABLE IF NOT EXISTS sh_claim_files (claim_id TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (claim_id, seq))`,
  `CREATE TABLE IF NOT EXISTS sh_claim_rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL, window_start INTEGER NOT NULL)`,
  // A listing made private by a verified claimant; stays private until that claimant turns it back on.
  `CREATE TABLE IF NOT EXISTS sh_private (slug TEXT PRIMARY KEY, claim_id TEXT NOT NULL, at TEXT NOT NULL)`,
  // "Make it private" asked by a claim that is not verified yet; applied when it verifies.
  `CREATE TABLE IF NOT EXISTS sh_private_pending (claim_id TEXT PRIMARY KEY, slug TEXT NOT NULL, at TEXT NOT NULL)`,
  // Real-finishes requests (paid by the claimant). status: requested → (later) paid / delivered.
  `CREATE TABLE IF NOT EXISTS sh_finishes (claim_id TEXT PRIMARY KEY, slug TEXT NOT NULL, at TEXT NOT NULL, status TEXT NOT NULL)`,
  // Finish files (photos, schedules) uploaded after payment; chunked like evidence files.
  `CREATE TABLE IF NOT EXISTS sh_finish_files (claim_id TEXT NOT NULL, file_no INTEGER NOT NULL, seq INTEGER NOT NULL, name TEXT, type TEXT, bytes INTEGER, data BLOB NOT NULL, PRIMARY KEY (claim_id, file_no, seq))`,
  // 2026-11-10: domain match alone no longer verifies. Claims verified under the old rule (reason 'domain_match') go back
  // to pending until the mailbox is proven; proven ones carry reason 'email_confirmed', so this is idempotent.
  `UPDATE sh_claims SET status = 'pending', reason = 'email_unconfirmed' WHERE status = 'verified' AND reason = 'domain_match'`,
];
let ready = null;
async function cdb(env) {
  const d = await db(env);
  if (!d) return null;
  if (!ready) ready = d.batch(SCHEMA.map(s => d.prepare(s))).catch(e => { ready = null; throw e; });
  await ready;
  return d;
}
export function resetClaimsForTests() { ready = null; privateCache.clear(); }

const j = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const rand = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const B32 = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i: easy to read aloud
const shortCode = (n = 6) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => B32[b % B32.length]).join('');
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------- pure rules (unit-tested) ----------
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.com.au',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com', 'yandex.com',
  'bigpond.com', 'bigpond.net.au', 'optusnet.com.au', 'iinet.net.au', 'tpg.com.au', 'internode.on.net', 'outlook.com.au', 'hotmail.com.au', 'live.com.au']);
const SECOND_LEVEL = /^(com|net|org|edu|gov|asn|id|co|ac)\.(au|nz|uk|jp|kr|sg|hk|in|za)$/;
export function siteDomain(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '').replace(/^www\d?\./, '');
  const parts = h.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const last2 = parts.slice(-2).join('.');
  return SECOND_LEVEL.test(last2) && parts.length >= 3 ? parts.slice(-3).join('.') : last2;
}
export function websiteHost(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 200) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    if (!/^https?:$/.test(u.protocol) || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
    return u.hostname.toLowerCase().replace(/^www\d?\./, '');
  } catch { return null; }
}
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*\.[a-z]{2,})$/i;
export const emailDomain = e => { const m = String(e || '').trim().toLowerCase().match(EMAIL_RE); return m ? m[1] : null; };
export const isFreeMail = dom => FREE_MAIL.has(String(dom || '').toLowerCase());

// Australian Business Number: 11 digits, weighted checksum (ATO): subtract 1 from the first digit, Σ wᵢdᵢ ≡ 0 (mod 89).
export function validAbn(raw) {
  const d = String(raw || '').replace(/\s/g, '');
  if (!/^\d{11}$/.test(d)) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const sum = [...d].reduce((s, c, i) => s + w[i] * (Number(c) - (i === 0 ? 1 : 0)), 0);
  return sum % 89 === 0;
}
// "ABN or agency licence no.": 11 digits must be a valid ABN; otherwise a licence/registration number (4–14 letters/digits).
export function parseLicence(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/[\s-]/g, '');
  if (/^\d{11}$/.test(s)) return validAbn(s) ? { kind: 'abn', value: s } : { error: 'That ABN does not check out. Re-check the 11 digits.' };
  if (/^[A-Z0-9]{4,14}$/.test(s)) return { kind: 'licence', value: s };
  return { error: 'Enter your ABN (11 digits) or agency licence number.' };
}
// Domain half of the rule: work-email domain == company-website domain, and neither is free mail.
export function domainCheck(email, website) {
  const ed = emailDomain(email), wh = websiteHost(website);
  if (!ed || !wh) return { match: false, reason: 'invalid' };
  if (isFreeMail(ed)) return { match: false, reason: 'free_mail' };
  if (isFreeMail(siteDomain(wh))) return { match: false, reason: 'free_mail_site' };
  return siteDomain(ed) === siteDomain(wh) ? { match: true, reason: 'domain_match' } : { match: false, reason: 'domain_mismatch' };
}
// The whole rule: verified only when the domain matches AND the mailbox was proven with the emailed code.
export function verdict(email, website, mailboxProven = false) {
  const d = domainCheck(email, website);
  if (!d.match) return { status: 'pending', reason: d.reason };
  return mailboxProven ? { status: 'verified', reason: 'email_confirmed' } : { status: 'pending', reason: 'email_unconfirmed' };
}
// Evidence: sniff the bytes, not the filename. Returns the canonical MIME type or null.
export function sniff(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}
export function validateClaim(f) {
  const errors = {};
  if (!ROLES[f.role]) errors.role = 'Pick your role.';
  const company = clean(f.company, 120);
  if (company.length < 2) errors.company = 'Enter the company name.';
  const lic = parseLicence(f.licence);
  if (lic.error) errors.licence = lic.error;
  const wh = websiteHost(f.website);
  if (!wh) errors.website = 'Enter the company website, e.g. agency.com.au.';
  const ed = emailDomain(f.email);
  if (!ed) errors.email = 'Enter your work email.';
  if (!['guest', 'signup'].includes(f.mode)) errors.mode = 'Choose sign up or guest.';
  return { ok: !Object.keys(errors).length, errors, value: { company, licence: lic.value, licence_kind: lic.kind, website_host: wh, email_domain: ed } };
}

// ---------- helpers ----------
const onShowhaus = url => url.hostname === 'showhaus.app' || url.hostname === 'www.showhaus.app';
const prefix = url => (onShowhaus(url) ? '' : '/showhaus');
export const shareUrl = (url, slug, code) => `${onShowhaus(url) ? 'https://showhaus.app' : url.origin}/s/${slug}${code ? '/' + code : ''}`;
const manageUrl = (url, slug, token) => `${onShowhaus(url) ? 'https://showhaus.app' : url.origin + '/showhaus'}/claim/?p=${slug}#m=${token}`;
const walkEmbed = (url, slug, code) => `<iframe src="${onShowhaus(url) ? 'https://showhaus.app' : url.origin + '/showhaus'}/walk/?p=${slug}${code ? '&by=' + code : ''}&src=embed" title="3D walkthrough on SHOWHAUS" loading="lazy" allowfullscreen style="width:100%;aspect-ratio:16/10;border:0;border-radius:14px"></iframe>`;
const embedOf = (url, slug, code, kind) => kind === 'walk' ? walkEmbed(url, slug, code) : `<script src="${onShowhaus(url) ? 'https://showhaus.app' : url.origin + '/showhaus'}/studio/embed.js" data-project="${slug}"${code ? ` data-by="${code}"` : ''} async></` + 'script>';

async function propertyOf(request, env, slug) {
  if (!/^[a-z0-9-]{3,80}$/.test(slug || '')) return null;
  const u = new URL(request.url);
  // A slug is either a Studio project (massing model) or a walk listing (interior walkthrough, dist/showhaus/walk).
  for (const kind of ['studio', 'walk']) {
    try {
      const r = await env.ASSETS.fetch(new Request(`${u.origin}/showhaus/${kind}/data/${slug}.json`));
      if (!r.ok) continue;
      const data = await r.json().catch(() => null);
      const p = data && data.project;
      if (!p) continue;
      return { slug, kind, name: p.name || slug, address: p.address || '' };
    } catch { /* try the next kind */ }
  }
  return null;
}

function tokensOf(request) { return (cookieOf(request, COOKIE) || '').split('.').filter(t => /^[0-9a-f]{48}$/.test(t)).slice(-MAX_TOKENS); }
function tokenCookie(request, tokens) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${[...new Set(tokens)].slice(-MAX_TOKENS).join('.')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}${secure}`;
}

export function publicClaim(url, c, kind) {
  return {
    id: c.id, slug: c.slug, code: c.code, status: c.status, reason: c.reason, mode: c.mode, role: c.role, role_label: ROLES[c.role],
    company: c.company, website_host: c.website_host, email_domain: c.email_domain, file: c.file_name ? { name: c.file_name, bytes: c.file_bytes } : null,
    at: c.at, share_url: shareUrl(url, c.slug, c.code), embed: embedOf(url, c.slug, c.code, kind),
  };
}

// Fixed-window counter. Keys are pseudonymous (HMAC of the IP), never the raw address; rows expire with the window.
export async function hit(d, key, limit, windowMs, now = Date.now()) {
  const row = await d.prepare('SELECT n, window_start FROM sh_claim_rate WHERE k = ?').bind(key).first();
  if (row && now - row.window_start < windowMs) {
    if (row.n >= limit) return false;
    await d.prepare('UPDATE sh_claim_rate SET n = n + 1 WHERE k = ?').bind(key).run();
    return true;
  }
  await d.prepare('INSERT INTO sh_claim_rate (k, n, window_start) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = 1, window_start = excluded.window_start').bind(key, now).run();
  if (Math.random() < 0.02) await d.prepare('DELETE FROM sh_claim_rate WHERE window_start < ?').bind(now - 2 * 864e5).run();
  return true;
}

async function actorOf(request, env, d, anon) {
  const user = await currentUser(request, env).catch(() => null);
  if (user) return { actor: 'u:' + user.id, user };
  const a = anon || cookieOf(request, 'sh_a');
  return { actor: a ? 'a:' + await pseudo(d, 'anon', String(a).slice(0, 64)) : null, user: null };
}

// ---------- private listings and real finishes ----------
const privateCache = new Map(); // slug → { v, t }: the Worker asks on every scene-file request
const PRIVATE_TTL = 30e3;
async function privateRow(d, slug) { return d.prepare('SELECT claim_id, at FROM sh_private WHERE slug = ?').bind(slug).first(); }
export async function isPrivate(env, slug) {
  if (!/^[a-z0-9-]{3,80}$/.test(slug || '')) return false;
  const hit = privateCache.get(slug);
  if (hit && Date.now() - hit.t < PRIVATE_TTL) return hit.v;
  let v = false;
  try { const d = await cdb(env); v = !!(d && await privateRow(d, slug)); } catch (e) { console.error('private', e && e.message); }
  privateCache.set(slug, { v, t: Date.now() });
  return v;
}
async function setPrivate(env, request, d, row, on, ctx) {
  if (on) {
    await d.prepare('INSERT INTO sh_private (slug, claim_id, at) VALUES (?, ?, ?) ON CONFLICT(slug) DO UPDATE SET claim_id = excluded.claim_id, at = excluded.at').bind(row.slug, row.id, new Date().toISOString()).run();
    await d.prepare('DELETE FROM sh_private_pending WHERE claim_id = ?').bind(row.id).run();
  } else {
    await d.prepare('DELETE FROM sh_private WHERE slug = ? AND claim_id = ?').bind(row.slug, row.id).run();
  }
  privateCache.delete(row.slug);
  const p = track(env, { name: 'listing_private', env: row.env === 'synthetic' ? 'synthetic' : environmentOf(request), source: 'server', actor: row.actor, path: '/api/claim/private', props: { kind: 'claim:' + row.slug, step: on ? 'on' : 'off', cta: row.role } }).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
}
const PAY_HOSTS = /^(buy|checkout)\.stripe\.com$/;
// The offer exists only when BOTH a price label and a Stripe link are configured; otherwise requests are just recorded.
export function finishesOffer(env) {
  const price = clean(env && env.FINISHES_PRICE_LABEL, 40) || null;
  let link = null;
  try { const u = new URL((env && env.FINISHES_PAYMENT_LINK) || ''); if (u.protocol === 'https:' && PAY_HOSTS.test(u.hostname)) link = u.toString(); } catch { /* not configured */ }
  return price && link ? { price, pay: true, link } : { price: null, pay: false, link: null };
}
export const MAX_FINISH_FILES = 12;
// Called by the Stripe webhook with the checkout's client_reference_id.
export async function finishesPaid(env, ref) {
  const m = /^fin_([0-9a-f]{16})$/.exec(String(ref || ''));
  if (!m) return false;
  const d = await cdb(env);
  if (!d) return false;
  const r = await d.prepare("UPDATE sh_finishes SET status = 'paid' WHERE claim_id = ? AND status = 'requested'").bind(m[1]).run();
  return !!(r.meta && r.meta.changes);
}
async function finishFile(request, env, d) {
  let form;
  try { form = await request.formData(); } catch { return j({ error: 'Send the file again.' }, 400); }
  const mine = await heldClaim(request, env, d, { id: form.get('id'), token: form.get('token') });
  if (!mine || mine.status === 'released') return j({ error: 'Open your private manage link first.' }, 404);
  const fin = await d.prepare('SELECT status FROM sh_finishes WHERE claim_id = ?').bind(mine.id).first();
  if (!fin || fin.status === 'requested') return j({ error: 'Uploads open after payment.' }, 402);
  const up = form.get('file');
  if (!up || typeof up !== 'object' || !up.size) return j({ error: 'Choose a file.' }, 400);
  if (up.size > MAX_FILE) return j({ error: 'That file is over 2 MB.' }, 413);
  const bytes = new Uint8Array(await up.arrayBuffer());
  const type = sniff(bytes);
  if (!type) return j({ error: 'Upload a PDF, JPG or PNG.' }, 415);
  const n = (await d.prepare('SELECT COUNT(DISTINCT file_no) AS n FROM sh_finish_files WHERE claim_id = ?').bind(mine.id).first())?.n || 0;
  if (n >= MAX_FINISH_FILES) return j({ error: `That is the limit of ${MAX_FINISH_FILES} files.` }, 409);
  const used = ((await d.prepare('SELECT COALESCE(SUM(file_bytes), 0) AS b FROM sh_claims').first())?.b || 0)
    + ((await d.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM sh_finish_files WHERE seq = 0').first())?.b || 0);
  if (used + bytes.length > FILE_BUDGET) return j({ error: 'Storage is full right now. Nothing was lost; try again later.' }, 507);
  const name = clean(up.name || 'finish', 80).replace(/[^\w. ()-]/g, '_') || 'finish';
  const no = ((await d.prepare('SELECT COALESCE(MAX(file_no), 0) AS m FROM sh_finish_files WHERE claim_id = ?').bind(mine.id).first())?.m || 0) + 1;
  for (let i = 0, seq = 0; i < bytes.length; i += CHUNK, seq++)
    await d.prepare('INSERT INTO sh_finish_files (claim_id, file_no, seq, name, type, bytes, data) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(mine.id, no, seq, name, type, bytes.length, bytes.slice(i, i + CHUNK)).run();
  await d.prepare("UPDATE sh_finishes SET status = 'uploaded' WHERE claim_id = ?").bind(mine.id).run();
  return j({ ok: true, files: n + 1, max: MAX_FINISH_FILES, finishes: 'uploaded' });
}
// The claim this browser or account holds: by manage token, or by id when the cookie / signed-in account covers it.
async function heldClaim(request, env, d, body) {
  if (body.token) return byToken(d, body.token);
  if (!/^[0-9a-f]{16}$/.test(String(body.id || ''))) return null;
  const row = await d.prepare("SELECT * FROM sh_claims WHERE id = ? AND status != 'released'").bind(body.id).first();
  if (!row) return null;
  const hashes = await Promise.all(tokensOf(request).map(t => sha256(t)));
  if (hashes.includes(row.token_h)) return row;
  const user = await currentUser(request, env).catch(() => null);
  return user && (row.owner === 'u:' + user.id || row.email_h === user.id) ? row : null;
}
async function extras(d, slug, claims) {
  const ids = claims.map(c => c.id);
  const priv = await privateRow(d, slug);
  const out = { private: !!priv, private_by_me: !!priv && ids.includes(priv.claim_id), private_pending: false, finishes: null, finish_files: 0 };
  if (ids.length) {
    const q = ids.map(() => '?').join(',');
    out.private_pending = !!(await d.prepare(`SELECT 1 FROM sh_private_pending WHERE claim_id IN (${q}) LIMIT 1`).bind(...ids).first());
    out.finishes = (await d.prepare(`SELECT status FROM sh_finishes WHERE claim_id IN (${q}) LIMIT 1`).bind(...ids).first())?.status || null;
    out.finish_files = (await d.prepare(`SELECT COUNT(*) AS n FROM sh_finish_files WHERE seq = 0 AND claim_id IN (${q})`).bind(...ids).first())?.n || 0;
  }
  return out;
}

// ---------- routes ----------
async function submit(request, env, ctx, d) {
  const url = new URL(request.url);
  let form;
  try { form = await request.formData(); } catch { return j({ error: 'Send the form again.' }, 400); }
  const f = Object.fromEntries(['p', 'mode', 'role', 'company', 'licence', 'website', 'email', 'anon', 'src', 'env', 'intent'].map(k => [k, form.get(k)]));
  const prop = await propertyOf(request, env, String(f.p || ''));
  if (!prop) return j({ error: 'Unknown property.' }, 404);
  const v = validateClaim(f);
  if (!v.ok) return j({ error: 'Check the highlighted fields.', fields: v.errors }, 400);

  const environment = environmentOf(request, { claimed: f.env === 'synthetic' ? 'synthetic' : undefined });
  const ipKey = await pseudo(d, 'ip', request.headers.get('cf-connecting-ip') || 'local');
  if (!(await hit(d, 'ip:' + ipKey, PER_IP_HOUR, 3600e3))) return j({ error: 'Too many claims from this connection. Try again in an hour.' }, 429);
  if (!(await hit(d, 'day:' + new Date().toISOString().slice(0, 10), PER_DAY, 864e5))) return j({ error: 'Claims are busy right now. Try again later.' }, 503);

  // Evidence file (optional).
  let file = null, fileNote = null;
  const up = form.get('file');
  if (up && typeof up === 'object' && up.size > 0) {
    if (up.size > MAX_FILE) return j({ error: 'That file is over 2 MB.', fields: { file: 'Max 2 MB — PDF, JPG or PNG.' } }, 413);
    const bytes = new Uint8Array(await up.arrayBuffer());
    const type = sniff(bytes);
    if (!type) return j({ error: 'Upload a PDF, JPG or PNG.', fields: { file: 'PDF, JPG or PNG only.' } }, 415);
    const used = (await d.prepare('SELECT COALESCE(SUM(file_bytes), 0) AS b FROM sh_claims').first())?.b || 0;
    if (used + bytes.length > FILE_BUDGET) fileNote = 'storage_full';
    else file = { bytes, type, name: clean(up.name || 'evidence', 80).replace(/[^\w. ()-]/g, '_') || 'evidence' };
  }

  const email = String(f.email).trim().toLowerCase();
  const emailH = await pseudo(d, 'email', email);
  const { actor, user } = await actorOf(request, env, d, f.anon);
  const owner = user ? 'u:' + user.id : f.mode === 'signup' ? 'u:' + emailH : null; // a sign-up claim follows the email's account
  const proven = !!user && user.id === emailH; // signed in through the emailed code for exactly this address
  const { status, reason } = verdict(email, f.website, proven);
  const now = new Date().toISOString();
  const src = clean(f.src, 60) || null;

  // One claim per (property, work email): a second submit updates it and keeps the same share link.
  const prev = await d.prepare("SELECT * FROM sh_claims WHERE slug = ? AND email_h = ? AND status != 'released'").bind(prop.slug, emailH).first();
  const token = rand(24);
  const id = prev ? prev.id : rand(8);
  const code = prev ? prev.code : shortCode();
  if (prev) {
    await d.prepare(`UPDATE sh_claims SET updated_at = ?, mode = ?, owner = COALESCE(?, owner), token_h = ?, role = ?, company = ?, licence = ?, licence_kind = ?,
      website_host = ?, email_domain = ?, status = ?, reason = ?, actor = COALESCE(?, actor), src = COALESCE(?, src) WHERE id = ?`)
      .bind(now, f.mode, owner, await sha256(token), f.role, v.value.company, v.value.licence, v.value.licence_kind, v.value.website_host, v.value.email_domain, status, reason, actor, src, id).run();
  } else {
    await d.prepare(`INSERT INTO sh_claims (id, code, slug, at, updated_at, env, mode, owner, token_h, role, company, licence, licence_kind, website_host,
      email_h, email_domain, status, reason, actor, src) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, code, prop.slug, now, now, environment, f.mode, owner, await sha256(token), f.role, v.value.company, v.value.licence, v.value.licence_kind,
        v.value.website_host, emailH, v.value.email_domain, status, reason, actor, src).run();
  }
  if (file) {
    await d.prepare('DELETE FROM sh_claim_files WHERE claim_id = ?').bind(id).run();
    for (let i = 0, seq = 0; i < file.bytes.length; i += CHUNK, seq++)
      await d.prepare('INSERT INTO sh_claim_files (claim_id, seq, data) VALUES (?, ?, ?)').bind(id, seq, file.bytes.slice(i, i + CHUNK)).run();
    await d.prepare('UPDATE sh_claims SET file_name = ?, file_type = ?, file_bytes = ? WHERE id = ?').bind(file.name, file.type, file.bytes.length, id).run();
  }

  const props = { kind: 'claim:' + prop.slug, step: f.mode, cta: f.role, utm_source: src || undefined };
  const evs = [track(env, { name: 'claim_submitted', env: environment, source: 'server', actor, path: '/api/claim/submit', props })];
  if (status === 'verified' && (!prev || prev.status !== 'verified')) evs.push(track(env, { name: 'claim_verified', env: environment, source: 'server', actor, path: '/api/claim/submit', props: { ...props, step: reason } }));
  const p = Promise.all(evs).catch(e => console.error('claim track', e));
  if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;

  const row = await d.prepare('SELECT * FROM sh_claims WHERE id = ?').bind(id).first();
  // "Make it private": a verified claimant gets it at once; otherwise it waits for the mailbox proof.
  if (f.intent === 'private') {
    if (status === 'verified') await setPrivate(env, request, d, row, true, ctx);
    else await d.prepare('INSERT INTO sh_private_pending (claim_id, slug, at) VALUES (?, ?, ?) ON CONFLICT(claim_id) DO NOTHING').bind(id, prop.slug, now).run();
  }
  return j({ ok: true, claim: publicClaim(url, row, prop.kind), manage_url: manageUrl(url, prop.slug, token), file_note: fileNote, updated: !!prev, ...(await extras(d, prop.slug, [row])), offer: (({ price, pay }) => ({ price, pay }))(finishesOffer(env)) }, 200,
    { 'set-cookie': tokenCookie(request, [...tokensOf(request), token]) });
}

async function byToken(d, token) {
  if (!/^[0-9a-f]{48}$/.test(String(token || ''))) return null;
  return d.prepare('SELECT * FROM sh_claims WHERE token_h = ?').bind(await sha256(token)).first();
}

// A signed-in session proves its own address. Domain-matched claims made with that address become verified.
async function confirmMailbox(env, d, user, request) {
  const rows = (await d.prepare("SELECT id, slug, mode, role, actor FROM sh_claims WHERE email_h = ? AND status = 'pending' AND reason = 'email_unconfirmed'").bind(user.id).all()).results;
  if (!rows.length) return 0;
  await d.prepare("UPDATE sh_claims SET status = 'verified', reason = 'email_confirmed', updated_at = ? WHERE email_h = ? AND status = 'pending' AND reason = 'email_unconfirmed'").bind(new Date().toISOString(), user.id).run();
  const environment = user.env === 'synthetic' ? 'synthetic' : environmentOf(request);
  await Promise.all(rows.map(r => track(env, { name: 'claim_verified', env: environment, source: 'server', actor: 'u:' + user.id, path: '/api/claim/state', props: { kind: 'claim:' + r.slug, step: 'email_confirmed', cta: r.role } }))).catch(() => {});
  // Private requests made before the proof take effect now.
  for (const r of rows) {
    if (await d.prepare('SELECT 1 FROM sh_private_pending WHERE claim_id = ?').bind(r.id).first())
      await setPrivate(env, request, d, { ...r, env: environment }, true, null);
  }
  return rows.length;
}

async function state(request, env, d) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('p') || '';
  const prop = await propertyOf(request, env, slug);
  if (!prop) return j({ error: 'Unknown property.' }, 404);
  const user = await currentUser(request, env).catch(() => null);
  if (user) await confirmMailbox(env, d, user, request);
  const hashes = await Promise.all(tokensOf(request).map(t => sha256(t)));
  const conds = [], args = [prop.slug];
  if (hashes.length) { conds.push(`token_h IN (${hashes.map(() => '?').join(',')})`); args.push(...hashes); }
  if (user) { conds.push('owner = ? OR email_h = ?'); args.push('u:' + user.id, user.id); } // the account, or claims made with its address
  const mine = conds.length
    ? (await d.prepare(`SELECT * FROM sh_claims WHERE slug = ? AND status != 'released' AND (${conds.join(' OR ')}) ORDER BY updated_at DESC LIMIT 5`).bind(...args).all()).results
    : [];
  return j({ property: prop, mine: mine.map(c => publicClaim(url, c, prop.kind)), auth: { signedIn: !!user, available: !!mailMode(env) }, ...(await extras(d, prop.slug, mine)), offer: (({ price, pay }) => ({ price, pay }))(finishesOffer(env)) });
}

export async function handleClaim(request, env, ctx) {
  const url = new URL(request.url), path = url.pathname;
  const share = path.match(/^\/s\/([a-z0-9-]{3,80})(?:\/([a-z0-9]{4,12}))?\/?$/);
  if (share) {
    const kind = ((await propertyOf(request, env, share[1])) || {}).kind === 'walk' ? 'walk' : 'studio';
    const to = `${url.origin}${prefix(url)}/${kind}/?p=${share[1]}${share[2] ? '&by=' + share[2] : ''}&src=share`;
    return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } });
  }
  if (path === '/pay/finishes') { // the claimant pays for storing and rendering their finishes; without a configured offer, back to the claim
    const offer = finishesOffer(env);
    const code = (url.searchParams.get('c') || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
    const slug = (url.searchParams.get('p') || '').replace(/[^a-z0-9-]/g, '').slice(0, 80);
    let to = `${url.origin}${prefix(url)}/claim/?p=${slug}`;
    if (offer.link && code) {
      const d = await cdb(env).catch(() => null);
      const row = d && await d.prepare("SELECT c.id FROM sh_claims c JOIN sh_finishes f ON f.claim_id = c.id WHERE c.code = ? AND c.slug = ? AND c.status != 'released' AND f.status = 'requested'").bind(code, slug).first();
      if (row) { const u = new URL(offer.link); u.searchParams.set('client_reference_id', 'fin_' + row.id); to = u.toString(); }
    }
    return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  }
  if (!path.startsWith('/api/claim/')) return null;
  const sameOrigin = (() => { const o = request.headers.get('origin'); if (!o) return true; try { return new URL(o).host === url.host; } catch { return false; } })();
  if (request.method === 'POST' && !sameOrigin) return new Response('forbidden', { status: 403 });
  try {
    const d = await cdb(env);
    if (!d) return j({ error: 'Claiming is not available here yet.' }, 503);
    if (path === '/api/claim/state' && request.method === 'GET') return await state(request, env, d);
    if (path === '/api/claim/public' && request.method === 'GET') { // is this property claimed? Drives the page badge; names only verified claimants.
      const slug = url.searchParams.get('p') || '';
      if (await isPrivate(env, slug)) return j({ claimed: false, company: null, private: true }, 200, { 'cache-control': 'public, max-age=30' });
      const row = /^[a-z0-9-]{3,80}$/.test(slug) ? await d.prepare("SELECT company FROM sh_claims WHERE slug = ? AND status = 'verified' ORDER BY updated_at DESC LIMIT 1").bind(slug).first() : null;
      return j({ claimed: !!row, company: row ? row.company : null, private: false }, 200, { 'cache-control': 'public, max-age=60' });
    }
    if (path === '/api/claim/brand' && request.method === 'GET') {
      const code = (url.searchParams.get('c') || '').toLowerCase();
      const row = /^[a-z0-9]{4,12}$/.test(code) ? await d.prepare("SELECT company, slug FROM sh_claims WHERE code = ? AND status = 'verified'").bind(code).first() : null;
      return j(row ? { company: row.company, slug: row.slug } : {}, 200, { 'cache-control': 'public, max-age=60' });
    }
    if (request.method !== 'POST') return j({ error: 'method' }, 405);
    if (path === '/api/claim/submit') return await submit(request, env, ctx, d);
    if (path === '/api/claim/finishes-file') return await finishFile(request, env, d);
    const body = await request.json().catch(() => ({}));
    if (path === '/api/claim/private' || path === '/api/claim/finishes') {
      const mine = await heldClaim(request, env, d, body);
      if (!mine || mine.status === 'released') return j({ error: 'Open your private manage link first.' }, 404);
      if (path === '/api/claim/private') {
        if (mine.status !== 'verified') return j({ error: 'Confirm your work email first. The home goes private the moment it is confirmed.', pending: true }, 403);
        await setPrivate(env, request, d, mine, body.on !== false, ctx);
        return j({ ok: true, ...(await extras(d, mine.slug, [mine])) });
      }
      const now = new Date().toISOString();
      const had = await d.prepare('SELECT status FROM sh_finishes WHERE claim_id = ?').bind(mine.id).first();
      if (!had) {
        await d.prepare("INSERT INTO sh_finishes (claim_id, slug, at, status) VALUES (?, ?, ?, 'requested')").bind(mine.id, mine.slug, now).run();
        const p = track(env, { name: 'finishes_requested', env: mine.env === 'synthetic' ? 'synthetic' : environmentOf(request), source: 'server', actor: mine.actor, path, props: { kind: 'claim:' + mine.slug, cta: mine.role } }).catch(() => {});
        if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
      }
      const { price, pay } = finishesOffer(env);
      return j({ ok: true, finishes: had ? had.status : 'requested', max_files: MAX_FINISH_FILES, offer: { price, pay }, pay_url: pay ? `${prefix(url)}/pay/finishes?c=${mine.code}&p=${mine.slug}`.replace(/^\/showhaus\/pay/, '/pay') : null });
    }
    const row = await byToken(d, body.token);
    if (path === '/api/claim/manage') {
      if (!row || row.status === 'released') return j({ error: 'This manage link is not valid any more.' }, 404);
      const kind = ((await propertyOf(request, env, row.slug)) || {}).kind;
      return j({ ok: true, claim: publicClaim(url, row, kind) }, 200, { 'set-cookie': tokenCookie(request, [...tokensOf(request), body.token]) });
    }
    if (path === '/api/claim/release') {
      if (!row) return j({ error: 'This manage link is not valid any more.' }, 404);
      await d.prepare("UPDATE sh_claims SET status = 'released', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), row.id).run();
      return j({ ok: true }, 200, { 'set-cookie': tokenCookie(request, tokensOf(request).filter(t => t !== body.token)) });
    }
    return j({ error: 'not found' }, 404);
  } catch (e) {
    console.error('claim', path, e && e.stack || e);
    return j({ error: 'Something went wrong. Please try again.' }, 500);
  }
}

// ---------- CVF read side (called from /api/ops/summary and /api/ops/claim-file, both GitHub-OIDC only) ----------
export async function claimSummary(env) {
  const d = await cdb(env);
  if (!d) return null;
  const counts = {};
  for (const r of (await d.prepare('SELECT env, status, COUNT(*) AS n FROM sh_claims GROUP BY env, status').all()).results) (counts[r.env] ||= {})[r.status] = r.n;
  const pending = (await d.prepare(`SELECT id, at, slug, role, company, licence, licence_kind, website_host, email_domain, reason, file_name, file_bytes, mode
    FROM sh_claims WHERE status = 'pending' AND env = 'production' ORDER BY at DESC LIMIT 50`).all()).results;
  const privateListings = (await d.prepare('SELECT p.slug, p.at, c.company FROM sh_private p LEFT JOIN sh_claims c ON c.id = p.claim_id ORDER BY p.at DESC LIMIT 50').all()).results;
  const privatePending = (await d.prepare('SELECT q.slug, q.at, c.company, c.reason FROM sh_private_pending q LEFT JOIN sh_claims c ON c.id = q.claim_id ORDER BY q.at DESC LIMIT 50').all()).results;
  const finishes = (await d.prepare('SELECT f.claim_id AS id, f.slug, f.at, f.status, c.company, c.status AS claim_status, (SELECT COUNT(*) FROM sh_finish_files x WHERE x.claim_id = f.claim_id AND x.seq = 0) AS files FROM sh_finishes f LEFT JOIN sh_claims c ON c.id = f.claim_id ORDER BY f.at DESC LIMIT 50').all()).results;
  return { counts, pending, private: privateListings, private_pending: privatePending, finishes };
}
export async function claimFile(env, id, fileNo) {
  const d = await cdb(env);
  if (!d || !/^[0-9a-f]{16}$/.test(id || '')) return null;
  if (fileNo) { // a finish file (1-based)
    const rows = (await d.prepare('SELECT name, type, data FROM sh_finish_files WHERE claim_id = ? AND file_no = ? ORDER BY seq').bind(id, Number(fileNo) || 0).all()).results;
    if (!rows.length) return null;
    const parts = rows.map(r => new Uint8Array(r.data));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return new Response(out, { headers: { 'content-type': rows[0].type, 'content-disposition': `attachment; filename="${rows[0].name}"`, 'cache-control': 'no-store' } });
  }
  const meta = await d.prepare('SELECT file_name, file_type FROM sh_claims WHERE id = ?').bind(id).first();
  if (!meta || !meta.file_type) return null;
  const parts = (await d.prepare('SELECT data FROM sh_claim_files WHERE claim_id = ? ORDER BY seq').bind(id).all()).results.map(r => new Uint8Array(r.data));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return new Response(out, { headers: { 'content-type': meta.file_type, 'content-disposition': `attachment; filename="${meta.file_name}"`, 'cache-control': 'no-store' } });
}
