'use strict';

// Binance USDT-M perpetual history with an on-disk cache. Only closed bars are
// stored; each run fetches just the bars and funding events added since the last.
const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = 'https://fapi.binance.com';
const CACHE_DIR = path.join(__dirname, '.cache');
const INTERVAL_MS = Object.freeze({ '1h': 3_600_000, '4h': 14_400_000 });
// First full month of BTCUSDT perpetual trading.
const HISTORY_START = Date.UTC(2019, 9, 1);

async function getJson(url, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      if (attempt >= attempts) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
      continue;
    }
    if (res.ok) return res.json();
    if (attempt >= attempts || (res.status !== 429 && res.status < 500)) {
      throw new Error(`GET ${url} failed: HTTP ${res.status}`);
    }
    await new Promise(r => setTimeout(r, 2000 * attempt));
  }
}

function readCache(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, name), 'utf8'));
  } catch {
    return [];
  }
}

function writeCache(name, rows) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, name), JSON.stringify(rows));
}

async function loadKlines({ symbol = 'BTCUSDT', interval = '1h', now = Date.now() } = {}) {
  const step = INTERVAL_MS[interval];
  if (!step) throw new Error(`Unsupported interval: ${interval}`);
  const name = `${symbol}-${interval}.json`;
  const bars = readCache(name);
  const endTime = Math.floor(now / step) * step; // open time of the still-forming bar
  let cursor = bars.length ? bars.at(-1).openTime + step : HISTORY_START;

  while (cursor < endTime) {
    const rows = await getJson(`${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${interval}`
      + `&startTime=${cursor}&endTime=${endTime - 1}&limit=1500`);
    if (!rows.length) break;
    for (const r of rows) {
      if (r[0] >= endTime) break;
      bars.push({ openTime: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });
    }
    cursor = rows.at(-1)[0] + step;
  }
  writeCache(name, bars);
  return bars;
}

async function loadFunding({ symbol = 'BTCUSDT', now = Date.now() } = {}) {
  const name = `${symbol}-funding.json`;
  const events = readCache(name);
  let cursor = events.length ? events.at(-1).time + 1 : HISTORY_START;

  while (cursor < now) {
    const rows = await getJson(`${BASE_URL}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&limit=1000`);
    if (!rows.length) break;
    for (const r of rows) events.push({ time: r.fundingTime, rate: +r.fundingRate });
    cursor = rows.at(-1).fundingTime + 1;
    if (rows.length < 1000) break;
  }
  writeCache(name, events);
  return events;
}

module.exports = { loadKlines, loadFunding, INTERVAL_MS, HISTORY_START };
