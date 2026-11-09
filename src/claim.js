// SHOWHAUS "claim this property": an agent, agency or developer registers a walkthrough as theirs and gets a share link.
//   GET  /api/claim/state?p=<slug>   { property, mine: [claim…], auth } — claims held by this browser (cookie) or account
//   POST /api/claim/submit           multipart: p, mode (guest|signup), role, company, licence (ABN or licence no.), website,
//                                    email, file? (≤ 2 MB PDF/JPG/PNG), anon?, src?, env? → { claim, manage_url }
//   POST /api/claim/manage {token}   the claim behind a private manage link (also re-sets the browser cookie)
//   POST /api/claim/release {token}  the claimant withdraws the claim (share link stops showing their branding)
//   GET  /api/claim/brand?c=<code>   { company } only for a verified claim — what the public walkthrough may show
//   GET  /s/<slug>[/<code>]          the share link → the walkthrough page (with the claimant's line when verified)
// Verification is automatic and never waits on a person: the work-email domain must match the company website's
// domain (free-mail domains never match). Anything else stays "pending" and is listed for CVF in /api/ops/summary.
// Stored: business details the claimant typed (company, ABN/licence, website host), the work-email DOMAIN and an
// HMAC of the address (never the address), a hash of the guest token, the optional evidence file (D1, chunked).
import { db, pseudo, sha256 } from './ops/store.js';
import { track, environmentOf } from './ops/events.js';
import { currentUser, cookieOf, mailMode } from './ops/auth.js';

export const ROLES = { listing_agent: 'Listing agent', principal: 'Agency principal', developer: 'Developer', marketing: 'Marketing agency' };
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
];
let ready = null;
async function cdb(env) {
  const d = await db(env);
  if (!d) return null;
  if (!ready) ready = d.batch(SCHEMA.map(s => d.prepare(s))).catch(e => { ready = null; throw e; });
  await ready;
  return d;
}
export function resetClaimsForTests() { ready = null; }

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
// The one verification rule: work-email domain == company-website domain, and neither is free mail.
export function verdict(email, website) {
  const ed = emailDomain(email), wh = websiteHost(website);
  if (!ed || !wh) return { status: 'pending', reason: 'invalid' };
  if (isFreeMail(ed)) return { status: 'pending', reason: 'free_mail' };
  if (isFreeMail(siteDomain(wh))) return { status: 'pending', reason: 'free_mail_site' };
  return siteDomain(ed) === siteDomain(wh) ? { status: 'verified', reason: 'domain_match' } : { status: 'pending', reason: 'domain_mismatch' };
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
const embedOf = (url, slug, code) => `<script src="${onShowhaus(url) ? 'https://showhaus.app' : url.origin + '/showhaus'}/studio/embed.js" data-project="${slug}"${code ? ` data-by="${code}"` : ''} async></` + 'script>';

async function propertyOf(request, env, slug) {
  if (!/^[a-z0-9-]{3,80}$/.test(slug || '')) return null;
  const u = new URL(request.url);
  try {
    const r = await env.ASSETS.fetch(new Request(`${u.origin}/showhaus/studio/data/${slug}.json`));
    if (!r.ok) return null;
    const data = await r.json().catch(() => null);
    const p = data && data.project;
    return { slug, name: (p && p.name) || slug, address: (p && p.address) || '' };
  } catch { return null; }
}

function tokensOf(request) { return (cookieOf(request, COOKIE) || '').split('.').filter(t => /^[0-9a-f]{48}$/.test(t)).slice(-MAX_TOKENS); }
function tokenCookie(request, tokens) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${[...new Set(tokens)].slice(-MAX_TOKENS).join('.')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}${secure}`;
}

export function publicClaim(url, c) {
  return {
    id: c.id, slug: c.slug, code: c.code, status: c.status, reason: c.reason, mode: c.mode, role: c.role, role_label: ROLES[c.role],
    company: c.company, website_host: c.website_host, email_domain: c.email_domain, file: c.file_name ? { name: c.file_name, bytes: c.file_bytes } : null,
    at: c.at, share_url: shareUrl(url, c.slug, c.code), embed: embedOf(url, c.slug, c.code),
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

// ---------- routes ----------
async function submit(request, env, ctx, d) {
  const url = new URL(request.url);
  let form;
  try { form = await request.formData(); } catch { return j({ error: 'Send the form again.' }, 400); }
  const f = Object.fromEntries(['p', 'mode', 'role', 'company', 'licence', 'website', 'email', 'anon', 'src', 'env'].map(k => [k, form.get(k)]));
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
  const { status, reason } = verdict(email, f.website);
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
  return j({ ok: true, claim: publicClaim(url, row), manage_url: manageUrl(url, prop.slug, token), file_note: fileNote, updated: !!prev }, 200,
    { 'set-cookie': tokenCookie(request, [...tokensOf(request), token]) });
}

async function byToken(d, token) {
  if (!/^[0-9a-f]{48}$/.test(String(token || ''))) return null;
  return d.prepare('SELECT * FROM sh_claims WHERE token_h = ?').bind(await sha256(token)).first();
}

async function state(request, env, d) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('p') || '';
  const prop = await propertyOf(request, env, slug);
  if (!prop) return j({ error: 'Unknown property.' }, 404);
  const user = await currentUser(request, env).catch(() => null);
  const hashes = await Promise.all(tokensOf(request).map(t => sha256(t)));
  const conds = [], args = [prop.slug];
  if (hashes.length) { conds.push(`token_h IN (${hashes.map(() => '?').join(',')})`); args.push(...hashes); }
  if (user) { conds.push('owner = ?'); args.push('u:' + user.id); }
  const mine = conds.length
    ? (await d.prepare(`SELECT * FROM sh_claims WHERE slug = ? AND status != 'released' AND (${conds.join(' OR ')}) ORDER BY updated_at DESC LIMIT 5`).bind(...args).all()).results
    : [];
  return j({ property: prop, mine: mine.map(c => publicClaim(url, c)), auth: { signedIn: !!user, available: !!mailMode(env) } });
}

export async function handleClaim(request, env, ctx) {
  const url = new URL(request.url), path = url.pathname;
  const share = path.match(/^\/s\/([a-z0-9-]{3,80})(?:\/([a-z0-9]{4,12}))?\/?$/);
  if (share) {
    const to = `${url.origin}${prefix(url)}/studio/?p=${share[1]}${share[2] ? '&by=' + share[2] : ''}&src=share`;
    return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } });
  }
  if (!path.startsWith('/api/claim/')) return null;
  const sameOrigin = (() => { const o = request.headers.get('origin'); if (!o) return true; try { return new URL(o).host === url.host; } catch { return false; } })();
  if (request.method === 'POST' && !sameOrigin) return new Response('forbidden', { status: 403 });
  try {
    const d = await cdb(env);
    if (!d) return j({ error: 'Claiming is not available here yet.' }, 503);
    if (path === '/api/claim/state' && request.method === 'GET') return await state(request, env, d);
    if (path === '/api/claim/brand' && request.method === 'GET') {
      const code = (url.searchParams.get('c') || '').toLowerCase();
      const row = /^[a-z0-9]{4,12}$/.test(code) ? await d.prepare("SELECT company, slug FROM sh_claims WHERE code = ? AND status = 'verified'").bind(code).first() : null;
      return j(row ? { company: row.company, slug: row.slug } : {}, 200, { 'cache-control': 'public, max-age=60' });
    }
    if (request.method !== 'POST') return j({ error: 'method' }, 405);
    if (path === '/api/claim/submit') return await submit(request, env, ctx, d);
    const body = await request.json().catch(() => ({}));
    const row = await byToken(d, body.token);
    if (path === '/api/claim/manage') {
      if (!row || row.status === 'released') return j({ error: 'This manage link is not valid any more.' }, 404);
      return j({ ok: true, claim: publicClaim(url, row) }, 200, { 'set-cookie': tokenCookie(request, [...tokensOf(request), body.token]) });
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
  return { counts, pending };
}
export async function claimFile(env, id) {
  const d = await cdb(env);
  if (!d || !/^[0-9a-f]{16}$/.test(id || '')) return null;
  const meta = await d.prepare('SELECT file_name, file_type FROM sh_claims WHERE id = ?').bind(id).first();
  if (!meta || !meta.file_type) return null;
  const parts = (await d.prepare('SELECT data FROM sh_claim_files WHERE claim_id = ? ORDER BY seq').bind(id).all()).results.map(r => new Uint8Array(r.data));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return new Response(out, { headers: { 'content-type': meta.file_type, 'content-disposition': `attachment; filename="${meta.file_name}"`, 'cache-control': 'no-store' } });
}
