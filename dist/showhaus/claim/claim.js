/* SHOWHAUS — claim this property. Steps: intro → mode (sign up | guest) → details → done (share link).
   Server: src/claim.js (/api/claim/*). Events go through window.SH.track (../lib/ops.js → /api/e). */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const slug = (qs.get('p') || 'arncliffe-central').replace(/[^a-z0-9-]/g, '');
  const src = (qs.get('ref') || qs.get('utm_source') || (document.referrer ? 'ref' : 'direct')).replace(/[^\w.-]/g, '').slice(0, 60);
  const REC = qs.get('rec') === '1';
  if (REC) document.body.classList.add('rec');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const track = (name, props = {}) => { try { window.SH && window.SH.track(name, { kind: 'claim:' + slug, utm_source: src, ...props }); } catch { /* never breaks the page */ } };
  const synthetic = (() => { try { return sessionStorage.getItem('sh_synth') === '1'; } catch { return false; } })();

  let state = { property: null, auth: { available: false }, mode: 'guest', claim: null, manage: null, suVerified: false, suEmail: '' };
  const STEPS = ['intro', 'mode', 'details', 'done'];

  function go(step, { focus = true } = {}) {
    document.body.dataset.step = step;
    for (const s of STEPS) $('s-' + s).hidden = s !== step;
    const i = STEPS.indexOf(step);
    document.querySelectorAll('.rail li').forEach((li, k) => li.classList.toggle('on', k <= i));
    if (focus) { const h = $('s-' + step).querySelector('h1,h2'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } }
    if (innerWidth <= 860 && step !== 'intro') $('s-' + step).closest('.panel').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    if (step === 'mode') hintModes();
  }
  let toastT;
  function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 1600); }
  async function copy(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg); return true; }
    catch { toast('Select the text and copy it'); return false; }
  }

  // ---------- step 1 ----------
  $('yes').onclick = () => { track('claim_started'); go('mode'); };

  // ---------- step 2: sign up or guest ----------
  const ICON = {
    guest: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/></svg>',
    signup: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  };
  const PREVIEW = { guest: 'A private manage link keeps it yours', signup: 'Your claim follows your email' };
  function setMode(m, { user = true } = {}) {
    state.mode = m;
    document.querySelectorAll('.mode').forEach(el => {
      const on = el.dataset.mode === m;
      el.classList.toggle('on', on);
      el.querySelector('input').checked = on;
      if (on && user) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } // one hairline sweep per switch
    });
    $('signupBox').hidden = m !== 'signup' || state.suVerified;
    const p = $('modePreview');
    p.innerHTML = ICON[m] + '<span></span>'; p.lastChild.textContent = PREVIEW[m];
    p.classList.remove('swap'); void p.offsetWidth; p.classList.add('swap');
    $('modeErr').textContent = '';
    if (m === 'signup' && user) setTimeout(() => $('suEmail').focus(), 40);
  }
  document.querySelectorAll('.mode input').forEach(i => i.addEventListener('change', () => setMode(i.value)));
  // First visit to this step: show once what each choice means (sign up → guest), then settle on guest.
  let hinted = false;
  function hintModes() {
    if (hinted || reduced || REC) { if (!hinted) setMode(state.mode, { user: false }); hinted = true; return; }
    hinted = true;
    setMode('signup', { user: false });
    setTimeout(() => { if (state.mode === 'signup' && document.activeElement !== $('suEmail')) setMode('guest', { user: false }); }, 900);
  }
  async function authApi(p, body) {
    const r = await fetch('/api/auth/' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  }
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
  $('modeNext').onclick = async () => {
    const err = $('modeErr');
    if (state.mode === 'signup' && !state.suVerified) {
      const email = $('suEmail').value.trim();
      if (!EMAIL_RE.test(email)) { err.textContent = 'Enter your email to sign up.'; $('suEmail').focus(); return; }
      state.suEmail = email;
      if (state.auth.available) { // email-code sign-in is open: prove the address first
        if ($('suCodeRow').hidden) {
          $('modeNext').disabled = true;
          const r = await authApi('start', { email });
          $('modeNext').disabled = false;
          if (!r.ok) { err.textContent = r.data.error || 'Could not send the code.'; return; }
          $('suCodeRow').hidden = false; $('suCode').focus(); err.textContent = ''; return;
        }
        const code = $('suCode').value.replace(/\D/g, '');
        $('modeNext').disabled = true;
        const v = await authApi('verify', { email, code, anon: (() => { try { return localStorage.getItem('sh_a'); } catch { return null; } })() });
        $('modeNext').disabled = false;
        if (!v.ok) { err.textContent = v.data.error || 'That code did not work.'; return; }
        state.suVerified = true;
      }
    }
    track(state.mode === 'signup' ? 'claim_signup' : 'claim_guest', { step: state.mode });
    const f = $('s-details');
    if (state.mode === 'signup' && state.suEmail && !f.email.value) { f.email.value = state.suEmail; updateMatch(); }
    go('details');
  };
  $('suEmail').addEventListener('keydown', e => { if (e.key === 'Enter') $('modeNext').click(); });
  $('suCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('modeNext').click(); });

  // ---------- step 3: documents ----------
  const form = $('s-details');
  const FREE = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|icloud|me|mac|aol|proton|protonmail|gmx|mail|zoho|yandex|bigpond|optusnet|iinet|tpg)\./i;
  const site = h => { const p = String(h || '').toLowerCase().replace(/^www\d?\./, '').split('.').filter(Boolean); if (p.length < 2) return ''; const l2 = p.slice(-2).join('.'); return /^(com|net|org|edu|gov|asn|id|co|ac)\.(au|nz|uk)$/.test(l2) && p.length > 2 ? p.slice(-3).join('.') : l2; };
  const hostOf = v => { try { return new URL(/^https?:\/\//i.test(v) ? v : 'https://' + v).hostname; } catch { return ''; } };
  function updateMatch() {
    const m = $('match'), e = form.email.value.trim().toLowerCase(), w = form.website.value.trim();
    const ed = EMAIL_RE.test(e) ? e.split('@')[1] : '', wh = /\.[a-z]{2,}/i.test(w) ? hostOf(w) : '';
    m.className = 'match';
    if (!ed || !wh) { m.textContent = ''; return; }
    if (!FREE.test(ed) && site(ed) && site(ed) === site(wh)) {
      // Verified needs the domain match AND the emailed code for this exact address; never promise more than that.
      const proven = state.suVerified && state.suEmail.toLowerCase() === e;
      if (proven) { m.classList.add('ok'); m.textContent = '✓ Domains match and your email is confirmed — you’ll be verified.'; }
      else m.textContent = state.auth.available ? '✓ Domains match — we’ll email you a code to confirm it’s you.' : '✓ Domains match — we’ll confirm by email shortly.';
    }
    else m.textContent = FREE.test(ed) ? 'Personal email — your link works now; verification stays pending.' : 'Domains differ — your link works now; verification stays pending.';
  }
  form.email.addEventListener('input', updateMatch); form.website.addEventListener('input', updateMatch);
  const drop = $('drop'), fileIn = form.file;
  function setFile() {
    const f = fileIn.files && fileIn.files[0];
    const bad = f && (f.size > 2 * 1024 * 1024 || !/^(application\/pdf|image\/jpeg|image\/png)$/.test(f.type));
    fieldErr('file', bad ? (f.size > 2 * 1024 * 1024 ? 'Max 2 MB — PDF, JPG or PNG.' : 'PDF, JPG or PNG only.') : '');
    if (bad) fileIn.value = '';
    const ok = f && !bad;
    drop.classList.toggle('has', !!ok);
    $('dropT').innerHTML = ok ? '' : 'Add evidence <em>(optional)</em>';
    if (ok) $('dropT').textContent = `✓ ${f.name} · ${f.size < 1048576 ? Math.max(1, Math.round(f.size / 1024)) + ' KB' : (f.size / 1048576).toFixed(1) + ' MB'}`;
  }
  fileIn.addEventListener('change', setFile);
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, () => drop.classList.add('over')));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, () => drop.classList.remove('over')));
  function fieldErr(name, msg) {
    const p = form.querySelector(`.ferr[data-for="${name}"]`); if (p) p.textContent = msg || '';
    const input = form.elements[name]; const lab = input && input.closest && input.closest('.field'); if (lab) lab.classList.toggle('bad', !!msg);
  }
  form.addEventListener('input', e => { if (e.target.name) fieldErr(e.target.name, ''); });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    ['role', 'company', 'licence', 'website', 'email'].forEach(n => fieldErr(n, ''));
    $('detailsErr').textContent = '';
    const fd = new FormData(form);
    const local = {};
    if (!fd.get('role')) local.role = 'Pick your role.';
    if (String(fd.get('company') || '').trim().length < 2) local.company = 'Enter the company name.';
    if (!String(fd.get('licence') || '').trim()) local.licence = 'Enter your ABN or agency licence number.';
    if (!/\.[a-z]{2,}/i.test(String(fd.get('website') || ''))) local.website = 'Enter the company website, e.g. agency.com.au.';
    if (!EMAIL_RE.test(String(fd.get('email') || '').trim())) local.email = 'Enter your work email.';
    if (Object.keys(local).length) { Object.entries(local).forEach(([k, v]) => fieldErr(k, v)); focusFirstBad(); return; }
    fd.set('p', slug); fd.set('mode', state.mode); fd.set('src', src);
    try { const a = localStorage.getItem('sh_a'); if (a) fd.set('anon', a); } catch { /* ignore */ }
    if (synthetic) fd.set('env', 'synthetic');
    if (!(fileIn.files && fileIn.files[0])) fd.delete('file');
    const btn = $('submit'); btn.disabled = true; const label = btn.innerHTML; btn.textContent = 'Claiming…';
    try {
      const r = await fetch('/api/claim/submit', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (data.fields) { Object.entries(data.fields).forEach(([k, v]) => fieldErr(k, v)); focusFirstBad(); }
        $('detailsErr').textContent = data.error || 'Something went wrong. Please try again.';
        return;
      }
      state.claim = data.claim; state.manage = data.manage_url;
      showDone({ fileNote: data.file_note });
    } catch { $('detailsErr').textContent = 'No connection. Check your network and try again.'; }
    finally { btn.disabled = false; btn.innerHTML = label; }
  });
  function focusFirstBad() { const p = [...form.querySelectorAll('.ferr')].find(x => x.textContent); if (p) { const el = p.previousElementSibling && p.previousElementSibling.querySelector('input'); if (el) el.focus(); } }

  // ---------- step 4: the payoff ----------
  function showDone({ fileNote, back } = {}) {
    const c = state.claim;
    const st = $('status');
    st.className = 'status ' + c.status;
    st.textContent = c.status === 'verified' ? '✓ Verified' : 'Pending verification';
    const unconfirmed = c.status === 'pending' && c.reason === 'email_unconfirmed';
    $('statusNote').textContent = c.status === 'verified'
      ? `Work email confirmed on ${c.website_host}. Your link shows “Marketed by ${c.company}”.`
      : unconfirmed
        ? `Domain matches — we’ll confirm by email shortly. Your link works now; “Marketed by ${c.company}” appears once confirmed.`
        : `Your link works now. “Marketed by ${c.company}” appears on it once verified (work email on ${c.website_host}).`;
    // Confirming the mailbox here is possible only while email codes can be sent.
    $('confirmBox').hidden = !(unconfirmed && state.auth.available);
    if (!$('confirmBox').hidden && !$('cfEmail').value) $('cfEmail').value = form.email.value || '';
    if (fileNote === 'storage_full') $('statusNote').textContent += ' Your file could not be stored right now; the claim is saved.';
    $('h-done').textContent = back ? 'Welcome back — you’re live.' : 'You’re live.';
    $('shareUrl').textContent = c.share_url.replace(/^https?:\/\//, '');
    $('openShare').href = c.share_url.replace(/^https:\/\/showhaus\.app/, location.hostname.endsWith('showhaus.app') ? 'https://showhaus.app' : location.origin);
    $('embed').textContent = c.embed;
    $('manageBox').hidden = !state.manage;
    if (state.manage) $('manageUrl').textContent = state.manage.replace(/^https?:\/\//, '');
    go('done');
  }
  $('copyShare').onclick = async () => {
    if (await copy(state.claim.share_url, 'Link copied')) { $('copyShare').textContent = 'Copied ✓'; $('copyShare').closest('.share').classList.add('copied'); setTimeout(() => { $('copyShare').textContent = 'Copy link'; }, 1800); }
    track('share_link_copied', { cta: 'share' });
  };
  $('copyEmbed').onclick = async () => { await copy(state.claim.embed, 'Embed copied'); track('share_link_copied', { cta: 'embed' }); };
  $('copyManage').onclick = () => copy(state.manage, 'Manage link copied');
  $('cfBtn').onclick = async () => {
    const email = $('cfEmail').value.trim(), err = $('cfErr'); err.textContent = '';
    if (!EMAIL_RE.test(email)) { err.textContent = 'Enter the work email you claimed with.'; return; }
    $('cfBtn').disabled = true;
    try {
      if ($('cfCodeRow').hidden) {
        const r = await authApi('start', { email });
        if (!r.ok) { err.textContent = r.data.error || 'Could not send the code.'; return; }
        $('cfCodeRow').hidden = false; $('cfBtn').textContent = 'Confirm'; $('cfCode').focus(); return;
      }
      const v = await authApi('verify', { email, code: $('cfCode').value.replace(/\D/g, '') });
      if (!v.ok) { err.textContent = v.data.error || 'That code did not work.'; return; }
      const st = await fetch(`/api/claim/state?p=${slug}`, { credentials: 'same-origin' }).then(r => r.json());
      const mine = (st.mine || []).find(x => x.code === state.claim.code);
      if (mine) { state.claim = mine; showDone(); toast(mine.status === 'verified' ? 'Verified' : 'Email confirmed'); }
    } finally { $('cfBtn').disabled = false; }
  };
  $('release').onclick = async () => {
    const token = (state.manage || '').split('#m=')[1];
    if (!token) { toast('Open your private manage link to release this claim'); return; }
    if (!confirm('Release this claim? Your share link will keep opening the walkthrough, without your company name.')) return;
    const r = await fetch('/api/claim/release', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), credentials: 'same-origin' });
    if (r.ok) { state.claim = null; state.manage = null; history.replaceState(null, '', location.pathname + location.search); toast('Claim released'); go('intro'); }
  };
  document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => go(b.dataset.back));

  // ---------- boot ----------
  async function boot() {
    const m = location.hash.match(/^#m=([0-9a-f]{48})$/);
    const st = await fetch(`/api/claim/state?p=${slug}`, { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (st) {
      state.property = st.property; state.auth = st.auth || state.auth;
      const street = st.property.address.split(/ and |,/)[0].replace(/ Street\b/, ' St').replace(/ Road\b/, ' Rd');
      const suburb = (st.property.address.match(/,\s*([A-Za-z' -]+?)\s+(NSW|VIC|QLD|ACT|SA|WA|TAS|NT)\b/) || [])[1];
      $('paddr').textContent = [st.property.name, [street, suburb].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
      if (st.property.kind === 'walk') { // the hero clip is the Studio demo; a walk listing shows its own still instead
        const v = $('walk'); if (v) { v.pause(); v.removeAttribute('src'); v.removeAttribute('autoplay'); v.poster = `../walk/data/${slug}/poster.jpg`; v.setAttribute('aria-label', `Still from the ${st.property.name} walkthrough`); v.load(); }
        const ex = $('explainer'); if (ex) { ex.pause(); const box = ex.closest('.explainer') || ex; box.hidden = true; } // that recording shows another property
        $('h-intro').textContent = 'Do you build, own or market this home?';
        const note = document.querySelector('.stage-note'); if (note) note.textContent = `${st.property.name} · base walkthrough`;
        const fine = [...document.querySelectorAll('p.fine')].find(e => /^Made by SHOWHAUS/.test(e.textContent));
        if (fine) fine.textContent = 'Made by SHOWHAUS as an AI visualisation. Not endorsed by the builder, owner or any agency until it is claimed.';
      }
      $('submit').textContent = `Claim ${st.property.name}`;
      if (st.property.kind !== 'walk') $('h-intro').textContent = 'Do you or your agency own or market this property?';
    }
    const view = st && st.property.kind === 'walk' ? 'walk' : 'studio';
    $('open3d').href = `../${view}/?p=${slug}&src=claim`;
    $('justView').href = `../${view}/?p=${slug}&src=claim-no`;
    if (m) {
      const r = await fetch('/api/claim/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: m[1] }), credentials: 'same-origin' });
      const data = await r.json().catch(() => ({}));
      if (r.ok) { state.claim = data.claim; state.manage = location.href.split('#')[0] + '#m=' + m[1]; showDone({ back: true }); return; }
      toast(data.error || 'That manage link is not valid');
    } else if (st && st.mine && st.mine.length) { state.claim = st.mine[0]; showDone({ back: true }); return; }
    track('claim_viewed');
    go('intro', { focus: false });
  }
  window.claimPage = { go, setMode, get state() { return state; } };
  boot();
})();
