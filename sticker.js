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

// Window sticker (Monroney label) reader.
//
// GM serves the sticker as a text PDF. The last text run is a JSON block
// listing every RPO option code on the build; that block plus the printed
// price lines is what the card needs. Fetch one sticker per user request only.

/** Option codes shown on the card, in display order. Descriptions follow GM's 2025 and 2026 order guides. */
export const PERTINENT_RPO = {
  KV7: { key: 'outlets', label: 'Outlets', value: '7.2 kW offboard power. Four 120 V and one 240 V outlet in the cargo area.' },
  K2O: { key: 'charging', label: 'Charging', value: '19.2 kW onboard charger. About 25 mi of range per hour on AC.' },
  K28: { key: 'charging', label: 'Charging', value: '11.5 kW onboard charger. About 16 mi of range per hour on AC.' },
  PCP: { key: 'doors', label: 'Doors', value: 'Power bulkhead and passenger doors.' },
  ZHR: { key: 'spare', label: 'Spare', value: 'Spare tire, wheel and jack.' },
  KYW: { key: 'governor', label: 'Governor', value: 'Limited to 75 mph.' },
  KYR: { key: 'governor', label: 'Governor', value: 'Limited to 65 mph.' },
  KGU: { key: 'upfit', label: 'Upfit', value: 'Universal Vehicle Module for third-party equipment.' },
  RY9: { key: 'fleet', label: 'Fleet', value: 'Fleet delete. Excluded from the included first maintenance visit.' },
  VTJ: { key: 'shipthru', label: 'Shipped', value: 'Shipped to an upfitter before delivery.' },
  VSQ: { key: 'shipthru', label: 'Shipped', value: 'Shipped to an upfitter before delivery.' },
  V2Q: { key: 'shipthru', label: 'Shipped', value: 'Shipped to an upfitter before delivery.' },
  PCY: { key: 'shipthru', label: 'Shipped', value: 'Shipped to an upfitter before delivery.' },
};

/** What to say when a headline option is absent, so its absence is a fact rather than a gap. AC rates are GM's 2025 figures. */
const DEFAULTS = {
  outlets: { label: 'Outlets', value: 'Two 110 V outlets only. No 7.2 kW offboard power.' },
  charging: { label: 'Charging', value: '11.5 kW onboard charger. About 16 mi of range per hour on AC.' },
};

const latin1 = new TextDecoder('latin1');

async function inflate(bytes) {
  // Trim the EOL that precedes "endstream"; the browser decoder rejects trailing junk.
  let n = bytes.length;
  while (n > 0 && (bytes[n - 1] === 0x0a || bytes[n - 1] === 0x0d || bytes[n - 1] === 0x20)) n -= 1;
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const done = writer.write(bytes.subarray(0, n)).then(() => writer.close()).catch(() => {});
  const chunks = [];
  const reader = ds.readable.getReader();
  try {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      chunks.push(value);
    }
  } catch {
    // Trailing-junk complaints arrive after the real data has been emitted; keep what we have.
  }
  await done;
  if (!chunks.length) throw new Error('inflate failed');
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Unescape a PDF literal string body. */
const unescapePdf = (s) => s.replace(/\\([nrtbf()\\]|\d{1,3})/g, (_, c) => {
  if (/^\d/.test(c)) return String.fromCharCode(parseInt(c, 8));
  return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c];
});

/** All literal-string text in every content stream, in document order. */
export async function extractPdfText(buffer) {
  const bytes = new Uint8Array(buffer);
  const raw = latin1.decode(bytes);
  if (!raw.startsWith('%PDF')) throw new Error('Not a PDF');
  const parts = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    let body;
    try { body = latin1.decode(await inflate(bytes.subarray(start, end))); }
    catch { body = raw.slice(start, end); }
    for (const s of body.matchAll(/\(((?:\\.|[^\\)])*)\)/g)) parts.push(unescapePdf(s[1]));
    re.lastIndex = end;
  }
  return parts.join('');
}

const money = (text, label) => {
  const m = text.match(new RegExp(`${label}\\*?\\$?([\\d,]+\\.\\d\\d)`));
  return m ? Number(m[1].replace(/,/g, '')) : null;
};

/** Sticker text -> structured facts. Everything is best effort and null when absent. */
export function parseStickerText(text) {
  const meta = (() => {
    const m = text.match(/\{"maker".*?"Options":\[[^\]]*\]\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  })();
  // GM pads the array with empty strings; keep only real codes, once each.
  const rawOptions = meta?.Options ?? [...text.matchAll(/"([A-Z0-9]{3})"/g)].map((x) => x[1]);
  const options = [...new Set(rawOptions.filter((c) => /^[A-Z0-9]{3}$/.test(c)))];

  const head = text.match(/(20\d\d)\s+(?:CHEVROLET\s+)?BRIGHTDROP\s+(?:ZEVO\s+)?(\d{3})\s+(AWD|FWD)/i);
  const colours = text.match(/EXTERIOR:\s*([A-Z][A-Z /-]+?)\s*INTERIOR:\s*([A-Z][A-Z /-]+?)\s*(?:Visit|$)/i);

  let dealer = null;
  const d = text.match(/DEALERTOWHOMDELIVERED\s*(.*?)(?=\{"maker"|$)/s);
  if (d) {
    const cols = d[1].split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    const cityLine = cols.find((c) => /, [A-Z]{2} \d{5}/.test(c));
    const cs = cityLine?.match(/^(.+?), ([A-Z]{2}) (\d{5})/);
    dealer = { name: cols[0] ? titleCase(cols[0]) : null, city: cs ? titleCase(cs[1]) : null, state: cs ? cs[2] : null };
  }

  return {
    vin: meta?.vin ?? null,
    modelYear: head ? Number(head[1]) : meta?.model_year ? Number(meta.model_year) : null,
    series: head ? head[2] : null,
    drive: head ? head[3].toUpperCase() : null,
    exterior: colours ? titleCase(colours[1]) : null,
    interior: colours ? titleCase(colours[2]) : null,
    basePrice: money(text, 'STANDARD VEHICLE PRICE'),
    optionsPrice: money(text, 'TOTAL OPTIONS'),
    destination: money(text, 'DESTINATION CHARGE'),
    totalPrice: money(text, 'TOTAL VEHICLE PRICE'),
    dealer,
    orderNumber: meta?.order_number ?? null,
    orderDate: meta?.creation_date ?? null,
    options,
  };
}

const titleCase = (s) => String(s).trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Rows for the card: the headline options present or explicitly absent, then the rest. */
export function pertinentRows(options = []) {
  const set = new Set(options);
  const rows = [];
  const seen = new Set();
  for (const [code, spec] of Object.entries(PERTINENT_RPO)) {
    if (!set.has(code) || seen.has(spec.key)) continue;
    seen.add(spec.key);
    rows.push({ key: spec.key, label: spec.label, value: spec.value, code });
  }
  for (const [key, spec] of Object.entries(DEFAULTS)) {
    if (!seen.has(key)) rows.push({ key, label: spec.label, value: spec.value, code: null, absent: true });
  }
  const order = ['outlets', 'charging', 'doors', 'spare', 'governor', 'upfit', 'fleet', 'shipthru'];
  return rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

/** Full pipeline for the service worker. */
export async function readSticker(buffer) {
  const text = await extractPdfText(buffer);
  if (!/BRIGHTDROP|"maker"/i.test(text)) throw new Error('No sticker data found');
  const facts = parseStickerText(text);
  return { ...facts, rows: pertinentRows(facts.options) };
}
