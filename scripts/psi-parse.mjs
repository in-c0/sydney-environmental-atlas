#!/usr/bin/env node
// NSW Valuer General Property Sales Information (PSI) parser — Node 22, no dependencies.
//
// Input : .DAT files, .zip files (weekly or yearly; nested zips are handled), or directories of them.
//         Files must be obtained by a person from the Valuation Portal
//         (https://valuation.property.nsw.gov.au/embed/propertySalesInformation); the portal sits behind a
//         Cloudflare browser challenge and is NOT fetched by this script.
// Format: "Current Property Sales Data File (Format 2001 - current)" fact sheet, Valuer General NSW, May 2020.
//         Semicolon-delimited records A (header), B (sale + address), C (legal description, may repeat),
//         D (purchaser/vendor flag, owner details suppressed), Z (trailer).
// Licence: PSI on the NSW site is CC BY-NC-ND 4.0 (non-commercial only). Commercial use, sharing for business
//         use or inclusion in products/services needs a separate PSI licence from Valuer General NSW.
//
// Truth rules (ENVIRONMENT_ATLAS_SPEC.md): a missing field stays null, never 0. Geometry comes only from the
// NSW Geocoded Addressing Theme AddressPoint; an address that does not match exactly stays ungeocoded.
//
// Usage:
//   node scripts/psi-parse.mjs <file|dir>... [--asof 2026-11-08] [--months 12] [--suburbs KENSINGTON,RANDWICK]
//                              [--geocode] [--cache geocode-cache.json] [--out sales.json] [--max-bytes 2000000]
//   node scripts/psi-parse.mjs --self-test

import { readFileSync, writeFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';

// Greater Sydney postcode ranges requested for SHOWHAUS.
export const SYDNEY_POSTCODE_RANGES = [[2000, 2234], [2555, 2574], [2745, 2770]];
export const inSydneyPostcode = (pc) => pc != null && SYDNEY_POSTCODE_RANGES.some(([a, b]) => pc >= a && pc <= b);

export const GAT_ADDRESS_POINT =
  'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Geocoded_Addressing_Theme/FeatureServer/1/query';

// ---------- minimal ZIP reader (stored + deflate, nested zips) ----------
export function* zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commLen;
    if (name.endsWith('/')) continue;
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    if (method === 0) yield [name, raw];
    else if (method === 8) yield [name, inflateRawSync(raw)];
    else throw new Error(`unsupported zip method ${method} for ${name}`);
  }
}

function* datTexts(path) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const f of readdirSync(path).sort()) yield* datTexts(join(path, f));
    return;
  }
  const ext = extname(path).toLowerCase();
  if (ext === '.dat') yield [path, readFileSync(path, 'latin1')];
  else if (ext === '.zip') yield* datTextsFromZip(path, readFileSync(path));
}
function* datTextsFromZip(label, buf) {
  for (const [name, data] of zipEntries(buf)) {
    const ext = extname(name).toLowerCase();
    if (ext === '.dat') yield [`${label}!${name}`, data.toString('latin1')];
    else if (ext === '.zip') yield* datTextsFromZip(`${label}!${name}`, data);
  }
}

// ---------- record parsing ----------
const str = (s) => { const t = (s ?? '').trim().replace(/\s+/g, ' '); return t === '' ? null : t; };
const num = (s) => { const t = str(s); if (t == null) return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
const ymd = (s) => { const t = str(s); return t && /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : null; };

/** Parse one DAT text into sale objects (B record + joined C legal descriptions). */
export function parseDat(text) {
  const sales = new Map();
  let header = null, trailer = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const f = line.split(';');
    const type = f[0];
    if (type === 'A') header = { fileType: str(f[1]), district: str(f[2]), created: str(f[3]) };
    else if (type === 'Z') trailer = { total: num(f[1]), b: num(f[2]), c: num(f[3]), d: num(f[4]) };
    else if (type === 'B') {
      const key = `${f[1]}|${f[2]}|${f[3]}`;
      const area = num(f[11]), areaType = str(f[12]);
      sales.set(key, {
        district: str(f[1]),
        propertyId: str(f[2]),
        saleCounter: str(f[3]),
        fileCreated: str(f[4]),
        propertyName: str(f[5]),
        unit: str(f[6]),
        houseNumber: str(f[7]),
        street: str(f[8]),
        locality: str(f[9]),
        postcode: num(f[10]),
        area,
        areaType,                                  // M = m², H = hectares, null = not supplied
        areaM2: area == null ? null : areaType === 'H' ? Math.round(area * 10000) : areaType === 'M' ? area : null,
        contractDate: ymd(f[13]),
        settlementDate: ymd(f[14]),
        price: num(f[15]),                         // null if absent — never coerced to 0
        zoning: str(f[16]),
        nature: str(f[17]),                        // V vacant, R residence, 3 other
        primaryPurpose: str(f[18]),
        strataLot: str(f[19]),
        componentCode: str(f[20]),
        saleCode: str(f[21]),
        interestPct: num(f[22]),                   // null means 100% per spec
        dealingNumber: str(f[23]),
        legal: null,
      });
    } else if (type === 'C') {
      const s = sales.get(`${f[1]}|${f[2]}|${f[3]}`);
      const part = f[5] ?? '';
      if (s) s.legal = (s.legal ?? '') + part;   // spec: multiple C records join without a space
    }
  }
  for (const s of sales.values()) s.legal = str(s.legal);
  return { header, trailer, sales: [...sales.values()] };
}

// ---------- address normalisation for GAT ----------
// PSI street names may carry abbreviated street types; GAT AddressPoint.address uses full words, upper case,
// e.g. "1/212 ANZAC PARADE KENSINGTON". Only common, unambiguous types are expanded.
const STREET_TYPES = {
  RD: 'ROAD', ST: 'STREET', AVE: 'AVENUE', AV: 'AVENUE', PDE: 'PARADE', HWY: 'HIGHWAY', DR: 'DRIVE', CRES: 'CRESCENT',
  CR: 'CRESCENT', PL: 'PLACE', LANE: 'LANE', LN: 'LANE', CCT: 'CIRCUIT', CL: 'CLOSE', CT: 'COURT', TCE: 'TERRACE',
  BVD: 'BOULEVARD', BLVD: 'BOULEVARD', GR: 'GROVE', GRV: 'GROVE', SQ: 'SQUARE', WAY: 'WAY', ESP: 'ESPLANADE',
  CNR: 'CORNER', PKWY: 'PARKWAY', WYND: 'WYND', ROW: 'ROW', RDGE: 'RIDGE', CIR: 'CIRCLE', PROM: 'PROMENADE',
};
export function normaliseStreet(street) {
  if (!street) return null;
  // GAT drops apostrophes (verified: "91 CANARYS ROAD ROSELANDS").
  const words = street.toUpperCase().replace(/['’]/g, '').replace(/\s+/g, ' ').trim().split(' ');
  // expand the last street-type token (may be followed by a suffix like N/S/E/W or EXTENSION)
  for (let i = words.length - 1; i >= Math.max(1, words.length - 2); i--) {
    if (STREET_TYPES[words[i]]) { words[i] = STREET_TYPES[words[i]]; break; }
  }
  return words.join(' ');
}
export function gatAddressCandidates({ unit, houseNumber, street, locality }) {
  const st = normaliseStreet(street), loc = str(locality)?.toUpperCase();
  const hn = str(houseNumber)?.toUpperCase();
  if (!st || !loc || !hn) return [];
  const base = `${hn} ${st} ${loc}`;
  const u = str(unit)?.toUpperCase().replace(/\s+/g, '');
  return u ? [`${u}/${base}`, base] : [base];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Exact-match lookup in NSW GAT AddressPoint. Returns {lon, lat, matched, pointType, siteOid} or null. */
export async function geocodeGat(candidates, { retries = 2 } = {}) {
  for (const addr of candidates) {
    const where = `address='${addr.replace(/'/g, "''")}'`;
    const url = `${GAT_ADDRESS_POINT}?where=${encodeURIComponent(where)}` +
      '&outFields=address,addresspointtype,principaladdresssiteoid&returnGeometry=true&outSR=4326&resultRecordCount=5&f=json';
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (j.error) throw new Error(j.error.message);
        const f = j.features?.[0];
        if (f) return {
          lon: +f.geometry.x.toFixed(6), lat: +f.geometry.y.toFixed(6), matched: f.attributes.address,
          pointType: f.attributes.addresspointtype, siteOid: f.attributes.principaladdresssiteoid,
          candidates: j.features.length, matchType: 'exact',
        };
        // Fallback: a single house number that is the start of a GAT range ("334" -> "334-340 ...").
        // Labelled matchType 'range-start' so the UI can disclose it; suburb is never changed.
        const m = addr.match(/^((?:[0-9A-Z]+\/)?)(\d+[A-Z]?) (.*)$/);
        if (m) {
          const like = `address LIKE '${m[1]}${m[2]}-% ${m[3].replace(/'/g, "''")}'`;
          const r2 = await fetch(`${GAT_ADDRESS_POINT}?where=${encodeURIComponent(like)}` +
            '&outFields=address,addresspointtype,principaladdresssiteoid&returnGeometry=true&outSR=4326&resultRecordCount=5&f=json');
          const j2 = r2.ok ? await r2.json() : null;
          const f2 = j2?.features?.[0];
          if (f2 && j2.features.length === 1) return {
            lon: +f2.geometry.x.toFixed(6), lat: +f2.geometry.y.toFixed(6), matched: f2.attributes.address,
            pointType: f2.attributes.addresspointtype, siteOid: f2.attributes.principaladdresssiteoid,
            candidates: 1, matchType: 'range-start',
          };
        }
        break; // no match for this candidate; try next
      } catch (e) {
        if (attempt >= retries) throw e;
        await sleep(500 * (attempt + 1));
      }
    }
  }
  return null;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---------- compact output ----------
export const COMPACT_FIELDS = ['contractDate', 'settlementDate', 'price', 'unit', 'houseNumber', 'street', 'locality',
  'postcode', 'areaM2', 'zoning', 'nature', 'strataLot', 'propertyId', 'dealingNumber', 'lon', 'lat', 'geoMatch'];

function parseArgs(argv) {
  const a = { inputs: [], months: 12, asof: new Date().toISOString().slice(0, 10), suburbs: null, geocode: false,
    cache: null, out: null, maxBytes: 2_000_000, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--asof') a.asof = argv[++i];
    else if (k === '--months') a.months = Number(argv[++i]);
    else if (k === '--suburbs') a.suburbs = new Set(argv[++i].split(',').map((s) => s.trim().toUpperCase()));
    else if (k === '--geocode') a.geocode = true;
    else if (k === '--cache') a.cache = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--max-bytes') a.maxBytes = Number(argv[++i]);
    else if (k === '--self-test') a.selfTest = true;
    else a.inputs.push(k);
  }
  return a;
}

export async function run(opts) {
  const asof = new Date(`${opts.asof}T00:00:00Z`);
  const from = new Date(asof); from.setUTCMonth(from.getUTCMonth() - opts.months);
  const fromStr = from.toISOString().slice(0, 10), asofStr = asof.toISOString().slice(0, 10);

  const byDealing = new Map();
  const counts = { files: 0, bRecords: 0, trailerMismatch: 0, duplicates: 0, sydneyLast12m: 0, nullPrice: 0,
    selected: 0, geocoded: 0, geocodeMiss: 0, geocodeError: 0 };
  const sourceFiles = [];
  for (const input of opts.inputs) {
    for (const [label, text] of datTexts(input)) {
      const { header, trailer, sales } = parseDat(text);
      counts.files++; counts.bRecords += sales.length;
      if (trailer?.b != null && trailer.b !== sales.length) counts.trailerMismatch++;
      sourceFiles.push({ file: label, district: header?.district ?? null, created: header?.created ?? null });
      for (const s of sales) {
        // The same dealing can reappear in later weekly files (amendments); keep the latest file's version.
        const key = `${s.propertyId}|${s.dealingNumber}`;
        const prev = byDealing.get(key);
        if (prev) counts.duplicates++;
        if (!prev || (s.fileCreated ?? '') >= (prev.fileCreated ?? '')) byDealing.set(key, s);
      }
    }
  }
  const sydney = [...byDealing.values()].filter((s) =>
    inSydneyPostcode(s.postcode) && s.contractDate && s.contractDate >= fromStr && s.contractDate <= asofStr);
  counts.sydneyLast12m = sydney.length;
  counts.nullPrice = sydney.filter((s) => s.price == null).length;
  const perPostcode = {};
  for (const s of sydney) perPostcode[s.postcode] = (perPostcode[s.postcode] ?? 0) + 1;

  let selected = opts.suburbs ? sydney.filter((s) => opts.suburbs.has((s.locality ?? '').toUpperCase())) : sydney;
  selected.sort((x, y) => (y.contractDate ?? '').localeCompare(x.contractDate ?? ''));
  counts.selected = selected.length;

  if (opts.geocode) {
    const cache = opts.cache && existsSync(opts.cache) ? JSON.parse(readFileSync(opts.cache, 'utf8')) : {};
    await mapLimit(selected, 4, async (s) => {
      const cands = gatAddressCandidates(s);
      const key = cands.join('|');
      if (!key) { counts.geocodeMiss++; return; }
      let g = cache[key];
      if (g === undefined) {
        try { g = await geocodeGat(cands); cache[key] = g; } catch { counts.geocodeError++; return; }
      }
      if (g) { s.lon = g.lon; s.lat = g.lat; s.geoMatch = g.matchType; counts.geocoded++; if (g.matchType !== 'exact') counts.geocodedRangeStart = (counts.geocodedRangeStart ?? 0) + 1; }
      else counts.geocodeMiss++;
    });
    if (opts.cache) writeFileSync(opts.cache, JSON.stringify(cache));
  }

  const rows = selected.map((s) => COMPACT_FIELDS.map((k) => s[k] ?? null));
  const doc = {
    generatedAt: new Date().toISOString(),
    window: { from: fromStr, to: asofStr, by: 'contractDate' },
    sources: [
      { name: 'NSW Valuer General Property Sales Information (bulk)', licence: 'CC BY-NC-ND 4.0 (non-commercial); commercial use requires a PSI licence', files: sourceFiles },
      ...(opts.geocode ? [{ name: 'NSW Spatial Services Geocoded Addressing Theme — AddressPoint (exact string match)', url: GAT_ADDRESS_POINT }] : []),
    ],
    notes: [
      'price null = not supplied; never treated as 0.',
      'lon/lat null = no GAT AddressPoint match; the sale is not placed on the map.',
      'geoMatch: exact = full address string match; range-start = unique GAT range beginning with the PSI house number.',
      'nature: V vacant, R residence, 3 other. areaM2 converted from hectares where areaType = H.',
    ],
    counts: { ...counts, perPostcode },
    fields: COMPACT_FIELDS,
    rows,
  };
  let json = JSON.stringify(doc);
  while (json.length > opts.maxBytes && doc.rows.length > 0) {
    doc.rows = doc.rows.slice(0, Math.floor(doc.rows.length * 0.9));
    doc.counts.truncatedTo = doc.rows.length;
    json = JSON.stringify(doc);
  }
  if (opts.out) writeFileSync(opts.out, json);
  return doc;
}

// ---------- self test (synthetic fixture shaped per the published spec; not real sales) ----------
function selfTest() {
  const fx = [
    'A;RTSALEDATA;220;20261103 01:02;VG;',
    'B;220;1234567;1;20261103 01:02;;;212;ANZAC PDE;KENSINGTON;2033;;;20261020;20261101;1500000;R3;R;;;;;;AB123456;',
    'C;220;1234567;1;20261103 01:02;1/SP12345;',
    'C;220;1234567;1;20261103 01:02;6;',
    'B;220;7654321;2;20261103 01:02;;5 A;1;ADDISON ST;KENSINGTON;2033;0.5;H;20251001;20251101;;;3;SHOP;5;;;50;AB999;',
    'D;220;7654321;2;20261103 01:02;P;',
    'Z;7;2;2;1;',
  ].join('\n');
  const { header, trailer, sales } = parseDat(fx);
  const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  assert(header.district === '220' && trailer.b === 2 && sales.length === 2, 'records');
  assert(sales[0].price === 1500000 && sales[0].contractDate === '2026-10-20' && sales[0].legal === '1/SP123456', 'B/C');
  assert(sales[1].price === null && sales[1].areaM2 === 5000 && sales[1].interestPct === 50 && sales[1].unit === '5 A', 'nulls');
  assert(JSON.stringify(gatAddressCandidates(sales[1])) === JSON.stringify(['5A/1 ADDISON STREET KENSINGTON', '1 ADDISON STREET KENSINGTON']), 'candidates');
  assert(normaliseStreet('ANZAC PDE') === 'ANZAC PARADE' && normaliseStreet('PACIFIC HWY N') === 'PACIFIC HIGHWAY N', 'street');
  assert(inSydneyPostcode(2033) && inSydneyPostcode(2560) && !inSydneyPostcode(2300) && !inSydneyPostcode(null), 'postcode');
  console.log('psi-parse self-test OK');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) selfTest();
  else if (!opts.inputs.length) { console.error('usage: psi-parse.mjs <file|dir>... [--geocode] [--out f.json]'); process.exit(2); }
  else {
    const doc = await run(opts);
    console.log(JSON.stringify({ ...doc.counts, perPostcode: Object.keys(doc.counts.perPostcode).length + ' postcodes', bytes: JSON.stringify(doc).length }));
  }
}
