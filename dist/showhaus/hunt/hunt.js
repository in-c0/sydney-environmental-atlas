/* SHOWHAUS Hunt board: the homes someone is looking at, from any site, each checked against NSW data. No login.
   Own board: kept in this browser (localStorage `sh_hunt`). Share: POST /api/hunt/board → /hunt/?b=<id>, which anyone
   with the link can read and comment on (src/hunt.js). Rent is computed here from data/rents.json (same file as the map). */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const C = window.ShowhausCore;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const qs = new URLSearchParams(location.search), shared = /^[a-z0-9]{10}$/.test(qs.get('b') || '') ? qs.get('b') : null;
  const src = qs.get('src') || undefined;
  const track = (name, props = {}) => { try { window.SH && SH.track(name, { kind: shared ? 'shared' : 'own', utm_source: src, ...props }); } catch { /* never breaks the page */ } };
  const store = {
    get() { try { return JSON.parse(localStorage.getItem('sh_hunt') || '{}'); } catch { return {}; } },
    set(v) { try { localStorage.setItem('sh_hunt', JSON.stringify(v)); } catch { /* private mode: board lives for this visit */ } },
  };
  let board = shared ? { items: [] } : { items: [], ...store.get() };
  let comments = [];
  const save = () => { if (!shared) { store.set(board); syncShared(); } };

  // ---------- data for the rent line (lazy: only once a home is on the board) ----------
  let dataP = null;
  const data = () => dataP || (dataP = Promise.all([
    fetch('../data/rents.json').then(r => r.json()), fetch('../data/places.json').then(r => r.json()),
    fetch('../walk/data/index.json').then(r => r.ok ? r.json() : { items: [] }).catch(() => ({ items: [] })),
  ]).then(([R, P, W]) => ({ R, P, W })).catch(() => null));

  function postcodeFor(it, P) {
    if (it.postcode) return it.postcode;
    const sub = (String(it.label).split(',')[1] || '').replace(/\bNSW\b/i, '').trim().toLowerCase();
    if (!sub || !it.lngLat) return null;
    let best = null, bd = Infinity;
    for (const s of P.suburbs) if (String(s[0]).toLowerCase() === sub) { const d = (s[2] - it.lngLat[1]) ** 2 + (s[3] - it.lngLat[0]) ** 2; if (d < bd) { bd = d; best = s[1]; } }
    return best;
  }
  function rentLine(it, D) {
    const pc = postcodeFor(it, D.P);
    if (!pc) return { text: 'Rent: postcode not found for this address.', cls: 'unk' };
    const pci = D.R.postcodes.indexOf(Number(pc));
    if (pci < 0) return { text: `Rent: no bonds lodged in ${pc} in the last 12 months.`, cls: 'unk' };
    const beds = it.beds == null ? null : new Set([it.beds >= 4 ? 4 : it.beds]);
    const v = C.filterRents(D.R, { pcSet: new Set([pci]), beds }).map(i => D.R.w[i]).sort((a, b) => a - b);
    if (v.length < 5) return { text: `Rent: too few ${it.beds != null ? (it.beds === 0 ? 'studio' : it.beds + '-bed') + ' ' : ''}leases in ${pc} to say.`, cls: 'unk' };
    const med = C.quantile(v, 0.5), q1 = C.quantile(v, 0.25), q3 = C.quantile(v, 0.75), what = it.beds == null ? 'all homes' : it.beds === 0 ? 'studios' : it.beds >= 4 ? '4+ bed' : it.beds + '-bed';
    let vs = '', cls = 'ok';
    if (it.price) {
      const pct = Math.round((it.price / med - 1) * 100);
      vs = ` · <b>$${it.price}/wk asked: ${pct === 0 ? 'right on the middle' : Math.abs(pct) + '% ' + (pct > 0 ? 'above' : 'below') + ' the middle'}</b>`;
      cls = it.price > q3 ? 'flag' : 'ok';
    }
    return { text: `Rent in ${pc} (${what}): middle <b>$${Math.round(med)}/wk</b>, middle half $${Math.round(q1)}–$${Math.round(q3)} · ${v.length.toLocaleString()} new leases, 12 months${vs}`, cls, pc };
  }
  const near = (a, b) => a && b && Math.abs(a[0] - b[0]) < 0.0004 && Math.abs(a[1] - b[1]) < 0.0004; // ~40 m

  // ---------- cards ----------
  function chip(c, label) {
    if (!c) return `<li class="unk"><b>${label}</b> couldn’t be checked right now</li>`;
    return `<li class="${c.hit ? 'flag' : 'ok'}"><b>${label}</b> ${esc(c.text)}</li>`;
  }
  function card(it, i, D) {
    const ch = it.checks || {}, r = D ? rentLine(it, D) : { text: 'Rent: loading…', cls: 'unk' };
    const walk = D && D.W.items.find(w => w.kind === 'walk' && near(w.lngLat, it.lngLat));
    const z = ch.zoning ? `<li class="ok"><b>Zoning</b> ${esc([ch.zoning.code, ch.zoning.name].filter(Boolean).join(' · '))}</li>` : '<li class="unk"><b>Zoning</b> couldn’t be checked right now</li>';
    const cm = comments.filter(c => c.item === it.key);
    return `<article class="h-card" data-i="${i}">
      <header><h2>${esc(it.label)}</h2>${shared ? '' : `<button type="button" class="x" data-act="remove" aria-label="Remove ${esc(it.label)}">×</button>`}</header>
      <p class="meta">${[it.beds != null ? (it.beds === 0 ? 'Studio' : it.beds + (it.beds >= 4 ? '+' : '') + ' bed') : '', it.link ? `<a href="${esc(it.link)}" target="_blank" rel="noopener nofollow">Listing ↗</a>` : '', walk ? `<a href="../walk/?p=${esc(walk.slug)}&src=hunt-card">▶ 3D walk</a>` : ''].filter(Boolean).join(' · ')}</p>
      <p class="rent ${r.cls}">${r.text}</p>
      <ul class="checks">${chip(ch.flood, 'Flood')}${chip(ch.bushfire, 'Bush fire')}${chip(ch.aircraft, 'Aircraft')}${z}${ch.canopy ? `<li class="ok"><b>Trees</b> ${ch.canopy.pct}% canopy around it</li>` : ''}</ul>
      ${shared ? (it.note ? `<p class="note-ro">“${esc(it.note)}”</p>` : '') : `<textarea class="note" data-act="note" rows="2" maxlength="300" placeholder="Your notes — inspection time, what you liked, what to ask">${esc(it.note || '')}</textarea>`}
      ${cm.length || shared ? `<div class="cm">${cm.map(c => `<p><b>${esc(c.name || 'Someone')}</b> ${esc(c.text)}</p>`).join('')}${shared ? `<form class="cm-add" data-key="${esc(it.key)}"><input name="name" maxlength="30" placeholder="Your name (optional)" aria-label="Your name"><input name="text" maxlength="400" required placeholder="Comment on this home" aria-label="Comment"><button>Post</button></form>` : ''}</div>` : ''}
      <p class="src">Checked ${esc(it.checked || '')} · NSW Planning Portal, NSW Spatial Services, NSW Fair Trading rental bonds</p>
    </article>`;
  }
  async function render() {
    const n = board.items.length;
    $('empty').hidden = n > 0;
    $('bar').hidden = n === 0 || !!shared;
    $('count').textContent = n === 1 ? '1 home' : `${n} homes`;
    $('cards').innerHTML = board.items.map((it, i) => card(it, i, null)).join('');
    if (!n) return;
    const D = await data();
    $('cards').innerHTML = board.items.map((it, i) => card(it, i, D)).join('');
  }

  // ---------- add a home ----------
  let suburbHint = null;
  $('add').addEventListener('submit', async e => {
    e.preventDefault();
    const raw = $('q').value.trim(), msg = $('addMsg');
    if (!raw) { msg.textContent = 'Paste a listing link or type an address first.'; return; }
    const isLink = /^https?:\/\//i.test(raw);
    const q = !isLink && suburbHint && !/\b[a-z]{3,}\s*$/i.test(raw) ? `${raw} ${suburbHint}` : raw;
    $('addBtn').disabled = true; msg.textContent = 'Checking…';
    try {
      const r = await fetch('/api/hunt/check?' + new URLSearchParams({ q }));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not check that right now.');
      if (d.need) {
        if (isLink) { board.pendingLink = raw; suburbHint = d.suburb || null; }
        msg.textContent = d.error || (d.suburb ? `That link doesn’t include the street. Type the address — e.g. 12 Smith St ${d.suburb}.` : 'That link doesn’t include the address. Type the street address instead.');
        $('q').value = ''; $('q').focus(); return;
      }
      const key = d.address;
      if (board.items.some(x => x.key === key)) { msg.textContent = 'That home is already on your list.'; return; }
      const beds = $('beds').value === '' ? null : Number($('beds').value), price = Number($('price').value) || null;
      const link = isLink ? raw : board.pendingLink || null;
      board.items.unshift({ key, label: d.label, lngLat: d.lngLat, postcode: d.postcode, beds, price, link, note: '', checks: d.checks, checked: d.checked });
      delete board.pendingLink; suburbHint = null;
      save(); track('hunt_add', { cta: isLink ? 'link' : 'address' });
      msg.textContent = d.exact ? '' : `Closest match in the NSW address register: ${d.label}. Remove it if that’s not the home.`;
      $('q').value = ''; $('price').value = '';
      render();
    } catch (err) { msg.textContent = err.message; }
    finally { $('addBtn').disabled = false; }
  });
  // address autocomplete (same proxy as the walk gallery)
  let acT = 0;
  $('q').addEventListener('input', () => {
    clearTimeout(acT); const v = $('q').value.trim();
    if (/^https?:/i.test(v) || v.length < 4) return;
    acT = setTimeout(async () => {
      const d = await fetch('/api/suggest/address?' + new URLSearchParams({ q: v })).then(r => r.json()).catch(() => ({ results: [] }));
      $('acList').innerHTML = (d.results || []).filter(x => x.kind === 'address').map(x => `<option value="${esc(x.label)}">`).join('');
    }, 220);
  });

  // ---------- card actions ----------
  $('cards').addEventListener('click', e => {
    const b = e.target.closest('[data-act="remove"]'); if (!b) return;
    const i = Number(b.closest('.h-card').dataset.i); board.items.splice(i, 1); save(); track('hunt_remove'); render();
  });
  let noteT = 0;
  $('cards').addEventListener('input', e => {
    const t = e.target.closest('[data-act="note"]'); if (!t) return;
    board.items[Number(t.closest('.h-card').dataset.i)].note = t.value.slice(0, 300);
    clearTimeout(noteT); noteT = setTimeout(save, 600);
  });
  $('cards').addEventListener('submit', async e => {
    const f = e.target.closest('.cm-add'); if (!f) return; e.preventDefault();
    const body = { id: shared, key: f.dataset.key, name: f.name.value, text: f.text.value };
    const r = await fetch('/api/hunt/comment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { f.text.value = ''; f.text.placeholder = d.error || 'Could not post that.'; return; }
    comments.push({ item: body.key, name: body.name, text: body.text }); render();
  });

  // ---------- share ----------
  let syncT = 0;
  function syncShared() {
    if (!board.share) return;
    clearTimeout(syncT); syncT = setTimeout(() => fetch('/api/hunt/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: board.share.id, edit: board.share.edit, items: board.items }) }).catch(() => {}), 1200);
  }
  $('share').addEventListener('click', async () => {
    const m = $('shareMsg'); m.hidden = false;
    if (!board.share) {
      m.textContent = 'Making a link…';
      const r = await fetch('/api/hunt/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: board.items }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { m.textContent = d.error || 'Could not make a link right now.'; return; }
      board.share = { id: d.id, edit: d.edit }; store.set(board);
    }
    const link = `${location.origin}${location.pathname}?b=${board.share.id}`;
    try { await navigator.clipboard.writeText(link); m.innerHTML = `Link copied: <a href="${esc(link)}">${esc(link)}</a> — anyone with it can see these homes and comment. It updates when you change your list.`; }
    catch { m.innerHTML = `Send this link: <a href="${esc(link)}">${esc(link)}</a>`; }
    track('cta', { cta: 'share' });
  });

  // ---------- boot ----------
  if (shared) {
    $('ownHead').hidden = true; $('sharedHead').hidden = false; $('add').hidden = true;
    fetch('/api/hunt/board?id=' + shared).then(r => r.json()).then(d => {
      if (d.error) { $('sharedTitle').textContent = 'This shortlist is not available.'; return; }
      board = { items: d.items || [] }; comments = d.comments || []; $('sharedTitle').textContent = d.title || 'Our shortlist'; render();
    });
  } else {
    const pre = qs.get('q'); if (pre) { $('q').value = pre; setTimeout(() => $('add').requestSubmit(), 0); }
    render();
  }
  track('hunt_view', { cta: board.items.length ? 'returning' : 'new' }, { once: true });
})();
