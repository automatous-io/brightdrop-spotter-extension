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

// BrightDrop VIN decoder.
//
// Two sources, cross-checked against each other:
//   - NHTSA's vPIC API, which returns the series, drivetrain, motor and battery
//     RPO codes for real BrightDrop VINs. This is the authority.
//   - A positional table for positions 4-8, built from confirmed window
//     stickers, so the decoder still works offline and can flag vPIC drift.

export const TRANSLITERATION = {
  A:1, B:2, C:3, D:4, E:5, F:6, G:7, H:8,
  J:1, K:2, L:3, M:4, N:5, P:7, R:9,
  S:2, T:3, U:4, V:5, W:6, X:7, Y:8, Z:9,
  0:0, 1:1, 2:2, 3:3, 4:4, 5:5, 6:6, 7:7, 8:8, 9:9,
};

export const CHECK_DIGIT_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

// Position 10. GM skips I, O, Q, U and Z.
export const MODEL_YEAR_CODES = {
  N: 2022, P: 2023, R: 2024, S: 2025, T: 2026, V: 2027, W: 2028,
};

// Positions 1-3. 2G5 through model year 2025; 2GC from 2026, when BrightDrop
// became a Chevrolet model. 2GC is also every Chevrolet truck, so a 2GC VIN is
// only a BrightDrop once vPIC says so (see isBrightDropRow). vPIC's stale CAMI
// registrations 2C0 and 2CC are not used.
export const KNOWN_WMIS = {
  '2G5': { manufacturer: 'General Motors (CAMI Assembly)', country: 'Canada', vehicleType: 'Truck', plant: 'Ingersoll, Ontario' },
  '2GC': { manufacturer: 'General Motors (Chevrolet Truck)', country: 'Canada', vehicleType: 'Truck', plant: 'Ingersoll, Ontario' },
};

/** vPIC row -> is this actually a BrightDrop? 2024 rows say Make BRIGHTDROP / Model Zevo; 2025+ say CHEVROLET / BrightDrop. */
export function isBrightDropRow(r) {
  return /brightdrop/i.test(`${r?.Make ?? ''} ${r?.Model ?? ''}`) || /^zevo$/i.test(r?.Model ?? '');
}

const brandCase = (s) => (/^brightdrop$/i.test(s) ? 'BrightDrop' : String(s).charAt(0).toUpperCase() + String(s).slice(1).toLowerCase());

/**
 * Display name from a vPIC row. Make and model casing and naming differ by year:
 * 2024 is "BRIGHTDROP" / "Zevo" / "600", 2025+ is "CHEVROLET" / "BrightDrop" / "400".
 * -> make "BrightDrop", name "Zevo 600"; make "Chevrolet", name "BrightDrop 400".
 */
export function vehicleName(r) {
  const make = r?.Make ? brandCase(r.Make) : null;
  const model = r?.Model ? brandCase(r.Model) : null;
  const name = [model, r?.Series].filter(Boolean).join(' ') || null;
  return { make, name };
}

// Positions 4-8, from confirmed window stickers and vPIC. `samples` counts
// distinct builds backing each value, not VINs seen.
export const VDS_POSITIONS = {
  // Position 4: GVWR class.
  gvwr: {
    index: 3,
    label: 'GVWR class',
    confidence: 'confirmed',
    values: {
      '8': { value: '11,000 lb', samples: 3, detail: 'NHTSA Class 3' },
      'Z': { value: '9,990 lb', samples: 2, detail: 'NHTSA Class 2H' },
    },
  },
  // Position 6: model.
  model: {
    index: 5,
    label: 'Model',
    confidence: 'confirmed',
    values: {
      '2': { value: 'BrightDrop 400', samples: 2, detail: 'about 412 cu ft' },
      '3': { value: 'BrightDrop 600', samples: 4, detail: 'about 615 cu ft' },
    },
  },
  // Position 8: motor system and battery pack together.
  powertrain: {
    index: 7,
    label: 'Powertrain',
    confidence: 'confirmed',
    values: {
      '6': { value: 'FWD · Standard Range', samples: 2, detail: 'XRM + ETC, 1 motor, 240 hp, 12 modules' },
      'Y': { value: 'AWD · Standard Range', samples: 5, detail: 'XRJ + ETC, 2 motors, 300 hp, 12 modules' },
      'Z': { value: 'AWD · Max Range', samples: 3, detail: 'XRJ + ETJ, 2 motors, 300 hp, 20 modules' },
      // No FWD Max Range code exists: GM offers ETJ with AWD only (2025 and 2026 order guides).
    },
  },
};

/**
 * VIN substring that finds a given build in an inventory search box.
 * Positions 5-8 only: including position 4 would pin the GVWR class and hide
 * half the matching vans.
 */
export function searchPattern({ model = '600', powertrain = 'Z' } = {}) {
  const modelDigit = String(model).startsWith('4') ? '2' : '3';
  return `J${modelDigit}T${powertrain}`;
}

/**
 * GM serves the window sticker by VIN alone. Undocumented endpoint: open it as
 * a link, or fetch it for one van at a time on the user's request. Never sweep.
 */
export function windowStickerUrl(vin) {
  return `https://cws.gm.com/vs-cws/vehshop/v2/vehicle/windowsticker?vin=${normalizeVin(vin)}&make=chevrolet`;
}

/** Decode positions 4-8 against VDS_POSITIONS. */
export function decodeVds(vin) {
  const out = {};
  for (const [key, spec] of Object.entries(VDS_POSITIONS)) {
    const chunk = vin.substr(spec.index, spec.length ?? 1);
    const hit = spec.values[chunk];
    out[key] = {
      label: spec.label,
      code: chunk,
      value: hit ? hit.value : null,
      detail: hit?.detail ?? null,
      confidence: hit ? spec.confidence : 'unknown',
      samples: hit ? hit.samples : 0,
    };
  }
  return out;
}

export class VinError extends Error {}

/** Normalise user input: strip whitespace and hyphens, uppercase. */
export function normalizeVin(raw) {
  return String(raw ?? '').replace(/[\s-]/g, '').toUpperCase();
}

/** ISO 3779 check digit. Returns '0'-'9' or 'X'. */
export function computeCheckDigit(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const value = TRANSLITERATION[vin[i]];
    if (value === undefined) {
      throw new VinError(`Character "${vin[i]}" at position ${i + 1} is not valid in a VIN.`);
    }
    sum += value * CHECK_DIGIT_WEIGHTS[i];
  }
  const remainder = sum % 11;
  return remainder === 10 ? 'X' : String(remainder);
}

/** Structural validation. Returns every problem at once rather than throwing on the first. */
export function validateVin(raw) {
  const vin = normalizeVin(raw);
  const errors = [];

  if (vin.length !== 17) {
    errors.push(`A VIN is 17 characters. This one is ${vin.length}.`);
    return { ok: false, vin, errors };
  }
  // I, O and Q are excluded from VINs so they cannot be confused with 1 and 0.
  const illegal = [...vin].map((c, i) => ({ c, i })).filter(({ c }) => 'IOQ'.includes(c));
  for (const { c, i } of illegal) {
    errors.push(`"${c}" at position ${i + 1} is never used in a VIN (it looks too much like ${c === 'O' || c === 'Q' ? '0' : '1'}).`);
  }
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    errors.push('VIN contains characters that are not letters or digits.');
    return { ok: false, vin, errors };
  }
  if (illegal.length) return { ok: false, vin, errors };

  const expected = computeCheckDigit(vin);
  if (vin[8] !== expected) {
    errors.push(`Check digit mismatch: position 9 is "${vin[8]}" but the other 16 characters compute to "${expected}". This VIN was probably mistyped.`);
  }
  return { ok: errors.length === 0, vin, errors };
}

/**
 * Everything derivable from the VIN string itself, plus an exact match from
 * `patterns` ({ vds, config, confidence, sampleCount }) when one is supplied.
 */
export function decodeVin(raw, patterns = []) {
  const { ok, vin, errors } = validateVin(raw);
  if (vin.length !== 17 || /[IOQ]/.test(vin) || !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return { ok: false, vin, errors, structural: null, config: null, confidence: 'none' };
  }

  const wmi = vin.slice(0, 3);
  const vds = vin.slice(3, 8);

  const structural = {
    wmi,
    vds,
    checkDigit: vin[8],
    checkDigitValid: vin[8] === computeCheckDigit(vin),
    modelYearCode: vin[9],
    modelYear: MODEL_YEAR_CODES[vin[9]] ?? null,
    plantCode: vin[10],
    sequential: vin.slice(11),
    ...(KNOWN_WMIS[wmi] ?? { manufacturer: null, country: null, vehicleType: null }),
    isKnownBrightDropWmi: Boolean(KNOWN_WMIS[wmi]),
  };

  const positional = structural.isKnownBrightDropWmi ? decodeVds(vin) : null;
  const match = patterns.find((p) => p.vds === vds);

  return {
    ok,
    vin,
    errors,
    structural,
    positional,
    stickerUrl: structural.isKnownBrightDropWmi ? windowStickerUrl(vin) : null,
    config: match ? match.config : null,
    confidence: match ? match.confidence : 'unknown',
    sampleCount: match ? match.sampleCount : 0,
  };
}

// ---------------------------------------------------------------------------
// NHTSA vPIC lookup. No key, permissive CORS, no published rate limit.
// ---------------------------------------------------------------------------

const VPIC = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues';

// Usable kWh from GM's 2025 and 2026 order guides. Module counts as vPIC
// reports them; EWU's is not published, so vPIC supplies it.
export const BATTERY_RPO = {
  ETC: { name: 'Standard Range', modules: 12, kWh: 102.4 },
  EWU: { name: 'Extended Range', modules: null, kWh: 121 },
  ETJ: { name: 'Max Range', modules: 20, kWh: 173.3 },
};

// GM-estimated combined range in miles, by model year. GM split 2024 by series
// and 2025 by drive type; 2026 is one figure per pack. Sources: GM 2025 and
// 2026 order guides; 2024 from GM's revised figures as published June 2024.
export const RANGE_MI = {
  2024: { ETC: { 400: 159, 600: 164 }, ETJ: 272 },
  2025: { ETC: { FWD: 177, AWD: 179 }, ETJ: 272 },
  2026: { ETC: 176, EWU: 204, ETJ: 285 },
};
const RANGE_YEARS = Object.keys(RANGE_MI).map(Number);

/** Range for a pack on a given van. Years outside the table clamp to the nearest known year. */
export function estimatedRange(batteryCode, { modelYear, series, driveType } = {}) {
  if (!batteryCode || !RANGE_YEARS.length) return null;
  const year = Math.min(Math.max(modelYear ?? RANGE_YEARS.at(-1), RANGE_YEARS[0]), RANGE_YEARS.at(-1));
  const entry = RANGE_MI[year]?.[batteryCode];
  if (entry == null) return null;
  if (typeof entry === 'number') return entry;
  const key = entry[String(series)] !== undefined ? String(series) : String(driveType ?? '').toUpperCase().slice(0, 3);
  const hit = entry[key];
  if (hit !== undefined) return hit;
  const all = Object.values(entry);
  return all.length ? Math.min(...all) : null;
}

/** Motor unit codes seen in vPIC's EngineModel field. */
export const MOTOR_CODES = {
  XRM: { drivetrain: 'FWD', motors: 1, hp: 240, torqueLbFt: 300 },
  XRJ: { drivetrain: 'AWD', motors: 2, hp: 300, torqueLbFt: 390 },
};

/**
 * Parse vPIC's EngineModel and OtherEngineInfo. Formats seen:
 *   2024-25: "XRJ + ETC" / "EAWD - 2-MOTOR SYSTEM + 12 MOD"
 *   2026:    "XRJ+ETJ"   / "EAWD, 2-MOTOR SYSTEM, 20-MOD"
 * `van` ({ modelYear, series, driveType }) selects the range figure.
 */
export function parsePowertrain(engineModel = '', otherEngineInfo = '', van = {}) {
  const codes = String(engineModel).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const motorCode = codes.find((c) => MOTOR_CODES[c]) ?? null;
  const batteryCode = codes.find((c) => BATTERY_RPO[c]) ?? null;
  const modules = String(otherEngineInfo).match(/(\d+)[\s-]*MOD/i);

  return {
    motorCode,
    motor: motorCode ? MOTOR_CODES[motorCode] : null,
    batteryCode,
    battery: batteryCode ? { ...BATTERY_RPO[batteryCode], rangeMi: estimatedRange(batteryCode, van) } : null,
    modules: modules ? Number(modules[1]) : null,
  };
}

/** Local decode plus live vPIC query. Never throws on network failure; the local decode still stands. */
export async function lookupVin(raw, patterns = [], { fetchImpl = fetch } = {}) {
  const local = decodeVin(raw, patterns);
  if (!local.structural) return { ...local, vpic: null, vpicError: 'VIN is not well formed.' };

  try {
    const res = await fetchImpl(`${VPIC}/${local.vin}?format=json`);
    if (!res.ok) throw new Error(`vPIC returned HTTP ${res.status}`);
    const r = (await res.json())?.Results?.[0];
    if (!r) throw new Error('vPIC returned no result row');

    const van = { modelYear: r.ModelYear ? Number(r.ModelYear) : null, series: r.Series || null, driveType: r.DriveType ? r.DriveType.split('/')[0] : null };
    const powertrain = parsePowertrain(r.EngineModel, r.OtherEngineInfo, van);
    const vpic = {
      clean: r.ErrorCode === '0',
      isBrightDrop: isBrightDropRow(r),
      errorText: r.ErrorText ?? null,
      make: r.Make || null,
      model: r.Model || null,
      series: r.Series || null,
      bodyClass: r.BodyClass || null,
      driveType: r.DriveType || null,
      driveUnit: r.EVDriveUnit || null,
      gvwrClass: r.GVWR || null,
      plant: [r.PlantCity, r.PlantState, r.PlantCountry].filter(Boolean).join(', ') || null,
      modelYear: r.ModelYear ? Number(r.ModelYear) : null,
      ...powertrain,
    };

    // A mismatch here means the positional table needs fixing.
    const drift = [];
    const localPower = local.positional?.powertrain?.value;   // "AWD · Max Range"
    const localDrive = localPower ? localPower.split(' ')[0] : null;
    if (localDrive && vpic.driveType && !vpic.driveType.toUpperCase().startsWith(localDrive)) {
      drift.push(`positional decode says ${localDrive}, vPIC says ${vpic.driveType}`);
    }
    const localBattery = localPower?.includes('Max Range') ? 'ETJ' : localPower ? 'ETC' : null;
    if (localBattery && vpic.batteryCode && localBattery !== vpic.batteryCode) {
      drift.push(`positional decode says ${localBattery}, vPIC says ${vpic.batteryCode}`);
    }
    const localModel = local.positional?.model?.value;
    if (localModel && vpic.series && !localModel.endsWith(vpic.series)) {
      drift.push(`positional decode says ${localModel}, vPIC says series ${vpic.series}`);
    }
    if (local.structural.modelYear && vpic.modelYear && local.structural.modelYear !== vpic.modelYear) {
      drift.push(`model year ${local.structural.modelYear} vs vPIC ${vpic.modelYear}`);
    }

    return { ...local, vpic, drift, vpicError: null };
  } catch (err) {
    return { ...local, vpic: null, drift: [], vpicError: err.message };
  }
}

const VPIC_BATCH = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVINValuesBatch/';

/** vPIC's documented ceiling for one batch POST. */
export const BATCH_LIMIT = 50;

/**
 * Decode many VINs in one POST. Malformed input is rejected locally and never
 * reaches the network.
 * @returns {Promise<Map<string, object>>} keyed by normalised VIN
 */
export async function decodeVinsBatch(vins, { fetchImpl = fetch } = {}) {
  const out = new Map();
  const queued = new Set();

  for (const raw of vins) {
    const vin = normalizeVin(raw);
    if (out.has(vin) || queued.has(vin)) continue;
    const check = validateVin(vin);
    if (!check.ok) { out.set(vin, { vin, ok: false, error: check.errors[0] ?? 'invalid VIN' }); continue; }
    if (!KNOWN_WMIS[vin.slice(0, 3)]) { out.set(vin, { vin, ok: false, error: 'not a BrightDrop' }); continue; }
    queued.add(vin);
  }
  const wanted = [...queued];
  if (!wanted.length) return out;

  for (let i = 0; i < wanted.length; i += BATCH_LIMIT) {
    const chunk = wanted.slice(i, i + BATCH_LIMIT);
    try {
      const res = await fetchImpl(VPIC_BATCH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ format: 'json', data: chunk.join(';') }).toString(),
      });
      if (!res.ok) throw new Error(`vPIC returned HTTP ${res.status}`);
      const rows = (await res.json())?.Results ?? [];

      for (const r of rows) {
        const vin = normalizeVin(r.VIN);
        if (!isBrightDropRow(r)) {
          // A 2GC VIN that vPIC says is some other Chevrolet truck. Cacheable and silent.
          const what = [r.ModelYear, r.Make, r.Model].filter(Boolean).join(' ');
          out.set(vin, { vin, ok: false, skip: true, error: what ? `Not a BrightDrop. NHTSA lists it as a ${what}.` : 'Not a BrightDrop.' });
          continue;
        }
        const van = { modelYear: r.ModelYear ? Number(r.ModelYear) : null, series: r.Series || null, driveType: r.DriveType ? r.DriveType.split('/')[0] : null };
        const pt = parsePowertrain(r.EngineModel, r.OtherEngineInfo, van);
        out.set(vin, {
          vin,
          ok: r.ErrorCode === '0',
          series: van.series,
          ...vehicleName(r),
          model: [r.Make, r.Model, r.Series].filter(Boolean).join(' ') || null,
          modelYear: van.modelYear,
          driveType: van.driveType,
          gvwrClass: r.GVWR || null,
          local: decodeVin(vin).positional,
          ...pt,
        });
      }
      // vPIC drops rows it cannot parse rather than erroring, so backfill.
      for (const vin of chunk) {
        if (!out.has(vin)) out.set(vin, { vin, ok: false, error: 'vPIC returned no row' });
      }
    } catch (err) {
      for (const vin of chunk) out.set(vin, { vin, ok: false, error: err.message });
    }
  }
  return out;
}

/** Every plausible VIN in a blob of text. The check digit is what rejects random 17-character strings. */
export function extractVins(text, { brightDropOnly = true } = {}) {
  const found = new Set();
  for (const m of String(text).matchAll(/\b[A-HJ-NPR-Z0-9]{17}\b/gi)) {
    const vin = m[0].toUpperCase();
    if (!validateVin(vin).ok) continue;
    if (brightDropOnly && !KNOWN_WMIS[vin.slice(0, 3)]) continue;
    found.add(vin);
  }
  return [...found];
}
