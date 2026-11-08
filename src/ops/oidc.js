// Authenticates CVF's GitHub Actions jobs without any shared secret: the job mints a GitHub OIDC token
// (audience "showhaus-ops") and we verify its RS256 signature against GitHub's published keys and its claims.
const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = ISSUER + '/.well-known/jwks';
export const AUDIENCE = 'showhaus-ops';
export const ALLOWED_REPOS = new Set(['in-c0/combinatory-venture-farming', 'in-c0/sydney-environmental-atlas']);

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const json = s => JSON.parse(new TextDecoder().decode(b64url(s)));

let jwks = null, jwksAt = 0;
async function keys(fetchImpl) {
  if (jwks && Date.now() - jwksAt < 3600e3) return jwks;
  const r = await fetchImpl(JWKS_URL, { cf: { cacheTtl: 3600 } });
  if (!r.ok) throw new Error('jwks ' + r.status);
  jwks = (await r.json()).keys; jwksAt = Date.now();
  return jwks;
}

// Returns the verified claims, or null. `now` and `fetchImpl` are injectable for tests.
export async function verifyGithubOidc(token, { fetchImpl = fetch, now = Date.now(), jwksOverride } = {}) {
  try {
    const [h, p, s] = String(token || '').split('.');
    if (!s) return null;
    const head = json(h), claims = json(p);
    if (head.alg !== 'RS256') return null;
    const set = jwksOverride || await keys(fetchImpl);
    const jwk = set.find(k => k.kid === head.kid) || (set.length === 1 ? set[0] : null);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(h + '.' + p));
    if (!ok) return null;
    const t = Math.floor(now / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== ISSUER || !aud.includes(AUDIENCE) || !(claims.exp > t) || (claims.nbf && claims.nbf > t + 60)) return null;
    if (claims.repository_owner !== 'in-c0' || !ALLOWED_REPOS.has(claims.repository)) return null;
    return claims;
  } catch { return null; }
}

export async function requireOps(request, opts) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return m ? verifyGithubOidc(m[1], opts) : null;
}
