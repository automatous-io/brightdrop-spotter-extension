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

import assert from 'node:assert/strict';
import { extractPdfText, parseStickerText, pertinentRows, readSticker } from '../sticker.js';

let pass = 0;
const t = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };
const ta = async (name, fn) => { await fn(); pass += 1; console.log(`  ok  ${name}`); };

// Text shapes below are verbatim from a real 2025 400 AWD sticker, trimmed.
const META = '{"maker":"CHEVY","model_year":"2025","mmc_code":"CM32705","vin":"2G58J2TZ7S9102966","sitedealer_code":"25217","sell_source":"13","order_number":"DVCF47","creation_date":"2/13/2026","Options":["AEO","C7E","EJY","ETJ","K2O","XRJ","ZHR","","",""]}';
const TEXT = [
  'PULL THIS STRIP TO EXPOSE ADHESIVE2025 BRIGHTDROP 400 AWDEXTERIOR: OYSTER WHITEINTERIOR: JET BLACKVisit us at www.chevy.comSTANDARD EQUIPMENT',
  "MANUFACTURER'S SUGGESTED RETAIL PRICESTANDARD VEHICLE PRICE$67,200.00OPTIONS & PRICINGBATTERY, MAX RANGE8,000.00TOTAL OPTIONS$10,510.00TOTAL VEHICLE & OPTIONS$77,710.00DESTINATION CHARGE3,325.00TOTAL VEHICLE PRICE*$81,035.00Electric Vehicle",
  'FINALASSEMBLY:INGERSOLL,ONCANADAVIN 2G58J2TZ7S9102966             REISSUEDEALERTOWHOMDELIVEREDBURLINGTON CHEVROLET               105 EAST ROUTE 130 SOUTH            BURLINGTON, NJ 08016-2731                                      ',
  META,
].join('');

t('reads identity, colours and every price line', () => {
  const f = parseStickerText(TEXT);
  assert.equal(f.vin, '2G58J2TZ7S9102966');
  assert.equal(f.modelYear, 2025);
  assert.equal(f.series, '400');
  assert.equal(f.drive, 'AWD');
  assert.equal(f.exterior, 'Oyster White');
  assert.equal(f.interior, 'Jet Black');
  assert.equal(f.basePrice, 67200);
  assert.equal(f.optionsPrice, 10510);
  assert.equal(f.destination, 3325);
  assert.equal(f.totalPrice, 81035);
});

t('reads the original dealer', () => {
  const f = parseStickerText(TEXT);
  assert.deepEqual(f.dealer, { name: 'Burlington Chevrolet', city: 'Burlington', state: 'NJ' });
  assert.equal(f.orderNumber, 'DVCF47');
  assert.equal(f.orderDate, '2/13/2026');
});

t('option codes drop the padding GM adds', () => {
  assert.deepEqual(parseStickerText(TEXT).options, ['AEO', 'C7E', 'EJY', 'ETJ', 'K2O', 'XRJ', 'ZHR']);
});

t('falls back to scanning codes when the JSON is damaged', () => {
  const broken = parseStickerText(TEXT.replace('{"maker"', '{maker'));
  assert.ok(broken.options.includes('K2O'));
  assert.equal(broken.vin, null);
});

t('pertinent rows: present options and explicit absences, in display order', () => {
  const rows = pertinentRows(['K2O', 'ZHR', 'KYW']);
  assert.deepEqual(rows.map((r) => r.key), ['outlets', 'charging', 'spare', 'governor']);
  assert.equal(rows[0].absent, true, 'no KV7 -> outlets row says so');
  assert.match(rows[1].value, /19\.2 kW/);
  assert.match(rows[3].value, /75 mph/);
});

t('KV7 and the bundled 11.5 kW module read as fitted', () => {
  const rows = pertinentRows(['KV7', 'K28']);
  assert.match(rows.find((r) => r.key === 'outlets').value, /7\.2 kW/);
  assert.equal(rows.find((r) => r.key === 'outlets').code, 'KV7');
  assert.match(rows.find((r) => r.key === 'charging').value, /11\.5 kW/);
});

t('one row per topic even when several codes map to it', () => {
  const rows = pertinentRows(['VTJ', 'VSQ', 'PCY']);
  assert.equal(rows.filter((r) => r.key === 'shipthru').length, 1);
});

// A tiny synthetic PDF: one deflated content stream carrying the sticker text.
async function deflate(str) {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  const done = w.write(new TextEncoder().encode(str)).then(() => w.close());
  const chunks = [];
  const r = cs.readable.getReader();
  for (;;) { const { value, done: end } = await r.read(); if (end) break; chunks.push(value); }
  await done;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
async function fakePdf(strings) {
  const content = strings.map((s) => `(${s.replace(/([()\\])/g, '\\$1')}) Tj`).join('\n');
  const body = await deflate(content);
  const head = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Length ' + body.length + ' /Filter /FlateDecode >>\nstream\n');
  const tail = new TextEncoder().encode('\nendstream\nendobj\n%%EOF');
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head, 0); out.set(body, head.length); out.set(tail, head.length + body.length);
  return out.buffer;
}

await ta('extracts literal strings from a deflated content stream', async () => {
  const pdf = await fakePdf(['Hello ', 'sticker (with parens)']);
  assert.equal(await extractPdfText(pdf), 'Hello sticker (with parens)');
});

await ta('end to end: PDF bytes -> facts and rows', async () => {
  const pdf = await fakePdf([TEXT]);
  const r = await readSticker(pdf);
  assert.equal(r.totalPrice, 81035);
  assert.equal(r.rows.find((x) => x.key === 'charging').code, 'K2O');
});

await ta('rejects things that are not stickers', async () => {
  await assert.rejects(readSticker(new TextEncoder().encode('<html>not found</html>').buffer), /Not a PDF/);
  await assert.rejects(readSticker(await fakePdf(['Some other document'])), /No sticker data/);
});

console.log(`\n${pass} tests passed`);
