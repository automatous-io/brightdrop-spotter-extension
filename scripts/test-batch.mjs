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
import { decodeVinsBatch, extractVins, BATCH_LIMIT, isBrightDropVin } from '../vin.js';

let pass = 0;
const t = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };
const ta = async (name, fn) => { await fn(); pass += 1; console.log(`  ok  ${name}`); };

const ROW = (vin, drive, motor, battery, mods, gvwr) => ({
  VIN: vin, Make: 'CHEVROLET', Model: 'BrightDrop', Series: '600', ModelYear: '2025',
  DriveType: drive, EngineModel: `${motor} + ${battery}`,
  OtherEngineInfo: `E${drive.split('/')[0]} - ${motor === 'XRJ' ? 2 : 1}-MOTOR SYSTEM + ${mods} MOD`,
  GVWR: gvwr, ErrorCode: '0',
});

// Verbatim shapes from the live batch call against the four confirmed VINs.
const LIVE = {
  '2G5ZJ3TY3S9100388': ROW('2G5ZJ3TY3S9100388', 'AWD/All-Wheel Drive', 'XRJ', 'ETC', 12, 'Class 2H: 9,001 - 10,000 lb'),
  '2G58J3T60S9106255': ROW('2G58J3T60S9106255', 'FWD/Front-Wheel Drive', 'XRM', 'ETC', 12, 'Class 3: 10,001 - 14,000 lb'),
  '2G58J3TYXS9106586': ROW('2G58J3TYXS9106586', 'AWD/All-Wheel Drive', 'XRJ', 'ETC', 12, 'Class 3: 10,001 - 14,000 lb'),
  '2G5ZJ3T60S9104168': ROW('2G5ZJ3T60S9104168', 'FWD/Front-Wheel Drive', 'XRM', 'ETC', 12, 'Class 2H: 9,001 - 10,000 lb'),
  '2G58J2TZ7S9102966': { ...ROW('2G58J2TZ7S9102966', 'AWD/All-Wheel Drive', 'XRJ', 'ETJ', 20, 'Class 3: 10,001 - 14,000 lb'), Series: '400' },
};

// Real rows outside the 2025 set: a 2024 Zevo, a 2026 2GC BrightDrop, and a 2GC Silverado.
const EXTRA = {
  '2G5ZJ3TY3R9103964': { ...ROW('2G5ZJ3TY3R9103964', 'AWD/All-Wheel Drive', 'XRJ', 'ETC', 12, 'Class 2H: 9,001 - 10,000 lb'), Make: 'BRIGHTDROP', Model: 'Zevo', ModelYear: '2024' },
  '2GC8J2TZXT9100025': { VIN: '2GC8J2TZXT9100025', Make: 'CHEVROLET', Model: 'BrightDrop', Series: '400', ModelYear: '2026', DriveType: 'AWD/All-Wheel Drive', EngineModel: 'XRJ+ETJ', OtherEngineInfo: 'EAWD, 2-MOTOR SYSTEM, 20-MOD', GVWR: 'Class 3: 10,001 - 14,000 lb', ErrorCode: '0' },
  '2GC4YPEYXR1234567': { VIN: '2GC4YPEYXR1234567', Make: 'CHEVROLET', Model: 'Silverado', Series: '2500 HD', ModelYear: '2024', DriveType: '4WD/4-Wheel Drive', EngineModel: 'L8T', OtherEngineInfo: '', GVWR: 'Class 2H', ErrorCode: '0' },
};

let calls = 0;
const fakeFetch = async (url, opts) => {
  calls += 1;
  const sent = new URLSearchParams(opts.body).get('data').split(';');
  return { ok: true, json: async () => ({ Results: sent.map((v) => LIVE[v] ?? EXTRA[v]).filter(Boolean) }) };
};

// --- extraction ---
t('pulls VINs out of page text and ignores junk', () => {
  const text = 'Stock 18191 VIN 2g5zj3ty3s9100388 / 2G58J3T60S9106255 · ABCDEFGHJKLMNPRST · 12345678901234567';
  assert.deepEqual(extractVins(text), ['2G5ZJ3TY3S9100388', '2G58J3T60S9106255']);
});

t('a valid non-BrightDrop VIN is excluded by default', () => {
  assert.deepEqual(extractVins('1M8GDM9AXKP042788'), []);
  assert.deepEqual(extractVins('1M8GDM9AXKP042788', { brightDropOnly: false }), ['1M8GDM9AXKP042788']);
});

t('a VIN with one character altered is rejected by the check digit', () => {
  assert.deepEqual(extractVins('2G5ZJ3TY3S9100389'), []);
});

t('duplicates collapse', () => {
  assert.equal(extractVins('2G5ZJ3TY3S9100388 2G5ZJ3TY3S9100388').length, 1);
});

// --- batch ---
await ta('decodes all four confirmed VINs in one request', async () => {
  calls = 0;
  const m = await decodeVinsBatch(Object.keys(LIVE), { fetchImpl: fakeFetch });
  assert.equal(calls, 1, 'all confirmed VINs must cost exactly one POST');
  assert.equal(m.size, 5);
  assert.equal(m.get('2G58J2TZ7S9102966').batteryCode, 'ETJ');
  assert.equal(m.get('2G58J2TZ7S9102966').modules, 20);
  assert.equal(m.get('2G58J2TZ7S9102966').series, '400');
  assert.equal(m.get('2G5ZJ3TY3S9100388').driveType, 'AWD');
  assert.equal(m.get('2G58J3T60S9106255').driveType, 'FWD');
  assert.equal(m.get('2G5ZJ3TY3S9100388').batteryCode, 'ETC');
  assert.equal(m.get('2G5ZJ3TY3S9100388').modules, 12);
});

await ta('offline powertrain decode agrees with vPIC on drivetrain and battery', async () => {
  const m = await decodeVinsBatch(Object.keys(LIVE), { fetchImpl: fakeFetch });
  for (const [vin, r] of m) {
    const local = r.local.powertrain.value;   // e.g. "AWD · Max Range"
    assert.ok(local.startsWith(r.driveType), `${vin}: ${local} vs ${r.driveType}`);
    const localBattery = local.includes('Max Range') ? 'ETJ' : 'ETC';
    assert.equal(localBattery, r.batteryCode, `${vin} battery must agree`);
  }
});

await ta('malformed and non-BrightDrop VINs never reach the network', async () => {
  calls = 0;
  const m = await decodeVinsBatch(['NOTAVIN', '1M8GDM9AXKP042788', '2G5ZJ3TY3S9100389'], { fetchImpl: fakeFetch });
  assert.equal(calls, 0, 'nothing valid to send, so no request');
  assert.equal(m.get('1M8GDM9AXKP042788').skip, true);
  assert.equal(m.get('2G5ZJ3TY3S9100389').ok, false);
});

await ta('a batch larger than the limit is chunked', async () => {
  calls = 0;
  const keys = Object.keys(LIVE);
  const many = Array.from({ length: BATCH_LIMIT + 5 }, (_, i) => keys[i % keys.length]);
  await decodeVinsBatch(many, { fetchImpl: fakeFetch });
  assert.equal(calls, 1, 'duplicates dedupe down to the unique VINs, so still one call');
});

await ta('network failure marks every VIN in the chunk, and does not throw', async () => {
  const m = await decodeVinsBatch(Object.keys(LIVE), {
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(m.size, 5);
  for (const [, r] of m) { assert.equal(r.ok, false); assert.equal(r.error, 'offline'); }
});

await ta('range is chosen per model year and series', async () => {
  const m = await decodeVinsBatch(['2G5ZJ3TY3R9103964', '2G5ZJ3TY3S9100388', '2GC8J2TZXT9100025'], { fetchImpl: fakeFetch });
  assert.equal(m.get('2G5ZJ3TY3R9103964').battery.rangeMi, 164, '2024 600 Standard');
  assert.equal(m.get('2G5ZJ3TY3S9100388').battery.rangeMi, 179, '2025 AWD Standard');
  assert.equal(m.get('2GC8J2TZXT9100025').battery.rangeMi, 285, '2026 Max');
  assert.equal(m.get('2GC8J2TZXT9100025').modules, 20, 'hyphenated module count parsed');
  assert.equal(m.get('2G5ZJ3TY3R9103964').name, 'Zevo 600');
  assert.equal(m.get('2GC8J2TZXT9100025').name, 'BrightDrop 400');
  assert.equal(m.get('2GC8J2TZXT9100025').make, 'Chevrolet');
});

await ta('sticker url is attached from 2024 on and withheld for 2023', async () => {
  EXTRA['2G5ZJ3HG4P9101315'] = { ...ROW('2G5ZJ3HG4P9101315', 'AWD/All-Wheel Drive', 'XRJ', 'ETJ', 20, 'Class 2H'), Make: 'BRIGHTDROP', Model: 'Zevo', ModelYear: '2023', OtherEngineInfo: 'EAWD' };
  const m = await decodeVinsBatch(['2G5ZJ3HG4P9101315', '2G5ZJ3TY3R9103964'], { fetchImpl: fakeFetch });
  assert.equal(m.get('2G5ZJ3HG4P9101315').stickerUrl, null);
  assert.match(m.get('2G5ZJ3TY3R9103964').stickerUrl, /windowsticker\?vin=2G5ZJ3TY3R9103964/);
});

await ta('a 2GC Silverado is rejected by its VIN pattern before any request', async () => {
  calls = 0;
  const m = await decodeVinsBatch(['2GC4YPEYXR1234567'], { fetchImpl: fakeFetch });
  const r = m.get('2GC4YPEYXR1234567');
  assert.equal(calls, 0);
  assert.equal(r.ok, false);
  assert.equal(r.skip, true);
});

t('structural BrightDrop test: J at 5, model at 6, T or H at 7', () => {
  assert.ok(isBrightDropVin('2G58J2TZ7S9102966'));
  assert.ok(isBrightDropVin('2GC8J2TZXT9100025'));
  assert.ok(isBrightDropVin('2G5ZJ3HG4P9101315'), '2023 coding');
  assert.ok(!isBrightDropVin('2GC4YPEYXR1234567'), 'Silverado');
  assert.ok(!isBrightDropVin('1M8GDM9AXKP042788'), 'other make');
});

await ta('a 2GC row vPIC names as another truck is skipped after the request', async () => {
  // Pattern-passing VIN, but vPIC says Colorado: still caught, still silent.
  EXTRA['2GC8J3TYXR9100001'] = { VIN: '2GC8J3TYXR9100001', Make: 'CHEVROLET', Model: 'Colorado', Series: 'ZR2', ModelYear: '2024', DriveType: '4WD', EngineModel: 'L3B', OtherEngineInfo: '', GVWR: 'Class 1', ErrorCode: '0' };
  const m = await decodeVinsBatch(['2GC8J3TYXR9100001'], { fetchImpl: fakeFetch });
  assert.equal(m.get('2GC8J3TYXR9100001').skip, true);
  assert.match(m.get('2GC8J3TYXR9100001').error, /Colorado/);
});

await ta('a row with no make or model yet is a retryable failure, not a skip', async () => {
  EXTRA['2GC8J3TY1R9100002'] = { VIN: '2GC8J3TY1R9100002', Make: '', Model: '', Series: '', ModelYear: '2024', DriveType: '', EngineModel: '', OtherEngineInfo: '', GVWR: '', ErrorCode: '8' };
  const m = await decodeVinsBatch(['2GC8J3TY1R9100002'], { fetchImpl: fakeFetch });
  const r = m.get('2GC8J3TY1R9100002');
  assert.equal(r.ok, false);
  assert.ok(!r.skip);
  assert.match(r.error, /no record/);
});

await ta('a non-zero vPIC error code keeps the build data', async () => {
  EXTRA['2G5ZJ3TY9R9100003'] = { ...ROW('2G5ZJ3TY9R9100003', 'AWD/All-Wheel Drive', 'XRJ', 'ETC', 12, 'Class 2H'), Make: 'BRIGHTDROP', Model: 'Zevo', ModelYear: '2024', ErrorCode: '14', ErrorText: '14 - Unused position(s)' };
  const m = await decodeVinsBatch(['2G5ZJ3TY9R9100003'], { fetchImpl: fakeFetch });
  const r = m.get('2G5ZJ3TY9R9100003');
  assert.equal(r.ok, true);
  assert.equal(r.batteryCode, 'ETC');
  assert.match(r.errorText, /Unused/);
});

await ta('a VIN vPIC silently drops is reported, not lost', async () => {
  const m = await decodeVinsBatch(['2G5ZJ3TY3S9100388'], {
    fetchImpl: async () => ({ ok: true, json: async () => ({ Results: [] }) }),
  });
  assert.equal(m.get('2G5ZJ3TY3S9100388').error, 'vPIC returned no row');
});

console.log(`\n${pass} tests passed`);
