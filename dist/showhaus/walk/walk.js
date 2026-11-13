// SHOWHAUS walk. /walk/ lists the homes you can walk; /walk/?p=<slug> opens one.
// Base tier: a light-baked mesh drawn unlit (no GPU cost per visit). Photoreal tier: stills or clips pinned to
// viewpoints, revealed over the live scene with a draggable divider. Every label that states where the interior
// came from is chosen from the listing data (data/<slug>.json), never written into this file.
const $ = id => document.getElementById(id);
const qs = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
const slug = (qs.get('p') || '').replace(/[^a-z0-9-]/g, '').slice(0, 80);
const src = (qs.get('src') || 'direct').replace(/[^\w.-]/g, '').slice(0, 40);
const track = (name, props = {}) => { try { window.SH && window.SH.track(name, { kind: 'walk:' + (slug || 'gallery'), utm_source: src, ...props }); } catch { /* analytics never breaks the page */ } };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const getJSON = u => fetch(u, { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : null)).catch(() => null);

export const BASIS = {
  plan: 'Layout follows the published floor plan. Ceiling heights, finishes and furniture are estimated.',
  estimate: 'Interior layout is estimated from satellite imagery and a world model.',
};
export function labels(listing, claim) {
  const claimed = !!(claim && claim.claimed), basis = BASIS[listing.source] || BASIS.estimate;
  return {
    badge: claimed ? 'Owner-claimed' : 'Not yet owner-claimed',
    basis: (claimed ? '' : 'The interior may differ from the real home. ') + basis,
    card: claimed ? `Confirmed by ${claim.company || 'the owner'}.` : 'Not yet owner-claimed: shown as an AI visualisation that may differ from the real home until the owner confirms it.',
    plan: listing.source === 'plan' ? 'Already on file for this home.' : 'Needed first: upload this home’s floor plan.',
    planOk: listing.source === 'plan',
  };
}

if (typeof document !== 'undefined') (slug ? openWalk() : openGallery());

async function openGallery() {
  document.body.dataset.mode = 'gallery'; $('gallery').hidden = false;
  const idx = await getJSON('./data/index.json');
  $('cards').innerHTML = ((idx && idx.items) || []).map(it => `
    <a class="g-card" href="${esc(it.href)}${it.href.includes('?') ? '&' : '?'}src=walk-gallery" data-slug="${esc(it.slug)}">
      <div class="shot" style="background-image:url('${esc(it.poster)}')"><span class="tier">${esc(it.tier)}</span><span class="go">▶ Walk</span></div>
      <div class="txt"><b>${esc(it.name)}</b><span class="by">${esc([it.type, it.by && 'by ' + it.by, it.by && it.kind === 'walk' && 'not affiliated'].filter(Boolean).join(' · '))}</span><span class="line">${esc(it.line)}</span></div>
    </a>`).join('') || '<p>No walkthroughs yet.</p>';
  $('cards').addEventListener('click', e => { const a = e.target.closest('.g-card'); if (a) track('cta', { cta: 'open:' + a.dataset.slug }); });
}

function fail(msg) { $('load').innerHTML = `${esc(msg)}<br><br><a href="./">See all walkthroughs</a>`; }

async function openWalk() {
  document.body.dataset.mode = 'walk';
  const base = `./data/${slug}/`;
  const [meta, claim] = await Promise.all([getJSON(`./data/${slug}.json`), getJSON(`/api/claim/public?p=${slug}`)]);
  if (!meta || !meta.listing) return fail('This walkthrough does not exist.');
  const L = meta.listing, T = labels(L, claim);
  document.title = `${L.name} — walk it · SHOWHAUS`;
  $('load').textContent = `Opening the ${L.name}…`;
  $('tname').textContent = L.name;
  $('tby').textContent = [L.type, L.by && 'by ' + L.by].filter(Boolean).join(' · ') + (L.by && !(claim && claim.claimed) ? ' · not affiliated' : '');
  $('trooms').textContent = L.rooms || '';
  $('claim').textContent = T.badge; $('claim').classList.toggle('yes', !!(claim && claim.claimed));
  $('basis').textContent = T.basis; $('cardbasis').textContent = T.card;
  $('needPlan').textContent = T.plan; if (T.planOk) { $('needPlanIc').textContent = '✓'; $('needPlanIc').classList.add('ok'); }
  $('claimLink').href = `../claim/?p=${slug}&src=walk`;
  $('claimLink').addEventListener('click', () => track('cta', { cta: 'claim' }));
  $('claim').addEventListener('click', () => $('title').classList.toggle('open'));
  $('title').hidden = false; $('side').hidden = false;
  if (matchMedia('(pointer: coarse)').matches) $('hint').textContent = 'Drag to look · stick or tap the plan to walk';
  const by = (qs.get('by') || '').toLowerCase();
  if (/^[a-z0-9]{4,12}$/.test(by)) getJSON(`/api/claim/brand?c=${by}`).then(b => { if (b && b.company && b.slug === slug) $('tby').textContent = `Shared by ${b.company}`; });

  try {
    await new Promise((ok, bad) => { const s = document.createElement('script'); s.src = base + 'room.js'; s.onload = ok; s.onerror = () => bad(new Error('scene data')); document.head.append(s); });
    const THREE = await import('three');
    const R = window.ROOM;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.setSize(innerWidth, innerHeight);
    document.body.prepend(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0.62, 0.76, 0.95);
    const camera = new THREE.PerspectiveCamera(64, innerWidth / innerHeight, 0.05, 200); camera.rotation.order = 'YXZ';
    const b64 = s => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
    const pending = [];
    for (const g of Object.keys(R.groups)) {
      const G = R.groups[g], f = new Float32Array(b64(G.mesh).buffer), geo = new THREE.BufferGeometry(), ib = new THREE.InterleavedBuffer(f, 5);
      geo.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0)); geo.setAttribute('uv', new THREE.InterleavedBufferAttribute(ib, 2, 3));
      const tex = new THREE.Texture(); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
      pending.push(new Promise((ok, bad) => { const im = new Image(); im.onload = () => { tex.image = im; tex.needsUpdate = true; ok(); }; im.onerror = () => bad(new Error('texture ' + g)); im.src = base + G.atlas; }));
      scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })));
    }
    for (const v of R.views) if (v.photo) { const im = new Image(); im.src = base + v.photo; }

    // ---- state (plan coords: x east, y north; three = x, -z)
    const V = R.views.map(v => ({ ...v, real: v.clip || v.photo || null, yaw: Math.atan2(-(v.look[0] - v.pos[0]), v.look[1] - v.pos[1]) }));
    let px = V[0].pos[0], py = V[0].pos[1], yaw = V[0].yaw, pitch = V[0].pitch, glide = null, photoOn = -1;
    const ok = (x, y) => { if (!R.walk.some(b => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3])) return false;
      for (const k of R.boxes) if (x > k[0] && x < k[2] && y > k[1] && y < k[3]) return false; return true; };
    const baseFov = () => innerWidth < innerHeight ? 82 : 64;
    const photoFov = () => { const a = innerWidth / innerHeight, t = Math.tan(39 * Math.PI / 180); return 2 * Math.atan(t / Math.max(a, 1.5)) * 180 / Math.PI; };
    const setFov = f => { camera.fov = f; camera.updateProjectionMatrix(); };
    const photo = $('photo'), clip = $('clip');
    let wipeAnim = null, layer = photo;
    const setWipe = w => { w = Math.max(0.03, Math.min(0.97, w)); layer.style.clipPath = `inset(0 0 0 ${(w * 100).toFixed(2)}%)`; $('wipe').style.left = (w * 100).toFixed(2) + '%'; };
    function photoOff() { if (photoOn < 0) return; photoOn = -1; wipeAnim = null; photo.style.opacity = 0; clip.style.opacity = 0; clip.pause(); $('tag').style.opacity = 0; $('wipe').style.display = 'none'; setFov(baseFov()); mark(-1); }
    function photoShow(i) { const v = V[i]; photoOn = i; layer = v.clip ? clip : photo;
      if (v.clip) { clip.src = base + v.clip; clip.loop = true; clip.currentTime = 0; clip.play().catch(() => {}); } else photo.src = base + v.photo;
      setWipe(0.97); $('wipe').style.display = 'block'; wipeAnim = { t: 0 }; layer.style.opacity = 1; $('tag').style.opacity = 1; }
    function mark(i) { [...$('chips').children].forEach((b, k) => b.setAttribute('aria-pressed', k === i)); }
    function go(i, why) { const v = V[i]; photoOff(); mark(i); $('hint').style.opacity = 0;
      if (why) track('walk_room', { step: v.name, cta: why });
      let dy = v.yaw - yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      glide = { t: 0, d: Math.min(2.2, 0.7 + Math.hypot(v.pos[0] - px, v.pos[1] - py) * 0.16), x0: px, y0: py, w0: yaw, p0: pitch, x1: v.pos[0], y1: v.pos[1], w1: yaw + dy, p1: v.pitch, f0: camera.fov, f1: v.real ? photoFov() : baseFov(), i }; }
    V.forEach((v, i) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = v.real ? '◉ ' + v.name.replace(/^Photo\b/, 'AI render') : v.name; if (v.real) b.className = 'ph'; b.onclick = () => go(i, 'chip'); $('chips').append(b); });

    // ---- mini plan, sized from the room outline
    const P = R.plan, S = innerWidth <= 560 ? 8 : 11, pad = 0.5;
    const xs = P.room.map(p => p[0]).concat(P.alfresco ? [P.alfresco[0], P.alfresco[2]] : []), ys = P.room.map(p => p[1]).concat(P.alfresco ? [P.alfresco[1], P.alfresco[3]] : []);
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - 0.3, y1 = Math.max(...ys) + 0.2, north = Math.max(...P.room.map(p => p[1]));
    const mx = x => ((x - x0) * S).toFixed(1), my = y => ((y1 - y) * S).toFixed(1), mw = (x1 - x0) * S, mh = (y1 - y0) * S;
    let svg = `<svg width="${mw}" height="${mh}" viewBox="0 0 ${mw} ${mh}" role="img" aria-label="Floor plan: tap to walk there">`;
    if (P.alfresco) svg += `<rect x="${mx(P.alfresco[0])}" y="${my(P.alfresco[3])}" width="${(P.alfresco[2] - P.alfresco[0]) * S}" height="${(P.alfresco[3] - P.alfresco[1]) * S}" fill="#e9e4da" stroke="#14181c" stroke-width="1" stroke-dasharray="3 3"/>`;
    svg += `<polygon points="${P.room.map(p => mx(p[0]) + ',' + my(p[1])).join(' ')}" fill="#fff" stroke="#14181c" stroke-width="2"/>`;
    for (const o of P.openings || []) svg += `<line x1="${mx(o[0])}" y1="${my(north)}" x2="${mx(o[1])}" y2="${my(north)}" stroke="#7fb6e6" stroke-width="3"/>`;
    for (const k of R.solid) svg += `<rect x="${mx(k[0])}" y="${my(k[3])}" width="${(k[2] - k[0]) * S}" height="${(k[3] - k[1]) * S}" rx="2" fill="#d9d4ca"/>`;
    svg += `<g id="me"><path d="M0 0 L-9 -17 A19 19 0 0 1 9 -17 Z" fill="#e8743b" opacity=".35"/><circle r="4.5" fill="#e8743b" stroke="#fff" stroke-width="1.5"/></g></svg>`;
    $('map').innerHTML = svg; const me = $('me');
    $('map').addEventListener('pointerdown', e => { const b = $('map').querySelector('svg').getBoundingClientRect(); let x = (e.clientX - b.left) / S + x0, y = y1 - (e.clientY - b.top) / S;
      if (!ok(x, y)) { let best = null; for (let a = 0; a < 6.3; a += 0.3) for (const r of [0.3, 0.6, 0.9, 1.3]) { const cx = x + Math.cos(a) * r, cy = y + Math.sin(a) * r; if (ok(cx, cy) && (!best || r < best[2])) best = [cx, cy, r]; } if (!best) return; [x, y] = best; }
      photoOff(); mark(-1); $('hint').style.opacity = 0; const w = Math.atan2(-(x - px), y - py); let dy = w - yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      glide = { t: 0, d: Math.min(2.2, 0.6 + Math.hypot(x - px, y - py) * 0.16), x0: px, y0: py, w0: yaw, p0: pitch, x1: x, y1: y, w1: yaw + dy * 0.85, p1: -0.08, f0: camera.fov, f1: baseFov(), i: -1 }; e.stopPropagation(); });

    // ---- input
    const keys = {}; let jx = 0, jy = 0, last = performance.now(), walked = false;
    const typing = e => /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');
    addEventListener('keydown', e => { if (typing(e)) return; keys[e.key.toLowerCase()] = 1; if (e.key === 'Escape') shut(); const n = +e.key; if (n >= 1 && n <= V.length) { go(n - 1, 'key'); glide.t = 0.999; } });
    addEventListener('keyup', e => { keys[e.key.toLowerCase()] = 0; });
    addEventListener('blur', () => { for (const k in keys) keys[k] = 0; });
    const cap = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone: the drag still works while it stays over the element */ } };
    const cv = renderer.domElement; let drag = null;
    cv.addEventListener('pointerdown', e => { drag = [e.clientX, e.clientY]; cap(cv, e); });
    cv.addEventListener('pointermove', e => { if (!drag) return; const dx = e.clientX - drag[0], dyy = e.clientY - drag[1]; if (!dx && !dyy) return; glide = null; photoOff();
      yaw += dx * 0.004; pitch = Math.max(-0.8, Math.min(0.7, pitch + dyy * 0.003)); drag = [e.clientX, e.clientY]; $('hint').style.opacity = 0; });
    cv.addEventListener('pointerup', () => { drag = null; }); cv.addEventListener('pointercancel', () => { drag = null; });
    const wp = $('wipe'); let wdrag = false;
    wp.addEventListener('pointerdown', e => { wdrag = true; wipeAnim = null; cap(wp, e); e.stopPropagation(); });
    wp.addEventListener('pointermove', e => { if (wdrag) setWipe(e.clientX / innerWidth); });
    wp.addEventListener('pointerup', () => { wdrag = false; }); wp.addEventListener('pointercancel', () => { wdrag = false; });

    // ---- upgrade card. No price exists yet, so the button counts demand instead of taking money.
    const veil = $('veil'), want = $('want'), key = 'sh_want_' + slug;
    function shut() { veil.style.display = 'none'; }
    const wanted = () => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };
    const paintWant = () => { if (!wanted() && !want.classList.contains('done')) return; want.classList.add('done'); want.textContent = 'Counted ✓'; want.disabled = true; $('wantFine').textContent = 'Thanks — counted for this home.'; };
    $('up').onclick = () => { veil.style.display = 'grid'; paintWant(); track('upgrade_open', { cta: 'button' }); };
    $('x').onclick = shut; veil.addEventListener('pointerdown', e => { if (e.target === veil) shut(); });
    const sample = V.findIndex(v => v.real);
    if (sample < 0) $('see').hidden = true; else $('see').onclick = () => { shut(); go(sample, 'sample'); };
    want.onclick = () => { if (want.disabled) return; track('upgrade_interest', { cta: L.source === 'plan' ? 'has-plan' : 'needs-plan' }); try { localStorage.setItem(key, '1'); } catch { /* private mode: still counted once */ } want.classList.add('done'); paintWant(); };

    const st = $('stick'), kn = $('knob');
    const stick = e => { const b = st.getBoundingClientRect(); let x = (e.clientX - b.left - 52) / 38, y = (e.clientY - b.top - 52) / 38; const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; } jx = x; jy = y; kn.style.left = 32 + x * 32 + 'px'; kn.style.top = 32 + y * 32 + 'px'; };
    st.addEventListener('pointerdown', e => { cap(st, e); stick(e); });
    st.addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'touch') stick(e); });
    const rel = () => { jx = jy = 0; kn.style.left = '32px'; kn.style.top = '32px'; }; st.addEventListener('pointerup', rel); st.addEventListener('pointercancel', rel);
    addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; setFov(photoOn >= 0 ? photoFov() : baseFov()); });

    const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    function step(now) {
      const rdt = (now - last) / 1000, dt = Math.min(0.05, rdt); last = now;
      const fwd = (keys.w || keys.arrowup ? 1 : 0) - (keys.s || keys.arrowdown ? 1 : 0) - jy, str = (keys.d ? 1 : 0) - (keys.a ? 1 : 0) + jx;
      const turn = (keys.arrowleft ? 1 : 0) - (keys.arrowright ? 1 : 0);
      if (fwd || str || turn) { glide = null; photoOff(); mark(-1); $('hint').style.opacity = 0; yaw += turn * 1.6 * dt;
        if (!walked) { walked = true; track('walk_room', { step: 'free-walk', cta: jx || jy ? 'stick' : 'keys' }); }
        const sp = 1.6 * dt, fx = -Math.sin(yaw), fy = Math.cos(yaw), nx = px + (fx * fwd + fy * str) * sp, ny = py + (fy * fwd - fx * str) * sp;
        if (ok(nx, py)) px = nx; if (ok(px, ny)) py = ny; }
      if (glide) { const g = glide; g.t = Math.min(1, g.t + Math.min(0.25, rdt) / g.d); const k = ease(g.t);
        px = g.x0 + (g.x1 - g.x0) * k; py = g.y0 + (g.y1 - g.y0) * k; yaw = g.w0 + (g.w1 - g.w0) * k; pitch = g.p0 + (g.p1 - g.p0) * k; setFov(g.f0 + (g.f1 - g.f0) * k);
        if (g.t >= 1) { glide = null; if (g.i >= 0 && V[g.i].real) photoShow(g.i); } }
      if (wipeAnim) { wipeAnim.t = Math.min(1, wipeAnim.t + Math.min(0.25, rdt) / 1.6); setWipe(0.97 - 0.47 * ease(wipeAnim.t)); if (wipeAnim.t >= 1) wipeAnim = null; }
      camera.position.set(px, 1.5, -py); camera.rotation.set(pitch, yaw, 0);
      me.setAttribute('transform', `translate(${mx(px)} ${my(py)}) rotate(${(-yaw * 180 / Math.PI).toFixed(1)})`);
      renderer.render(scene, camera);
    }
    await Promise.all(pending);
    setFov(baseFov()); mark(0); $('load').remove(); renderer.setAnimationLoop(step);
    track('walk_open', { step: L.source, cta: claim && claim.claimed ? 'claimed' : 'unclaimed' });
    window.__sh = { go, state: () => ({ px, py, yaw, pitch, photoOn, views: V.length }) };
  } catch (err) { fail('Could not open the walkthrough: ' + ((err && err.message) || err)); console.error(err); }
}
