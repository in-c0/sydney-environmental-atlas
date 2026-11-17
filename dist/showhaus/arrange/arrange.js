// SHOWHAUS arrange: put your own furniture into a home's floor plan in real metres, then walk it in 3D. No server bake:
// the room is built in the browser from the plan JSON (../walk/plan-core.js, ../walk/plan-room.js).
//   /arrange/                      start (movers: tape-measure room, sample plans, send a plan link)
//   /arrange/?for=listing          start for vendors, landlords and agents
//   /arrange/?p=<plan slug>        a published plan          /arrange/?room=3.6x4.2   one measured room
//   /arrange/?b=<id>#e=<edit>      a shared layout; the #e= part (also kept in this browser) lets its maker change it
import { CATALOGUE, PALETTE, fromPlanItem, rectOf, rectInRoom, snap, clearances, clashes, roomPlan, cleanLayout, wallBoxes, bounds, edges } from '../walk/plan-core.js';

const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const src = (qs.get('src') || 'direct').replace(/[^\w.-]/g, '').slice(0, 40);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const track = (name, props = {}) => { try { window.SH && window.SH.track(name, { utm_source: src, ...props }); } catch { /* analytics never breaks the page */ } };
const getJSON = u => fetch(u, { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: this visit only */ } } };
const anonId = () => { try { return localStorage.getItem('sh_a') || undefined; } catch { return undefined; } };
const synth = () => { try { return sessionStorage.getItem('sh_synth') === '1' || /[?&]synthetic=1/.test(location.search) ? 'synthetic' : undefined; } catch { return undefined; } };
async function post(path, body) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ ...body, anon: anonId(), env: synth() }) });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  } catch { return { ok: false, data: { error: 'No connection. Try again.' } }; }
}
const cm = m => Math.round(m * 100);
const say = (el, t, c = '') => { el.textContent = t; el.className = 'msg ' + c; };

// ------------------------------------------------------------------ start screen
async function openStart() {
  document.body.dataset.mode = 'start';
  const seller = qs.get('for') === 'listing';
  $('forMovers').hidden = seller; $('forListing').hidden = !seller;
  if (seller) document.title = 'Let buyers furnish your listing · SHOWHAUS';
  track('arrange_view', { kind: seller ? 'start:listing' : 'start:movers' });
  $('roomForm').addEventListener('submit', e => {
    e.preventDefault();
    const w = parseFloat($('rw').value), d = parseFloat($('rd').value);
    if (!(w >= 1.5 && w <= 30 && d >= 1.5 && d <= 30)) return say($('roomMsg'), 'Type both sides in metres, between 1.5 and 30 — e.g. 3.6 and 4.2.', 'bad');
    track('arrange_start', { cta: 'room' });
    location.href = `./?room=${w}x${d}&src=${src}`;
  });
  const sendPlan = (form, url, email, msg, kind, needEmail) => $(form).addEventListener('submit', async e => {
    e.preventDefault();
    const u = $(url).value.trim(), em = $(email).value.trim();
    if (!/^https?:\/\/\S+\.\S+/.test(u)) return say($(msg), 'Paste the full link to the floor plan, starting with https://', 'bad');
    if (needEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) return say($(msg), 'Add your email so we can send you the link before anyone else sees it.', 'bad');
    const r = await post('/api/suggest/home', { url: u, email: em || undefined });
    if (!r.ok) return say($(msg), r.data.error || 'Could not send it. Try again.', 'bad');
    $(url).value = '';
    say($(msg), (r.data.notify ? `Got it. We email ${em} once when the plan is ready to arrange, then delete the address.` : 'Got it. Plans are made in the order people ask for them.') + ' Nothing is charged.', 'ok');
    track('cta', { cta: 'arrange-plan-link:' + kind });
  });
  sendPlan('planForm', 'planUrl', 'planEmail', 'planMsg', 'mover', false);
  sendPlan('listForm', 'listUrl', 'listEmail', 'listMsg', 'listing', true);
  $('demoListing').addEventListener('click', () => track('cta', { cta: 'arrange-listing-demo' }));
  const idx = await getJSON('./plans/index.json');
  $('plans').innerHTML = ((idx && idx.items) || []).map(p => `<a class="plan-card" href="./?p=${esc(p.slug)}&src=${esc(src)}" data-slug="${esc(p.slug)}">${thumb(p.outline, p.walls)}<b>${esc(p.name)}</b><span>${esc(p.line)}</span></a>`).join('');
  $('plans').addEventListener('click', e => { const a = e.target.closest('.plan-card'); if (a) track('arrange_start', { cta: 'plan:' + a.dataset.slug }); });
  const mine = store.get('sh_arr_list') || [];
  if (mine.length) { $('mine').hidden = false; $('mineList').innerHTML = mine.slice(0, 8).map(m => `<a class="plan-card" href="${esc(m.href)}"><b>${esc(m.name)}</b><span>${esc(m.items)} pieces · ${esc(new Date(m.at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }))}</span></a>`).join(''); }
}
function thumb(outline, walls) {
  if (!outline) return '';
  const [x0, y0, x1, y1] = bounds(outline), s = 1;
  const pts = outline.map(([x, y]) => `${(x - x0) * s},${(y1 - y) * s}`).join(' ');
  const iw = (walls || []).map(w => `<line x1="${w.from[0] - x0}" y1="${y1 - w.from[1]}" x2="${w.to[0] - x0}" y2="${y1 - w.to[1]}" stroke="#14181c" stroke-width=".12"/>`).join('');
  return `<svg viewBox="-0.4 -0.4 ${x1 - x0 + 0.8} ${y1 - y0 + 0.8}" aria-hidden="true"><polygon points="${pts}" fill="#fff" stroke="#14181c" stroke-width=".18"/>${iw}</svg>`;
}

// ------------------------------------------------------------------ editor state
let plan = null, fixed = [], items = [], sel = null, key = null, board = null, owner = false, dirty = false, mode = '2d', planItems = [];
let three = null; // lazily created 3D view
const all = () => fixed.concat(items);
const find = id => items.find(i => i.id === id);
let seq = 0; const newId = () => 'n' + Date.now().toString(36) + (seq++);

async function openEditor() {
  document.body.dataset.mode = 'edit'; $('start').hidden = true; $('editor').hidden = false;
  const bid = (qs.get('b') || '').toLowerCase(), p = (qs.get('p') || '').replace(/[^a-z0-9-]/g, ''), room = qs.get('room');
  let layout = null;
  if (/^[a-z0-9]{10}$/.test(bid)) {
    const d = await getJSON('/api/arrange/board?id=' + bid);
    if (!d || !d.layout) return failEditor('This shared layout does not exist any more.');
    layout = cleanLayout(d.layout);
    const hashEdit = (location.hash.match(/[#&]e=([a-z0-9]{24})/) || [])[1];
    if (hashEdit) store.set('sh_arr_edit:' + bid, hashEdit);
    board = { id: bid, edit: hashEdit || store.get('sh_arr_edit:' + bid) };
    owner = !!board.edit;
    key = 'sh_arr:b:' + bid;
    const local = owner ? null : store.get(key); // a visitor's own changes to someone else's layout stay on their phone
    if (local) layout = cleanLayout(local) || layout;
    track('arrange_view', { kind: owner ? 'board:own' : 'board:shared' });
  } else if (p) { layout = cleanLayout(store.get('sh_arr:p:' + p)) || { plan: p, items: null }; key = 'sh_arr:p:' + p; track('arrange_view', { kind: 'plan:' + p }); }
  else if (room) {
    const m = room.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/); if (!m) return failEditor('Room size not understood.');
    key = `sh_arr:r:${m[1]}x${m[2]}`; layout = cleanLayout(store.get(key)) || { room: { w: +m[1], d: +m[2] }, items: [] }; track('arrange_view', { kind: 'room' });
  }
  if (!layout) return failEditor('This link is not complete. Open the layout from the link you were sent, or start your own.');
  if (layout.plan) {
    plan = await getJSON(`./plans/${layout.plan}.json`);
    if (!plan) return failEditor('This floor plan is not available.');
  } else plan = roomPlan(layout.room.w, layout.room.d);
  planItems = (plan.items || []).map(fromPlanItem).filter(Boolean);
  fixed = planItems.filter(i => i.fixed);
  items = layout.items ? layout.items.map(i => ({ ...i, id: newId() })) : planItems.filter(i => !i.fixed).map(i => ({ ...i, id: newId() }));
  $('eName').textContent = layout.title || plan.name;
  $('eSub').textContent = [plan.by && plan.source === 'plan' ? `${plan.type || 'Plan'} by ${plan.by}` : null, overall()].filter(Boolean).join(' · ');
  document.title = `${plan.name} — arrange it · SHOWHAUS`;
  basis(); banner(); palette(); wire(); draw();
}
function failEditor(t) { $('stage').innerHTML = `<p style="padding:24px">${esc(t)} <a href="./">Start again</a></p>`; }
function overall() { const [x0, y0, x1, y1] = bounds(plan.outline); return `${(x1 - x0).toFixed(2)} × ${(y1 - y0).toFixed(2)} m`; }
function basis() {
  const t = plan.source === 'plan' ? 'Walls, windows and doors follow the published floor plan' + (plan.source_url ? ` (<a href="${esc(plan.source_url)}" target="_blank" rel="noopener">plan</a>)` : '') + '. Ceiling height and the starting furniture are estimates; sizes you type are yours.'
    : plan.source === 'measured' ? 'One rectangular room at the size you measured. The door position and the 2.7 m ceiling are placeholders.'
    : /^fixture-/.test(plan.slug || '') ? 'Invented sample plan to show how arranging works. Not a real home.'
    : plan.source === 'estimate' ? 'Interior layout estimated from satellite imagery — not measured. Treat sizes as a guess.'
    : 'Invented sample plan to show how arranging works. Not a real home.';
  $('basis').innerHTML = t;
}
function banner() {
  const b = $('banner');
  if (qs.get('view') === 'listing') { b.hidden = false; b.textContent = 'Buyer view: this is what buyers get from a listing’s link — the floor plan in metres, ready for their own furniture. No sign-up.'; return; }
  if (board && !owner) { b.hidden = false; b.innerHTML = 'Someone shared this layout with you. Move anything — your changes stay on this phone. <button type="button" id="fork">Save as my own</button>'; $('fork').onclick = fork; return; }
  b.hidden = true;
}

// ------------------------------------------------------------------ 2D plan (SVG, metres)
let VB = null;
const X = x => +(x - VB[0]).toFixed(3), Y = y => +(VB[3] - y).toFixed(3);
function draw() {
  const svg = $('plan');
  const outs = (plan.outdoor || []).map(o => o.rect), b = bounds(plan.outline);
  const bx = [b[0], ...outs.map(o => o[0])], by = [b[1], ...outs.map(o => o[1])], ex = [b[2], ...outs.map(o => o[2])], ey = [b[3], ...outs.map(o => o[3])];
  const m = 0.9; VB = [Math.min(...bx) - m, Math.min(...by) - m, Math.max(...ex) + m, Math.max(...ey) + m];
  svg.setAttribute('viewBox', `0 0 ${(VB[2] - VB[0]).toFixed(2)} ${(VB[3] - VB[1]).toFixed(2)}`);
  let s = '';
  for (const o of outs) s += `<rect class="outdoor" x="${X(o[0])}" y="${Y(o[3])}" width="${o[2] - o[0]}" height="${o[3] - o[1]}"/>`;
  s += `<polygon class="room" points="${plan.outline.map(([x, y]) => X(x) + ',' + Y(y)).join(' ')}"/>`;
  for (const w of wallBoxes(plan)) s += `<rect class="iwall" x="${X(w[0])}" y="${Y(w[3])}" width="${(w[2] - w[0]).toFixed(3)}" height="${(w[3] - w[1]).toFixed(3)}"/>`;
  edges(plan.outline).forEach(([a, c], i) => {
    const horiz = Math.abs(c[1] - a[1]) < 1e-6, L = Math.hypot(c[0] - a[0], c[1] - a[1]), n = [-(c[1] - a[1]) / L, (c[0] - a[0]) / L]; // inward
    for (const o of (plan.openings || []).filter(o => o.edge === i)) {
      const p0 = horiz ? [o.a, a[1]] : [a[0], o.a], p1 = horiz ? [o.b, a[1]] : [a[0], o.b];
      s += `<line class="${o.type === 'door' ? 'door' : 'opening'}" x1="${X(p0[0])}" y1="${Y(p0[1])}" x2="${X(p1[0])}" y2="${Y(p1[1])}"/>`;
      if (o.type === 'door') { const r = Math.abs(o.b - o.a), q = [p0[0] + n[0] * r, p0[1] + n[1] * r];
        s += `<path class="swing" d="M${X(p1[0])} ${Y(p1[1])} A${r} ${r} 0 0 ${horiz ? (n[1] > 0 ? 0 : 1) : (n[0] > 0 ? 1 : 0)} ${X(q[0])} ${Y(q[1])} L${X(p0[0])} ${Y(p0[1])}"/>`; }
    }
  });
  for (const w of plan.walls || []) for (const g of w.doors || []) {
    const horiz = Math.abs(w.to[1] - w.from[1]) < 1e-6, r = Math.abs(g.b - g.a), lo = Math.min(g.a, g.b);
    const p0 = horiz ? [lo, w.from[1]] : [w.from[0], lo], p1 = horiz ? [lo + r, w.from[1]] : [w.from[0], lo + r], sg = g.swing === -1 ? -1 : 1;
    const q = horiz ? [p0[0], p0[1] + sg * r] : [p0[0] + sg * r, p0[1]];
    s += `<path class="swing" d="M${X(p1[0])} ${Y(p1[1])} A${r} ${r} 0 0 ${horiz ? (sg > 0 ? 0 : 1) : (sg > 0 ? 1 : 0)} ${X(q[0])} ${Y(q[1])} L${X(p0[0])} ${Y(p0[1])}"/>`;
  }
  for (const sp of plan.spaces || []) s += `<text class="space" x="${X(sp.at[0])}" y="${Y(sp.at[1])}">${esc(sp.name)}</text>`;
  s += `<text class="overall" x="${X((b[0] + b[2]) / 2)}" y="${Y(b[3]) - 0.3}">${(b[2] - b[0]).toFixed(2)} m</text>`;
  s += `<text class="overall" transform="translate(${X(b[0]) - 0.3} ${Y((b[1] + b[3]) / 2)}) rotate(-90)">${(b[3] - b[1]).toFixed(2)} m</text>`;
  const bad = clashes(all());
  const order = [...all()].sort((p, q) => ((CATALOGUE[q.t] || {}).flat ? 1 : 0) - ((CATALOGUE[p.t] || {}).flat ? 1 : 0)); // rugs first
  for (const it of order) {
    const c = CATALOGUE[it.t] || CATALOGUE.box, r = rectOf(it, false), rc = rectOf(it), w = r[2] - r[0], h = r[3] - r[1];
    const cls = ['it', it.fixed ? 'fixed' : 'mov', it.id === sel ? 'sel' : '', bad.has(it.id) ? 'clash' : ''].join(' ');
    s += `<g class="${cls}" data-id="${it.id}">`;
    if (c.chairs) s += `<rect class="chairs" x="${X(rc[0])}" y="${Y(rc[3])}" width="${(rc[2] - rc[0]).toFixed(3)}" height="${(rc[3] - rc[1]).toFixed(3)}" rx=".08"/>`;
    s += `<rect class="body" x="${X(r[0])}" y="${Y(r[3])}" width="${w.toFixed(3)}" height="${h.toFixed(3)}" rx="${c.flat ? 0 : 0.04}" fill="${it.fixed ? '#e5e1d9' : c.color}" fill-opacity="${c.flat ? 0.45 : 0.9}"/>`;
    if (['sofa', 'armchair', 'bed', 'tv_unit', 'desk'].includes(it.t)) { // the back (headboard, sofa back) so turning reads at a glance
      const t = 0.12, bk = { 0: [r[0], r[1], r[2], r[1] + t], 90: [r[2] - t, r[1], r[2], r[3]], 180: [r[0], r[3] - t, r[2], r[3]], 270: [r[0], r[1], r[0] + t, r[3]] }[it.r || 0];
      s += `<rect x="${X(bk[0])}" y="${Y(bk[3])}" width="${(bk[2] - bk[0]).toFixed(3)}" height="${(bk[3] - bk[1]).toFixed(3)}" fill="#4a423b" fill-opacity=".55" pointer-events="none"/>`;
    }
    const cx = X((r[0] + r[2]) / 2), cy = Y((r[1] + r[3]) / 2), small = Math.min(w, h) < 0.5;
    if (!small || it.id === sel) s += `<text x="${cx}" y="${cy - (small ? 0 : 0.04)}">${esc(it.label)}</text>${small ? '' : `<text class="sz" x="${cx}" y="${cy + 0.18}">${cm(it.w)} × ${cm(it.d)}</text>`}`;
    s += '</g>';
  }
  const it = sel && find(sel);
  if (it) {
    const g = clearances(plan, all(), it), r = rectOf(it), mx = (r[0] + r[2]) / 2, my = (r[1] + r[3]) / 2;
    const dim = (x0, y0, x1, y1, v) => { if (v == null || v > 4) return; const tight = v < 0.6 ? ' tight' : '';
      s += `<line class="dimline${tight}" x1="${X(x0)}" y1="${Y(y0)}" x2="${X(x1)}" y2="${Y(y1)}"/><text class="dimtxt${tight}" x="${X((x0 + x1) / 2) + (x0 === x1 ? 0.12 : 0)}" y="${Y((y0 + y1) / 2) + (x0 === x1 ? 0.06 : -0.06)}"${x0 === x1 ? ' text-anchor="start"' : ''}>${cm(v)}</text>`; };
    dim(r[0] - g.w, my, r[0], my, g.w); dim(r[2], my, r[2] + g.e, my, g.e); dim(mx, r[1] - g.s, mx, r[1], g.s); dim(mx, r[3], mx, r[3] + g.n, g.n);
  }
  svg.innerHTML = s;
  selPanel();
  if (three) three.update();
}
function frontGap(it) {
  const g = clearances(plan, all(), it), front = { 0: 'n', 90: 'w', 180: 's', 270: 'e' }[it.r || 0];
  return { g, front: g[front] };
}
function selPanel() {
  const it = sel && find(sel);
  $('sel').hidden = !it; if (!it) return;
  $('selName').textContent = it.label;
  if (document.activeElement !== $('selW')) $('selW').value = cm(it.w);
  if (document.activeElement !== $('selD')) $('selD').value = cm(it.d);
  const bad = clashes(all()).has(it.id), { g, front } = frontGap(it), facing = ['sofa', 'armchair', 'bed', 'tv_unit', 'desk', 'wardrobe', 'drawers', 'bookshelf'].includes(it.t);
  const near = Object.values(g).filter(v => v != null), min = near.length ? Math.min(...near) : null;
  let t = bad ? 'Overlaps another piece — move it until the red outline goes.' : '';
  if (!bad && facing && front != null) t = front < 0.6 ? `Only ${cm(front)} cm clear in front — 60 cm or more is comfortable to walk past.` : `${cm(front)} cm clear in front.`;
  else if (!bad && min != null) t = `Closest gap ${cm(min)} cm.`;
  $('selGap').textContent = t; $('selGap').className = 'gap' + (bad || (facing && front != null && front < 0.6) ? ' bad' : '');
}

// ------------------------------------------------------------------ editing
const BACKED = ['sofa', 'armchair', 'bed', 'tv_unit', 'desk', 'wardrobe', 'drawers', 'bookshelf', 'bedside'];
function place(it) { // a free spot against a wall, as near the middle of the room as possible (beds and wardrobes live on walls)
  const [x0, y0, x1, y1] = bounds(plan.outline), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, pts = [];
  const st = Math.max(0.1, Math.max(x1 - x0, y1 - y0) / 60);
  for (let x = x0; x <= x1; x += st) for (let y = y0; y <= y1; y += st) pts.push([x, y, Math.hypot(x - cx, y - cy)]);
  pts.sort((p, q) => p[2] - q[2]);
  const ok = c => rectInRoom(plan, rectOf(c, false)), free = c => ok(c) && !clashes([...all(), c]).has(c.id);
  const others = all(), backed = BACKED.includes(it.t), BACK = { 0: 's', 90: 'e', 180: 'n', 270: 'w' };
  for (const [x, y] of pts) for (const r of [0, 90, 180, 270]) {
    const c = snap(plan, { ...it, r, x: +x.toFixed(2), y: +y.toFixed(2) }, 0.6); if (!free(c)) continue;
    const g = clearances(plan, others, c), touch = k => g[k] != null && g[k] < 0.01;
    if (backed ? touch(BACK[r]) : Object.keys(g).some(touch)) return c; // a bed's head, a sofa's back, a desk's back to the wall
  }
  for (const [x, y] of pts) { const c = { ...it, x: +x.toFixed(2), y: +y.toFixed(2) }; if (free(c)) return c; }
  for (const [x, y] of pts) { const c = { ...it, x: +x.toFixed(2), y: +y.toFixed(2) }; if (ok(c)) return c; }
  return { ...it, x: cx, y: cy };
}
function add(t, w, d, label, how) {
  const c = CATALOGUE[t], it = place({ id: newId(), t, x: 0, y: 0, r: 0, w, d, h: c.h, label: label || c.label });
  items.push(it); sel = it.id; changed(); track('arrange_add', { cta: how, kind: t });
}
function changed() { dirty = true; draw(); save(); }
let saveT = 0;
function save() {
  const layout = { plan: plan.slug || null, room: plan.slug ? null : { w: bounds(plan.outline)[2], d: bounds(plan.outline)[3] }, items: items.map(({ id, ...i }) => i), title: $('eName').textContent };
  if (!board || !owner) store.set(key, layout);
  const href = board ? `./?b=${board.id}` : plan.slug ? `./?p=${plan.slug}` : `./?room=${layout.room.w}x${layout.room.d}`;
  const list = (store.get('sh_arr_list') || []).filter(m => m.href !== href);
  list.unshift({ href, name: layout.title, items: items.length, at: Date.now() }); store.set('sh_arr_list', list.slice(0, 12));
  if (board && owner) { clearTimeout(saveT); $('status').textContent = 'Saving…'; saveT = setTimeout(async () => {
    const r = await post('/api/arrange/board', { id: board.id, edit: board.edit, layout });
    $('status').textContent = r.ok ? 'Saved to your link' : (r.data.error || 'Not saved — no connection');
  }, 900); } else $('status').textContent = board ? 'Your changes are on this phone' : 'Saved on this phone';
}
function rotate(it) {
  const t = { ...it, r: ((it.r || 0) + 90) % 360 };
  for (const [dx, dy] of [[0, 0], ...ring()]) { const c = snap(plan, { ...t, x: t.x + dx, y: t.y + dy }); if (rectInRoom(plan, rectOf(c, false))) return Object.assign(it, c); }
  $('status').textContent = 'No room to turn it here — move it first.'; return it;
}
const ring = () => { const out = []; for (const r of [0.1, 0.2, 0.3, 0.5, 0.8]) for (let a = 0; a < 8; a++) out.push([Math.cos(a * Math.PI / 4) * r, Math.sin(a * Math.PI / 4) * r]); return out; };

function palette() {
  $('palette').innerHTML = PALETTE.map(([n, t, w, d], i) => `<button type="button" data-i="${i}">${esc(n)}<small>${cm(w)}×${cm(d)}</small></button>`).join('');
  $('palette').onclick = e => { const b = e.target.closest('button'); if (!b) return; const [n, t, w, d] = PALETTE[+b.dataset.i]; add(t, w, d, n, 'palette'); };
}

let wired = false;
function wire() {
  if (wired) return; wired = true;
  const svg = $('plan'); let drag = null;
  const pt = e => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; const q = p.matrixTransform(svg.getScreenCTM().inverse()); return [q.x + VB[0], VB[3] - q.y]; };
  svg.addEventListener('pointerdown', e => {
    const g = e.target.closest('.it'); const it = g && find(g.dataset.id);
    if (!it) { if (sel) { sel = null; draw(); } return; }
    const [x, y] = pt(e); drag = { id: it.id, dx: it.x - x, dy: it.y - y, moved: false };
    sel = it.id; try { svg.setPointerCapture(e.pointerId); } catch { /* fine */ } draw(); e.preventDefault();
  });
  svg.addEventListener('pointermove', e => {
    if (!drag) return; const it = find(drag.id); if (!it) return;
    const [x, y] = pt(e), c = snap(plan, { ...it, x: x + drag.dx, y: y + drag.dy });
    const okAt = q => rectInRoom(plan, rectOf(q, false));
    if (okAt(c)) Object.assign(it, { x: c.x, y: c.y }); // inside the walls: take it
    else if (okAt({ ...it, x: c.x })) it.x = c.x;         // slide along the wall it hit
    else if (okAt({ ...it, y: c.y })) it.y = c.y;
    drag.moved = true; draw();
  });
  const end = () => { if (drag && drag.moved) changed(); drag = null; };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
  addEventListener('keydown', e => {
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return; const it = sel && find(sel); if (!it || mode !== '2d') return;
    const k = e.key.toLowerCase(), step = e.shiftKey ? 0.25 : 0.05, mv = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, step], arrowdown: [0, -step] }[k];
    if (k === 'r') { rotate(it); changed(); } else if (k === 'delete' || k === 'backspace') { items = items.filter(i => i !== it); sel = null; changed(); }
    else if (mv) { const c = { ...it, x: +(it.x + mv[0]).toFixed(3), y: +(it.y + mv[1]).toFixed(3) }; if (rectInRoom(plan, rectOf(c, false))) Object.assign(it, c); changed(); }
    else return; e.preventDefault();
  });
  $('rot').onclick = () => { const it = find(sel); if (it) { rotate(it); changed(); } };
  $('dup').onclick = () => { const it = find(sel); if (!it) return; const c = place({ ...it, id: newId() }); items.push(c); sel = c.id; changed(); track('arrange_add', { cta: 'copy', kind: it.t }); };
  $('del').onclick = () => { items = items.filter(i => i.id !== sel); sel = null; changed(); };
  const size = (k, el) => el.addEventListener('change', () => { const it = find(sel), v = parseFloat(el.value) / 100; if (!it || !(v >= 0.1 && v <= 6)) return;
    const c = { ...it, [k]: v }; if (rectInRoom(plan, rectOf(c, false))) Object.assign(it, c); else { const p = place(c); if (rectInRoom(plan, rectOf(p, false))) Object.assign(it, p); else $('status').textContent = 'That size does not fit in this room.'; } changed(); });
  size('w', $('selW')); size('d', $('selD'));
  $('mineForm').addEventListener('submit', e => { e.preventDefault(); const w = parseFloat($('myW').value) / 100, d = parseFloat($('myD').value) / 100;
    if (!(w >= 0.1 && w <= 6 && d >= 0.1 && d <= 6)) { $('status').textContent = 'Type width and depth in cm, e.g. 230 and 95.'; return; }
    add('box', w, d, $('myName').value.trim() || 'My item', 'mine'); $('myName').value = $('myW').value = $('myD').value = ''; });
  $('clear').onclick = () => { items = []; sel = null; changed(); };
  $('reset').onclick = () => { items = planItems.filter(i => !i.fixed).map(i => ({ ...i, id: newId() })); sel = null; changed(); };
  $('reset').hidden = !planItems.some(i => !i.fixed);
  $('v2d').onclick = () => setMode('2d'); $('v3d').onclick = () => setMode('3d');
  $('remindRow').addEventListener('toggle', () => { if ($('remindRow').open) track('arrange_remind', { cta: 'open' }); });
  $('remind').onclick = remind; $('selfWa').addEventListener('click', () => track('arrange_remind', { cta: 'wa-self' }));
  $('share').onclick = share; $('shareX').onclick = () => { $('shareBox').hidden = true; };
  $('shareBox').addEventListener('pointerdown', e => { if (e.target === $('shareBox')) $('shareBox').hidden = true; });
  $('copy').onclick = async () => { try { await navigator.clipboard.writeText($('shareUrl').value); say($('shareMsg'), 'Copied.', 'ok'); } catch { $('shareUrl').select(); say($('shareMsg'), 'Select and copy the link above.'); } track('cta', { cta: 'arrange-copy-link' }); };
}

// ------------------------------------------------------------------ share (no sign-up): ?b=<id>, and #e=<edit> for the maker
async function ensureBoard() {
  if (board && owner) return true;
  const layout = { plan: plan.slug || null, room: plan.slug ? null : { w: bounds(plan.outline)[2], d: bounds(plan.outline)[3] }, items: items.map(({ id, ...i }) => i), title: $('eName').textContent };
  $('share').disabled = true; const r = await post('/api/arrange/board', { layout }); $('share').disabled = false;
  if (!r.ok) { $('status').textContent = r.data.error || 'Could not make a link. Try again.'; return false; }
  board = { id: r.data.id, edit: r.data.edit }; owner = true; store.set('sh_arr_edit:' + board.id, board.edit); key = 'sh_arr:b:' + board.id;
  history.replaceState(null, '', `./?b=${board.id}#e=${board.edit}`); banner(); save();
  return true;
}
async function share() {
  if (!(await ensureBoard())) return;
  const url = `${location.origin}/arrange/?b=${board.id}`;
  $('shareUrl').value = url;
  const text = `Here’s how our furniture fits — ${$('eName').textContent}: ${url}`;
  $('wa').href = 'https://wa.me/?text=' + encodeURIComponent(text); $('mail').href = 'mailto:?subject=' + encodeURIComponent('Our furniture layout') + '&body=' + encodeURIComponent(text);
  say($('shareMsg'), 'This page’s own address (with #e=) lets you keep changing it. Keep it, or open this layout again on this phone.');
  $('shareBox').hidden = false;
}
async function fork() {
  board = null; owner = false; track('arrange_copy');
  await share();
}

// ------------------------------------------------------------------ come back on the day (no account): a calendar file + a note to self
// The 21-day walk panel (2026-11-17): 0/12 came back because of anything SHOWHAUS sent; the ask was "bring my layout back before moving day".
export function icsFor({ date, title, url, now = new Date() }) {
  const d = date.replace(/-/g, ''), next = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + 1)).toISOString().slice(0, 10).replace(/-/g, '');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const esc = s => String(s).replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
  const alarm = (t, what) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER:${t}`, `DESCRIPTION:${esc(what)}`, 'END:VALARM'];
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SHOWHAUS//arrange//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:arrange-${d}-${Math.abs([...url].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}@showhaus.app`, `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`, `SUMMARY:${esc('Moving day — check your furniture layout')}`,
    `DESCRIPTION:${esc(`Your layout for ${title}: ${url}`)}`, `URL:${url}`,
    ...alarm('-P3D', 'Moving in 3 days — does everything still fit? ' + url), ...alarm('-PT15H', 'Tomorrow: your furniture layout ' + url),
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
}
async function remind() {
  const date = $('moveDate').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { say($('remindMsg'), 'Pick the day first.'); $('moveDate').focus(); return; }
  if (!(await ensureBoard())) return;
  const url = `${location.origin}/arrange/?b=${board.id}#e=${board.edit}`;
  const blob = new Blob([icsFor({ date, title: $('eName').textContent, url })], { type: 'text/calendar' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'moving-day-layout.ics'; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  $('selfWa').href = 'https://wa.me/?text=' + encodeURIComponent(`My furniture layout (keep this, it opens on any phone): ${url}`); $('selfWa').hidden = false;
  say($('remindMsg'), 'Calendar file ready — open it to add the reminders. The link inside opens this layout on any phone.', 'ok');
  const days = Math.round((Date.parse(date) - Date.now()) / 864e5);
  track('arrange_remind', { cta: 'ics', kind: days < 0 ? 'past' : days <= 7 ? '0-7d' : days <= 30 ? '8-30d' : '30d+' });
}

// ------------------------------------------------------------------ 3D: built here from the plan, no bake
function setMode(m) {
  mode = m; document.body.dataset.view = m; $('v2d').setAttribute('aria-pressed', m === '2d'); $('v3d').setAttribute('aria-pressed', m === '3d');
  $('plan').style.display = m === '2d' ? '' : 'none'; /* an <svg> has no .hidden property */ $('three').hidden = $('threeBar').hidden = m !== '3d';
  if (m === '3d') { track('arrange_3d', { cta: 'open' }); (three ? Promise.resolve() : start3d()).then(() => three.show(true)); } else if (three) three.show(false);
}
async function start3d() {
  $('threeHint').textContent = 'Building the room…';
  const THREE = await import('three'), { buildRoom } = await import('../walk/plan-room.js');
  const host = $('three'), renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  host.append(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#bcd3ea');
  const R = buildRoom(THREE, plan, { ceiling: false }); scene.add(R.root);
  const cam = new THREE.PerspectiveCamera(55, 1, 0.05, 300); cam.rotation.order = 'YXZ';
  let view = 'above', orbit = { th: -0.5, ph: 0.7, r: Math.max(5.5, R.span * 1.5) }, fp = null, on = false, glide = null;
  const [cx, cy] = R.center;
  const free = (x, y) => (rectInRoom(plan, [x - 0.2, y - 0.2, x + 0.2, y + 0.2])) && !all().some(i => !(CATALOGUE[i.t] || {}).flat && (() => { const r = rectOf(i); return x > r[0] - 0.15 && x < r[2] + 0.15 && y > r[1] - 0.15 && y < r[3] + 0.15; })());
  const startFp = () => { const v = (plan.views || []).find(v => free(...v.pos)); if (v) return { x: v.pos[0], y: v.pos[1], yaw: Math.atan2(-(v.look[0] - v.pos[0]), v.look[1] - v.pos[1]), pitch: -0.1 };
    // no camera in the plan: stand in a corner and look across the room to the opposite one (a wall at 1.5 m fills a phone screen)
    const [bx0, by0, bx1, by1] = bounds(plan.outline), look = (x, y, tx, ty) => ({ x, y, yaw: Math.atan2(-(tx - x), ty - y), pitch: -0.18 });
    for (const [fx, fy] of [[0.15, 0.12], [0.85, 0.12], [0.15, 0.88], [0.85, 0.88]]) { const x = bx0 + (bx1 - bx0) * fx, y = by0 + (by1 - by0) * fy;
      if (free(x, y)) return look(x, y, bx0 + (bx1 - bx0) * (1 - fx), by0 + (by1 - by0) * (1 - fy)); }
    for (const [dx, dy] of [[0, 0], ...ring(), ...ring().map(([a, b]) => [a * 3, b * 3])]) if (free(cx + dx, cy + dy)) return { x: cx + dx, y: cy + dy, yaw: 0, pitch: -0.1 }; return { x: cx, y: cy, yaw: 0, pitch: -0.1 }; };
  const size = () => { const w = host.clientWidth || innerWidth, h = host.clientHeight || innerHeight; renderer.setSize(w, h, false); cam.aspect = w / h; cam.fov = w < h ? 80 : 60; cam.updateProjectionMatrix(); };
  addEventListener('resize', size);
  const setView = v => { view = v; R.walls.scale.y = v === 'above' ? 0.4 : 1; /* dollhouse cut-away from above, full height inside */ $('above').setAttribute('aria-pressed', v === 'above'); $('walkIn').setAttribute('aria-pressed', v === 'inside'); R.ceiling.visible = v === 'inside';
    if (v === 'inside') { fp = fp || startFp(); $('threeHint').textContent = matchMedia('(pointer: coarse)').matches ? 'Drag to look · tap the floor to walk there' : 'Drag to look · WASD or tap the floor to walk'; }
    else $('threeHint').textContent = 'Drag to turn · pinch or scroll to zoom'; track('arrange_3d', { cta: v }); };
  $('above').onclick = () => setView('above'); $('walkIn').onclick = () => setView('inside');
  // input
  const cv = renderer.domElement, ptrs = new Map(); let down = null, pinch = 0;
  cv.addEventListener('pointerdown', e => { ptrs.set(e.pointerId, [e.clientX, e.clientY]); down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 }; try { cv.setPointerCapture(e.pointerId); } catch { /* fine */ } });
  cv.addEventListener('pointermove', e => {
    const p = ptrs.get(e.pointerId); if (!p) return; const dx = e.clientX - p[0], dy = e.clientY - p[1]; ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) orbit.r = Math.min(40, Math.max(3, orbit.r * pinch / d)); pinch = d; return; }
    if (down) down.moved += Math.abs(dx) + Math.abs(dy); glide = null;
    if (view === 'above') { orbit.th -= dx * 0.006; orbit.ph = Math.min(1.45, Math.max(0.25, orbit.ph - dy * 0.005)); }
    else { fp.yaw += dx * 0.004; fp.pitch = Math.max(-0.9, Math.min(0.7, fp.pitch + dy * 0.003)); }
  });
  const up = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = 0;
    if (down && down.moved < 8 && performance.now() - down.t < 400) tap(e); down = null; };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', e => { ptrs.delete(e.pointerId); down = null; });
  cv.addEventListener('wheel', e => { e.preventDefault(); orbit.r = Math.min(40, Math.max(3, orbit.r * (1 + Math.sign(e.deltaY) * 0.1))); }, { passive: false });
  const ray = new THREE.Raycaster();
  function tap(e) { // tap the floor: from above it takes you inside to that spot; inside it walks you there
    const b = cv.getBoundingClientRect(); ray.setFromCamera(new THREE.Vector2(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1), cam);
    const hit = ray.intersectObjects(R.floors, false)[0]; if (!hit) return; const x = hit.point.x, y = -hit.point.z;
    if (!free(x, y)) return;
    if (view === 'above') { fp = { x, y, yaw: Math.atan2(-(cx - x), cy - y), pitch: -0.1 }; setView('inside'); return; }
    let d = Math.atan2(-(x - fp.x), y - fp.y) - fp.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
    glide = { t: 0, x0: fp.x, y0: fp.y, x1: x, y1: y, w0: fp.yaw, w1: fp.yaw + d * 0.8, dur: Math.min(2, 0.5 + Math.hypot(x - fp.x, y - fp.y) * 0.2) };
  }
  const keys = {}; addEventListener('keydown', e => { if (mode === '3d' && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) keys[e.key.toLowerCase()] = 1; }); addEventListener('keyup', e => { keys[e.key.toLowerCase()] = 0; });
  let last = performance.now();
  function frame(now) {
    if (!on) return; const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (view === 'inside') {
      const f = (keys.w || keys.arrowup ? 1 : 0) - (keys.s || keys.arrowdown ? 1 : 0), s = (keys.d ? 1 : 0) - (keys.a ? 1 : 0), turn = (keys.arrowleft ? 1 : 0) - (keys.arrowright ? 1 : 0);
      if (f || s || turn) { glide = null; fp.yaw += turn * 1.6 * dt; const sp = 1.5 * dt, fx = -Math.sin(fp.yaw), fy = Math.cos(fp.yaw), nx = fp.x + (fx * f + fy * s) * sp, ny = fp.y + (fy * f - fx * s) * sp; if (free(nx, fp.y)) fp.x = nx; if (free(fp.x, ny)) fp.y = ny; }
      if (glide) { glide.t = Math.min(1, glide.t + dt / glide.dur); const k = glide.t < 0.5 ? 2 * glide.t ** 2 : 1 - (-2 * glide.t + 2) ** 2 / 2;
        fp.x = glide.x0 + (glide.x1 - glide.x0) * k; fp.y = glide.y0 + (glide.y1 - glide.y0) * k; fp.yaw = glide.w0 + (glide.w1 - glide.w0) * k; if (glide.t >= 1) glide = null; }
      cam.position.set(fp.x, 1.55, -fp.y); cam.rotation.set(fp.pitch, fp.yaw, 0);
    } else {
      cam.position.set(cx + orbit.r * Math.sin(orbit.ph) * Math.sin(orbit.th), orbit.r * Math.cos(orbit.ph), -cy + orbit.r * Math.sin(orbit.ph) * Math.cos(orbit.th));
      cam.lookAt(cx, 0.4, -cy);
    }
    renderer.render(scene, cam); requestAnimationFrame(frame);
  }
  three = {
    update: () => R.setItems(all(), null),
    show: v => { on = v; if (v) { size(); R.setItems(all(), null); setView(view); last = performance.now(); requestAnimationFrame(frame); } },
  };
  window.__arr = { state: () => ({ view, fp, orbit, items: items.length }), tapAt: (x, y) => { fp = { x, y, yaw: 0, pitch: -0.1 }; setView('inside'); } };
}

// test hook for the click-through judge
window.__arrange = { state: () => ({ plan: plan && (plan.slug || 'room'), items: items.map(({ id, t, x, y, r, w, d }) => ({ id, t, x, y, r, w, d })), sel, board, owner, mode }) };
if (qs.get('p') || qs.get('b') || qs.get('room')) openEditor(); else openStart();
