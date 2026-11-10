/* SHOWHAUS /agent and /agency: read-only views over the one shared listing model (../data/listings.json).
   Same rows for both roles today; the role only changes the wording. No new accounts: claims use the existing flow. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const role = /\/agency\/?$/.test(location.pathname) ? 'agency' : 'agent';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const root = new URL('../', document.baseURI);
  const at = p => new URL(p.replace(/^\//, ''), root).href;
  $('asAgent').href = at('agent'); $('asAgency').href = at('agency');
  $(role === 'agency' ? 'asAgency' : 'asAgent').setAttribute('aria-current', 'page');
  $('title').textContent = role === 'agency' ? "Your agency's listings" : 'Your listings';
  $('lead').textContent = role === 'agency'
    ? 'Read only for now. Every property your agents claim shows up here with its share link.'
    : 'Read only for now. Claim a property to add your name to its share link.';
  const RENDER = { rendered: ['ok', 'Rendered'], placeholder: ['wait', 'Placeholder (generated)'], none: ['', 'Not rendered'] };
  const WALK = { baked: ['wait', 'Built, not published'], published: ['ok', 'Live'], none: ['', 'None'] };
  fetch(at('data/listings.json')).then(r => r.json()).then(d => {
    const rows = d.listings.map(L => {
      const [rc, rt] = RENDER[L.hero] || RENDER.none, [wc, wt] = WALK[L.world] || WALK.none;
      return `<tr data-slug="${esc(L.slug)}">
        <td><a class="name" href="${esc(at('l/' + L.slug))}">${esc(L.name)}</a><span class="sub">${esc(L.address)}</span></td>
        <td><span class="st ${rc}">${rt}</span></td>
        <td><span class="st ${wc}">${wt}</span></td>
        <td>Noise, aerial, planning</td>
        <td><a href="${esc(at('l/' + L.slug + '/claim'))}">Claim</a></td>
        <td><code>${esc(location.origin + '/s/' + L.slug)}</code></td></tr>`;
    });
    document.querySelector('#tbl tbody').innerHTML = rows.join('');
    $('fine').textContent = `${d.listings.length} properties. Every render here is generated from public records and approved plans; none of it is a photo.`;
  }).catch(e => { $('fine').textContent = 'The list could not load: ' + e.message; });
})();
