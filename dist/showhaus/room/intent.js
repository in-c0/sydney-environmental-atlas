// SHOWHAUS Room: words → semantic ops. The renderer is fixed; what a sentence produces is only a list of ops
// (B2-R1 shape: the model side writes a mapping, never code). This is the rule-based reader (Korean + English);
// an open-weight model can replace parse() later as long as it returns the same op list.
// Pure module: no DOM, so node --test can load it.

export const WALL_COLOURS = {
  white: '#f1eee8', cream: '#efe4cc', beige: '#dccdb2', sage: '#a9b79b', green: '#6f8a62', navy: '#2e3c55',
  blue: '#7d9cc0', grey: '#9a9893', charcoal: '#45464a', terracotta: '#c0704f', pink: '#e2b9b0', yellow: '#e6cf86', black: '#26262a',
};
export const PATTERNS = ['plain', 'stripes', 'check', 'dots', 'panel'];
export const FLOORS = ['oak', 'tile', 'concrete', 'carpet'];

const WORDS = [ // [regex, kind, value]
  [/흰|하얀|화이트|white/i, 'colour', 'white'], [/크림|아이보리|cream|ivory/i, 'colour', 'cream'], [/베이지|beige/i, 'colour', 'beige'],
  [/세이지|sage|올리브/i, 'colour', 'sage'], [/초록|녹색|그린|green/i, 'colour', 'green'], [/네이비|남색|navy/i, 'colour', 'navy'],
  [/파랑|파란|하늘|블루|blue/i, 'colour', 'blue'], [/차콜|charcoal/i, 'colour', 'charcoal'], [/회색|그레이|grey|gray/i, 'colour', 'grey'],
  [/테라코타|주황|오렌지|terracotta|orange/i, 'colour', 'terracotta'], [/분홍|핑크|pink/i, 'colour', 'pink'], [/노랑|노란|옐로|yellow|mustard/i, 'colour', 'yellow'],
  [/검정|검은|블랙|black/i, 'colour', 'black'],
  [/줄무늬|스트라이프|stripe/i, 'pattern', 'stripes'], [/체크|격자|check|plaid/i, 'pattern', 'check'], [/도트|땡땡|물방울|꽃무늬|dots?|floral/i, 'pattern', 'dots'],
  [/패널|웨인스코팅|panel|wainscot/i, 'pattern', 'panel'], [/무지|민무늬|plain|solid/i, 'pattern', 'plain'],
  [/원목|마루|우드|oak|timber|wood/i, 'floor', 'oak'], [/타일|tile/i, 'floor', 'tile'], [/콘크리트|시멘트|concrete/i, 'floor', 'concrete'], [/카펫|carpet/i, 'floor', 'carpet'],
];
const ALIASES = { // what people call things → detector labels / words in names
  couch: /소파|쇼파|카우치|sofa|couch/i, chair: /의자|체어|chair|stool|스툴/i, bed: /침대|베드|bed\b/i, 'dining table': /식탁|테이블|탁자|table|desk|책상/i,
  tv: /티비|tv|텔레비전|모니터|monitor|screen/i, 'potted plant': /화분|식물|plant/i, light: /조명|램프|스탠드|전등|불|light|lamp/i,
  refrigerator: /냉장고|fridge|refrigerator/i, vase: /꽃병|화병|vase/i, bench: /벤치|bench/i,
};

const num = s => { const m = s.match(/(-?\d+(?:\.\d+)?)\s*(cm|센티|센치|mm|밀리|m\b|미터|도|°|deg|degrees?|%|퍼센트|배|x)?/i); if (!m) return null;
  const v = parseFloat(m[1]), u = (m[2] || '').toLowerCase();
  if (/cm|센/.test(u)) return { v: v / 100, u: 'm' }; if (/mm|밀/.test(u)) return { v: v / 1000, u: 'm' }; if (/^m$|미터/.test(u)) return { v, u: 'm' };
  if (/도|°|deg/.test(u)) return { v, u: 'deg' }; if (/%|퍼센트/.test(u)) return { v: v / 100, u: 'pct' }; if (/배|x/.test(u)) return { v, u: 'times' };
  return { v, u: '' }; };

// Which placed item a sentence is about: an alias or name match, else the selected one, else the last placed.
export function target(text, items, selected) {
  const t = text.toLowerCase();
  const byName = items.filter(i => i.name && t.includes(i.name.toLowerCase()));
  if (byName.length) return byName[byName.length - 1].uid;
  for (const [label, re] of Object.entries(ALIASES)) if (re.test(text)) {
    const hit = label === 'light' ? items.filter(i => i.light) : items.filter(i => i.label === label || re.test(i.name || ''));
    if (hit.length) return (hit.find(i => i.uid === selected) || hit[hit.length - 1]).uid;
  }
  return selected || (items.length ? items[items.length - 1].uid : null);
}

// parse(text, {items:[{uid,name,label,light}], selected}) → { ops }; ops are relative where they need the camera
// (nudge with dir) and the page turns them into absolute ops before they enter the timeline.
export function parse(text, ctx = {}) {
  const items = ctx.items || [], s = String(text || '').trim(), ops = [];
  if (!s) return { ops };
  const has = re => re.test(s), n = num(s), uid = () => target(s, items, ctx.selected);
  const allLights = has(/다|모든|전부|all|every/i) && has(ALIASES.light);
  const words = WORDS.filter(([re]) => re.test(s));
  const colour = words.find(w => w[1] === 'colour'), pattern = words.find(w => w[1] === 'pattern'), floor = words.find(w => w[1] === 'floor');

  if (has(/되돌려|취소|실행\s*취소|undo|go back|back a step/i)) return { ops: [{ op: 'undo' }] };

  if (has(/벽지|벽|wall/i) && (colour || pattern)) ops.push({ op: 'wall', ...(colour ? { colour: colour[2] } : {}), ...(pattern ? { pattern: pattern[2] } : {}) });
  else if (has(/바닥|floor/i) && floor) ops.push({ op: 'floor', floor: floor[2] });

  if (has(/밤|저녁|night|evening/i)) ops.push({ op: 'sun', on: false });
  else if (has(/낮|아침|해|햇빛|day|morning|sunlight/i) && !has(ALIASES.light)) ops.push({ op: 'sun', on: true });
  if (has(/따뜻|웜|warmer|warm/i)) ops.push({ op: 'warmth', by: 0.2 });
  if (has(/차갑|시원|쿨|cooler|cool/i)) ops.push({ op: 'warmth', by: -0.2 });
  if (has(/밝게|환하게|brighter/i)) ops.push({ op: 'exposure', by: 0.15 });
  if (has(/어둡게|dimmer|darker/i)) ops.push({ op: 'exposure', by: -0.15 });

  const off = has(/꺼|끄|끈|off|turn off|switch off/i), on = !off && has(/켜|켠|\bon\b|turn on|switch on/i);
  if ((off || on) && has(ALIASES.light)) {
    if (allLights) ops.push({ op: 'lights', on: !off });
    else { const named = items.filter(i => i.name && s.toLowerCase().includes(i.name.toLowerCase())), lights = items.filter(i => i.light);
      const it = named.find(i => i.light) || lights.find(i => i.uid === ctx.selected) || (named.length ? null : lights[lights.length - 1]);
      if (it) ops.push({ op: 'light', uid: it.uid, on: !off }); else if (!named.length) ops.push({ op: 'lights', on: !off }); }
  }

  if (has(/빼|치워|삭제|지워|없애|remove|delete|take out|get rid/i)) { const u = uid(); if (u) ops.push({ op: 'remove', uid: u }); return { ops }; }

  if (has(/돌려|회전|돌리|rotate|turn|spin/i) && !((on || off) && has(ALIASES.light))) {
    const u = uid(), deg = n && n.u !== 'm' ? n.v : 90, sign = has(/왼|반시계|counter|anti|left/i) ? 1 : -1;
    if (u) ops.push({ op: 'rotate', uid: u, by: sign * Math.abs(deg) });
  }
  const dims = [['w', /폭|가로|너비|width|wide/i], ['d', /깊이|depth|deep/i], ['h', /높이|키|height|tall|high/i]];
  const dim = dims.find(([, re]) => re.test(s));
  if (dim && n && n.u !== 'deg') { const u = uid(); if (u) ops.push({ op: 'size', uid: u, dim: dim[0], m: n.u === 'm' || n.u === '' ? (n.v > 10 ? n.v / 100 : n.v) : n.v }); }
  else if (has(/크게|키워|키우|bigger|larger|grow/i)) { const u = uid(); if (u) ops.push({ op: 'scale', uid: u, by: n && n.u === 'pct' ? 1 + n.v : n && n.u === 'times' ? n.v : 1.1 }); }
  else if (has(/작게|줄여|줄이|smaller|shrink/i)) { const u = uid(); if (u) ops.push({ op: 'scale', uid: u, by: n && n.u === 'pct' ? 1 - n.v : n && n.u === 'times' ? 1 / n.v : 1 / 1.1 }); }

  const dirs = [['left', /왼쪽|왼편|좌측|left/i], ['right', /오른쪽|오른편|우측|right/i], ['away', /뒤로|안쪽|멀리|back|further|away/i], ['near', /앞으로|가까이|forward|closer|toward me|nearer/i]];
  const dir = dirs.find(([, re]) => re.test(s));
  if (has(/벽에 붙|벽쪽|벽으로|against the wall|to the wall|on the wall side/i)) { const u = uid(); if (u) ops.push({ op: 'toWall', uid: u }); }
  else if (has(/가운데|중앙|center|centre|middle/i) && !has(/벽지/)) { const u = uid(); if (u) ops.push({ op: 'center', uid: u }); }
  else if (dir && !(has(ALIASES.light) && (on || off)) && !ops.some(o => o.op === 'rotate')) {
    const u = uid(); if (u) ops.push({ op: 'nudge', uid: u, dir: dir[0], m: n && n.u === 'm' ? n.v : n && n.u === '' && n.v ? (n.v > 5 ? n.v / 100 : n.v) : 0.3 });
  }
  return { ops };
}

// Words for one op, shown on its timeline step.
export function describe(op, nameOf = () => 'item') {
  switch (op.op) {
    case 'add': return `Placed ${op.name || 'item'}`;
    case 'move': return `Moved ${nameOf(op.uid)}`;
    case 'rotate': return `Turned ${nameOf(op.uid)} ${op.by > 0 ? '+' : ''}${Math.round(op.by)}°`;
    case 'setRot': return `Turned ${nameOf(op.uid)} to ${Math.round(op.r)}°`;
    case 'scale': return `${op.by >= 1 ? 'Bigger' : 'Smaller'} ${nameOf(op.uid)} ×${op.by.toFixed(2)}`;
    case 'size': return `${nameOf(op.uid)} ${({ w: 'width', d: 'depth', h: 'height' })[op.dim]} ${op.m.toFixed(2)} m`;
    case 'remove': return `Removed ${nameOf(op.uid)}`;
    case 'light': return `${nameOf(op.uid)} ${op.on ? 'on' : 'off'}`;
    case 'lights': return `All lights ${op.on ? 'on' : 'off'}`;
    case 'wall': return `Walls: ${[op.colour, op.pattern].filter(Boolean).join(' ')}`;
    case 'wallTint': return `Wall in photo: ${op.colour}`;
    case 'floor': return `Floor: ${op.floor}`;
    case 'sun': return op.on ? 'Daylight on' : 'Night';
    case 'warmth': return op.by > 0 ? 'Warmer light' : 'Cooler light';
    case 'exposure': return op.by > 0 ? 'Brighter' : 'Dimmer';
    case 'space': return `Space: ${op.space.title || op.space.kind}`;
    case 'horizon': return 'Matched the photo’s horizon';
    default: return op.op;
  }
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const emptyState = () => ({ space: null, items: [], wall: { colour: null, pattern: 'plain' }, floor: null, sun: true, warmth: 0, exposure: 1, horizon: 0.12, tints: [] });

// Absolute ops → next state. Pure; the timeline keeps every state so any step can be reopened.
export function apply(state, op) {
  const s = structuredClone(state), find = uid => s.items.find(i => i.uid === uid);
  switch (op.op) {
    case 'space': return { ...emptyState(), space: op.space, items: s.items.filter(() => op.keepItems), horizon: op.space.horizon ?? s.horizon };
    case 'add': s.items.push({ uid: op.uid, obj: op.obj, name: op.name, label: op.label, light: !!op.light, on: !!op.light, x: op.x, y: op.y, r: op.r || 0, k: 1, dims: { ...op.dims } }); break;
    case 'move': { const i = find(op.uid); if (i) { i.x = op.x; i.y = op.y; } break; }
    case 'rotate': { const i = find(op.uid); if (i) i.r = ((i.r + op.by) % 360 + 360) % 360; break; }
    case 'setRot': { const i = find(op.uid); if (i) i.r = ((op.r % 360) + 360) % 360; break; }
    case 'scale': { const i = find(op.uid); if (i) i.k = clamp(i.k * op.by, 0.2, 4); break; }
    case 'size': { const i = find(op.uid); if (i) { i.k = clamp(op.m / i.dims[op.dim], 0.2, 4); } break; }
    case 'remove': s.items = s.items.filter(i => i.uid !== op.uid); break;
    case 'light': { const i = find(op.uid); if (i && (i.light || op.make)) { i.light = true; i.on = op.on; } break; }
    case 'lights': s.items.forEach(i => { if (i.light) i.on = op.on; }); break;
    case 'wall': s.wall = { colour: op.colour ?? s.wall.colour, pattern: op.pattern ?? s.wall.pattern }; break;
    case 'wallTint': s.tints = [...s.tints.filter(t => Math.hypot(t.u - op.u, t.v - op.v) > 0.02), { u: op.u, v: op.v, colour: op.colour }]; break;
    case 'floor': s.floor = op.floor; break;
    case 'sun': s.sun = op.on; break;
    case 'warmth': s.warmth = clamp(s.warmth + op.by, -1, 1); break;
    case 'exposure': s.exposure = clamp(s.exposure + op.by, 0.4, 1.8); break;
    case 'horizon': s.horizon = op.v; break;
    default: return state;
  }
  return s;
}
