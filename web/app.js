//
// Copyright 2026 AUTOMATOUS.IO
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

// The website. Same decoder as the extension (vin.js and sticker.js are copied in
// beside this file at build time), with the popup's card laid out as a page.
// Lookups, caching and the recent list mirror background.js, on localStorage.

import { decodeVinsBatch, decodeVin, validateVin, extractVins, hasWindowSticker, windowStickerUrl, BATTERY_RPO, estimatedRange } from './vin.js';
import { readSticker } from './sticker.js';

const form = document.getElementById('finder');
const input = document.getElementById('vin');
const count = document.getElementById('count');
const slots = document.getElementById('slots');
const clearBtn = document.getElementById('clear');
const out = document.getElementById('out');
const recentEl = document.getElementById('recent');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const VIN_LENGTH = 17;
const MAX_MODULES = 20;
const BASE_TITLE = document.title;
// Decodes the way a real one does but belongs to no actual van, so GM has no sticker for it.
const EXAMPLE_VIN = '2G58J2TZXS9199001';
let seq = 0;

const VAN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3,7C1.89,7 1,7.89 1,9V17H3A3,3 0 0,0 6,20A3,3 0 0,0 9,17H15A3,3 0 0,0 18,20A3,3 0 0,0 21,17H23V13C23,11.89 22.11,11 21,11L18,7H3M15,8.5H17.5L19.46,11H15V8.5M6,15.5A1.5,1.5 0 0,1 7.5,17A1.5,1.5 0 0,1 6,18.5A1.5,1.5 0 0,1 4.5,17A1.5,1.5 0 0,1 6,15.5M18,15.5A1.5,1.5 0 0,1 19.5,17A1.5,1.5 0 0,1 18,18.5A1.5,1.5 0 0,1 16.5,17A1.5,1.5 0 0,1 18,15.5Z"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const CROSS = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>';
const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>';
const LINK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 6.8"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/></svg>';
const COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';

const gvwrClassShort = (s) => (s ? String(s).split(':')[0].trim() : null);

// ---------------------------------------------------------------------------
// Storage. Everything here is a convenience; the page works when it is unavailable.
// ---------------------------------------------------------------------------

const CACHE_KEY = 'bd.vinCache';
const STICKER_KEY = 'bd.stickerCache';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;   // vehicle build data never changes
const RECENT_KEY = 'bd.recent';
const RECENT_MAX = 20;

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window or full; nothing to do */ }
}
/** Add entries to a TTL store, dropping expired ones so it stays bounded. */
function cachePut(key, entries) {
  const store = read(key, {});
  const now = Date.now();
  for (const k of Object.keys(store)) if (now - (store[k]?.at ?? 0) >= CACHE_TTL_MS) delete store[k];
  for (const [vin, data] of entries) store[vin] = { at: now, data };
  write(key, store);
}
const cacheGet = (key, vin) => {
  const hit = read(key, {})[vin];
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.data : null;
};

/** Cached lookup. Decodes and confirmed non-BrightDrops are cached; transient failures retry later. */
async function lookup(vins) {
  const results = new Map();
  const misses = [];
  for (const vin of vins) {
    const hit = cacheGet(CACHE_KEY, vin);
    if (hit) results.set(vin, hit); else misses.push(vin);
  }
  if (misses.length) {
    const fresh = await decodeVinsBatch(misses);
    const keep = [];
    for (const [vin, data] of fresh) {
      results.set(vin, data);
      if (data.ok || data.skip) keep.push([vin, data]);
    }
    if (keep.length) cachePut(CACHE_KEY, keep);
  }
  return results;
}

/** Window sticker for one VIN, on explicit request only. Fetched from GM once, then served from the cache. */
async function sticker(vin) {
  const hit = cacheGet(STICKER_KEY, vin);
  if (hit) return hit;

  const year = decodeVin(vin).structural?.modelYear;
  if (!hasWindowSticker(year)) throw new Error(`GM has no window stickers for ${year} vans. They were sold by BrightDrop before it became a Chevrolet model.`);
  const res = await fetch(windowStickerUrl(vin), { credentials: 'omit' });
  if (!res.ok) throw new Error(`GM returned HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  // GM answers 200 with a small JSON body when it has no sticker.
  if (buf.byteLength < 4096) {
    const head = new TextDecoder().decode(buf.slice(0, 512)).trim();
    if (head.startsWith('{')) {
      let msg = 'GM has no window sticker for this VIN.';
      try { msg = JSON.parse(head).errorMessage || msg; } catch { /* keep default */ }
      throw new Error(msg);
    }
  }
  const data = await readSticker(buf);
  cachePut(STICKER_KEY, [[vin, data]]);
  return data;
}

/** Remember a VIN the user looked up, newest first, deduplicated. */
function rememberLookup(vin, data) {
  const recent = read(RECENT_KEY, []);
  const entry = {
    vin,
    at: Date.now(),
    pack: data.battery?.name ?? null,
    year: data.modelYear ?? null,
    series: data.name ?? data.series ?? null,
    drive: data.driveType ?? data.motor?.drivetrain ?? null,
  };
  write(RECENT_KEY, [entry, ...recent.filter((r) => r.vin !== vin)].slice(0, RECENT_MAX));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Decoder result -> the display values the layout needs. */
function present(r) {
  const b = r.battery;
  const m = r.motor;
  const isMax = b?.name === 'Max Range';
  const isExt = b?.name === 'Extended Range';
  // Max Range on this exact van, so the card can say what the alternative would do.
  const maxRange = estimatedRange('ETJ', r);

  let note = null;
  if (b && isMax) note = 'The biggest battery you can get.';
  else if (b && b.rangeMi && maxRange) note = `${isExt ? 'The middle battery' : 'The smallest battery'}. Max Range goes about ${maxRange - b.rangeMi} mi farther.`;

  return {
    vin: r.vin,
    title: r.name ?? r.series ?? 'BrightDrop',
    eyebrow: [r.modelYear, r.make ?? 'BrightDrop'].filter(Boolean).join(' · '),
    isMax,
    isExt,
    pillText: b ? (isMax ? 'Max Range' : isExt ? 'Extended' : 'Standard') : null,
    batteryName: b?.name ?? 'Battery not reported',
    batteryCode: r.batteryCode ?? null,
    kWh: BATTERY_RPO[r.batteryCode]?.kWh ?? null,
    rangeMi: b?.rangeMi ?? null,
    modules: r.modules ?? b?.modules ?? null,
    note,
    drive: r.driveType ?? m?.drivetrain ?? null,
    motors: m ? `${m.motors} motor${m.motors === 1 ? '' : 's'}` : null,
    hp: m?.hp ?? null,
    torque: m?.torqueLbFt ?? null,
    gvwr: r.local?.gvwr?.value ?? null,
    gvwrClass: gvwrClassShort(r.gvwrClass),
    modelYear: r.modelYear ?? null,
    sticker: r.stickerUrl ?? null,
  };
}

const stat = (label, value, sub) =>
  `<div class="stat"><div class="label">${esc(label)}</div><b>${value ? esc(value) : '—'}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>`;

const usd = (n) => (n == null ? null : `$${Math.round(n).toLocaleString('en-US')}`);

/** Sticker facts -> rows a shopper cares about. */
function stickerRowsHtml(st) {
  const row = (k, v, cls) => `<span class="k">${esc(k)}</span><span class="v${cls ? ` ${cls}` : ''}">${v}</span>`;
  const rows = [];
  for (const r of st.rows ?? []) rows.push(row(r.label, esc(r.value), r.absent ? 'off' : r.key === 'outlets' ? 'on' : ''));
  if (st.totalPrice) rows.push(row('Price', `<b>${esc(usd(st.totalPrice))}</b>${st.basePrice ? `<small> sticker · ${esc(usd(st.basePrice))} base</small>` : ''}`));
  if (st.exterior) rows.push(row('Color', esc(st.interior ? `${st.exterior} over ${st.interior}` : st.exterior)));
  if (st.dealer?.name) rows.push(row('Sold new', esc([st.dealer.name, [st.dealer.city, st.dealer.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '))));
  if (st.orderDate) rows.push(row('Ordered', esc(st.orderDate)));
  return `<div class="rows">${rows.join('')}</div>`;
}

/** The sticker panel before anything has been fetched. A cached sticker is shown straight away. */
function sheetHtml(p) {
  if (!p.sticker) {
    return `<div class="err">GM has no window stickers for ${esc(p.modelYear ?? 'these')} vans. They were sold by BrightDrop itself, before it became a Chevrolet.</div>`;
  }
  const cached = cacheGet(STICKER_KEY, p.vin);
  if (cached) return stickerRowsHtml(cached);
  return `<div class="ask">
      <p>The original sticker for this exact van: what it cost new, its color, charger, power outlets, spare tire and the dealer that first sold it.</p>
      <button type="button" class="btn" data-sticker="${esc(p.vin)}">Show the window sticker</button>
      <small>This asks GM for it, using the VIN.</small>
    </div>`;
}

function resultHtml(p) {
  const bar = p.modules
    ? `<div class="bar" role="img" aria-label="${p.modules} of ${MAX_MODULES} battery modules">${
        Array.from({ length: MAX_MODULES }, (_, i) => `<i class="${i < p.modules ? 'on' : ''}"></i>`).join('')
      }</div>
      <div class="meta"><span>${p.modules} of ${MAX_MODULES} modules${p.kWh ? ` · ${p.kWh} kWh` : ''}</span>${p.batteryCode ? `<span class="code">GM code <code>${esc(p.batteryCode)}</code></span>` : ''}</div>`
    : '';

  return `<article class="result">
    <section class="card">
      <div class="head">${VAN}
        <div>${p.eyebrow ? `<div class="eyebrow">${esc(p.eyebrow)}</div>` : ''}<div class="title">${esc(p.title)}</div></div>
        ${p.pillText ? `<span class="pill${p.isMax ? ' pill--max' : p.isExt ? ' pill--ext' : ''}">${esc(p.pillText)}</span>` : ''}
      </div>
      <div class="hero${p.isMax ? ' is-max' : p.isExt ? ' is-ext' : ''}">
        <div class="row">
          <div><div class="label">Battery</div><div class="name">${esc(p.batteryName)}</div></div>
          ${p.rangeMi ? `<div class="range"><b>~${p.rangeMi} mi</b><small>est. range</small></div>` : ''}
        </div>
        ${bar}
        ${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}
      </div>
      <div class="stats">
        ${stat('Drive', p.drive, p.motors)}
        ${stat('Power', p.hp ? `${p.hp} hp` : null, p.torque ? `${p.torque} lb-ft` : null)}
        ${stat('Max weight', p.gvwr ?? p.gvwrClass, p.gvwr ? 'fully loaded' : null)}
      </div>
      <div class="source">
        <button type="button" class="copy" data-copy="${esc(p.vin)}" aria-label="Copy VIN">${COPY}<code>${esc(p.vin)}</code></button>
        <button type="button" class="share" data-share="${esc(p.vin)}">${LINK}<span>Share this result</span></button>
      </div>
    </section>
    <section class="card" aria-label="Window sticker">
      <div class="sheet-head">
        <span class="label">Window sticker</span>
        ${p.sticker ? `<a class="pdf" href="${esc(p.sticker)}" target="_blank" rel="noopener noreferrer">Open the PDF ${ARROW}</a>` : ''}
      </div>
      <div class="sheet">${sheetHtml(p)}</div>
    </section>
  </article>`;
}

const skeletonHtml = () => `<article class="result skeleton" aria-busy="true" aria-label="Looking up the VIN">
    <section class="card">
      <div class="head"><div class="sk sk--icon"></div><div><div class="sk sk--eyebrow"></div><div class="sk sk--title"></div></div></div>
      <div class="hero sk"></div>
      <div class="stats"><div class="stat sk"></div><div class="stat sk"></div><div class="stat sk"></div></div>
    </section>
  </article>`;

const errorHtml = (title, body) => `<div class="error" role="alert"><b>${esc(title)}</b>${body ? esc(body) : ''}</div>`;

const BAD_VIN = "That doesn't look like a VIN";
/** The decoder's check-digit explanation is exact but technical; shoppers just need to know to re-check it. */
const plainVinError = (msg) => (/check digit/i.test(msg ?? '') ? 'One of the characters looks mistyped. Check it against the listing.' : msg);

/** Why a lookup produced no card, as a title and a sentence. */
function failure(r) {
  // The decoder's bare "Not a BrightDrop." would only repeat the title.
  if (r?.skip) return ['Not a BrightDrop', /NHTSA/.test(r.error ?? '') ? r.error.replace(/^Not a BrightDrop\.\s*/, '') : 'This only works for BrightDrop 400 and 600 vans, called the Zevo 400 and 600 before 2025.'];
  if (/no record|no row/i.test(r?.error ?? '')) return ['Nothing on this VIN yet', 'The government database has no record of it. A brand-new van can take a few weeks to show up.'];
  if (r?.errorText) return ['The database could not read this VIN', r.errorText];
  if (r?.error && !/fetch|load failed|network|HTTP/i.test(r.error)) return [BAD_VIN, plainVinError(r.error)];
  return ['Could not look that up', `${navigator.onLine === false ? 'You appear to be offline.' : 'The government VIN database did not answer.'} Try again in a minute.`];
}

/** One row of the recent list. */
function rowHtml(r, { pack, sub }) {
  const tone = pack === 'Max Range' ? 'max' : pack === 'Extended Range' ? 'ext' : null;
  const inner = `<span class="dot${tone ? ` dot--${tone}` : ''}"></span>
      <span><code>${esc(r.vin)}</code>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>
      <span class="pack${tone ? ` pack--${tone}` : ''}">${esc(pack ?? '—')}</span>`;
  return `<li><button type="button" class="row" data-vin="${esc(r.vin)}">${inner}</button></li>`;
}

function renderRecent() {
  const recent = read(RECENT_KEY, []);
  if (!recent.length) { recentEl.innerHTML = ''; return; }
  const rows = recent.map((r) => rowHtml(r, { pack: r.pack, sub: [r.year, r.series, r.drive].filter(Boolean).join(' · ') })).join('');
  recentEl.innerHTML = `<section class="list" aria-label="Recent lookups">
    <div class="rhead"><span class="label">Recent on this device</span><button type="button" class="link" id="clear-recent">Clear</button></div>
    <ul>${rows}</ul>
  </section>`;
}

// ---------------------------------------------------------------------------
// Input and routing. The decoded VIN lives in ?vin= so a result can be shared.
// ---------------------------------------------------------------------------

slots.innerHTML = Array.from({ length: VIN_LENGTH }, () => '<i></i>').join('');
const slotEls = [...slots.children];

function setState(state, n) {
  form.dataset.state = state;
  if (state === 'ok') count.innerHTML = CHECK;
  else if (state === 'bad') count.innerHTML = CROSS;
  else if (n > 0) count.textContent = `${n}/${VIN_LENGTH}`;
  else count.textContent = '';
  const filled = state === 'ok' || state === 'bad' ? VIN_LENGTH : (n ?? 0);
  slotEls.forEach((el, i) => el.classList.toggle('on', i < filled));
}

const shareUrl = (vin) => {
  const url = new URL(location.href);
  url.search = vin ? `?vin=${vin}` : '';
  url.hash = '';
  return url.href;
};

/** Reflect the current van in the address bar. A different van is a new history entry, so Back works. */
function setUrl(vin, { push = true } = {}) {
  const next = shareUrl(vin);
  if (next === location.href) return;
  try { history[push ? 'pushState' : 'replaceState'](null, '', next); } catch { /* file: or sandboxed; the page still works */ }
}

function showEmpty() {
  out.innerHTML = '';
  document.title = BASE_TITLE;
}

async function run({ push = true, strict = false } = {}) {
  // Separators are allowed in what gets pasted; only the 17 VIN characters are kept.
  const vin = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, VIN_LENGTH);
  if (input.value !== vin) input.value = vin;

  if (vin.length < VIN_LENGTH) {
    seq++;
    showEmpty();
    setUrl(null, { push: false });
    // Decode was pressed on a short VIN: say why nothing happened.
    if (strict && vin.length) {
      setState('bad');
      out.innerHTML = errorHtml(BAD_VIN, plainVinError(validateVin(vin).errors[0]));
    } else {
      setState(vin.length ? 'typing' : 'empty', vin.length);
    }
    return;
  }

  const mine = ++seq;
  const check = validateVin(vin);
  if (!check.ok) {
    setState('bad');
    document.title = BASE_TITLE;
    out.innerHTML = errorHtml(BAD_VIN, plainVinError(check.errors[0]));
    setUrl(null, { push: false });
    return;
  }

  setState('typing', VIN_LENGTH);
  setUrl(vin, { push });
  out.innerHTML = skeletonHtml();

  const r = (await lookup([vin])).get(vin) ?? null;
  if (mine !== seq) return;

  if (!r?.ok) {
    setState('bad');
    document.title = BASE_TITLE;
    out.innerHTML = errorHtml(...failure(r));
    return;
  }

  setState('ok');
  const p = present(r);
  out.innerHTML = resultHtml(p);
  document.title = `${[p.modelYear, p.title].filter(Boolean).join(' ')} · ${p.batteryName} · BrightDrop Spotter`;
  if (vin !== EXAMPLE_VIN) { rememberLookup(vin, r); renderRecent(); }
}

function open(vin, opts) {
  clearTimeout(run.t);
  input.value = vin;
  return run(opts);
}

function clearVin() {
  clearTimeout(run.t);
  input.value = '';
  run();
}

form.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(run.t); run({ strict: true }); });
input.addEventListener('input', () => { clearTimeout(run.t); run.t = setTimeout(run, 200); });
input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.preventDefault(); clearVin(); } });
clearBtn.addEventListener('click', () => { clearVin(); input.focus(); });
document.getElementById('example').addEventListener('click', () => open(EXAMPLE_VIN));

// A VIN pasted with text around it ("VIN: 2G5...") still lands in the field as just the VIN.
input.addEventListener('paste', (e) => {
  const [vin] = extractVins(e.clipboardData?.getData('text') ?? '', { brightDropOnly: false });
  if (!vin) return;   // not a clean VIN; let the field take it and strip separators
  e.preventDefault();
  open(vin);
});

function flash(btn, textEl, message) {
  const prior = textEl.textContent;
  btn.classList.add('done');
  textEl.textContent = message;
  setTimeout(() => { btn.classList.remove('done'); textEl.textContent = prior; }, 1400);
}

out.addEventListener('click', async (e) => {
  const sheetBtn = e.target.closest('[data-sticker]');
  if (sheetBtn) {
    const sheet = sheetBtn.closest('.sheet');
    sheetBtn.disabled = true;
    sheetBtn.textContent = 'Getting the sticker…';
    let html;
    try { html = stickerRowsHtml(await sticker(sheetBtn.dataset.sticker)); }
    catch (err) {
      const offline = err instanceof TypeError;   // fetch rejects with TypeError when the request never completes
      const why = offline ? 'Could not reach GM. Check your connection and try again.' : (err.message || 'Could not read the sticker.');
      html = `<div class="err">${esc(sheetBtn.dataset.sticker === EXAMPLE_VIN ? 'The example VIN belongs to no real van, so GM has no sticker for it. Try one from a listing.' : why)}</div>`;
    }
    if (sheet.isConnected) sheet.innerHTML = html;
    return;
  }

  const copy = e.target.closest('[data-copy]');
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); flash(copy, copy.querySelector('code'), 'Copied'); }
    catch { /* clipboard unavailable; nothing to do */ }
    return;
  }

  const share = e.target.closest('[data-share]');
  if (share) {
    const url = shareUrl(share.dataset.share);
    // Phones get the system share sheet; everything else copies the link.
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: document.title, url }); } catch { /* dismissed */ }
      return;
    }
    try { await navigator.clipboard.writeText(url); flash(share, share.querySelector('span'), 'Link copied'); }
    catch { /* clipboard unavailable; the address bar already holds the link */ }
  }
});

recentEl.addEventListener('click', async (e) => {
  const row = e.target.closest('[data-vin]');
  if (row) { await open(row.dataset.vin); form.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
  if (e.target.closest('#clear-recent')) { write(RECENT_KEY, []); renderRecent(); }
});

/** Show whatever the address bar says: a shared link, or Back and Forward. */
function route() {
  const vin = new URLSearchParams(location.search).get('vin') ?? '';
  if (vin) open(vin, { push: false });
  else { clearTimeout(run.t); seq++; input.value = ''; setState('empty'); showEmpty(); }
}
window.addEventListener('popstate', route);

renderRecent();
route();
// Put the cursor in the field on a computer. On a phone that would throw the keyboard up over the page.
if (!input.value && matchMedia('(pointer: fine)').matches) input.focus();
