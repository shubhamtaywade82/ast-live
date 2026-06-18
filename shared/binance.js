import { FAPI, BATCH } from "./constants.js";
import { intervalMs } from "./market.js";

export async function fetchKlines(symbol, interval, startMs, endMs, onProgress = null) {
  const stepMs = intervalMs(interval);
  const all = [];
  let cursor = startMs;
  let batch = 0;
  const maxBatches = Math.ceil((endMs - startMs) / (stepMs * BATCH)) + 1;

  while (cursor < endMs) {
    const url = `${FAPI}?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=${BATCH}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    for (const k of data) {
      all.push({
        t: k[0], open: +k[1], high: +k[2], low: +k[3],
        close: +k[4], vol: +k[5], closeTime: k[6],
      });
    }

    cursor = data[data.length - 1][6] + 1;
    batch += 1;
    if (onProgress) onProgress(Math.min(99, Math.round((batch / maxBatches) * 100)));
    if (data.length < BATCH) break;
    await new Promise(r => setTimeout(r, 80));
  }

  const seen = new Set();
  return all
    .filter(c => { if (seen.has(c.t)) return false; seen.add(c.t); return true; })
    .sort((a, b) => a.t - b.t);
}
