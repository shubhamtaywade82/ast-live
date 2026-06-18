export function atrRMA(candles, period) {
  const n = candles.length;
  const tr = new Float64Array(n);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  const out = new Float64Array(n);
  out.fill(NaN);
  let sum = 0;
  const firstValid = Math.min(period, n);
  for (let i = 0; i < firstValid; i++) sum += tr[i];
  out[firstValid - 1] = sum / firstValid;
  for (let i = firstValid; i < n; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return Array.from(out);
}

export function kaufmanER(candles, len) {
  const n = candles.length;
  const out = new Float64Array(n);
  out.fill(0);
  for (let i = len; i < n; i++) {
    const net = Math.abs(candles[i].close - candles[i - len].close);
    let path = 0;
    for (let j = i - len + 1; j <= i; j++) {
      path += Math.abs(candles[j].close - candles[j - 1].close);
    }
    out[i] = path > 0 ? net / path : 0;
  }
  return Array.from(out);
}

export function volumeWeightedER(candles, len) {
  const n = candles.length;
  const out = new Float64Array(n);
  out.fill(0);
  const volSMA = new Float64Array(n);
  volSMA.fill(NaN);
  let vSum = 0;
  for (let i = 0; i < n; i++) {
    vSum += candles[i].vol;
    if (i >= len) vSum -= candles[i - len].vol;
    if (i >= len - 1) volSMA[i] = vSum / len;
  }
  for (let i = len; i < n; i++) {
    const net = Math.abs(candles[i].close - candles[i - len].close);
    let wPath = 0;
    for (let j = i - len + 1; j <= i; j++) {
      const barMove = Math.abs(candles[j].close - candles[j - 1].close);
      const vNorm = volSMA[j] > 0 ? candles[j].vol / volSMA[j] : 1;
      wPath += barMove * Math.min(vNorm, 3);
    }
    out[i] = wPath > 0 ? net / wPath : 0;
  }
  return Array.from(out);
}

export function choppinessIndex(candles, len) {
  const n = candles.length;
  const out = new Float64Array(n);
  out.fill(NaN);
  for (let i = len; i < n; i++) {
    const c = candles[i];
    const cStart = candles[i - len];
    const range = c.high - cStart.low;
    if (range === 0) { out[i] = 50; continue; }
    let sumTR = 0;
    for (let j = i - len + 1; j <= i; j++) {
      const b = candles[j], p = candles[j - 1];
      sumTR += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    }
    const val = 100 * Math.log10(sumTR / range) / Math.log10(len);
    out[i] = Math.max(0, Math.min(100, isFinite(val) ? val : 50));
  }
  return Array.from(out);
}

export function ema(arr, period) {
  const k = 2 / (period + 1);
  const out = new Array(arr.length).fill(NaN);
  let started = false;
  let val = 0;
  for (let i = 0; i < arr.length; i++) {
    if (isNaN(arr[i])) continue;
    if (!started) { val = arr[i]; started = true; }
    else val = arr[i] * k + val * (1 - k);
    out[i] = val;
  }
  return out;
}

export function sma(arr, period) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function adaptiveST(candles, atr, factor) {
  const n = candles.length;
  const stLine = new Array(n).fill(NaN);
  const dir = new Array(n).fill(1);
  let fL = NaN, fU = NaN;
  let lastValidDir = 1;

  let startIdx = 1;
  for (; startIdx < n; startIdx++) {
    if (!isNaN(atr[startIdx]) && !isNaN(factor[startIdx])) break;
  }

  for (let i = startIdx; i < n; i++) {
    if (isNaN(atr[i]) || isNaN(factor[i])) {
      dir[i] = lastValidDir;
      stLine[i] = stLine[i - 1];
      continue;
    }
    const mid = (candles[i].high + candles[i].low) / 2;
    const bL = mid - factor[i] * atr[i];
    const bU = mid + factor[i] * atr[i];

    if (isNaN(fL) || isNaN(fU)) {
      fL = bL; fU = bU;
      dir[i] = 1; lastValidDir = 1;
      stLine[i] = fL;
      continue;
    }

    const pL = fL, pU = fU;
    fL = candles[i - 1].close > pL ? Math.max(bL, pL) : bL;
    fU = candles[i - 1].close < pU ? Math.min(bU, pU) : bU;

    const pd = lastValidDir;
    if (pd === 1 && candles[i].close < fL) { dir[i] = -1; lastValidDir = -1; }
    else if (pd === -1 && candles[i].close > fU) { dir[i] = 1; lastValidDir = 1; }
    else dir[i] = pd;

    stLine[i] = dir[i] === 1 ? fL : fU;
  }

  let firstValid = -1;
  for (let i = 0; i < n; i++) { if (!isNaN(stLine[i])) { firstValid = i; break; } }
  if (firstValid > 0) {
    for (let i = 0; i < firstValid; i++) {
      stLine[i] = stLine[firstValid];
      dir[i] = dir[firstValid];
    }
  }
  return { stLine, dir };
}

export function computeSignalQuality(candles, dir, signals) {
  const quality = [];
  for (const sig of signals) {
    let consec = 1;
    const d = sig.type === "long" ? 1 : -1;
    for (let i = sig.i + 1; i < candles.length && dir[i] === d; i++) consec++;
    const score = consec >= 20 ? 5 : consec >= 12 ? 4 : consec >= 7 ? 3 : consec >= 4 ? 2 : 1;
    quality.push({ ...sig, consec, score });
  }
  return quality;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MULTI-TIMEFRAME CONFLUENCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Align higher timeframe direction to current timeframe bar indices.
 * htfCandles should be from a higher timeframe (e.g., 4h when current is 1h).
 * Returns an array where each index corresponds to the current TF bar index,
 * containing the HTF trend direction (1 = up, -1 = down, 0 = unknown).
 */
export function alignHTFDir(currentCandles, htfCandles, htfDir) {
  const n = currentCandles.length;
  const aligned = new Array(n).fill(0);
  let htfIdx = 0;
  for (let i = 0; i < n; i++) {
    const t = currentCandles[i].t;
    // Advance htfIdx until htf candle covers current time
    while (htfIdx < htfCandles.length - 1 && htfCandles[htfIdx + 1].t <= t) {
      htfIdx++;
    }
    if (htfIdx < htfDir.length) {
      aligned[i] = htfDir[htfIdx];
    }
  }
  return aligned;
}