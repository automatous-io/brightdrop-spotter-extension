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
import { computeCheckDigit, validateVin, decodeVin, normalizeVin, decodeVds, windowStickerUrl, parsePowertrain, lookupVin, searchPattern, estimatedRange, isBrightDropRow, vehicleName } from '../vin.js';

let pass = 0;
const t = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };

// Published ISO 3779 test vectors.
t('canonical example VIN checks to X', () =>
  assert.equal(computeCheckDigit('1M8GDM9AXKP042788'), 'X'));
t('all-ones VIN checks to 1', () =>
  assert.equal(computeCheckDigit('11111111111111111'), '1'));
t('position 9 does not affect its own check digit', () =>
  assert.equal(computeCheckDigit('1M8GDM9A0KP042788'), computeCheckDigit('1M8GDM9A5KP042788')));

t('normalize strips spaces, hyphens and case', () =>
  assert.equal(normalizeVin(' 2g5-8j3t6 xp1234567 '), '2G58J3T6XP1234567'));

t('rejects wrong length', () => {
  const r = validateVin('2G58J3T6');
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /17 characters/);
});

t('rejects I, O and Q', () => {
  const r = validateVin('2G58J3T6XP123456O');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('"O"')));
});

t('catches a bad check digit', () => {
  const good = '1M8GDM9AXKP042788';
  const bad = good.slice(0, 8) + '5' + good.slice(9);
  assert.equal(validateVin(good).ok, true);
  assert.equal(validateVin(bad).ok, false);
});

t('a single transposition is caught', () => {
  // The check digit exists to catch exactly this: two adjacent chars swapped.
  const good = '1M8GDM9AXKP042788';
  const swapped = good.slice(0, 12) + good[13] + good[12] + good.slice(14);
  assert.equal(validateVin(swapped).ok, false);
});

t('decodes structure of a check-valid BrightDrop-pattern VIN', () => {
  const base = '2G58J3T60R1000001';
  const vin = base.slice(0, 8) + computeCheckDigit(base) + base.slice(9);
  const d = decodeVin(vin);
  assert.equal(d.structural.wmi, '2G5');
  assert.equal(d.structural.manufacturer, 'General Motors (CAMI Assembly)');
  assert.equal(d.structural.isKnownBrightDropWmi, true);
  assert.equal(d.structural.modelYear, 2024);
  assert.equal(d.structural.checkDigitValid, true);
  assert.equal(d.structural.vds, '8J3T6');
  assert.equal(d.config, null, 'no pattern table supplied, so no config');
  assert.equal(d.confidence, 'unknown');
});

t('flags a valid non-BrightDrop VIN as not a BrightDrop', () => {
  const d = decodeVin('1M8GDM9AXKP042788');
  assert.equal(d.structural.checkDigitValid, true);
  assert.equal(d.structural.isKnownBrightDropWmi, false);
});

t('applies a matching VDS pattern from the table', () => {
  const base = '2G58J3T60R1000001';
  const vin = base.slice(0, 8) + computeCheckDigit(base) + base.slice(9);
  const patterns = [{
    vds: '8J3T6',
    confidence: 'confirmed',
    sampleCount: 3,
    config: { model: 'Zevo 600', drivetrain: 'AWD', battery: 'ETJ', gvwr: '11,000 lb' },
  }];
  const d = decodeVin(vin, patterns);
  assert.equal(d.config.battery, 'ETJ');
  assert.equal(d.sampleCount, 3);
  assert.equal(d.confidence, 'confirmed');
});

t('every model year code maps to a distinct year', () => {
  const years = ['N', 'P', 'R', 'S', 'T'].map((c) => {
    const base = `2G58J3T60${c}1000001`;
    return decodeVin(base.slice(0, 8) + computeCheckDigit(base) + base.slice(9)).structural.modelYear;
  });
  assert.deepEqual(years, [2022, 2023, 2024, 2025, 2026]);
});


// Real VINs, each backed by a GM window sticker.
const REAL = [
  ['2G58J3T60S9106255', 'FWD · Standard Range', '11,000 lb', 'BrightDrop 600'],
  ['2G58J3TYXS9106586', 'AWD · Standard Range', '11,000 lb', 'BrightDrop 600'],
  ['2G5ZJ3TY3S9100388', 'AWD · Standard Range', '9,990 lb',  'BrightDrop 600'],
  ['2G5ZJ3T60S9104168', 'FWD · Standard Range', '9,990 lb',  'BrightDrop 600'],
  ['2G58J2TZ7S9102966', 'AWD · Max Range',      '11,000 lb', 'BrightDrop 400'],
];

t('all four real VINs pass check-digit validation', () => {
  for (const [vin] of REAL) assert.equal(validateVin(vin).ok, true, `${vin} should validate`);
});

t('positional decode matches every confirmed van', () => {
  for (const [vin, powertrain, gvwr, model] of REAL) {
    const p = decodeVin(vin).positional;
    assert.equal(p.powertrain.value, powertrain, `${vin} powertrain`);
    assert.equal(p.gvwr.value, gvwr, `${vin} GVWR`);
    assert.equal(p.model.value, model, `${vin} model`);
  }
});

t('the battery IS derivable from position 8', () => {
  // Standard and Max Range differ only at position 8.
  const max = decodeVin('2G58J2TZ7S9102966').positional;
  const std = decodeVin('2G58J3TYXS9106586').positional;
  assert.match(max.powertrain.value, /Max Range/);
  assert.match(std.powertrain.value, /Standard Range/);
  assert.equal(max.powertrain.code, 'Z');
  assert.equal(std.powertrain.code, 'Y');
});

t('search pattern skips position 4 so it spans both GVWR classes', () => {
  const pat = searchPattern({ model: '600', powertrain: 'Z' });
  assert.equal(pat, 'J3TZ');
  assert.equal(searchPattern({ model: '400', powertrain: 'Z' }), 'J2TZ');
  // Both confirmed 600s must match a position-4-agnostic pattern.
  for (const vin of ['2G58J3TYXS9106586', '2G5ZJ3TY3S9100388']) {
    assert.ok(vin.includes(searchPattern({ model: '600', powertrain: 'Y' })), vin);
  }
});

t('every positional field is now confirmed', () => {
  const p = decodeVin(REAL[0][0]).positional;
  for (const f of Object.values(p)) assert.equal(f.confidence, 'confirmed', f.label);
});

t('an unseen VDS code decodes as unknown rather than guessing', () => {
  const base = '2G5WJ3T60S9104168';
  const vin = base.slice(0, 8) + computeCheckDigit(base) + base.slice(9);
  const p = decodeVin(vin).positional;
  assert.equal(p.gvwr.value, null);
  assert.equal(p.gvwr.confidence, 'unknown');
  assert.match(p.powertrain.value, /FWD/, 'other positions still decode');
});

t('window sticker URL carries the VIN', () => {
  assert.ok(windowStickerUrl('2g5-zj3ty3s9100388').includes('vin=2G5ZJ3TY3S9100388'));
  assert.ok(!windowStickerUrl('2G5ZJ3TY3S9100388').includes('postalCode'));
});

t('no sticker URL offered for a non-BrightDrop VIN', () => {
  assert.equal(decodeVin('1M8GDM9AXKP042788').stickerUrl, null);
});


// --- vPIC parsing. Strings below are verbatim vPIC responses for real VINs. ---

t('parses the AWD powertrain string', () => {
  const p = parsePowertrain('XRJ + ETC', 'EAWD - 2-MOTOR SYSTEM + 12 MOD');
  assert.equal(p.motorCode, 'XRJ');
  assert.equal(p.motor.drivetrain, 'AWD');
  assert.equal(p.motor.motors, 2);
  assert.equal(p.batteryCode, 'ETC');
  assert.equal(p.battery.name, 'Standard Range');
  assert.equal(p.modules, 12);
});

t('parses the FWD powertrain string', () => {
  const p = parsePowertrain('XRM + ETC', 'EFWD - 1-MOTOR SYSTEM + 12 MOD');
  assert.equal(p.motor.drivetrain, 'FWD');
  assert.equal(p.motor.motors, 1);
  assert.equal(p.modules, 12);
});

t('recognises a Max Range pack', () => {
  const p = parsePowertrain('XRJ + ETJ', 'EAWD - 2-MOTOR SYSTEM + 20 MOD', { modelYear: 2025, series: '400', driveType: 'AWD' });
  assert.equal(p.batteryCode, 'ETJ');
  assert.equal(p.battery.name, 'Max Range');
  assert.equal(p.battery.rangeMi, 272);
  assert.equal(p.modules, 20);
});

// 2026 rows drop the spaces and hyphenate the module count. Verbatim from 2GC8J2TZXT9100025.
t('parses the 2026 vPIC format', () => {
  const p = parsePowertrain('XRJ+ETJ', 'EAWD, 2-MOTOR SYSTEM, 20-MOD', { modelYear: 2026, series: '400', driveType: 'AWD' });
  assert.equal(p.batteryCode, 'ETJ');
  assert.equal(p.modules, 20);
  assert.equal(p.battery.rangeMi, 285);
});

t('knows the 2026 Extended Range pack', () => {
  const p = parsePowertrain('XRM+EWU', 'EFWD, 1-MOTOR SYSTEM, 14-MOD', { modelYear: 2026, series: '600', driveType: 'FWD' });
  assert.equal(p.battery.name, 'Extended Range');
  assert.equal(p.battery.rangeMi, 204);
  assert.equal(p.modules, 14);
});

t('range follows the model year, and series or drive where GM split it', () => {
  assert.equal(estimatedRange('ETC', { modelYear: 2024, series: '400' }), 159);
  assert.equal(estimatedRange('ETC', { modelYear: 2024, series: '600' }), 164);
  assert.equal(estimatedRange('ETC', { modelYear: 2025, driveType: 'FWD' }), 177);
  assert.equal(estimatedRange('ETC', { modelYear: 2025, driveType: 'AWD' }), 179);
  assert.equal(estimatedRange('ETC', { modelYear: 2026 }), 176);
  assert.equal(estimatedRange('ETJ', { modelYear: 2024 }), 272);
  assert.equal(estimatedRange('ETJ', { modelYear: 2026 }), 285);
  assert.equal(estimatedRange('EWU', { modelYear: 2025 }), null, 'not offered before 2026');
  assert.equal(estimatedRange('ETJ', { modelYear: 2023 }), 272, 'earlier years clamp to the first known');
  assert.equal(estimatedRange('ETJ', { modelYear: 2030 }), 285, 'later years clamp to the last known');
  assert.equal(estimatedRange('ETC', { modelYear: 2025 }), 177, 'unknown drive falls back to the lower figure');
});

t('tells BrightDrop rows from other Chevrolet trucks', () => {
  assert.ok(isBrightDropRow({ Make: 'BRIGHTDROP', Model: 'Zevo' }));
  assert.ok(isBrightDropRow({ Make: 'CHEVROLET', Model: 'BrightDrop' }));
  assert.ok(!isBrightDropRow({ Make: 'CHEVROLET', Model: 'Silverado' }));
});

t('one display-name rule across vPIC naming eras', () => {
  assert.deepEqual(vehicleName({ Make: 'BRIGHTDROP', Model: 'Zevo', Series: '600' }), { make: 'BrightDrop', name: 'Zevo 600' });
  assert.deepEqual(vehicleName({ Make: 'CHEVROLET', Model: 'BrightDrop', Series: '400' }), { make: 'Chevrolet', name: 'BrightDrop 400' });
  assert.deepEqual(vehicleName({}), { make: null, name: null });
});

t('accepts the 2026 2GC manufacturer code', () => {
  const d = decodeVin('2GC8J2TZXT9100025');
  assert.ok(d.ok);
  assert.equal(d.structural.isKnownBrightDropWmi, true);
  assert.equal(d.structural.modelYear, 2026);
  assert.equal(d.positional.model.value, 'BrightDrop 400');
  assert.match(d.positional.powertrain.value, /Max Range/);
});

t('unknown powertrain codes degrade to null, never a guess', () => {
  const p = parsePowertrain('ZZZ + QQQ', 'something unparseable');
  assert.equal(p.motor, null);
  assert.equal(p.battery, null);
  assert.equal(p.modules, null);
});

const vpicRow = {
  Make: 'CHEVROLET', Model: 'BrightDrop', Series: '600', BodyClass: 'Step Van/Walk-in Van',
  DriveType: 'AWD/All-Wheel Drive', EVDriveUnit: 'Dual Motor', EngineModel: 'XRJ + ETC',
  OtherEngineInfo: 'EAWD - 2-MOTOR SYSTEM + 12 MOD',
  GVWR: 'Class 2H: 9,001 - 10,000 lb (4,082 - 4,536 kg)',
  PlantCity: 'INGERSOLL', PlantState: 'ONTARIO', PlantCountry: 'CANADA',
  ModelYear: '2025', ErrorCode: '0', ErrorText: '0 - VIN decoded clean',
};
const fakeFetch = (row = vpicRow) => async () => ({ ok: true, json: async () => ({ Results: [row] }) });

await (async () => {
  const r = await lookupVin('2G5ZJ3TY3S9100388', [], { fetchImpl: fakeFetch() });
  t('lookup merges vPIC into the local decode', () => {
    assert.equal(r.vpic.series, '600');
    assert.equal(r.vpic.batteryCode, 'ETC');
    assert.equal(r.vpic.modules, 12);
    assert.equal(r.vpicError, null);
  });
  t('no drift between the positional table and vPIC on a known VIN', () => {
    assert.deepEqual(r.drift, []);
  });

  const wrong = await lookupVin('2G5ZJ3TY3S9100388', [], {
    fetchImpl: fakeFetch({ ...vpicRow, DriveType: 'FWD/Front-Wheel Drive' }),
  });
  t('drift is reported when vPIC disagrees on drivetrain', () => {
    assert.equal(wrong.drift.length, 1);
    assert.match(wrong.drift[0], /positional decode says AWD/);
  });

  const wrongBattery = await lookupVin('2G5ZJ3TY3S9100388', [], {
    fetchImpl: fakeFetch({ ...vpicRow, EngineModel: 'XRJ + ETJ', OtherEngineInfo: 'EAWD - 2-MOTOR SYSTEM + 20 MOD' }),
  });
  t('drift is reported when vPIC disagrees on battery', () => {
    assert.ok(wrongBattery.drift.some((d) => /says ETC, vPIC says ETJ/.test(d)), wrongBattery.drift.join('; '));
  });

  const wrongSeries = await lookupVin('2G5ZJ3TY3S9100388', [], {
    fetchImpl: fakeFetch({ ...vpicRow, Series: '400' }),
  });
  t('drift is reported when vPIC disagrees on model', () => {
    assert.ok(wrongSeries.drift.some((d) => /series 400/.test(d)), wrongSeries.drift.join('; '));
  });

  const offline = await lookupVin('2G5ZJ3TY3S9100388', [], {
    fetchImpl: async () => { throw new Error('network down'); },
  });
  t('network failure leaves the offline decode intact', () => {
    assert.equal(offline.vpic, null);
    assert.equal(offline.vpicError, 'network down');
    assert.match(offline.positional.powertrain.value, /AWD/);
    assert.equal(offline.structural.modelYear, 2025);
  });
})();

console.log(`\n${pass} tests passed`);
