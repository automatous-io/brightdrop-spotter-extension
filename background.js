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

// Service worker. This is the only place that talks to the network, and the
// only place that imports the decoder, so the content script stays a thin DOM
// layer and there is exactly one source of truth for VIN logic.

import { decodeVinsBatch, decodeVin, validateVin, normalizeVin, windowStickerUrl, hasWindowSticker, BATTERY_RPO, estimatedRange } from './vin.js';
import { readSticker } from './sticker.js';

const CACHE_KEY = 'vinCache';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;   // vehicle build data never changes

const RECENT_KEY = 'recentLookups';
const RECENT_MAX = 20;

const STICKER_KEY = 'stickerCache';
const STICKER_TTL_MS = CACHE_TTL_MS;   // a build sheet never changes either

// Writes to one storage key are chained so concurrent frames cannot overwrite each other's
// entries with a stale copy. Expired entries are dropped on every write, so the stores stay bounded.
const writeQueues = new Map();
function withStore(key, ttl, mutate) {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const { [key]: store = {} } = await chrome.storage.local.get(key);
    const now = Date.now();
    for (const k of Object.keys(store)) if (now - (store[k]?.at ?? 0) >= ttl) delete store[k];
    mutate(store, now);
    await chrome.storage.local.set({ [key]: store });
  });
  writeQueues.set(key, next);
  return next;
}

async function readCache() {
  const { [CACHE_KEY]: cache = {} } = await chrome.storage.local.get(CACHE_KEY);
  return cache;
}

const writeCache = (entries) => withStore(CACHE_KEY, CACHE_TTL_MS, (cache, now) => {
  for (const [vin, data] of entries) cache[vin] = { at: now, data };
});

/**
 * Window sticker for one VIN, on explicit request only. Fetched from GM once,
 * then served from the cache. Never called for a whole page.
 */
async function sticker(vin) {
  const { [STICKER_KEY]: cache = {} } = await chrome.storage.local.get(STICKER_KEY);
  const hit = cache[vin];
  if (hit && Date.now() - hit.at < STICKER_TTL_MS) return hit.data;

  const year = decodeVin(vin).structural?.modelYear;
  if (!hasWindowSticker(year)) throw new Error(`GM has no window stickers for ${year} vans. They were sold by BrightDrop before it became a Chevrolet model.`);
  const res = await fetch(windowStickerUrl(vin), { credentials: 'omit' });
  if (!res.ok) throw new Error(`GM returned HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  // GM answers 200 with a small JSON body when it has no sticker. 2023 vans were sold by
  // BrightDrop directly, before the Chevrolet era, and none of them have one.
  if (buf.byteLength < 4096) {
    const head = new TextDecoder().decode(buf.slice(0, 512)).trim();
    if (head.startsWith('{')) {
      let msg = 'GM has no window sticker for this VIN.';
      try { msg = JSON.parse(head).errorMessage || msg; } catch { /* keep default */ }
      throw new Error(msg);
    }
  }
  const data = await readSticker(buf);
  await withStore(STICKER_KEY, STICKER_TTL_MS, (store, now) => { store[vin] = { at: now, data }; });
  return data;
}

/** Remember a VIN the user looked up by hand, newest first, deduplicated. */
async function rememberLookup(vin, data, page = null) {
  const { [RECENT_KEY]: recent = [] } = await chrome.storage.local.get(RECENT_KEY);
  const prior = recent.find((r) => r.vin === vin);
  const entry = {
    vin,
    at: Date.now(),
    pack: data.battery?.name ?? null,
    year: data.modelYear ?? prior?.year ?? null,
    series: data.name ?? data.series ?? null,
    drive: data.driveType ?? data.motor?.drivetrain ?? null,
    // The listing page a bookmark was made from. A popup lookup keeps whatever was saved before.
    url: page?.url ?? prior?.url ?? null,
    title: page?.title ?? prior?.title ?? null,
  };
  const next = [entry, ...recent.filter((r) => r.vin !== vin)].slice(0, RECENT_MAX);
  await chrome.storage.local.set({ [RECENT_KEY]: next });
}

/** Handlers receive VINs from pages and the popup; key everything by the normalised form. */
const vinOf = (msg) => normalizeVin(String(msg?.vin ?? ''));

/** Cached lookup. Decodes and confirmed non-BrightDrops are cached; transient failures retry later. */
async function lookup(vins) {
  const cache = await readCache();
  const now = Date.now();
  const results = new Map();
  const misses = [];

  for (const vin of vins) {
    const hit = cache[vin];
    if (hit && now - hit.at < CACHE_TTL_MS) {
      // Entries cached before stickerUrl existed on records: derive it the same way the decoder does.
      if (hit.data?.ok && hit.data.stickerUrl === undefined) hit.data.stickerUrl = hasWindowSticker(hit.data.modelYear) ? windowStickerUrl(vin) : null;
      results.set(vin, hit.data);
    }
    else misses.push(vin);
  }

  if (misses.length) {
    const fresh = await decodeVinsBatch(misses);
    const keep = [];
    for (const [vin, data] of fresh) {
      results.set(vin, data);
      if (data.ok || data.skip) keep.push([vin, data]);
    }
    if (keep.length) await writeCache(keep);
  }
  return results;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'decode') {
    lookup(msg.vins ?? [])
      .then((map) => sendResponse({ ok: true, results: Object.fromEntries(map) }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;   // keep the message channel open for the async reply
  }
  if (msg?.type === 'decodeOne') {
    const vin = vinOf(msg);
    const check = validateVin(vin);
    if (!check.ok) { sendResponse({ ok: false, error: check.errors[0], local: null }); return false; }
    lookup([check.vin])
      .then(async (map) => {
        const result = map.get(check.vin) ?? null;
        if (result?.ok) await rememberLookup(check.vin, result);
        sendResponse({
          ok: true,
          result,
          local: decodeVin(check.vin).positional,
          stickerUrl: result?.stickerUrl ?? null,
          packs: BATTERY_RPO,
          // Every pack's range for this exact van, so the UI can say what the alternative would do.
          ranges: Object.fromEntries(Object.keys(BATTERY_RPO).map((code) => [code, estimatedRange(code, result ?? {})])),
        });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg?.type === 'sticker') {
    const check = validateVin(String(msg.vin ?? ''));
    if (!check.ok) { sendResponse({ ok: false, error: check.errors[0] }); return false; }
    sticker(check.vin)
      .then((data) => sendResponse({ ok: true, sticker: data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg?.type === 'remember') {
    // Save a badged van to the popup's recent list. Data comes from our own cache, not the page.
    const vin = vinOf(msg);
    lookup([vin])
      .then(async (map) => {
        const data = map.get(vin);
        if (!data?.ok) { sendResponse({ ok: false, error: 'No decoded record to save.' }); return; }
        const page = msg.page && /^https?:/i.test(msg.page.url ?? '') ? { url: String(msg.page.url).slice(0, 2000), title: String(msg.page.title ?? '').slice(0, 200) } : null;
        await rememberLookup(vin, data, page);
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg?.type === 'forget') {
    const vin = vinOf(msg);
    chrome.storage.local.get(RECENT_KEY)
      .then(({ [RECENT_KEY]: recent = [] }) => chrome.storage.local.set({ [RECENT_KEY]: recent.filter((r) => r.vin !== vin) }))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg?.type === 'isRecent') {
    chrome.storage.local.get(RECENT_KEY)
      .then(({ [RECENT_KEY]: recent = [] }) => {
        const hit = recent.find((r) => r.vin === vinOf(msg));
        sendResponse({ ok: true, saved: Boolean(hit), url: hit?.url ?? null, title: hit?.title ?? null });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg?.type === 'recent') {
    chrome.storage.local.get(RECENT_KEY)
      .then(({ [RECENT_KEY]: recent = [] }) => sendResponse({ ok: true, recent }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg?.type === 'clearRecent') {
    chrome.storage.local.remove(RECENT_KEY)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});
