// Email sign-up / log-in with a one-time 6-digit code (no password). The email address is used only to send
// the code and is never stored: accounts are keyed by an HMAC of the address.
//   POST /api/auth/start  { email }        → sends a code (or, for CVF test accounts with a GitHub OIDC token, returns it)
//   POST /api/auth/verify { email, code }  → sets the session cookie; emits signup (first time) or login
//   GET  /api/auth/me                      → { signedIn, since }
//   POST /api/auth/logout
import { db, pseudo, sha256, getMeta, setMeta } from './store.js';
import { environmentOf, track } from './events.js';
import { requireOps } from './oidc.js';

const CODE_TTL_MS = 10 * 60e3, MAX_TRIES = 5, MAX_SENDS_PER_HOUR = 5, MAX_SENDS_PER_DAY = 300;
const SESSION_DAYS = 30, COOKIE = 'sh_s';
// Reserved for CVF's synthetic E2E accounts. Never a real mailbox (.invalid is reserved by RFC 2606).
export const TEST_DOMAIN = 'e2e.showhaus.invalid';
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i;

const j = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const normEmail = e => String(e || '').trim().toLowerCase();
export const isTestEmail = e => normEmail(e).endsWith('@' + TEST_DOMAIN);

export function cookieOf(request, name = COOKIE) {
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

export async function currentUser(request, env) {
  const tok = cookieOf(request);
  if (!tok) return null;
  const d = await db(env);
  if (!d) return null;
  const row = await d.prepare('SELECT s.user_id AS id, u.created_at, u.env FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_h = ? AND s.exp > ?')
    .bind(await sha256(tok), Date.now()).first();
  return row || null;
}

function mailText(code) {
  return `Your SHOWHAUS sign-in code is ${code}\n\nIt works for 10 minutes. If you did not ask for it, ignore this email — nothing happens without the code.\n\nSHOWHAUS · https://showhaus.app`;
}
export async function sendCode(env, to, code) {
  if (!env.MAIL) throw Object.assign(new Error('mail binding not configured'), { code: 'E_NO_BINDING' });
  return env.MAIL.send({
    to, from: { email: env.MAIL_FROM || 'login@showhaus.app', name: 'SHOWHAUS' },
    subject: `${code} is your SHOWHAUS code`, text: mailText(code),
  });
}

async function start(request, env, d) {
  const body = await request.json().catch(() => ({}));
  const email = normEmail(body.email);
  if (!EMAIL_RE.test(email)) return j({ error: 'Enter a valid email address.' }, 400);
  const testAccount = isTestEmail(email);
  if (testAccount && !(await requireOps(request))) return j({ error: 'Enter a valid email address.' }, 400);
  const emailH = await pseudo(d, 'email', email);
  const now = Date.now();
  const prev = await d.prepare('SELECT sent_count, window_start FROM codes WHERE email_h = ?').bind(emailH).first();
  const inWindow = prev && now - prev.window_start < 3600e3;
  if (inWindow && prev.sent_count >= MAX_SENDS_PER_HOUR) return j({ error: 'Too many codes for this address. Try again in an hour.' }, 429);
  const day = new Date().toISOString().slice(0, 10);
  const sentToday = Number(await getMeta(d, 'mail_sent:' + day) || 0);
  if (!testAccount && sentToday >= MAX_SENDS_PER_DAY) return j({ error: 'Sign-in is busy right now. Try again later.' }, 503);

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0');
  await d.prepare(`INSERT INTO codes (email_h, code_h, exp, tries, sent_count, window_start) VALUES (?, ?, ?, 0, 1, ?)
    ON CONFLICT(email_h) DO UPDATE SET code_h = excluded.code_h, exp = excluded.exp, tries = 0,
      sent_count = CASE WHEN ? THEN codes.sent_count + 1 ELSE 1 END, window_start = CASE WHEN ? THEN codes.window_start ELSE excluded.window_start END`)
    .bind(emailH, await sha256(emailH + ':' + code), now + CODE_TTL_MS, now, inWindow ? 1 : 0, inWindow ? 1 : 0).run();
  if (testAccount) return j({ ok: true, test_code: code });
  try {
    await sendCode(env, email, code);
    await setMeta(d, 'mail_sent:' + day, sentToday + 1);
    await setMeta(d, 'mail_last_ok', new Date().toISOString());
    return j({ ok: true });
  } catch (e) {
    await setMeta(d, 'mail_last_error', JSON.stringify({ at: new Date().toISOString(), code: e.code || null, message: String(e.message || e).slice(0, 160) }));
    return j({ error: 'We could not send the email just now. Please try again in a few minutes.' }, 502);
  }
}

async function verify(request, env, d) {
  const body = await request.json().catch(() => ({}));
  const email = normEmail(body.email), code = String(body.code || '').replace(/\D/g, '');
  if (!EMAIL_RE.test(email) || code.length !== 6) return j({ error: 'Enter the 6-digit code from the email.' }, 400);
  const emailH = await pseudo(d, 'email', email);
  const row = await d.prepare('SELECT code_h, exp, tries FROM codes WHERE email_h = ?').bind(emailH).first();
  if (!row || row.exp < Date.now()) return j({ error: 'That code has expired. Ask for a new one.' }, 400);
  if (row.tries >= MAX_TRIES) return j({ error: 'Too many wrong codes. Ask for a new one.' }, 429);
  if (row.code_h !== await sha256(emailH + ':' + code)) {
    await d.prepare('UPDATE codes SET tries = tries + 1 WHERE email_h = ?').bind(emailH).run();
    return j({ error: 'That code is not right. Check the latest email.' }, 400);
  }
  await d.prepare('UPDATE codes SET exp = 0 WHERE email_h = ?').bind(emailH).run();
  const environment = isTestEmail(email) ? 'synthetic' : environmentOf(request);
  const nowIso = new Date().toISOString();
  const existing = await d.prepare('SELECT id FROM users WHERE id = ?').bind(emailH).first();
  if (existing) await d.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowIso, emailH).run();
  else await d.prepare('INSERT INTO users (id, created_at, env, last_login_at) VALUES (?, ?, ?, ?)').bind(emailH, nowIso, environment, nowIso).run();
  const token = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
  await d.prepare('INSERT INTO sessions (token_h, user_id, exp) VALUES (?, ?, ?)').bind(await sha256(token), emailH, Date.now() + SESSION_DAYS * 864e5).run();
  await track(env, { name: existing ? 'login' : 'signup', env: environment, source: 'server', actor: 'u:' + emailH, path: '/api/auth/verify', props: body.anon ? { kind: 'from_anon' } : undefined });
  // Link the anonymous browser id to the account once, so a user case can show what happened before sign-up.
  if (body.anon) await track(env, { name: 'cta', env: environment, source: 'server', actor: 'a:' + await pseudo(d, 'anon', String(body.anon).slice(0, 64)), path: '/api/auth/verify', props: { cta: 'became:u:' + emailH } });
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return j({ ok: true, signedIn: true, since: existing ? null : nowIso, new: !existing }, 200,
    { 'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}` });
}

export async function handleAuth(request, env, path) {
  const d = await db(env);
  if (!d) return j({ error: 'Sign-in is not available yet.' }, 503);
  if (path === '/api/auth/me' && request.method === 'GET') {
    const u = await currentUser(request, env);
    return j(u ? { signedIn: true, since: u.created_at } : { signedIn: false });
  }
  if (request.method !== 'POST') return j({ error: 'method' }, 405);
  if (path === '/api/auth/start') return start(request, env, d);
  if (path === '/api/auth/verify') return verify(request, env, d);
  if (path === '/api/auth/logout') {
    const tok = cookieOf(request);
    const u = await currentUser(request, env);
    if (tok) await d.prepare('DELETE FROM sessions WHERE token_h = ?').bind(await sha256(tok)).run();
    if (u) await track(env, { name: 'logout', env: u.env === 'synthetic' ? 'synthetic' : environmentOf(request), source: 'server', actor: 'u:' + u.id, path });
    return j({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
  }
  return j({ error: 'not found' }, 404);
}
