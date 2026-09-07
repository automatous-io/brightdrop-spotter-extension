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

import { decodeVinsBatch, decodeVin, validateVin, windowStickerUrl, BATTERY_RPO, estimatedRange } from './vin.js';
import { readSticker } from './sticker.js';

const CACHE_KEY = 'vinCache';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;   // vehicle build data never changes

const RECENT_KEY = 'recentLookups';
const RECENT_MAX = 5;

const STICKER_KEY = 'stickerCache';
const STICKER_TTL_MS = CACHE_TTL_MS;   // a build sheet never changes either

async function readCache() {
  const { [CACHE_KEY]: cache = {} } = await chrome.storage.local.get(CACHE_KEY);
  return cache;
}

async function writeCache(entries) {
  const cache = await readCache();
  const now = Date.now();
  for (const [vin, data] of entries) cache[vin] = { at: now, data };
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

/**
 * Window sticker for one VIN, on explicit request only. Fetched from GM once,
 * then served from the cache. Never called for a whole page.
 */
async function sticker(vin) {
  const { [STICKER_KEY]: cache = {} } = await chrome.storage.local.get(STICKER_KEY);
  const hit = cache[vin];
  if (hit && Date.now() - hit.at < STICKER_TTL_MS) return hit.data;

  const res = await fetch(windowStickerUrl(vin), { credentials: 'omit' });
  if (!res.ok) throw new Error(res.status === 404 ? 'GM has no sticker for this VIN.' : `GM returned HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const data = await readSticker(buf);
  cache[vin] = { at: Date.now(), data };
  await chrome.storage.local.set({ [STICKER_KEY]: cache });
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
    series: data.name ?? data.series ?? null,
    drive: data.driveType ?? data.motor?.drivetrain ?? null,
    // The listing page a bookmark was made from. A popup lookup keeps whatever was saved before.
    url: page?.url ?? prior?.url ?? null,
    title: page?.title ?? prior?.title ?? null,
  };
  const next = [entry, ...recent.filter((r) => r.vin !== vin)].slice(0, RECENT_MAX);
  await chrome.storage.local.set({ [RECENT_KEY]: next });
}

/** Cached lookup. Decodes and confirmed non-BrightDrops are cached; transient failures retry later. */
async function lookup(vins) {
  const cache = await readCache();
  const now = Date.now();
  const results = new Map();
  const misses = [];

  for (const vin of vins) {
    const hit = cache[vin];
    if (hit && now - hit.at < CACHE_TTL_MS) results.set(vin, hit.data);
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
    const vin = String(msg.vin ?? '');
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
          stickerUrl: windowStickerUrl(check.vin),
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
    const vin = String(msg.vin ?? '');
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
    const vin = String(msg.vin ?? '');
    chrome.storage.local.get(RECENT_KEY)
      .then(({ [RECENT_KEY]: recent = [] }) => chrome.storage.local.set({ [RECENT_KEY]: recent.filter((r) => r.vin !== vin) }))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg?.type === 'isRecent') {
    chrome.storage.local.get(RECENT_KEY)
      .then(({ [RECENT_KEY]: recent = [] }) => {
        const hit = recent.find((r) => r.vin === msg.vin);
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
