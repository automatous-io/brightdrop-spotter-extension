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

// Content script. Reads the page, never the network.
//
// Only ever inserts a badge after text positively identified as a BrightDrop
// VIN. Never rewrites page text and skips editable regions. The hover card is
// one shared element in a shadow root, so host CSS cannot reach it.

const BADGE_CLASS = 'bd-vin-badge';
/** VINs already badged, per text node. Failures are not recorded, so the next scan retries them. */
const done = new WeakMap();
const isDone = (node, vin) => done.get(node)?.has(vin) ?? false;
const markDone = (node, vin) => { if (!done.has(node)) done.set(node, new Set()); done.get(node).add(vin); };
const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;

const TRANSLIT = { A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9 };
const WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];

// Check-digit filter so junk never reaches the service worker. Mirrors vin.js.
function looksLikeBrightDropVin(vin) {
  if (vin.length !== 17 || !/^2G[5C]J?/.test(vin)) return false;
  if (vin[4] !== 'J' || !'23'.includes(vin[5]) || !'TH'.includes(vin[6])) return false;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const v = /\d/.test(vin[i]) ? Number(vin[i]) : TRANSLIT[vin[i]];
    if (v === undefined) return false;
    sum += v * WEIGHTS[i];
  }
  const expect = sum % 11 === 10 ? 'X' : String(sum % 11);
  return vin[8] === expect;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'CODE', 'PRE']);

/** Find text nodes holding a BrightDrop VIN, skipping anything interactive. */
function findVinNodes(root) {
  const hits = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
      if (parent.closest(`.${BADGE_CLASS}`)) return NodeFilter.FILTER_REJECT;
      if (node.nodeValue.length < 17 || node.nodeValue.length > 5000) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.toUpperCase();
    VIN_RE.lastIndex = 0;
    for (const m of text.matchAll(VIN_RE)) {
      if (looksLikeBrightDropVin(m[0]) && !isDone(n, m[0])) hits.push({ node: n, vin: m[0] });
    }
  }
  return hits;
}

// Material Design Icons "van-utility" (Pictogrammers, Apache-2.0), inlined.
const VAN_PATH = 'M3,7C1.89,7 1,7.89 1,9V17H3A3,3 0 0,0 6,20A3,3 0 0,0 9,17H15A3,3 0 0,0 18,20A3,3 0 0,0 21,17H23V13C23,11.89 22.11,11 21,11L18,7H3M15,8.5H17.5L19.46,11H15V8.5M6,15.5A1.5,1.5 0 0,1 7.5,17A1.5,1.5 0 0,1 6,18.5A1.5,1.5 0 0,1 4.5,17A1.5,1.5 0 0,1 6,15.5M18,15.5A1.5,1.5 0 0,1 19.5,17A1.5,1.5 0 0,1 18,18.5A1.5,1.5 0 0,1 16.5,17A1.5,1.5 0 0,1 18,15.5Z';

function vanIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', VAN_PATH);
  svg.appendChild(path);
  return svg;
}

// ---------------------------------------------------------------------------
// Presentation helpers shared by the badge and the card.
// ---------------------------------------------------------------------------

/** The largest pack GM fits; the module bar is drawn against this. */
const MAX_MODULES = 20;

/** "Class 3: 10,001 - 14,000 lb (...)" -> "Class 3" */
const gvwrClassShort = (s) => (s ? String(s).split(':')[0].trim() : null);

/** Decoder result -> the display values the layout needs. */
function present(r) {
  const b = r.battery;
  const m = r.motor;
  const modules = r.modules ?? b?.modules ?? null;
  return {
    vin: r.vin,
    title: r.name ?? r.series ?? 'BrightDrop',
    eyebrow: [r.modelYear, r.make ?? 'BrightDrop'].filter(Boolean).join(' · '),
    isMax: b?.name === 'Max Range',
    isExt: b?.name === 'Extended Range',
    batteryName: b?.name ?? 'Battery not reported',
    batteryCode: r.batteryCode ?? null,
    rangeMi: b?.rangeMi ?? null,
    modules,
    drive: r.driveType ?? m?.drivetrain ?? null,
    motors: m ? `${m.motors} motor${m.motors === 1 ? '' : 's'}` : null,
    hp: m?.hp ?? null,
    torque: m?.torqueLbFt ?? null,
    gvwr: r.local?.gvwr?.value ?? null,
    gvwrClass: gvwrClassShort(r.gvwrClass),
    sticker: r.stickerUrl ?? null,
  };
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

/** Decoder results keyed by badge element, read back when the card opens. */
const badgeData = new WeakMap();

function badge(result) {
  const el = document.createElement('span');
  el.className = BADGE_CLASS;

  const bits = [];
  if (result.battery) bits.push(result.battery.name);
  if (result.driveType) bits.push(result.driveType);
  if (result.name ?? result.series) bits.push(result.name ?? result.series);

  el.appendChild(vanIcon());
  el.appendChild(document.createTextNode(bits.join(' · ') || 'BrightDrop'));
  if (result.battery?.name === 'Max Range') el.classList.add('bd-vin-badge--max');
  if (result.battery?.name === 'Extended Range') el.classList.add('bd-vin-badge--ext');

  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-haspopup', 'dialog');
  el.setAttribute('aria-label', `${bits.join(', ') || 'BrightDrop'}. Show vehicle details.`);
  badgeData.set(el, result);
  return el;
}

/** Insert a badge directly after the text node that contained the VIN. */
function annotate(node, result) {
  const parent = node.parentElement;
  if (!parent || isDone(node, result.vin)) return;
  markDone(node, result.vin);
  const el = badge(result);
  // Place after the text node and after any badge already added for an earlier VIN in it.
  let after = node;
  while (after.nextSibling instanceof Element && after.nextSibling.classList.contains(BADGE_CLASS)) after = after.nextSibling;
  parent.insertBefore(el, after.nextSibling);
}

// ---------------------------------------------------------------------------
// Hover card
// ---------------------------------------------------------------------------

const CARD_CSS = `
  :host {
    all: initial;
    position: fixed;
    top: 0; left: 0;
    z-index: 2147483647;
    pointer-events: none;
    --bg: #ffffff; --surface: #f2f4f7; --border: #e3e7ec; --border-strong: #cfd6de;
    --text: #0d1419; --muted: #5a6672; --accent: #0f6fd1;
    --max: #07845f; --max-soft: #e6f5ef; --max-line: #b9e2d3;
    --ext: #b4640a; --ext-soft: #fdf1e2; --ext-line: #efd2a3;
    --seg: #cfd6de; --shadow: 0 12px 32px rgba(13, 20, 25, 0.14), 0 2px 6px rgba(13, 20, 25, 0.08);
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --bg: #151b23; --surface: #1b222c; --border: #252c36; --border-strong: #38414d;
      --text: #e6edf3; --muted: #8b949e; --accent: #5ab0f5;
      --max: #3fbf95; --max-soft: #0e2620; --max-line: #1e4a3c;
      --ext: #e3a35a; --ext-soft: #2b2012; --ext-line: #5a4020;
      --seg: #38414d; --shadow: 0 12px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .card {
    width: 300px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow);
    font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
    pointer-events: auto;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 120ms ease, transform 120ms ease;
  }
  .card.is-open { opacity: 1; transform: none; }
  .card.is-above { transform: translateY(-4px); }
  .card.is-above.is-open { transform: none; }

  .head { display: flex; align-items: center; gap: 10px; padding: 12px 14px 10px; }
  .head > div { flex: 1; min-width: 0; }
  .head svg { width: 20px; height: 20px; fill: var(--accent); flex: none; }
  .head .eyebrow { font-size: 11px; color: var(--muted); letter-spacing: 0.02em; }
  .head .title { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .head .ib {
    width: 26px; height: 26px; flex: none;
    display: grid; place-items: center; border-radius: 6px;
    background: none; border: 0; padding: 0; color: var(--muted); cursor: pointer;
  }
  .head .ib:last-child { margin-right: -6px; }
  .head .ib:hover { background: var(--surface); color: var(--accent); }
  .head .ib:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .head .ib:disabled { color: var(--border-strong); cursor: progress; }
  .head .ib svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .head .save.done { color: var(--max); }
  .head .save.done:hover { color: var(--accent); }
  .head .save.done svg { fill: currentColor; }
  .head .sheet-btn.on { color: var(--accent); }
  .head a.ib { text-decoration: none; }
  .head a.ib[hidden] { display: none; }

  .hero {
    margin: 0 10px; padding: 11px 12px 12px;
    border-radius: 9px; background: var(--surface); border: 1px solid var(--border);
  }
  .hero.is-max { background: var(--max-soft); border-color: var(--max-line); }
  .hero.is-ext { background: var(--ext-soft); border-color: var(--ext-line); }
  .hero .row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .label { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
  .hero .name { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; margin-top: 2px; }
  .hero.is-max .name { color: var(--max); }
  .hero.is-ext .name { color: var(--ext); }
  .hero .range { text-align: right; white-space: nowrap; }
  .hero .range b { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .hero.is-max .range b { color: var(--max); }
  .hero.is-ext .range b { color: var(--ext); }
  .hero .range small { display: block; font-size: 10px; color: var(--muted); letter-spacing: 0.04em; text-transform: uppercase; }
  .bar { display: flex; gap: 2px; margin-top: 9px; height: 6px; }
  .bar i { flex: 1; border-radius: 2px; background: var(--seg); opacity: 0.45; }
  .bar i.on { opacity: 1; background: var(--muted); }
  .hero.is-max .bar i.on { background: var(--max); }
  .hero.is-ext .bar i.on { background: var(--ext); }
  .hero .meta { display: flex; justify-content: space-between; margin-top: 6px; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .hero .meta code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }

  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 8px 10px 0; }
  .stat { padding: 8px 9px; border-radius: 8px; border: 1px solid var(--border); min-width: 0; }
  .stat .label { white-space: nowrap; letter-spacing: 0.06em; }
  .stat b { display: block; font-size: 14px; font-weight: 650; margin-top: 2px; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
  .stat span { display: block; font-size: 11px; color: var(--muted); }

  .sheet { margin: 8px 10px 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .sheet[hidden] { display: none; }
  .sheet .rows { display: grid; grid-template-columns: auto 1fr; gap: 5px 10px; padding: 9px 10px 10px; font-size: 11px; line-height: 1.4; }
  .sheet .rows .k { font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); padding-top: 1px; white-space: nowrap; }
  .sheet .rows .v { color: var(--text); }
  .sheet .rows .v.on { color: var(--max); font-weight: 600; }
  .sheet .rows .v.off { color: var(--muted); }
  .sheet .rows .v b { font-weight: 650; font-variant-numeric: tabular-nums; }
  .sheet .rows .v small { color: var(--muted); }
  .sheet .err { padding: 8px 10px 10px; font-size: 11px; color: var(--muted); }
  .foot {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 10px 14px 12px;
  }
  .foot .vin {
    display: inline-flex; align-items: center; gap: 5px;
    font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; letter-spacing: 0.06em;
    color: var(--muted); background: none; border: 0; padding: 0; cursor: pointer;
  }
  .foot .vin:hover { color: var(--accent); }
  .foot .vin:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
  .foot .vin.done { color: var(--max); }
  .foot .vin svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; flex: none; }
  .foot a {
    display: inline-flex; align-items: center; gap: 4px;
    color: var(--accent); text-decoration: none; font-size: 12px; font-weight: 600; white-space: nowrap;
  }
  .foot a:hover { text-decoration: underline; }
  .foot a svg { width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-width: 2; }
`;

const OPEN_DELAY = 90;    // ms before the card appears; avoids flashing while the pointer crosses a badge
const CLOSE_DELAY = 160;  // ms grace so the pointer can travel from badge to card

const card = (() => {
  let host = null;
  let shadow = null;
  let box = null;
  let current = null;       // badge the card is open for
  let openTimer = 0;
  let closeTimer = 0;

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.setAttribute('data-bd-vin-card', '');
    shadow = host.attachShadow({ mode: 'open' });

    // Constructed stylesheets are not subject to the host page's CSP, unlike an
    // injected <style> element. Fall back to <style> where unsupported.
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CARD_CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = CARD_CSS;
      shadow.appendChild(style);
    }

    box = document.createElement('div');
    box.className = 'card';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'BrightDrop vehicle details');
    box.addEventListener('mouseenter', () => clearTimeout(closeTimer));
    box.addEventListener('mouseleave', () => scheduleClose());
    shadow.appendChild(box);
    document.body.appendChild(host);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function stat(label, value, sub) {
    const s = el('div', 'stat');
    s.appendChild(el('div', 'label', label));
    s.appendChild(el('b', null, value ?? '—'));
    if (sub) s.appendChild(el('span', null, sub));
    return s;
  }

  const usd = (n) => (n == null ? null : `$${Math.round(n).toLocaleString('en-US')}`);

  /** Sticker facts -> the rows a shopper cares about. */
  function stickerRows(st) {
    const rows = el('div', 'rows');
    const add = (k, v, cls) => {
      rows.appendChild(el('span', 'k', k));
      const val = el('span', `v${cls ? ` ${cls}` : ''}`);
      if (typeof v === 'string') val.textContent = v; else val.appendChild(v);
      rows.appendChild(val);
    };
    for (const r of st.rows ?? []) add(r.label, r.value, r.absent ? 'off' : r.key === 'outlets' ? 'on' : null);
    if (st.totalPrice) {
      const v = el('span');
      v.appendChild(el('b', null, usd(st.totalPrice)));
      if (st.basePrice) v.appendChild(el('small', null, ` sticker · ${usd(st.basePrice)} base`));
      add('Price', v);
    }
    if (st.exterior) add('Color', st.interior ? `${st.exterior} over ${st.interior}` : st.exterior);
    if (st.dealer?.name) add('Sold new', [st.dealer.name, [st.dealer.city, st.dealer.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '));
    if (st.orderDate) add('Ordered', st.orderDate);
    return rows;
  }

  function render(p) {
    box.replaceChildren();

    const head = el('div', 'head');
    head.appendChild(vanIcon());
    const ident = el('div');
    if (p.eyebrow) ident.appendChild(el('div', 'eyebrow', p.eyebrow));
    ident.appendChild(el('div', 'title', p.title));
    head.appendChild(ident);
    // Window sticker details: fetched from GM only when asked, for this one van.
    const sheet = el('div', 'sheet');
    sheet.hidden = true;
    const sheetBtn = el('button', 'ib sheet-btn');
    sheetBtn.type = 'button';
    const docIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    docIcon.setAttribute('viewBox', '0 0 24 24');
    docIcon.setAttribute('aria-hidden', 'true');
    for (const d of ['M7 3h7l5 5v13H7z', 'M14 3v5h5', 'M10 13h6M10 17h6']) {
      const seg = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      seg.setAttribute('d', d);
      docIcon.appendChild(seg);
    }
    sheetBtn.appendChild(docIcon);
    sheetBtn.title = 'Window sticker details';
    sheetBtn.setAttribute('aria-label', 'Show window sticker details: options, price, color and first dealer');
    sheetBtn.setAttribute('aria-expanded', 'false');
    let loaded = false;
    sheetBtn.addEventListener('click', async () => {
      if (loaded) {
        sheet.hidden = !sheet.hidden;
        sheetBtn.classList.toggle('on', !sheet.hidden);
        sheetBtn.setAttribute('aria-expanded', String(!sheet.hidden));
        if (current) place(current);
        return;
      }
      sheetBtn.disabled = true;
      sheetBtn.title = 'Reading sticker…';
      try {
        const res = await chrome.runtime.sendMessage({ type: 'sticker', vin: p.vin });
        sheet.replaceChildren(res?.ok ? stickerRows(res.sticker) : el('div', 'err', res?.error ?? 'Could not read the sticker.'));
        loaded = true;
        sheet.hidden = false;
        sheetBtn.classList.add('on');
        sheetBtn.setAttribute('aria-expanded', 'true');
      } catch { /* extension reloaded; nothing to do */ }
      sheetBtn.disabled = false;
      sheetBtn.title = 'Window sticker details';
      if (current) place(current);   // the card grew; keep it on screen
    });
    if (p.sticker) head.appendChild(sheetBtn);

    // Listing page this van was bookmarked from, when it is not the page we are on.
    const link = el('a', 'ib page-link');
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.hidden = true;
    const linkIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    linkIcon.setAttribute('viewBox', '0 0 24 24');
    linkIcon.setAttribute('aria-hidden', 'true');
    for (const d of ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 6.8', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5']) {
      const seg = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      seg.setAttribute('d', d);
      linkIcon.appendChild(seg);
    }
    link.appendChild(linkIcon);
    const pageHere = () => (window.top === window ? location.href : (document.referrer || location.href));
    const showLink = (url, title) => {
      const ok = Boolean(url) && url !== pageHere();
      link.hidden = !ok;
      if (!ok) return;
      link.href = url;
      let host = '';
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* leave blank */ }
      link.title = title ? `Open saved listing: ${title}` : `Open saved listing on ${host}`;
      link.setAttribute('aria-label', link.title);
    };
    head.appendChild(link);

    const save = el('button', 'ib save');
    save.type = 'button';
    const saveIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    saveIcon.setAttribute('viewBox', '0 0 24 24');
    saveIcon.setAttribute('aria-hidden', 'true');
    const savePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    savePath.setAttribute('d', 'M6 4h12v17l-6-4-6 4z');   // bookmark
    saveIcon.appendChild(savePath);
    save.appendChild(saveIcon);
    let saved = false;
    const setSaved = (on) => {
      saved = on;
      save.classList.toggle('done', on);
      save.title = on ? 'Saved. Click to remove from recent lookups' : 'Save to recent lookups';
      save.setAttribute('aria-label', save.title);
      save.setAttribute('aria-pressed', String(on));
    };
    setSaved(false);
    save.addEventListener('click', async () => {
      try {
        const page = { url: pageHere(), title: (window.top === window ? document.title : '').trim() };
        const res = await chrome.runtime.sendMessage({ type: saved ? 'forget' : 'remember', vin: p.vin, page });
        if (res?.ok) { const wasSaved = saved; setSaved(!wasSaved); if (wasSaved) showLink(null); }
      } catch { /* extension reloaded; nothing to do */ }
    });
    // Reflect an existing entry once the answer arrives; the card is usable meanwhile.
    chrome.runtime.sendMessage({ type: 'isRecent', vin: p.vin })
      .then((res) => { if (res?.ok && res.saved) { setSaved(true); showLink(res.url, res.title); } })
      .catch(() => {});
    head.appendChild(save);
    box.appendChild(head);

    const hero = el('div', `hero${p.isMax ? ' is-max' : p.isExt ? ' is-ext' : ''}`);
    const row = el('div', 'row');
    const left = el('div');
    left.appendChild(el('div', 'label', 'Battery pack'));
    left.appendChild(el('div', 'name', p.batteryName));
    row.appendChild(left);
    if (p.rangeMi) {
      const range = el('div', 'range');
      range.appendChild(el('b', null, `~${p.rangeMi} mi`));
      range.appendChild(el('small', null, 'est. range'));
      row.appendChild(range);
    }
    hero.appendChild(row);
    if (p.modules) {
      const bar = el('div', 'bar');
      for (let i = 0; i < MAX_MODULES; i += 1) bar.appendChild(el('i', i < p.modules ? 'on' : null));
      hero.appendChild(bar);
      const meta = el('div', 'meta');
      meta.appendChild(el('span', null, `${p.modules} of ${MAX_MODULES} modules`));
      if (p.batteryCode) meta.appendChild(el('code', null, `RPO ${p.batteryCode}`));
      hero.appendChild(meta);
    }
    box.appendChild(hero);

    const stats = el('div', 'stats');
    stats.appendChild(stat('Drive Type', p.drive, p.motors));
    stats.appendChild(stat('Power', p.hp ? `${p.hp} hp` : null, p.torque ? `${p.torque} lb-ft` : null));
    stats.appendChild(stat('GVWR', p.gvwr ?? p.gvwrClass, p.gvwr ? p.gvwrClass : null));
    box.appendChild(stats);

    box.appendChild(sheet);

    const foot = el('div', 'foot');
    const copy = el('button', 'vin');
    copy.type = 'button';
    copy.setAttribute('aria-label', 'Copy VIN');
    const clip = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    clip.setAttribute('viewBox', '0 0 24 24');
    clip.setAttribute('aria-hidden', 'true');
    for (const d of ['M9 9h11v11H9z', 'M5 15V6a2 2 0 0 1 2-2h9']) {
      const seg = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      seg.setAttribute('d', d);
      clip.appendChild(seg);
    }
    copy.appendChild(clip);
    const vinText = el('span', null, p.vin);
    copy.appendChild(vinText);
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(p.vin);
        copy.classList.add('done');
        vinText.textContent = 'Copied';
        setTimeout(() => { copy.classList.remove('done'); vinText.textContent = p.vin; }, 1200);
      } catch { /* clipboard blocked on this page; nothing to do */ }
    });
    foot.appendChild(copy);
    if (!p.sticker) { box.appendChild(foot); return; }
    const a = el('a', null, 'window sticker');
    a.href = p.sticker;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('viewBox', '0 0 24 24');
    arrow.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M7 17L17 7M9 7h8v8');
    arrow.appendChild(path);
    a.appendChild(arrow);
    foot.appendChild(a);
    box.appendChild(foot);
  }

  function place(anchor) {
    const r = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const gap = 8;
    const pad = 8;

    // Measure once rendered but before it is visible.
    const w = box.offsetWidth;
    const h = box.offsetHeight;

    const below = r.bottom + gap + h <= vh - pad;
    const above = r.top - gap - h >= pad;
    const useAbove = !below && above;
    const top = useAbove ? r.top - gap - h : Math.min(r.bottom + gap, vh - pad - h);
    const left = Math.max(pad, Math.min(r.left, vw - pad - w));

    host.style.top = `${Math.round(top)}px`;
    host.style.left = `${Math.round(left)}px`;
    box.classList.toggle('is-above', useAbove);
  }

  function open(anchor) {
    const result = badgeData.get(anchor);
    if (!result) return;
    mount();
    clearTimeout(closeTimer);
    if (current && current !== anchor) current.removeAttribute('data-bd-open');
    current = anchor;
    anchor.setAttribute('data-bd-open', '');
    render(present(result));
    place(anchor);
    // Two frames so the transition runs from the initial state.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (current === anchor) box.classList.add('is-open');
    }));
  }

  function close() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (!current) return;
    current.removeAttribute('data-bd-open');
    current = null;
    box.classList.remove('is-open');
    host.style.top = '-9999px';
  }

  function scheduleOpen(anchor) {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (current === anchor) return;
    openTimer = setTimeout(() => open(anchor), OPEN_DELAY);
  }

  function scheduleClose() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, CLOSE_DELAY);
  }

  function isOpen() { return Boolean(current); }

  return { scheduleOpen, scheduleClose, open, close, isOpen };
})();

// One delegated listener set for every badge on the page, present or future.
const badgeOf = (t) => (t instanceof Element ? t.closest(`.${BADGE_CLASS}`) : null);

document.addEventListener('mouseover', (e) => {
  const b = badgeOf(e.target);
  if (b && badgeData.has(b)) card.scheduleOpen(b);
});
document.addEventListener('mouseout', (e) => {
  const b = badgeOf(e.target);
  if (b && badgeData.has(b) && !b.contains(e.relatedTarget)) card.scheduleClose();
});
document.addEventListener('focusin', (e) => {
  const b = badgeOf(e.target);
  if (b && badgeData.has(b)) card.open(b);
});
document.addEventListener('focusout', (e) => {
  if (badgeOf(e.target)) card.scheduleClose();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && card.isOpen()) card.close();
});
window.addEventListener('scroll', () => { if (card.isOpen()) card.close(); }, { passive: true, capture: true });
window.addEventListener('resize', () => { if (card.isOpen()) card.close(); }, { passive: true });

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

let running = false;

let rerun = false;

async function scan(root = document.body) {
  if (!root) return;
  if (running) { rerun = true; return; }   // picked up when the in-flight scan finishes
  running = true;
  try {
    const hits = findVinNodes(root);
    if (!hits.length) return;

    const vins = [...new Set(hits.map((h) => h.vin))];
    const res = await chrome.runtime.sendMessage({ type: 'decode', vins });
    if (!res?.ok) return;

    for (const { node, vin } of hits) {
      const result = res.results[vin];
      if (!node.isConnected) continue;
      if (result?.skip) { markDone(node, vin); continue; }   // confirmed not a BrightDrop: nothing to show
      if (result?.ok) annotate(node, result);
      // Anything else (network error, no record yet) is left unmarked so a later scan can retry.
    }
  } catch {
    // Extension reloaded under us; nothing to do.
  } finally {
    running = false;
    if (rerun) { rerun = false; scan(root); }
  }
}

scan();

// Dealer inventory pages load listings lazily, so keep watching, but coalesce
// bursts of mutations into one scan.
let pending;
new MutationObserver(() => {
  clearTimeout(pending);
  pending = setTimeout(() => scan(), 600);
}).observe(document.documentElement, { childList: true, subtree: true });
