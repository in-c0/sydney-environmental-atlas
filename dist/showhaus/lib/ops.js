/* SHOWHAUS ops client: first-party beacons (/api/e) and email-code sign-in (/api/auth/*).
   Pseudonymous only: a random per-browser id, never an email. Honours Global Privacy Control / Do Not Track
   by sending events without any id. `?synthetic=1` marks this browser's traffic as a probe. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const quiet = navigator.globalPrivacyControl === true || navigator.doNotTrack === '1';
  const ss = { get: k => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } } };
  if (new URLSearchParams(location.search).get('synthetic') === '1') ss.set('sh_synth', '1');
  const synthetic = ss.get('sh_synth') === '1';
  let anon = null;
  if (!quiet) {
    try { anon = localStorage.getItem('sh_a'); if (!anon) { anon = crypto.randomUUID(); localStorage.setItem('sh_a', anon); } } catch { anon = null; }
    if (anon) document.cookie = `sh_a=${anon}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  }
  const sent = new Set();
  function track(name, props, { once } = {}) {
    if (once) { const k = name + JSON.stringify(props || {}); if (sent.has(k)) return; sent.add(k); }
    const body = JSON.stringify({ name, anon, path: location.pathname, env: synthetic ? 'synthetic' : undefined, props: { ...(props || {}), ref: document.referrer || undefined } });
    try {
      if (!(navigator.sendBeacon && navigator.sendBeacon('/api/e', new Blob([body], { type: 'application/json' })))) {
        fetch('/api/e', { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => {});
      }
    } catch { /* analytics never breaks the page */ }
    try { if (window.posthog && window.posthog.capture) window.posthog.capture('sh_' + name, { ...(props || {}), synthetic }); } catch { /* same */ }
  }
  const utm = Object.fromEntries([...new URLSearchParams(location.search)].filter(([k]) => /^utm_(source|medium|campaign)$/.test(k)));
  track('view', utm, { once: true });

  // ---------- account ----------
  const api = (p, data) => fetch('/api/auth/' + p, data ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), credentials: 'same-origin' } : { credentials: 'same-origin' })
    .then(async r => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }));
  let me = { signedIn: false }, email = '';
  const btn = $('acct'), dlg = $('acctDlg');
  function paint() {
    if (!btn) return;
    btn.hidden = !(me.signedIn || me.available); // no mail route yet → no sign-in promise on screen
    btn.textContent = me.signedIn ? 'Signed in' : 'Sign in';
    btn.setAttribute('aria-label', me.signedIn ? 'Account: signed in' : 'Sign in with email');
    document.body.classList.toggle('signed-in', !!me.signedIn);
  }
  function step(n) { if (!dlg) return; dlg.dataset.step = n; const f = dlg.querySelector(n === 'code' ? '#acctCode' : n === 'email' ? '#acctEmail' : '#acctDone'); if (f) setTimeout(() => f.focus(), 30); }
  function msg(t) { const m = $('acctMsg'); if (m) m.textContent = t || ''; }
  function open(reason) {
    if (!dlg) return;
    track('signin_open', reason ? { cta: reason } : undefined);
    dlg.dataset.reason = reason || ''; dlg.hidden = false; msg(''); step(me.signedIn ? 'done' : 'email');
  }
  function close() { if (dlg) { dlg.hidden = true; btn && btn.focus(); } }
  window.SH = { track, openSignIn: open, get signedIn() { return !!me.signedIn; }, get canSignIn() { return !!me.available; } };

  api('me').then(r => { if (r.ok) { me = r.data; paint(); } }).catch(() => {});
  if (btn) btn.addEventListener('click', () => (dlg && !dlg.hidden ? close() : open('header')));
  if (!dlg) return;
  dlg.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  $('acctClose').addEventListener('click', close);
  $('acctEmailForm').addEventListener('submit', async e => {
    e.preventDefault();
    email = $('acctEmail').value.trim(); msg('Sending…');
    const r = await api('start', { email }).catch(() => ({ ok: false, data: {} }));
    if (!r.ok) return msg(r.data.error || 'Something went wrong. Try again.');
    $('acctSentTo').textContent = email; msg(''); step('code');
  });
  $('acctCodeForm').addEventListener('submit', async e => {
    e.preventDefault(); msg('Checking…');
    const r = await api('verify', { email, code: $('acctCode').value, anon }).catch(() => ({ ok: false, data: {} }));
    if (!r.ok) return msg(r.data.error || 'Something went wrong. Try again.');
    me = { signedIn: true, since: r.data.since }; paint(); msg(''); step('done');
    if (dlg.dataset.reason === 'pro') track('pro_interest', { cta: 'signed_in' });
    $('acctDoneText').textContent = r.data.new ? 'Account created. You are signed in on this browser.' : 'Welcome back. You are signed in.';
  });
  $('acctBack').addEventListener('click', () => { msg(''); step('email'); });
  $('acctOut').addEventListener('click', async () => { await api('logout', {}).catch(() => {}); me = { signedIn: false }; paint(); close(); });
  paint();
})();
