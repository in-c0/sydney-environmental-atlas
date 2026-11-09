// SHOWHAUS operations store (D1, binding OPS_DB). Holds pseudonymous events, login codes, sessions and
// webhook dedupe ids. No raw email, IP or payment detail is ever written: emails and customer ids are
// HMAC-ed with a key that is generated on first use and kept in the `meta` table (never in the repo).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sh_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sh_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, name TEXT NOT NULL,
     env TEXT NOT NULL, source TEXT NOT NULL, actor TEXT, path TEXT, props TEXT)`,
  `CREATE INDEX IF NOT EXISTS sh_events_at ON sh_events (at)`,
  `CREATE TABLE IF NOT EXISTS sh_users (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, env TEXT NOT NULL, last_login_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sh_codes (email_h TEXT PRIMARY KEY, code_h TEXT NOT NULL, exp INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0,
     sent_count INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sh_sessions (token_h TEXT PRIMARY KEY, user_id TEXT NOT NULL, exp INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sh_hooks_seen (id TEXT PRIMARY KEY, at TEXT NOT NULL)`,
  // What a payment entitles the customer to, so "paid but not served" is countable (one row per payment).
  `CREATE TABLE IF NOT EXISTS sh_entitlements (id TEXT PRIMARY KEY, at TEXT NOT NULL, env TEXT NOT NULL, customer TEXT,
     amount INTEGER, currency TEXT, payment_link TEXT, status TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  // Accounts with Pro. Keyed by the same HMAC-ed email id as sh_users, so a grant can exist before first sign-in.
  `CREATE TABLE IF NOT EXISTS sh_pro (user_id TEXT PRIMARY KEY, at TEXT NOT NULL, via TEXT NOT NULL)`,
];

let ready = null;
export function db(env) {
  if (!env.OPS_DB) return null;
  if (!ready) ready = env.OPS_DB.batch(SCHEMA.map(s => env.OPS_DB.prepare(s))).catch(e => { ready = null; throw e; });
  return ready.then(() => env.OPS_DB);
}
export function resetForTests() { ready = null; keyCache = null; }

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

let keyCache = null;
async function hmacKey(d) {
  if (keyCache) return keyCache;
  let row = await d.prepare('SELECT v FROM sh_meta WHERE k = ?').bind('hmac_key').first();
  if (!row) {
    const fresh = hex(crypto.getRandomValues(new Uint8Array(32)));
    await d.prepare('INSERT OR IGNORE INTO sh_meta (k, v) VALUES (?, ?)').bind('hmac_key', fresh).run();
    row = await d.prepare('SELECT v FROM sh_meta WHERE k = ?').bind('hmac_key').first();
  }
  keyCache = await crypto.subtle.importKey('raw', enc.encode(row.v), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return keyCache;
}
// Pseudonym for an email / customer id / visitor id. Same input → same 16-hex id; not reversible without the DB key.
export async function pseudo(d, kind, value) {
  if (!value) return null;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(d), enc.encode(kind + ':' + String(value).trim().toLowerCase()));
  return hex(sig).slice(0, 16);
}

export async function getMeta(d, k) { return (await d.prepare('SELECT v FROM sh_meta WHERE k = ?').bind(k).first())?.v ?? null; }
export async function setMeta(d, k, v) { await d.prepare('INSERT INTO sh_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v)).run(); }

const RETAIN_DAYS = 180;
export async function insertEvent(d, ev) {
  await d.prepare('INSERT INTO sh_events (at, name, env, source, actor, path, props) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(ev.at || new Date().toISOString(), ev.name, ev.env, ev.source, ev.actor || null, ev.path || null, ev.props ? JSON.stringify(ev.props) : null).run();
  if (Math.random() < 0.01) {
    const cut = new Date(Date.now() - RETAIN_DAYS * 864e5).toISOString();
    await d.prepare('DELETE FROM sh_events WHERE at < ?').bind(cut).run();
    await d.prepare('DELETE FROM sh_sessions WHERE exp < ?').bind(Date.now()).run();
    await d.prepare('DELETE FROM sh_hooks_seen WHERE at < ?').bind(cut).run();
  }
}
