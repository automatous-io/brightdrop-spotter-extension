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

const input = document.getElementById('vin');
const field = document.getElementById('field');
const count = document.getElementById('count');
const slots = document.getElementById('slots');
const clearBtn = document.getElementById('clear');
const out = document.getElementById('out');
const about = document.getElementById('about');
const infoBtn = document.getElementById('info');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const VIN_LENGTH = 17;
const MAX_MODULES = 20;
let seq = 0;

const VAN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3,7C1.89,7 1,7.89 1,9V17H3A3,3 0 0,0 6,20A3,3 0 0,0 9,17H15A3,3 0 0,0 18,20A3,3 0 0,0 21,17H23V13C23,11.89 22.11,11 21,11L18,7H3M15,8.5H17.5L19.46,11H15V8.5M6,15.5A1.5,1.5 0 0,1 7.5,17A1.5,1.5 0 0,1 6,18.5A1.5,1.5 0 0,1 4.5,17A1.5,1.5 0 0,1 6,15.5M18,15.5A1.5,1.5 0 0,1 19.5,17A1.5,1.5 0 0,1 18,18.5A1.5,1.5 0 0,1 16.5,17A1.5,1.5 0 0,1 18,15.5Z"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const CROSS = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>';
const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>';
const DOC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6M10 17h6"/></svg>';
const LINK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 6.8"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/></svg>';
const COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';

const gvwrClassShort = (s) => (s ? String(s).split(':')[0].trim() : null);
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

// Footer version comes from the manifest.
const versionEl = document.getElementById('version');
const version = chrome.runtime.getManifest?.().version;
if (versionEl && version) {
  versionEl.textContent = `v${version}`;
  versionEl.href = `https://github.com/automatous-io/brightdrop-spotter-extension/releases/tag/v${version}`;
  versionEl.setAttribute('aria-label', `Version ${version}. Open release notes.`);
}

// Progress segments under the input.
slots.innerHTML = Array.from({ length: VIN_LENGTH }, () => '<i></i>').join('');
const slotEls = [...slots.children];

/** Decoder result -> the display values the layout needs. */
function present(r, stickerUrl, ranges) {
  const b = r.battery;
  const m = r.motor;
  const isMax = b?.name === 'Max Range';
  const isExt = b?.name === 'Extended Range';
  const maxRange = ranges?.ETJ ?? null;

  let note = null;
  if (b && isMax) note = 'The largest pack BrightDrop offers.';
  else if (b && b.rangeMi && maxRange) note = `${isExt ? 'Middle pack' : 'Smaller pack'}. Max Range adds about ${maxRange - b.rangeMi} mi.`;

  return {
    vin: r.vin,
    title: r.name ?? r.series ?? 'BrightDrop',
    eyebrow: [r.modelYear, r.make ?? 'BrightDrop'].filter(Boolean).join(' · '),
    isMax,
    isExt,
    hasPack: Boolean(b),
    pillText: b ? (isMax ? 'Max Range' : isExt ? 'Extended' : 'Standard') : null,
    batteryName: b?.name ?? 'Battery not reported',
    batteryCode: r.batteryCode ?? null,
    rangeMi: b?.rangeMi ?? null,
    modules: r.modules ?? b?.modules ?? null,
    note,
    drive: r.driveType ?? m?.drivetrain ?? null,
    motors: m ? `${m.motors} motor${m.motors === 1 ? '' : 's'}` : null,
    hp: m?.hp ?? null,
    torque: m?.torqueLbFt ?? null,
    gvwr: r.local?.gvwr?.value ?? null,
    gvwrClass: gvwrClassShort(r.gvwrClass),
    sticker: stickerUrl,
  };
}

const stat = (label, value, sub) =>
  `<div class="stat"><div class="label">${esc(label)}</div><b>${value ? esc(value) : '—'}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>`;

function resultHtml(p) {
  const bar = p.modules
    ? `<div class="bar" role="img" aria-label="${p.modules} of ${MAX_MODULES} battery modules">${
        Array.from({ length: MAX_MODULES }, (_, i) => `<i class="${i < p.modules ? 'on' : ''}"></i>`).join('')
      }</div>
      <div class="meta"><span>${p.modules} of ${MAX_MODULES} modules</span>${p.batteryCode ? `<code>RPO ${esc(p.batteryCode)}</code>` : ''}</div>`
    : '';

  return `<section class="card" aria-live="polite">
    <div class="head">${VAN}
      <div>${p.eyebrow ? `<div class="eyebrow">${esc(p.eyebrow)}</div>` : ''}<div class="title">${esc(p.title)}</div></div>
      ${p.pillText ? `<span class="pill${p.isMax ? ' pill--max' : p.isExt ? ' pill--ext' : ''}">${esc(p.pillText)}</span>` : ''}
      ${p.sticker ? `<button type="button" class="ib" data-sticker="${esc(p.vin)}" title="Window sticker details" aria-label="Show window sticker details: options, price, color and first dealer" aria-expanded="false">${DOC}</button>` : ''}
      <a class="ib page-link" hidden target="_blank" rel="noopener noreferrer">${LINK}</a>
    </div>
    <div class="hero${p.isMax ? ' is-max' : p.isExt ? ' is-ext' : ''}">
      <div class="row">
        <div><div class="label">Battery pack</div><div class="name">${esc(p.batteryName)}</div></div>
        ${p.rangeMi ? `<div class="range"><b>~${p.rangeMi} mi</b><small>est. range</small></div>` : ''}
      </div>
      ${bar}
      ${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}
    </div>
    <div class="stats">
      ${stat('Drive Type', p.drive, p.motors)}
      ${stat('Power', p.hp ? `${p.hp} hp` : null, p.torque ? `${p.torque} lb-ft` : null)}
      ${stat('GVWR', p.gvwr ?? p.gvwrClass, p.gvwr ? p.gvwrClass : null)}
    </div>
    <div class="sheet" hidden></div>
    <div class="source">
      <button type="button" class="copy" data-copy="${esc(p.vin)}" aria-label="Copy VIN">${COPY}<code>${esc(p.vin)}</code></button>
      ${p.sticker ? `<a class="sticker" href="${esc(p.sticker)}" target="_blank" rel="noopener noreferrer">window sticker ${ARROW}</a>` : ''}
    </div>
  </section>`;
}

const usd = (n) => (n == null ? null : `$${Math.round(n).toLocaleString('en-US')}`);

/** Sticker facts -> rows a shopper cares about. */
function stickerRowsHtml(st) {
  const row = (k, v, cls) => `<span class="k">${esc(k)}</span><span class="v${cls ? ` ${cls}` : ''}">${v}</span>`;
  const out = [];
  for (const r of st.rows ?? []) out.push(row(r.label, esc(r.value), r.absent ? 'off' : r.key === 'outlets' ? 'on' : ''));
  if (st.totalPrice) out.push(row('Price', `<b>${esc(usd(st.totalPrice))}</b>${st.basePrice ? `<small> sticker · ${esc(usd(st.basePrice))} base</small>` : ''}`));
  if (st.exterior) out.push(row('Color', esc(st.interior ? `${st.exterior} over ${st.interior}` : st.exterior)));
  if (st.dealer?.name) out.push(row('Sold new', esc([st.dealer.name, [st.dealer.city, st.dealer.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '))));
  if (st.orderDate) out.push(row('Ordered', esc(st.orderDate)));
  return `<div class="rows">${out.join('')}</div>`;
}

const skeletonHtml = () => `<section class="card skeleton" aria-busy="true" aria-label="Looking up VIN">
    <div class="head"><div class="sk" style="width:22px;height:22px;border-radius:6px"></div><div style="flex:1"><div class="sk" style="width:40%;height:10px;margin-bottom:6px"></div><div class="sk" style="width:60%"></div></div></div>
    <div class="hero sk"></div>
    <div class="stats"><div class="stat sk"></div><div class="stat sk"></div><div class="stat sk"></div></div>
  </section>`;

const errorHtml = (title, body) => `<div class="error" role="alert"><b>${esc(title)}</b>${body ? esc(body) : ''}</div>`;

const sampleBadge = (text, max) =>
  `<span class="badge${max ? ' badge--max' : ''}" aria-hidden="true">${VAN}${esc(text)}</span>`;

const introHtml = () => `<div class="intro">
    <span class="label">Green means Max Range</span>
    <div class="samples">${sampleBadge('Max Range · AWD · Zevo 600', true)}${sampleBadge('Standard Range · FWD · Zevo 400', false)}</div>
    <p>Badges appear beside every BrightDrop VIN as you browse. Hover one for the full spec sheet.</p>
  </div>`;

function recentHtml(recent) {
  if (!recent?.length) return '';
  const rows = recent.map((r) => {
    const tone = r.pack === 'Max Range' ? 'max' : r.pack === 'Extended Range' ? 'ext' : null;
    const sub = [r.year, r.series, r.drive].filter(Boolean).join(' · ');
    let host = '';
    try { if (r.url) host = new URL(r.url).hostname.replace(/^www\./, ''); } catch { /* no link */ }
    const open = r.url
      ? `<a class="open" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" title="Open saved listing on ${esc(host)}" aria-label="Open saved listing on ${esc(host)}">${LINK}</a>`
      : '';
    return `<li><button type="button" class="row" data-vin="${esc(r.vin)}">
      <span class="dot${tone ? ` dot--${tone}` : ''}"></span>
      <span><code>${esc(r.vin)}</code>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>
      <span class="pack${tone ? ` pack--${tone}` : ''}">${esc(r.pack ?? '—')}</span>
    </button>${open}</li>`;
  }).join('');
  return `<section class="recent">
    <div class="rhead"><span class="label">Recent</span><button type="button" class="link" id="clear-recent">Clear</button></div>
    <ul>${rows}</ul>
  </section>`;
}

async function showEmpty() {
  const mine = seq;
  const res = await send({ type: 'recent' });
  if (mine !== seq) return;
  const recent = res?.ok ? res.recent : [];
  out.innerHTML = recent.length ? recentHtml(recent) : introHtml();
}

function setState(state, n) {
  field.dataset.state = state;
  if (state === 'ok') count.innerHTML = CHECK;
  else if (state === 'bad') count.innerHTML = CROSS;
  else if (n > 0) count.textContent = `${n}/${VIN_LENGTH}`;
  else count.textContent = '';
  const filled = state === 'ok' || state === 'bad' ? VIN_LENGTH : (n ?? 0);
  slotEls.forEach((el, i) => el.classList.toggle('on', i < filled));
}

async function run() {
  // Separators are allowed in what gets pasted; only the 17 VIN characters are kept.
  const vin = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, VIN_LENGTH);
  if (input.value !== vin) input.value = vin;

  if (vin.length < VIN_LENGTH) {
    seq++;
    setState(vin.length ? 'typing' : 'empty', vin.length);
    await showEmpty();
    return;
  }

  const mine = ++seq;
  setState('typing', VIN_LENGTH);
  out.innerHTML = skeletonHtml();

  const res = await send({ type: 'decodeOne', vin });
  if (mine !== seq) return;

  if (!res?.ok) {
    setState('bad');
    out.innerHTML = errorHtml('That is not a valid VIN', res?.error ?? 'Lookup failed.');
    return;
  }
  const r = res.result;
  if (!r || !r.ok) {
    setState('bad');
    out.innerHTML = errorHtml('No record for this VIN', r?.error ?? 'NHTSA had no record for this VIN. It may be too new, or not a BrightDrop.');
    return;
  }

  setState('ok');
  out.innerHTML = resultHtml(present(r, res.stickerUrl, res.ranges));

  // If this van was bookmarked from a listing, offer that page.
  send({ type: 'isRecent', vin }).then((rec) => {
    if (mine !== seq || !rec?.ok || !rec.url) return;
    const a = out.querySelector('.page-link');
    if (!a) return;
    let host = '';
    try { host = new URL(rec.url).hostname.replace(/^www\./, ''); } catch { /* leave blank */ }
    a.href = rec.url;
    a.title = rec.title ? `Open saved listing: ${rec.title}` : `Open saved listing on ${host}`;
    a.setAttribute('aria-label', a.title);
    a.hidden = false;
  });
}

out.addEventListener('click', async (e) => {
  const recentRow = e.target.closest('[data-vin]');
  if (recentRow) { input.value = recentRow.dataset.vin; run(); return; }

  if (e.target.closest('#clear-recent')) { await send({ type: 'clearRecent' }); showEmpty(); return; }

  const sheetBtn = e.target.closest('[data-sticker]');
  if (sheetBtn) {
    const sheet = sheetBtn.closest('.card').querySelector('.sheet');
    if (sheet.dataset.loaded) {
      sheet.hidden = !sheet.hidden;
      sheetBtn.classList.toggle('on', !sheet.hidden);
      sheetBtn.setAttribute('aria-expanded', String(!sheet.hidden));
      return;
    }
    sheetBtn.disabled = true;
    sheetBtn.title = 'Reading sticker…';
    const res = await send({ type: 'sticker', vin: sheetBtn.dataset.sticker });
    if (!sheet.isConnected) return;
    sheet.innerHTML = res?.ok ? stickerRowsHtml(res.sticker) : `<div class="err">${esc(res?.error ?? 'Could not read the sticker.')}</div>`;
    sheet.dataset.loaded = '1';
    sheet.hidden = false;
    sheetBtn.disabled = false;
    sheetBtn.title = 'Window sticker details';
    sheetBtn.classList.add('on');
    sheetBtn.setAttribute('aria-expanded', 'true');
    return;
  }

  const copy = e.target.closest('[data-copy]');
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      copy.classList.add('done');
      copy.querySelector('code').textContent = 'Copied';
      setTimeout(() => { copy.classList.remove('done'); copy.querySelector('code').textContent = copy.dataset.copy; }, 1200);
    } catch { /* clipboard unavailable; nothing to do */ }
  }
});

infoBtn.addEventListener('click', () => {
  const open = about.hidden;
  about.hidden = !open;
  field.hidden = open;
  out.hidden = open;
  infoBtn.setAttribute('aria-expanded', String(open));
  if (!open) input.focus();
});

input.addEventListener('input', () => { clearTimeout(run.t); run.t = setTimeout(run, 200); });

// Back to the list without closing the popup: the × in the field, or Escape.
function clearVin() {
  if (!input.value) return;
  clearTimeout(run.t);
  input.value = '';
  run();
  input.focus();
}
clearBtn.addEventListener('click', clearVin);
input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); clearVin(); } });
run();
