import { useState, useRef, useEffect, useMemo, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════════════════════
//  ADAPTIVE SUPERTRIND PRO v2.1 — Continued Enhancements
//  New in this continuation:
//    • Trailing stop + break-even logic in backtest
//    • Multi-timeframe confluence detection (higher TF trend filter)
//    • Walk-forward analysis (in-sample optimize → out-of-sample test)
//    • Monte Carlo simulation (trade shuffle robustness test)
//    • CSV export (trades + equity curve)
//    • Chart crosshair with OHLC/tooltip readout
//    • Drawdown distribution histogram
//    • ATR-based position sizing option
//    • Session/hour filtering
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Palette ──────────────────────────────────────────────────────────────────
const C = {
  bg: "#080a0e", panel: "#0d1018", panel2: "#111520",
  border: "#1a2035", border2: "#222840",
  accent: "#00d4aa", red: "#ff4757", purple: "#a855f7",
  yellow: "#fbbf24", blue: "#38bdf8", orange: "#fb923c",
  text: "#dde3f0", sub: "#5a6480", label: "#8899bb",
  grid: "#0f1420",
};

// ─── Constants ────────────────────────────────────────────────────────────────
const FAPI = "https://fapi.binance.com/fapi/v1/klines";
const BATCH = 1500;
const FEE_RT = 0.0008;
const SLIP_RT = 0.0004;
const COST_RT = FEE_RT + SLIP_RT;

const SYMBOLS = [
  "SOLUSDT", "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT",
  "NEARUSDT", "ATOMUSDT", "INJUSDT", "SUIUSDT", "WIFUSDT",
  "PEPEUSDT", "TIAUSDT", "SEIUSDT", "AAVEUSDT", "LTCUSDT",
];

const INTERVALS = [
  { label: "1m", ms: 60e3 }, { label: "3m", ms: 3 * 60e3 }, { label: "5m", ms: 5 * 60e3 },
  { label: "15m", ms: 15 * 60e3 }, { label: "30m", ms: 30 * 60e3 },
  { label: "1h", ms: 3600e3 }, { label: "2h", ms: 2 * 3600e3 }, { label: "4h", ms: 4 * 3600e3 },
  { label: "6h", ms: 6 * 3600e3 }, { label: "12h", ms: 12 * 3600e3 },
  { label: "1d", ms: 86400e3 }, { label: "3d", ms: 3 * 86400e3 },
  { label: "1w", ms: 7 * 86400e3 }, { label: "1M", ms: 30 * 86400e3 },
];

const PRESETS = [
  { label: "1D", days: 1 }, { label: "3D", days: 3 }, { label: "1W", days: 7 },
  { label: "2W", days: 14 }, { label: "1M", days: 30 }, { label: "3M", days: 90 },
  { label: "6M", days: 180 }, { label: "1Y", days: 365 },
];

const HTF_INTERVALS = [
  { label: "None", mult: 0 },
  { label: "4x", mult: 4 },
  { label: "6x", mult: 6 },
  { label: "12x", mult: 12 },
  { label: "24x", mult: 24 },
];

// ─── Binance FAPI Fetcher (paginated) ─────────────────────────────────────────
async function fetchKlines(symbol, interval, startMs, endMs, onProgress) {
  const intervalMs = INTERVALS.find(i => i.label === interval)?.ms ?? 3600e3;
  const all = [];
  let cursor = startMs;
  let batch = 0;
  const maxBatches = Math.ceil((endMs - startMs) / (intervalMs * BATCH)) + 1;

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

    const last = data[data.length - 1];
    cursor = last[6] + 1;
    batch++;
    if (onProgress) onProgress(Math.min(99, Math.round((batch / maxBatches) * 100)));
    if (data.length < BATCH) break;
    await new Promise(r => setTimeout(r, 80));
  }

  const seen = new Set();
  return all.filter(c => { if (seen.has(c.t)) return false; seen.add(c.t); return true; })
    .sort((a, b) => a.t - b.t);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CORE ENGINE (from v2.0 — preserved + enhanced)
// ═══════════════════════════════════════════════════════════════════════════════

function atrRMA(candles, period) {
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

function kaufmanER(candles, len) {
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

function volumeWeightedER(candles, len) {
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

function choppinessIndex(candles, len) {
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

function ema(arr, period) {
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

function sma(arr, period) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function adaptiveST(candles, atr, factor) {
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

function computeSignalQuality(candles, dir, signals) {
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
function alignHTFDir(currentCandles, htfCandles, htfDir) {
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

// ═══════════════════════════════════════════════════════════════════════════════
//  ENHANCED BACKTEST ENGINE — with trailing stop, break-even, session filter
// ═══════════════════════════════════════════════════════════════════════════════

function runBacktest(candles, p, htfAlignedDir = null) {
  const n = candles.length;

  // ── Technical Indicators ──
  const atr = atrRMA(candles, p.atrPeriod);
  const er = p.useVWER ? volumeWeightedER(candles, p.erLength) : kaufmanER(candles, p.erLength);
  const rawF = er.map(e => p.maxFactor - e * (p.maxFactor - p.minFactor));
  const smoothF = ema(rawF, p.smoothLength);
  const ci = p.useRegimeFilter ? choppinessIndex(candles, p.erLength) : null;
  const { stLine, dir } = adaptiveST(candles, atr, smoothF);

  // Session filter: get hour of each candle
  const hours = candles.map(c => new Date(c.t).getUTCHours());

  // ── Signal Detection — O(n) ──
  const sigMap = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    if (dir[i] !== dir[i - 1]) {
      sigMap[i] = { i, type: dir[i] === 1 ? "long" : "short", bar: candles[i] };
    }
  }

  // ── Backtest ──
  const startEquity = p.startEquity || 10000;
  const riskPct = p.riskPct || 0.01;
  let equity = startEquity;
  const equityCurve = new Array(n).fill(NaN);
  equityCurve[0] = equity;
  const trades = [];
  let inPos = 0, entryPrice = 0, entryIdx = 0;
  let bestPrice = 0; // for trailing stop
  let breakEvenTriggered = false;
  const drawdowns = [];
  let peakEquity = startEquity;
  let peakIdx = 0;

  // Track exit reasons for analysis
  const EXIT_FLIP = "flip";
  const EXIT_TRAIL = "trail";
  const EXIT_BREAKEVEN = "be";

  for (let i = 1; i < n; i++) {
    const sig = sigMap[i];

    // ── Update trailing state if in position ──
    if (inPos !== 0) {
      if (inPos === 1 && candles[i].high > bestPrice) bestPrice = candles[i].high;
      if (inPos === -1 && candles[i].low < bestPrice) bestPrice = candles[i].low;
    }

    // ── Check exit conditions ──
    let shouldExit = false;
    let exitReason = EXIT_FLIP;
    let exitPrice = candles[i].close;

    if (inPos !== 0) {
      // Trailing stop: price crosses back over ST line
      if (p.useTrailingStop) {
        if (inPos === 1 && candles[i].close < stLine[i]) {
          shouldExit = true; exitReason = EXIT_TRAIL; exitPrice = candles[i].close;
        } else if (inPos === -1 && candles[i].close > stLine[i]) {
          shouldExit = true; exitReason = EXIT_TRAIL; exitPrice = candles[i].close;
        }
      }

      // Break-even stop: after reaching BE threshold, stop moves to entry
      if (!shouldExit && p.useBreakEven && breakEvenTriggered) {
        if (inPos === 1 && candles[i].close < entryPrice) {
          shouldExit = true; exitReason = EXIT_BREAKEVEN; exitPrice = entryPrice;
        } else if (inPos === -1 && candles[i].close > entryPrice) {
          shouldExit = true; exitReason = EXIT_BREAKEVEN; exitPrice = entryPrice;
        }
      }

      // Check if break-even threshold reached
      if (!breakEvenTriggered && p.useBreakEven && entryPrice > 0) {
        const bePct = p.breakEvenPct || 1.0;
        if (inPos === 1 && (candles[i].high - entryPrice) / entryPrice * 100 >= bePct) {
          breakEvenTriggered = true;
        } else if (inPos === -1 && (entryPrice - candles[i].low) / entryPrice * 100 >= bePct) {
          breakEvenTriggered = true;
        }
      }
    }

    // ── Process signal flip ──
    if (sig && !shouldExit) {
      shouldExit = true;
      exitReason = EXIT_FLIP;
      exitPrice = candles[i].close;
    }

    if (shouldExit && inPos !== 0) {
      const rawPnl = inPos === 1
        ? (exitPrice - entryPrice) / entryPrice
        : (entryPrice - exitPrice) / entryPrice;
      const netPnl = rawPnl - COST_RT;
      const stopDist = Math.max(
        Math.abs(entryPrice - stLine[entryIdx]),
        entryPrice * (p.minStopPct || 0.001)
      );

      // ATR-based position sizing option
      let posSize;
      if (p.useATRSizing && !isNaN(atr[entryIdx])) {
        posSize = (equity * riskPct) / (atr[entryIdx] * (p.atrMult || 2));
      } else {
        posSize = equity * riskPct / stopDist;
      }

      const dollarPnl = posSize * netPnl * entryPrice;
      equity += dollarPnl;

      if (equity > peakEquity) { peakEquity = equity; peakIdx = i; }
      const dd = (peakEquity - equity) / peakEquity;
      drawdowns.push({ idx: i, dd, duration: i - peakIdx });

      trades.push({
        n: trades.length + 1,
        dir: inPos === 1 ? "Long" : "Short",
        entryTime: candles[entryIdx].t,
        exitTime: candles[i].t,
        entryPrice,
        exitPrice,
        rawPnlPct: (rawPnl * 100).toFixed(2),
        netPnlPct: (netPnl * 100).toFixed(2),
        dollarPnl: dollarPnl.toFixed(2),
        bars: i - entryIdx,
        equity: equity.toFixed(2),
        win: netPnl > 0,
        exitReason,
        quality: 0,
      });

      inPos = 0;
      bestPrice = 0;
      breakEvenTriggered = false;
    }

    // ── Open new position ──
    if (sig && inPos === 0) {
      // Regime filter
      const isChoppy = ci && !isNaN(ci[i]) && ci[i] > (p.chopThreshold || 61.8);
      if (isChoppy) { equityCurve[i] = equity; continue; }

      // Session filter
      if (p.sessionFilter) {
        const h = hours[i];
        const [startH, endH] = p.sessionHours || [0, 24];
        if (h < startH || h >= endH) { equityCurve[i] = equity; continue; }
      }

      // Multi-timeframe confluence
      if (htfAlignedDir && htfAlignedDir[i] !== 0) {
        // Only take longs when HTF is bullish, shorts when HTF is bearish
        const htfDir = htfAlignedDir[i];
        if (sig.type === "long" && htfDir === -1) { equityCurve[i] = equity; continue; }
        if (sig.type === "short" && htfDir === 1) { equityCurve[i] = equity; continue; }
      }

      inPos = sig.type === "long" ? 1 : -1;
      entryPrice = candles[i].close;
      entryIdx = i;
      bestPrice = entryPrice;
      breakEvenTriggered = false;
    }

    equityCurve[i] = equity;
  }

  // ── Signal Quality ──
  const signals = sigMap.filter(s => s !== null);
  const qualitySignals = computeSignalQuality(candles, dir, signals);

  // ── Statistics ──
  const wins = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const grossWin = wins.reduce((s, t) => s + (+t.netPnlPct), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (+t.netPnlPct), 0));
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  const avgWin = wins.length ? (grossWin / wins.length).toFixed(2) : "0";
  const avgLoss = losses.length ? (grossLoss / losses.length).toFixed(2) : "0";

  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    if (!isNaN(equityCurve[i]) && !isNaN(equityCurve[i - 1]) && equityCurve[i - 1] > 0) {
      returns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
    }
  }
  const meanR = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
  const stdR = Math.sqrt(returns.reduce((s, r) => s + (r - meanR) ** 2, 0) / (returns.length || 1));
  const sharpe = stdR > 0 ? ((meanR / stdR) * Math.sqrt(252)).toFixed(2) : "—";

  const downsideRets = returns.filter(r => r < 0);
  const downsideDev = downsideRets.length > 0
    ? Math.sqrt(downsideRets.reduce((s, r) => s + r * r, 0) / downsideRets.length)
    : 0;
  const sortino = downsideDev > 0 ? ((meanR / downsideDev) * Math.sqrt(252)).toFixed(2) : "—";

  let peak = startEquity, maxDD = 0, maxDDD = 0, ddStart = 0;
  for (let i = 0; i < equityCurve.length; i++) {
    const v = equityCurve[i];
    if (isNaN(v)) continue;
    if (v > peak) { peak = v; ddStart = i; }
    const dd = (peak - v) / peak;
    if (dd > maxDD) { maxDD = dd; maxDDD = i - ddStart; }
  }

  // Exit reason breakdown
  const flipExits = trades.filter(t => t.exitReason === EXIT_FLIP).length;
  const trailExits = trades.filter(t => t.exitReason === EXIT_TRAIL).length;
  const beExits = trades.filter(t => t.exitReason === EXIT_BREAKEVEN).length;

  // Drawdown distribution
  const ddDistribution = computeDDDistribution(equityCurve);

  const totalBars = equityCurve.filter(v => !isNaN(v)).length;
  const barsPerYear = p.barsPerYear || 365 * 24;
  const years = totalBars / barsPerYear;
  const annReturn = years > 0 ? ((equity / startEquity) ** (1 / years) - 1) * 100 : 0;
  const calmar = maxDD > 0 ? (annReturn / (maxDD * 100)).toFixed(2) : "—";
  const netProfit = equity - startEquity;
  const recoveryFactor = maxDD > 0 ? (netProfit / (maxDD * startEquity)).toFixed(2) : "—";

  const W = trades.length ? wins.length / trades.length : 0;
  const avgWinFrac = wins.length ? grossWin / wins.length / 100 : 0;
  const avgLossFrac = losses.length ? grossLoss / losses.length / 100 : 0;
  const kelly = (avgLossFrac > 0 && W > 0)
    ? ((W - ((1 - W) / (avgWinFrac / avgLossFrac))) * 100).toFixed(1)
    : "—";

  let maxCW = 0, maxCL = 0, cw = 0, cl = 0;
  for (const t of trades) {
    if (t.win) { cw++; cl = 0; maxCW = Math.max(maxCW, cw); }
    else { cl++; cw = 0; maxCL = Math.max(maxCL, cl); }
  }

  const monthlyRets = computeMonthlyReturns(trades, startEquity);
  const longs = trades.filter(t => t.dir === "Long");
  const shorts = trades.filter(t => t.dir === "Short");
  const netReturn = ((equity / startEquity - 1) * 100).toFixed(2);

  return {
    atr, er, smoothF, stLine, dir, signals: qualitySignals, equityCurve, trades,
    ci, monthlyRets, drawdowns: drawdowns.length > 0 ? drawdowns : [{ idx: 0, dd: 0, duration: 0 }],
    ddDistribution,
    stats: {
      netReturn, annReturn: annReturn.toFixed(2),
      winRate: trades.length ? ((wins.length / trades.length) * 100).toFixed(1) : "—",
      totalTrades: trades.length,
      longs: longs.length, shorts: shorts.length,
      longWinRate: longs.length ? ((longs.filter(t => t.win).length / longs.length) * 100).toFixed(1) : "—",
      shortWinRate: shorts.length ? ((shorts.filter(t => t.win).length / shorts.length) * 100).toFixed(1) : "—",
      profitFactor: pf, avgWin, avgLoss,
      maxDD: (maxDD * 100).toFixed(2), maxDDD,
      sharpe, sortino, calmar, recoveryFactor, kelly,
      maxCW, maxCL,
      bestTrade: trades.length ? Math.max(...trades.map(t => +t.netPnlPct)).toFixed(2) : "—",
      worstTrade: trades.length ? Math.min(...trades.map(t => +t.netPnlPct)).toFixed(2) : "—",
      avgQuality: "—",
      flipExits, trailExits, beExits,
    }
  };
}

function computeDDDistribution(equityCurve) {
  const dds = [];
  let peak = equityCurve[0] || 10000;
  let inDD = false;
  let ddStart = 0;
  for (let i = 0; i < equityCurve.length; i++) {
    const v = equityCurve[i];
    if (isNaN(v)) continue;
    if (v >= peak) {
      if (inDD) {
        dds.push({ depth: (peak - equityCurve[i - 1]) / peak, duration: i - 1 - ddStart });
        inDD = false;
      }
      peak = v;
    } else {
      if (!inDD) { inDD = true; ddStart = i; }
    }
  }
  if (inDD) {
    dds.push({ depth: (peak - equityCurve[equityCurve.length - 1]) / peak, duration: equityCurve.length - 1 - ddStart });
  }
  return dds;
}

function computeMonthlyReturns(trades, startEquity) {
  if (!trades.length) return [];
  const months = {};
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  for (const t of sorted) {
    const d = new Date(t.exitTime);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!months[key]) months[key] = { month: key, wins: 0, losses: 0, pnl: 0, trades: 0 };
    const pnl = +t.dollarPnl;
    months[key].pnl += pnl;
    months[key].trades++;
    if (pnl > 0) months[key].wins++; else months[key].losses++;
  }
  return Object.values(months);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  WALK-FORWARD ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

function runWalkForward(candles, baseParams, optRanges, wfConfig) {
  const { trainSize, testSize } = wfConfig; // in bars
  const results = [];
  let cursor = 0;

  while (cursor + trainSize + testSize <= candles.length) {
    const trainCandles = candles.slice(cursor, cursor + trainSize);
    const testCandles = candles.slice(cursor + trainSize, cursor + trainSize + testSize);

    // Optimize on training set (limited grid for speed)
    const trainResults = runOptimization(trainCandles, baseParams, optRanges);
    if (!trainResults.length) { cursor += testSize; continue; }

    const bestParams = { ...baseParams, ...trainResults[0].params };

    // Test on out-of-sample data
    const testResult = runBacktest(testCandles, bestParams);

    results.push({
      window: results.length + 1,
      trainStart: cursor,
      trainEnd: cursor + trainSize - 1,
      testStart: cursor + trainSize,
      testEnd: cursor + trainSize + testSize - 1,
      bestParams: trainResults[0].params,
      testStats: testResult.stats,
      oosReturn: parseFloat(testResult.stats.netReturn),
      oosSharpe: testResult.stats.sharpe === "—" ? 0 : parseFloat(testResult.stats.sharpe),
    });

    cursor += testSize; // anchored walk-forward
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MONTE CARLO SIMULATION
// ═══════════════════════════════════════════════════════════════════════════════

function runMonteCarlo(trades, equityCurve, startEquity, iterations = 1000) {
  if (!trades.length) return null;
  const n = trades.length;
  const simResults = [];

  for (let iter = 0; iter < iterations; iter++) {
    // Fisher-Yates shuffle of trades
    const shuffled = [...trades];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    let eq = startEquity;
    let peak = startEquity;
    let maxDD = 0;
    const simCurve = [eq];

    for (const t of shuffled) {
      const pct = +t.netPnlPct / 100;
      eq *= (1 + pct);
      simCurve.push(eq);
      if (eq > peak) peak = eq;
      const dd = (peak - eq) / peak;
      if (dd > maxDD) maxDD = dd;
    }

    simResults.push({
      finalEquity: eq,
      maxDD,
      netReturn: (eq / startEquity - 1),
    });
  }

  // Compute percentiles
  const finalEquities = simResults.map(s => s.finalEquity).sort((a, b) => a - b);
  const maxDDs = simResults.map(s => s.maxDD).sort((a, b) => a - b);
  const netReturns = simResults.map(s => s.netReturn).sort((a, b) => a - b);

  const percentile = (arr, p) => arr[Math.floor(arr.length * p)];

  return {
    finalEquity: {
      p5: percentile(finalEquities, 0.05),
      p25: percentile(finalEquities, 0.25),
      p50: percentile(finalEquities, 0.5),
      p75: percentile(finalEquities, 0.75),
      p95: percentile(finalEquities, 0.95),
      mean: finalEquities.reduce((s, v) => s + v, 0) / finalEquities.length,
    },
    maxDD: {
      p5: percentile(maxDDs, 0.05),
      p50: percentile(maxDDs, 0.5),
      p95: percentile(maxDDs, 0.95),
      mean: maxDDs.reduce((s, v) => s + v, 0) / maxDDs.length,
    },
    netReturn: {
      p5: percentile(netReturns, 0.05),
      p50: percentile(netReturns, 0.5),
      p95: percentile(netReturns, 0.95),
    },
    ruinRate: netReturns.filter(r => r < -0.5).length / netReturns.length, // 50% account loss
    // Full distribution for histogram
    allFinalEquities: finalEquities,
    allMaxDDs: maxDDs,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PARAMETER OPTIMIZATION
// ═══════════════════════════════════════════════════════════════════════════════

function runOptimization(candles, baseParams, ranges, onProgress) {
  const results = [];
  let total = 0, done = 0;

  const combos = [];
  for (const atrP of ranges.atrPeriod) {
    for (const erL of ranges.erLength) {
      for (const smL of ranges.smoothLength) {
        for (const minF of ranges.minFactor) {
          for (const maxF of ranges.maxFactor) {
            if (minF >= maxF) continue;
            combos.push({ atrPeriod: atrP, erLength: erL, smoothLength: smL, minFactor: minF, maxFactor: maxF });
          }
        }
      }
    }
  }
  total = combos.length;

  for (const combo of combos) {
    const p = { ...baseParams, ...combo };
    try {
      const r = runBacktest(candles, p);
      const s = r.stats;
      results.push({
        params: combo,
        netReturn: parseFloat(s.netReturn),
        sharpe: s.sharpe === "—" ? -999 : parseFloat(s.sharpe),
        maxDD: parseFloat(s.maxDD),
        profitFactor: s.profitFactor === "∞" ? 999 : parseFloat(s.profitFactor),
        totalTrades: s.totalTrades,
        winRate: parseFloat(s.winRate),
        calmar: s.calmar === "—" ? -999 : parseFloat(s.calmar),
        score: (parseFloat(s.netReturn) * 0.3)
          + (s.sharpe === "—" ? 0 : parseFloat(s.sharpe) * 10)
          - parseFloat(s.maxDD) * 0.5
          + Math.min(s.profitFactor === "∞" ? 0 : parseFloat(s.profitFactor), 5) * 5,
      });
    } catch (_e) { }
    done++;
    if (onProgress) onProgress(Math.round((done / total) * 100));
  }

  return results.sort((a, b) => b.score - a.score);
}

// ─── Formatting helpers ───────────────────────────────────────────────────────
const fmtDate = ms => new Date(ms).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
const fmtTime = ms => new Date(ms).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtPrice = (p, sym) => {
  if (!p) return "—";
  const digits = sym?.includes("BTC") ? 1 : sym?.includes("DOGE") || sym?.includes("PEPE") || sym?.includes("BONK") ? 6 : 3;
  return (+p).toFixed(digits);
};
const toISO = ms => new Date(ms).toISOString().slice(0, 10);
const fromISO = s => new Date(s).getTime();
const fmtMonth = key => { const [y, m] = key.split("-"); return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m - 1]} ${y.slice(2)}`; };

// ─── CSV Export ───────────────────────────────────────────────────────────────
function exportTradesCSV(trades, symbol) {
  const headers = ["#", "Direction", "Entry Time", "Exit Time", "Entry Price", "Exit Price", "Raw PnL %", "Net PnL %", "Dollar PnL", "Bars", "Equity", "Exit Reason"];
  const rows = trades.map(t => [
    t.n, t.dir,
    new Date(t.entryTime).toISOString(),
    new Date(t.exitTime).toISOString(),
    t.entryPrice, t.exitPrice,
    t.rawPnlPct, t.netPnlPct, t.dollarPnl,
    t.bars, t.equity, t.exitReason || "flip"
  ]);
  const csv = [headers, ...rows].map(r => r.join(",")).join("\n");
  downloadFile(csv, `${symbol}_trades_${Date.now()}.csv`, "text/csv");
}

function exportEquityCSV(equityCurve, candles, symbol) {
  const headers = ["Index", "Timestamp", "Open", "High", "Low", "Close", "Equity"];
  const rows = candles.map((c, i) => [i, new Date(c.t).toISOString(), c.open, c.high, c.low, c.close, equityCurve[i]]);
  const csv = [headers, ...rows].map(r => r.join(",")).join("\n");
  downloadFile(csv, `${symbol}_equity_${Date.now()}.csv`, "text/csv");
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}


// ═══════════════════════════════════════════════════════════════════════════════
//  CHART COMPONENTS — Enhanced with crosshair
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Price Chart with Crosshair & Trade Annotations ──────────────────────────
function PriceChart({ candles, result, width, height, symbol, viewRange }) {
  const ref = useRef(null);
  const [tooltip, setTooltip] = useState(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !candles.length || !result) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const [vStart, vEnd] = viewRange;
    const vis = candles.slice(vStart, vEnd);
    const stV = result.stLine.slice(vStart, vEnd);
    const dirV = result.dir.slice(vStart, vEnd);
    if (vis.length < 2) return;

    const pL = 10, pR = 72, pT = 14, pB = 24;
    const W = width - pL - pR, H = height - pT - pB;

    const allP = [...vis.flatMap(c => [c.high, c.low]), ...stV.filter(v => !isNaN(v))];
    const yMin = Math.min(...allP) * 0.9985;
    const yMax = Math.max(...allP) * 1.0015;

    const xS = i => pL + (i / (vis.length - 1)) * W;
    const yS = v => pT + H - ((v - yMin) / (yMax - yMin)) * H;

    // Background
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, width, height);

    // Grid
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    for (let g = 0; g <= 5; g++) {
      const y = pT + (g / 5) * H;
      ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(pL + W, y); ctx.stroke();
      const price = yMax - (g / 5) * (yMax - yMin);
      ctx.fillStyle = C.sub; ctx.font = "9px monospace"; ctx.textAlign = "left";
      ctx.fillText(fmtPrice(price, symbol), pL + W + 3, y + 3);
    }

    // Candles
    const cW = Math.max(1, W / vis.length * 0.7);
    vis.forEach((c, i) => {
      const x = xS(i), bull = c.close >= c.open;
      ctx.strokeStyle = bull ? C.accent : C.red;
      ctx.fillStyle = bull ? C.accent + "aa" : C.red + "aa";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yS(c.high)); ctx.lineTo(x, yS(c.low)); ctx.stroke();
      const y1 = yS(Math.max(c.open, c.close));
      const bH = Math.max(1, Math.abs(yS(c.open) - yS(c.close)));
      ctx.fillRect(x - cW / 2, y1, cW, bH);
    });

    // ST line
    let seg = []; let lastDir = dirV[0];
    const flushSeg = () => {
      if (seg.length < 2) { seg = []; return; }
      ctx.beginPath(); ctx.lineWidth = 2;
      ctx.strokeStyle = lastDir === 1 ? C.accent : C.red;
      seg.forEach(([x, y], k) => k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
      ctx.stroke(); seg = [];
    };
    stV.forEach((v, i) => {
      if (isNaN(v)) return;
      if (dirV[i] !== lastDir) { flushSeg(); lastDir = dirV[i]; }
      seg.push([xS(i), yS(v)]);
    });
    flushSeg();

    // Entry/exit signals
    const sigOffset = vStart;
    result.signals.forEach(s => {
      const si = s.i - sigOffset;
      if (si < 0 || si >= vis.length) return;
      const x = xS(si), price = vis[si]?.close;
      if (!price) return;
      const isLong = s.type === "long";
      const y = yS(price) + (isLong ? 18 : -18);
      ctx.beginPath(); ctx.fillStyle = isLong ? C.accent : C.red;
      if (isLong) { ctx.moveTo(x, y - 9); ctx.lineTo(x + 5, y + 2); ctx.lineTo(x - 5, y + 2); }
      else { ctx.moveTo(x, y + 9); ctx.lineTo(x + 5, y - 2); ctx.lineTo(x - 5, y - 2); }
      ctx.fill();

      if (s.score >= 3) {
        ctx.fillStyle = s.score >= 4 ? C.yellow + "dd" : C.blue + "dd";
        ctx.font = "bold 7px monospace";
        ctx.textAlign = "center";
        ctx.fillText(`Q${s.score}`, x, y + (isLong ? 14 : -14));
      }

      const trade = result.trades.find(t => t.entryTime === s.bar.t);
      if (trade && trade.netPnlPct) {
        const pnlColor = +trade.netPnlPct >= 0 ? C.accent : C.red;
        ctx.fillStyle = pnlColor + "cc";
        ctx.font = "7px monospace";
        ctx.textAlign = "center";
        const pnlY = yS(price) + (isLong ? -10 : 10);
        ctx.fillText(`${+trade.netPnlPct >= 0 ? "+" : ""}${trade.netPnlPct}%`, x, pnlY);
      }
    });

    // X-axis
    ctx.fillStyle = C.sub; ctx.font = "9px monospace"; ctx.textAlign = "center";
    for (let g = 0; g <= 4; g++) {
      const i = Math.round((g / 4) * (vis.length - 1));
      const t = vis[i]?.t;
      if (t) ctx.fillText(fmtDate(t), xS(i), pT + H + 16);
    }
  }, [candles, result, width, height, symbol, viewRange]);

  // Crosshair mouse handler
  const handleMouseMove = useCallback((e) => {
    const canvas = ref.current;
    if (!canvas || !candles.length || !result) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const [vStart, vEnd] = viewRange;
    const vis = candles.slice(vStart, vEnd);
    const stV = result.stLine.slice(vStart, vEnd);
    if (vis.length < 2) return;

    const pL = 10, pR = 72, pT = 14, pB = 24;
    const W = width - pL - pR, H = height - pT - pB;

    if (mx < pL || mx > pL + W || my < pT || my > pT + H) {
      setTooltip(null);
      return;
    }

    const allP = [...vis.flatMap(c => [c.high, c.low]), ...stV.filter(v => !isNaN(v))];
    const yMin = Math.min(...allP) * 0.9985;
    const yMax = Math.max(...allP) * 1.0015;

    const idx = Math.round(((mx - pL) / W) * (vis.length - 1));
    if (idx < 0 || idx >= vis.length) { setTooltip(null); return; }

    const c = vis[idx];
    const priceAtY = yMax - ((my - pT) / H) * (yMax - yMin);
    const stVal = stV[idx];

    setTooltip({
      x: mx + 10, y: my - 10,
      candle: c, st: stVal,
      dir: result.dir[vStart + idx],
      realIdx: vStart + idx,
      priceAtY,
    });
  }, [candles, result, width, height, viewRange]);

  const handleMouseLeave = () => setTooltip(null);

  return (
    <div style={{ position: "relative" }}>
      <canvas
        ref={ref}
        style={{ width, height, display: "block", cursor: "crosshair" }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
      {tooltip && (
        <div style={{
          position: "absolute", left: tooltip.x, top: tooltip.y,
          background: C.panel, border: `1px solid ${C.border2}`,
          borderRadius: 6, padding: "6px 10px", pointerEvents: "none",
          zIndex: 100, fontSize: 10, fontFamily: "monospace",
          color: C.text, boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
        }}>
          <div style={{ color: C.label, fontSize: 9, marginBottom: 3 }}>{fmtTime(tooltip.candle.t)}</div>
          <div>O: <span style={{ color: C.accent }}>{fmtPrice(tooltip.candle.open, symbol)}</span></div>
          <div>H: <span style={{ color: C.accent }}>{fmtPrice(tooltip.candle.high, symbol)}</span></div>
          <div>L: <span style={{ color: C.red }}>{fmtPrice(tooltip.candle.low, symbol)}</span></div>
          <div>C: <span style={{ color: tooltip.candle.close >= tooltip.candle.open ? C.accent : C.red }}>{fmtPrice(tooltip.candle.close, symbol)}</span></div>
          <div>V: <span style={{ color: C.blue }}>{(tooltip.candle.vol / 1e6).toFixed(2)}M</span></div>
          {tooltip.st && !isNaN(tooltip.st) && (
            <div style={{ marginTop: 3, borderTop: `1px solid ${C.border}`, paddingTop: 3 }}>
              <div>ST: <span style={{ color: tooltip.dir === 1 ? C.accent : C.red }}>{fmtPrice(tooltip.st, symbol)}</span></div>
              <div>Dir: <span style={{ color: tooltip.dir === 1 ? C.accent : C.red }}>{tooltip.dir === 1 ? "LONG" : "SHORT"}</span></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Volume Chart ─────────────────────────────────────────────────────────────
function VolumeChart({ candles, result, width, height, viewRange }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !candles.length) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const [vStart, vEnd] = viewRange;
    const vis = candles.slice(vStart, vEnd);
    const dirV = result?.dir?.slice(vStart, vEnd) || [];
    if (!vis.length) return;

    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, width, height);

    const pL = 10, pR = 72, pT = 6, pB = 18;
    const W = width - pL - pR, H = height - pT - pB;
    const maxVol = Math.max(...vis.map(c => c.vol));
    const xS = i => pL + (i / (vis.length - 1)) * W;
    const cW = Math.max(1, W / vis.length * 0.7);

    vis.forEach((c, i) => {
      const barH = (c.vol / maxVol) * H;
      ctx.fillStyle = (dirV[i] === 1 ? C.accent : C.red) + "55";
      ctx.fillRect(xS(i) - cW / 2, pT + H - barH, cW, barH);
    });

    ctx.fillStyle = C.sub; ctx.font = "9px monospace"; ctx.textAlign = "left";
    const fmtVol = v => v > 1e9 ? (v / 1e9).toFixed(1) + "B" : v > 1e6 ? (v / 1e6).toFixed(1) + "M" : (v / 1e3).toFixed(0) + "K";
    ctx.fillText(fmtVol(maxVol), pL + W + 3, pT + 10);
    ctx.fillStyle = C.sub + "88";
    ctx.fillText("vol", pL + W + 3, pT + H);
  }, [candles, result, width, height, viewRange]);

  return <canvas ref={ref} style={{ width, height, display: "block" }} />;
}

// ─── ER + Factor Chart (with CI overlay) ──────────────────────────────────────
function ERChart({ result, width, height, minFactor, maxFactor, viewRange, showCI }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !result) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, width, height);

    const [vStart, vEnd] = viewRange;
    const er = result.er.slice(vStart, vEnd);
    const sf = result.smoothF.slice(vStart, vEnd);
    const ci = result.ci?.slice(vStart, vEnd) || [];
    if (!er.length) return;

    const pL = 10, pR = 72, pT = 8, pB = 14;
    const W = width - pL - pR, H = height - pT - pB;

    const xS = i => pL + (i / (er.length - 1)) * W;
    const erY = v => pT + H - v * H;
    const sfRange = maxFactor - minFactor;
    const sfY = v => pT + H - ((v - minFactor * 0.9) / (sfRange * 1.2)) * H;

    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    [0, 0.5, 1].forEach(g => {
      ctx.beginPath(); ctx.moveTo(pL, erY(g)); ctx.lineTo(pL + W, erY(g)); ctx.stroke();
    });

    if (showCI && ci.length) {
      ci.forEach((v, i) => {
        if (isNaN(v)) return;
        const chopIntensity = v > 50 ? Math.min((v - 50) / 50, 1) : 0;
        if (chopIntensity > 0.1) {
          ctx.fillStyle = `rgba(255, 71, 87, ${chopIntensity * 0.15})`;
          const barW = W / er.length;
          ctx.fillRect(xS(i) - barW / 2, pT, barW, H);
        }
      });
    }

    const g = ctx.createLinearGradient(0, pT, 0, pT + H);
    g.addColorStop(0, C.purple + "40"); g.addColorStop(1, C.purple + "08");
    ctx.beginPath();
    er.forEach((v, i) => i === 0 ? ctx.moveTo(xS(i), erY(v)) : ctx.lineTo(xS(i), erY(v)));
    ctx.lineTo(xS(er.length - 1), pT + H); ctx.lineTo(xS(0), pT + H);
    ctx.closePath(); ctx.fillStyle = g; ctx.fill();

    ctx.beginPath(); ctx.strokeStyle = C.purple; ctx.lineWidth = 1.5;
    er.forEach((v, i) => i === 0 ? ctx.moveTo(xS(i), erY(v)) : ctx.lineTo(xS(i), erY(v)));
    ctx.stroke();

    ctx.beginPath(); ctx.strokeStyle = C.yellow; ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    sf.forEach((v, i) => {
      if (isNaN(v)) return;
      i === 0 ? ctx.moveTo(xS(i), sfY(v)) : ctx.lineTo(xS(i), sfY(v));
    });
    ctx.stroke(); ctx.setLineDash([]);

    ctx.font = "9px monospace"; ctx.textAlign = "left";
    ctx.fillStyle = C.purple; ctx.fillText("ER", pL + W + 3, pT + 10);
    ctx.fillStyle = C.yellow; ctx.fillText("F×", pL + W + 3, pT + H - 4);
    ctx.fillStyle = C.sub;
    [minFactor, maxFactor].forEach(v => ctx.fillText(v.toFixed(1), pL + W + 20, sfY(v) + 3));
    if (showCI) { ctx.fillStyle = C.red + "88"; ctx.fillText("CI", pL + W + 3, pT + H / 2); }
  }, [result, width, height, minFactor, maxFactor, viewRange, showCI]);

  return <canvas ref={ref} style={{ width, height, display: "block" }} />;
}

// ─── Equity Curve ─────────────────────────────────────────────────────────────
function EquityChart({ result, width, height }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !result) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, width, height);
    const curve = result.equityCurve.filter(v => !isNaN(v));
    if (curve.length < 2) return;

    const pL = 10, pR = 72, pT = 8, pB = 14;
    const W = width - pL - pR, H = height - pT - pB;
    const yMin = Math.min(...curve) * 0.995;
    const yMax = Math.max(...curve) * 1.005;
    const full = result.equityCurve;
    const xS = i => pL + (i / (full.length - 1)) * W;
    const yS = v => pT + H - ((v - yMin) / (yMax - yMin)) * H;

    const base = result.stats?.startEquity || 10000;
    const baseY = yS(base);
    ctx.strokeStyle = C.border2; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(pL, baseY); ctx.lineTo(pL + W, baseY); ctx.stroke();
    ctx.setLineDash([]);

    const grad = ctx.createLinearGradient(0, pT, 0, pT + H);
    const isUp = (full[full.length - 1] || 0) >= base;
    grad.addColorStop(0, (isUp ? C.accent : C.red) + "35");
    grad.addColorStop(1, (isUp ? C.accent : C.red) + "05");
    ctx.beginPath();
    let started = false;
    full.forEach((v, i) => {
      if (isNaN(v)) return;
      if (!started) { ctx.moveTo(xS(i), yS(v)); started = true; }
      else ctx.lineTo(xS(i), yS(v));
    });
    ctx.lineTo(xS(full.length - 1), pT + H); ctx.lineTo(pL, pT + H);
    ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

    ctx.beginPath(); ctx.lineWidth = 1.5;
    ctx.strokeStyle = isUp ? C.accent : C.red;
    started = false;
    full.forEach((v, i) => {
      if (isNaN(v)) return;
      if (!started) { ctx.moveTo(xS(i), yS(v)); started = true; }
      else ctx.lineTo(xS(i), yS(v));
    });
    ctx.stroke();

    ctx.fillStyle = C.sub; ctx.font = "9px monospace"; ctx.textAlign = "left";
    const finalVal = curve[curve.length - 1];
    ctx.fillStyle = isUp ? C.accent : C.red;
    ctx.fillText("$" + finalVal.toFixed(0), pL + W + 3, yS(finalVal) + 3);
    ctx.fillStyle = C.sub;
    ctx.fillText("$" + (base / 1000).toFixed(0) + "K", pL + W + 3, baseY + 3);
  }, [result, width, height]);

  return <canvas ref={ref} style={{ width, height, display: "block" }} />;
}

// ─── Underwater Chart ─────────────────────────────────────────────────────────
function UnderwaterChart({ result, width, height }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !result) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, width, height);
    const curve = result.equityCurve;
    if (!curve || curve.length < 2) return;

    const pL = 10, pR = 72, pT = 6, pB = 14;
    const W = width - pL - pR, H = height - pT - pB;
    const n = curve.length;

    const ddSeries = new Array(n).fill(0);
    let peak = curve[0] || 10000;
    for (let i = 0; i < n; i++) {
      if (!isNaN(curve[i])) {
        if (curve[i] > peak) peak = curve[i];
        ddSeries[i] = (peak - curve[i]) / peak;
      }
    }
    const maxDD = Math.max(...ddSeries);
    if (maxDD <= 0) return;

    const xS = i => pL + (i / (n - 1)) * W;
    const yS = v => pT + H - (v / (maxDD * 1.1)) * H;

    const grad = ctx.createLinearGradient(0, pT, 0, pT + H);
    grad.addColorStop(0, C.red + "50");
    grad.addColorStop(1, C.red + "08");
    ctx.beginPath();
    ctx.moveTo(xS(0), yS(0));
    ddSeries.forEach((v, i) => ctx.lineTo(xS(i), yS(v)));
    ctx.lineTo(xS(n - 1), pT + H);
    ctx.lineTo(xS(0), pT + H);
    ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

    ctx.beginPath(); ctx.strokeStyle = C.red + "aa"; ctx.lineWidth = 1;
    ctx.moveTo(xS(0), yS(0));
    ddSeries.forEach((v, i) => ctx.lineTo(xS(i), yS(v)));
    ctx.stroke();

    ctx.fillStyle = C.red; ctx.font = "9px monospace"; ctx.textAlign = "left";
    ctx.fillText(`-${(maxDD * 100).toFixed(1)}%`, pL + W + 3, yS(maxDD) + 3);
    ctx.fillStyle = C.sub + "88";
    ctx.fillText("DD", pL + W + 3, pT + H - 2);
  }, [result, width, height]);

  return <canvas ref={ref} style={{ width, height, display: "block" }} />;
}

// ─── Drawdown Distribution Histogram ──────────────────────────────────────────
function DDDistributionChart({ ddDistribution, width, height }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !ddDistribution || ddDistribution.length === 0) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, width, height);

    // Bin drawdown depths into 10 bins
    const bins = new Array(10).fill(0);
    ddDistribution.forEach(dd => {
      const bin = Math.min(Math.floor(dd.depth * 100 / 5), 9);
      bins[bin]++;
    });
    const maxCount = Math.max(...bins);
    if (maxCount === 0) return;

    const pL = 30, pR = 10, pT = 10, pB = 20;
    const W = width - pL - pR, H = height - pT - pB;
    const barW = W / 10;

    bins.forEach((count, i) => {
      const barH = (count / maxCount) * H;
      const alpha = 0.3 + (i / 10) * 0.5;
      ctx.fillStyle = `rgba(255, 71, 87, ${alpha})`;
      ctx.fillRect(pL + i * barW, pT + H - barH, barW - 1, barH);

      // Count label on top
      if (count > 0) {
        ctx.fillStyle = C.sub;
        ctx.font = "8px monospace";
        ctx.textAlign = "center";
        ctx.fillText(count.toString(), pL + i * barW + barW / 2, pT + H - barH - 2);
      }
    });

    // X-axis labels (DD % ranges)
    ctx.fillStyle = C.sub; ctx.font = "7px monospace"; ctx.textAlign = "center";
    for (let i = 0; i < 10; i++) {
      ctx.fillText(`${i * 5}-${(i + 1) * 5}%`, pL + i * barW + barW / 2, pT + H + 12);
    }

    ctx.fillStyle = C.label; ctx.font = "8px monospace"; ctx.textAlign = "center";
    ctx.fillText("Drawdown Distribution (%)", pL + W / 2, height - 2);
  }, [ddDistribution, width, height]);

  return <canvas ref={ref} style={{ width, height, display: "block" }} />;
}

// ─── Optimization Heatmap ─────────────────────────────────────────────────────
function OptimizationHeatmap({ results, width, height }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !results || results.length === 0) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, width, height);

    const minFs = [...new Set(results.map(r => r.params.minFactor))].sort((a, b) => a - b);
    const maxFs = [...new Set(results.map(r => r.params.maxFactor))].sort((a, b) => a - b);
    if (!minFs.length || !maxFs.length) return;

    const cellW = Math.floor((width - 60) / maxFs.length);
    const cellH = Math.floor((height - 40) / minFs.length);

    const scores = results.map(r => r.score);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const scoreRange = maxScore - minScore || 1;

    minFs.forEach((minF, mi) => {
      maxFs.forEach((maxF, mxi) => {
        const r = results.find(x => x.params.minFactor === minF && x.params.maxFactor === maxF);
        if (!r) return;
        const norm = (r.score - minScore) / scoreRange;
        const r2 = Math.round(255 * Math.max(0, 1 - norm * 2));
        const g2 = Math.round(255 * Math.min(1, norm * 2));
        ctx.fillStyle = `rgb(${r2},${g2},60)`;
        ctx.fillRect(40 + mxi * cellW, 20 + mi * cellH, cellW - 1, cellH - 1);

        ctx.fillStyle = norm > 0.5 ? "#000" : "#fff";
        ctx.font = "8px monospace";
        ctx.textAlign = "center";
        ctx.fillText(`${r.netReturn.toFixed(0)}%`, 40 + mxi * cellW + cellW / 2, 20 + mi * cellH + cellH / 2 + 3);
      });
    });

    ctx.fillStyle = C.sub; ctx.font = "8px monospace"; ctx.textAlign = "center";
    maxFs.forEach((v, i) => ctx.fillText(v.toFixed(1), 40 + i * cellW + cellW / 2, 16));
    ctx.fillStyle = C.sub; ctx.font = "8px monospace"; ctx.textAlign = "right";
    minFs.forEach((v, i) => ctx.fillText(v.toFixed(1), 36, 20 + i * cellH + cellH / 2 + 3));

    ctx.fillStyle = C.label; ctx.font = "8px monospace"; ctx.textAlign = "center";
    ctx.fillText("maxF →", 40 + (maxFs.length * cellW) / 2, height - 4);
    ctx.save();
    ctx.translate(8, 20 + (minFs.length * cellH) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("minF →", 0, 0);
    ctx.restore();
  }, [results, width, height]);

  return <canvas ref={ref} style={{ width, height, display: "block" }} />;
}

// ─── Monte Carlo Distribution Chart ───────────────────────────────────────────
function MonteCarloChart({ mcResults, width, height }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !mcResults) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, width, height);

    const finalEqs = mcResults.allFinalEquities;
    if (!finalEqs || finalEqs.length === 0) return;

    // Create 40 bins
    const min = finalEqs[0];
    const max = finalEqs[finalEqs.length - 1];
    const range = max - min || 1;
    const binCount = 40;
    const bins = new Array(binCount).fill(0);
    finalEqs.forEach(v => {
      const b = Math.min(Math.floor((v - min) / range * binCount), binCount - 1);
      bins[b]++;
    });
    const maxCount = Math.max(...bins);

    const pL = 50, pR = 15, pT = 10, pB = 20;
    const W = width - pL - pR, H = height - pT - pB;
    const barW = W / binCount;

    bins.forEach((count, i) => {
      const barH = (count / maxCount) * H;
      const isMedian = i >= binCount * 0.4 && i <= binCount * 0.6;
      ctx.fillStyle = isMedian ? C.accent + "88" : C.blue + "44";
      ctx.fillRect(pL + i * barW, pT + H - barH, barW - 0.5, barH);
    });

    // Labels
    ctx.fillStyle = C.sub; ctx.font = "8px monospace"; ctx.textAlign = "center";
    ctx.fillText(`$${(min / 1000).toFixed(0)}K`, pL, pT + H + 12);
    ctx.fillText(`$${(max / 1000).toFixed(0)}K`, pL + W, pT + H + 12);
    ctx.fillText(`median $${(mcResults.finalEquity.p50 / 1000).toFixed(1)}K`, pL + W / 2, pT + H + 12);

    ctx.fillStyle = C.label; ctx.font = "8px monospace"; ctx.textAlign = "center";
    ctx.fillText("Monte Carlo: Final Equity Distribution", pL + W / 2, height - 2);
  }, [mcResults, width, height]);

  return <canvas ref={ref} style={{ width, height, display: "block" }} />;
}


// ═══════════════════════════════════════════════════════════════════════════════
//  UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function Pill({ children, active, onClick, color }) {
  return (
    <button onClick={onClick} style={{
      padding: "4px 10px", borderRadius: 5, cursor: "pointer", fontSize: 11,
      fontFamily: "monospace", fontWeight: active ? 700 : 400,
      background: active ? (color || C.accent) + "22" : "transparent",
      border: `1px solid ${active ? (color || C.accent) + "66" : C.border}`,
      color: active ? (color || C.accent) : C.sub,
      transition: "all 0.12s",
    }}>{children}</button>
  );
}

function Slider({ label, value, min, max, step, onChange, color, unit }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 10, color: C.label }}>{label}</span>
        <span style={{ fontSize: 10, fontFamily: "monospace", color: color || C.accent }}>{value}{unit || ""}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(+e.target.value)}
        style={{ width: "100%", accentColor: color || C.accent, cursor: "pointer" }} />
    </div>
  );
}

function StatRow({ label, value, color, mono }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
      <span style={{ fontSize: 10, color: C.sub }}>{label}</span>
      <span style={{ fontSize: 11, fontFamily: mono ? "monospace" : undefined, fontWeight: 600, color: color || C.text }}>{value}</span>
    </div>
  );
}

function Panel({ title, children, style }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 10, ...style }}>
      {title && (
        <div style={{ padding: "9px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 10, color: C.label, letterSpacing: "0.07em", textTransform: "uppercase" }}>
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

function Toggle({ label, value, onChange, color }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
      <span style={{ fontSize: 10, color: C.label }}>{label}</span>
      <button onClick={() => onChange(!value)} style={{
        width: 32, height: 18, borderRadius: 9, border: "none", cursor: "pointer",
        background: value ? (color || C.accent) + "66" : C.border2,
        position: "relative", transition: "all 0.15s"
      }}>
        <div style={{
          width: 14, height: 14, borderRadius: 7, background: value ? (color || C.accent) : C.sub,
          position: "absolute", top: 2, left: value ? 16 : 2, transition: "all 0.15s"
        }} />
      </button>
    </div>
  );
}

// ─── Pine Script Export ───────────────────────────────────────────────────────
function PineModal({ params, onClose }) {
  const [copied, setCopied] = useState(false);
  const script = `// ============================================
// Adaptive Supertrend PRO v2.1
// ============================================
//@version=6
strategy(
    title="Adaptive ST PRO v2.1", shorttitle="AST_PRO",
    overlay=true, initial_capital=${params.startEquity || 10000},
    default_qty_type=strategy.percent_of_equity,
    default_qty_value=10, margin_long=100, margin_short=100,
    commission_type=strategy.commission.percent,
    commission_value=0.04, slippage=2,
    process_orders_on_close=true
)

// ── Inputs ──
atrPeriod    = input.int(${params.atrPeriod},   "ATR Period",    minval=1)
minFactor    = input.float(${params.minFactor}, "Min Multiplier",step=0.1)
maxFactor    = input.float(${params.maxFactor}, "Max Multiplier",step=0.1)
erLength     = input.int(${params.erLength},    "ER Window",     minval=2)
smoothLength = input.int(${params.smoothLength},"EMA Smooth",    minval=1)
useRegime    = input.bool(${params.useRegimeFilter || false}, "Regime Filter")
chopThreshold= input.float(${params.chopThreshold || 61.8}, "Chop Threshold", minval=50, maxval=80)
useVWER      = input.bool(${params.useVWER || false}, "Volume-Weighted ER")
useTrailing  = input.bool(${params.useTrailingStop || false}, "Trailing Stop")
useBreakEven = input.bool(${params.useBreakEven || false}, "Break-Even Stop")
bePct        = input.float(${params.breakEvenPct || 1.0}, "BE Trigger %", step=0.5)

// ── ER ──
f_vwer(len) =>
    float net = math.abs(close - close[len])
    float vSMA = ta.sma(volume, len)
    float wPath = 0.0
    for i = 0 to len - 1
        float vNorm = vSMA > 0 ? volume[i] / vSMA : 1
        wPath += math.abs(close[i] - close[i + 1]) * math.min(vNorm, 3)
    wPath > 0 ? net / wPath : 0.0

f_kaufman(len) =>
    float net = math.abs(close - close[len])
    float path = ta.sma(math.abs(close - close[1]), len) * len
    path > 0 ? net / path : 0.0

er = useVWER ? f_vwer(erLength) : f_kaufman(erLength)

// ── Choppiness ──
f_chop(len) =>
    float sumTR = ta.rma(ta.tr(true), len) * len
    float range = ta.highest(len) - ta.lowest(len)
    range > 0 ? 100 * math.log10(sumTR / range) / math.log10(len) : 50

chop = f_chop(erLength)
isChoppy = useRegime and chop > chopThreshold

// ── Adaptive Multiplier ──
rawF = maxFactor - (er * (maxFactor - minFactor))
dynF = ta.ema(rawF, smoothLength)

// ── Supertrend ──
[stLine, stDir] = ta.supertrend(dynF * ta.atr(atrPeriod), atrPeriod)
// Note: Use custom implementation for full control (see docs)

bool isUp = stDir < 0
bool isDown = stDir > 0
bool flipped = ta.change(stDir) != 0

// ── Entries ──
if isUp and flipped and not isChoppy
    strategy.entry("Long", strategy.long)
if isDown and flipped and not isChoppy
    strategy.entry("Short", strategy.short)

// ── Exits ──
if isDown and strategy.position_size > 0
    strategy.close("Long", comment="ST")
if isUp and strategy.position_size < 0
    strategy.close("Short", comment="ST")

plot(stLine, "ST", isUp ? color.teal : color.red, 2)
`;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "#000000cc", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, width: "100%", maxWidth: 740, maxHeight: "88vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 18px", borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>Pine Script v6 Export (PRO v2.1)</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { navigator.clipboard.writeText(script); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              style={{ padding: "5px 14px", borderRadius: 6, border: `1px solid ${C.accent}`, background: "transparent", color: C.accent, fontSize: 11, cursor: "pointer", fontFamily: "monospace" }}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button onClick={onClose} style={{ padding: "5px 12px", borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", color: C.sub, fontSize: 11, cursor: "pointer" }}>Close</button>
          </div>
        </div>
        <pre style={{ flex: 1, overflow: "auto", margin: 0, padding: "14px 18px", fontSize: 10.5, lineHeight: 1.7, color: "#7dd3b0", fontFamily: "'SF Mono','Fira Code',monospace", background: "#060810" }}>{script}</pre>
      </div>
    </div>
  );
}

// ─── Trade Log ────────────────────────────────────────────────────────────────
function TradeLog({ trades }) {
  const [page, setPage] = useState(0);
  const PAGE = 20;
  const total = trades.length;
  const slice = trades.slice(page * PAGE, (page + 1) * PAGE);
  const pages = Math.ceil(total / PAGE);

  if (!total) return (
    <div style={{ padding: "20px", textAlign: "center", color: C.sub, fontSize: 11 }}>No trades</div>
  );

  const qualityColor = q => q >= 4 ? C.yellow : q >= 3 ? C.blue : q >= 2 ? C.accent : C.sub;

  const TH = ({ children, right }) => (
    <th style={{ padding: "6px 10px", fontSize: 9, color: C.sub, fontWeight: 600, letterSpacing: "0.08em", textAlign: right ? "right" : "left", borderBottom: `1px solid ${C.border}`, background: C.panel2 }}>{children}</th>
  );

  return (
    <div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
          <thead>
            <tr>
              <TH>#</TH><TH>Dir</TH><TH>Q</TH><TH>Entry</TH><TH>Exit</TH>
              <TH right>Entry $</TH><TH right>Exit $</TH>
              <TH right>Net%</TH><TH right>Bars</TH><TH right>Exit</TH>
            </tr>
          </thead>
          <tbody>
            {slice.map(t => (
              <tr key={t.n} style={{ borderBottom: `1px solid ${C.border}11`, background: t.n % 2 === 0 ? C.panel2 + "60" : "transparent" }}>
                <td style={{ padding: "5px 10px", color: C.sub, fontFamily: "monospace" }}>{t.n}</td>
                <td style={{ padding: "5px 10px" }}>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: t.dir === "Long" ? C.accent + "22" : C.red + "22", color: t.dir === "Long" ? C.accent : C.red }}>{t.dir}</span>
                </td>
                <td style={{ padding: "5px 10px", fontFamily: "monospace", fontWeight: 700, color: qualityColor(t.quality || 0), fontSize: 9 }}>{t.quality || "—"}</td>
                <td style={{ padding: "5px 10px", color: C.sub, fontSize: 9 }}>{fmtTime(t.entryTime)}</td>
                <td style={{ padding: "5px 10px", color: C.sub, fontSize: 9 }}>{fmtTime(t.exitTime)}</td>
                <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "monospace", color: C.label }}>{(+t.entryPrice).toFixed(2)}</td>
                <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "monospace", color: C.label }}>{(+t.exitPrice).toFixed(2)}</td>
                <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "monospace", color: +t.netPnlPct >= 0 ? C.accent : C.red, fontWeight: 700 }}>{+t.netPnlPct >= 0 ? "+" : ""}{t.netPnlPct}%</td>
                <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "monospace", color: C.sub }}>{t.bars}</td>
                <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "monospace", color: C.label, fontSize: 8 }}>{t.exitReason || "flip"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: "10px" }}>
          <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} style={{ padding: "3px 10px", borderRadius: 5, border: `1px solid ${C.border}`, background: "transparent", color: page === 0 ? C.border : C.sub, cursor: page === 0 ? "default" : "pointer", fontSize: 10 }}>Prev</button>
          <span style={{ fontSize: 10, color: C.sub, lineHeight: "22px" }}>{page + 1}/{pages} &middot; {total} trades</span>
          <button onClick={() => setPage(Math.min(pages - 1, page + 1))} disabled={page === pages - 1} style={{ padding: "3px 10px", borderRadius: 5, border: `1px solid ${C.border}`, background: "transparent", color: page === pages - 1 ? C.border : C.sub, cursor: page === pages - 1 ? "default" : "pointer", fontSize: 10 }}>Next</button>
        </div>
      )}
    </div>
  );
}

// ─── Monthly Returns Table ────────────────────────────────────────────────────
function MonthlyTable({ monthlyRets }) {
  if (!monthlyRets || monthlyRets.length === 0) return null;
  const totalPnl = monthlyRets.reduce((s, m) => s + m.pnl, 0);
  const winMonths = monthlyRets.filter(m => m.pnl > 0).length;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${C.border}` }}>
            <th style={{ padding: "6px 10px", fontSize: 9, color: C.sub, textAlign: "left" }}>Month</th>
            <th style={{ padding: "6px 10px", fontSize: 9, color: C.sub, textAlign: "right" }}>Trades</th>
            <th style={{ padding: "6px 10px", fontSize: 9, color: C.sub, textAlign: "right" }}>W</th>
            <th style={{ padding: "6px 10px", fontSize: 9, color: C.sub, textAlign: "right" }}>L</th>
            <th style={{ padding: "6px 10px", fontSize: 9, color: C.sub, textAlign: "right" }}>P&L</th>
          </tr>
        </thead>
        <tbody>
          {monthlyRets.map(m => (
            <tr key={m.month} style={{ borderBottom: `1px solid ${C.border}11`, background: m.pnl > 0 ? C.accent + "08" : m.pnl < 0 ? C.red + "08" : "transparent" }}>
              <td style={{ padding: "5px 10px", color: C.label, fontSize: 9 }}>{fmtMonth(m.month)}</td>
              <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "monospace", color: C.sub }}>{m.trades}</td>
              <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "monospace", color: C.accent }}>{m.wins}</td>
              <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "monospace", color: C.red }}>{m.losses}</td>
              <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: m.pnl >= 0 ? C.accent : C.red }}>{m.pnl >= 0 ? "+" : ""}${m.pnl.toFixed(0)}</td>
            </tr>
          ))}
          <tr style={{ borderTop: `2px solid ${C.border}`, background: C.panel2 }}>
            <td style={{ padding: "6px 10px", color: C.text, fontWeight: 700, fontSize: 9 }}>TOTAL</td>
            <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "monospace", color: C.text }}>{monthlyRets.reduce((s, m) => s + m.trades, 0)}</td>
            <td colSpan={2} style={{ padding: "6px 10px", textAlign: "right", fontFamily: "monospace", color: C.accent }}>{winMonths}/{monthlyRets.length} months</td>
            <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: totalPnl >= 0 ? C.accent : C.red }}>{totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── Walk-Forward Results Table ───────────────────────────────────────────────
function WalkForwardTable({ wfResults }) {
  if (!wfResults || wfResults.length === 0) return null;

  const avgReturn = (wfResults.reduce((s, r) => s + r.oosReturn, 0) / wfResults.length).toFixed(2);
  const profitable = wfResults.filter(r => r.oosReturn > 0).length;

  return (
    <div>
      <div style={{ padding: "8px 14px", fontSize: 10, color: C.label }}>
        {wfResults.length} windows &middot; {profitable}/{wfResults.length} profitable &middot; avg return: {avgReturn}%
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.border}` }}>
              <th style={{ padding: "5px 8px", color: C.sub, textAlign: "left" }}>W</th>
              <th style={{ padding: "5px 8px", color: C.sub, textAlign: "left" }}>Test Range</th>
              <th style={{ padding: "5px 8px", color: C.sub, textAlign: "right" }}>ATR</th>
              <th style={{ padding: "5px 8px", color: C.sub, textAlign: "right" }}>ER</th>
              <th style={{ padding: "5px 8px", color: C.sub, textAlign: "right" }}>minF</th>
              <th style={{ padding: "5px 8px", color: C.sub, textAlign: "right" }}>maxF</th>
              <th style={{ padding: "5px 8px", color: C.sub, textAlign: "right" }}>Return</th>
              <th style={{ padding: "5px 8px", color: C.sub, textAlign: "right" }}>Sharpe</th>
              <th style={{ padding: "5px 8px", color: C.sub, textAlign: "right" }}>Trades</th>
            </tr>
          </thead>
          <tbody>
            {wfResults.map((r, i) => (
              <tr key={i} style={{ borderBottom: `1px solid ${C.border}11`, background: r.oosReturn > 0 ? C.accent + "08" : C.red + "08" }}>
                <td style={{ padding: "4px 8px", color: C.sub }}>#{r.window}</td>
                <td style={{ padding: "4px 8px", color: C.label }}>{fmtDate(candlesRef[r.testStart]?.t)} to {fmtDate(candlesRef[r.testEnd]?.t)}</td>
                <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: C.text }}>{r.bestParams.atrPeriod}</td>
                <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: C.text }}>{r.bestParams.erLength}</td>
                <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: C.accent }}>{r.bestParams.minFactor.toFixed(1)}</td>
                <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: C.red }}>{r.bestParams.maxFactor.toFixed(1)}</td>
                <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: r.oosReturn >= 0 ? C.accent : C.red }}>{r.oosReturn.toFixed(1)}%</td>
                <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: C.yellow }}>{r.oosSharpe.toFixed(2)}</td>
                <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: C.sub }}>{r.testStats.totalTrades}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
// Need a candles ref for WF table - handled in main app differently

// ─── Monte Carlo Summary ──────────────────────────────────────────────────────
function MonteCarloSummary({ mcResults }) {
  if (!mcResults) return null;
  const { finalEquity, maxDD, netReturn, ruinRate } = mcResults;

  return (
    <div style={{ padding: "10px 14px" }}>
      <div style={{ fontSize: 9, color: C.sub, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Monte Carlo Results (1000 iterations)</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px" }}>
        <StatRow label="Final Equity (median)" value={`$${(finalEquity.p50 / 1000).toFixed(1)}K`} color={C.accent} mono />
        <StatRow label="Final Equity (5th %ile)" value={`$${(finalEquity.p5 / 1000).toFixed(1)}K`} color={finalEquity.p5 >= (mcResults.startEquity || 10000) ? C.accent : C.red} mono />
        <StatRow label="Final Equity (95th %ile)" value={`$${(finalEquity.p95 / 1000).toFixed(1)}K`} color={C.accent} mono />
        <StatRow label="Max DD (median)" value={`${(maxDD.p50 * 100).toFixed(1)}%`} color={C.red} mono />
        <StatRow label="Net Return (median)" value={`${(netReturn.p50 * 100).toFixed(1)}%`} color={netReturn.p50 >= 0 ? C.accent : C.red} mono />
        <StatRow label="Ruin Rate (>50% loss)" value={`${(ruinRate * 100).toFixed(1)}%`} color={ruinRate > 0.05 ? C.red : C.accent} mono />
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════

export default function App() {
  const now = Date.now();
  const d30 = 30 * 86400e3;

  const [symbol, setSymbol] = useState("SOLUSDT");
  const [interval, setInterval] = useState("1h");
  const [startDate, setStartDate] = useState(toISO(now - d30));
  const [endDate, setEndDate] = useState(toISO(now));

  const [candles, setCandles] = useState([]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [showPine, setShowPine] = useState(false);

  // HTF confluence state
  const [htfMultiplier, setHtfMultiplier] = useState(0); // 0 = off
  const [htfCandles, setHtfCandles] = useState(null);
  const [htfResult, setHtfResult] = useState(null);

  // Tabs and advanced features
  const [activeTab, setActiveTab] = useState("overview");
  const [showCI, setShowCI] = useState(true);
  const [optResults, setOptResults] = useState(null);
  const [optRunning, setOptRunning] = useState(false);
  const [optProgress, setOptProgress] = useState(0);
  const [mcResults, setMcResults] = useState(null);
  const [mcRunning, setMcRunning] = useState(false);
  const [wfResults, setWfResults] = useState(null);
  const [wfRunning, setWfRunning] = useState(false);

  const [params, setParams] = useState({
    atrPeriod: 10, erLength: 14, smoothLength: 5,
    minFactor: 1.5, maxFactor: 4.5,
    useRegimeFilter: true, useVWER: false,
    chopThreshold: 61.8, riskPct: 0.01,
    startEquity: 10000, minStopPct: 0.001,
    barsPerYear: 365 * 24,
    // New features
    useTrailingStop: false,
    useBreakEven: false,
    breakEvenPct: 1.0,
    useATRSizing: false,
    atrMult: 2,
    sessionFilter: false,
    sessionHours: [0, 24],
  });

  const [viewRange, setViewRange] = useState([0, 0]);
  const containerRef = useRef(null);
  const [chartW, setChartW] = useState(700);

  useEffect(() => {
    const obs = new ResizeObserver(([e]) => setChartW(e.contentRect.width));
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // ── Main backtest effect ──
  useEffect(() => {
    if (!candles.length) return;
    try {
      let htfAligned = null;
      if (htfResult && htfMultiplier > 0) {
        htfAligned = alignHTFDir(candles, htfCandles, htfResult.dir);
      }
      const r = runBacktest(candles, params, htfAligned);
      setResult(r);
    } catch (e) {
      console.error("Backtest error:", e);
      setError("Backtest failed: " + e.message);
    }
  }, [candles, params, htfResult, htfMultiplier]);

  // Reset view range
  useEffect(() => {
    if (!candles.length) return;
    const n = candles.length;
    const visible = Math.min(n, 200);
    setViewRange([n - visible, n]);
  }, [candles]);

  // ── Fetch data ──
  const fetch = useCallback(async () => {
    setLoading(true); setError(""); setProgress(0);
    setCandles([]); setResult(null); setOptResults(null); setMcResults(null); setWfResults(null);
    setHtfCandles(null); setHtfResult(null);

    try {
      const startMs = fromISO(startDate);
      const endMs = Math.min(fromISO(endDate) + 86400e3 - 1, now);
      if (startMs >= endMs) throw new Error("Start date must be before end date");

      const data = await fetchKlines(symbol, interval, startMs, endMs, p => setProgress(p));
      if (!data.length) throw new Error("No data returned");
      setCandles(data);
      setProgress(100);

      // Fetch HTF data if confluence enabled
      if (htfMultiplier > 0) {
        const htfMs = INTERVALS.find(i => i.label === interval)?.ms * htfMultiplier;
        const htfLabel = INTERVALS.find(i => i.ms >= htfMs)?.label || interval;
        try {
          const htfData = await fetchKlines(symbol, htfLabel, startMs, endMs);
          setHtfCandles(htfData);
          // Compute ST on HTF
          const htfAtr = atrRMA(htfData, params.atrPeriod);
          const htfEr = params.useVWER ? volumeWeightedER(htfData, params.erLength) : kaufmanER(htfData, params.erLength);
          const htfRawF = htfEr.map(e => params.maxFactor - e * (params.maxFactor - params.minFactor));
          const htfSmoothF = ema(htfRawF, params.smoothLength);
          const htfST = adaptiveST(htfData, htfAtr, htfSmoothF);
          setHtfResult(htfST);
        } catch (e) {
          console.warn("HTF fetch failed:", e);
        }
      }
    } catch (e) {
      setError(e.message || "Fetch failed");
    } finally {
      setLoading(false);
    }
  }, [symbol, interval, startDate, endDate, htfMultiplier, params]);

  const applyPreset = useCallback(days => {
    setEndDate(toISO(now));
    setStartDate(toISO(now - days * 86400e3));
  }, []);

  const setP = k => v => setParams(p => ({ ...p, [k]: v }));

  // ── Run optimization ──
  const runOpt = useCallback(async () => {
    if (!candles.length) return;
    setOptRunning(true); setOptProgress(0); setOptResults(null);
    const ranges = {
      atrPeriod: [8, 10, 14],
      erLength: [10, 14, 20],
      smoothLength: [3, 5, 8],
      minFactor: [1.0, 1.5, 2.0, 2.5],
      maxFactor: [3.0, 4.0, 5.0, 6.0],
    };
    setTimeout(() => {
      try {
        const results = runOptimization(candles, params, ranges, p => setOptProgress(p));
        setOptResults(results.slice(0, 20));
      } catch (e) {
        setError("Optimization failed: " + e.message);
      }
      setOptRunning(false);
    }, 50);
  }, [candles, params]);

  // ── Run Monte Carlo ──
  const runMC = useCallback(() => {
    if (!result || !result.trades.length) return;
    setMcRunning(true);
    setTimeout(() => {
      try {
        const mc = runMonteCarlo(result.trades, result.equityCurve, params.startEquity || 10000, 1000);
        setMcResults(mc);
      } catch (e) {
        setError("Monte Carlo failed: " + e.message);
      }
      setMcRunning(false);
    }, 50);
  }, [result, params]);

  // ── Run Walk-Forward ──
  const runWF = useCallback(() => {
    if (!candles.length) return;
    setWfRunning(true);
    setTimeout(() => {
      try {
        const trainSize = Math.floor(candles.length * 0.6);
        const testSize = Math.floor(candles.length * 0.2);
        const optRanges = {
          atrPeriod: [8, 10, 14],
          erLength: [10, 14],
          smoothLength: [3, 5],
          minFactor: [1.0, 1.5, 2.0],
          maxFactor: [3.0, 4.0, 5.0],
        };
        const wf = runWalkForward(candles, params, optRanges, { trainSize, testSize });
        setWfResults(wf);
      } catch (e) {
        setError("Walk-forward failed: " + e.message);
      }
      setWfRunning(false);
    }, 50);
  }, [candles, params]);

  const lastER = result?.er?.filter(v => !isNaN(v)).at(-1) ?? 0;
  const lastF = result?.smoothF?.filter(v => !isNaN(v)).at(-1) ?? 0;
  const lastCI = result?.ci?.filter(v => !isNaN(v)).at(-1) ?? 50;
  const regime = lastER > 0.62 ? "Trending" : lastER > 0.38 ? "Mixed" : "Choppy";
  const regimeColor = lastER > 0.62 ? C.accent : lastER > 0.38 ? C.yellow : C.red;

  const candleCount = candles.length;
  const viewLen = viewRange[1] - viewRange[0];

  const moveView = dir => {
    const step = Math.round(viewLen * 0.3);
    setViewRange(([s, e]) => {
      const ns = Math.max(0, Math.min(s + dir * step, candleCount - viewLen));
      return [ns, ns + viewLen];
    });
  };

  const zoomView = dir => {
    setViewRange(([s, e]) => {
      const len = e - s;
      const newLen = Math.max(30, Math.min(candleCount, Math.round(len * (dir > 0 ? 0.6 : 1.6))));
      const center = Math.round((s + e) / 2);
      const ns = Math.max(0, Math.min(center - Math.round(newLen / 2), candleCount - newLen));
      return [ns, ns + newLen];
    });
  };

  const s = result?.stats;
  const tabs = ["overview", "monthly", "optimize", "montecarlo", "walkforward"];

  return (
    <div style={{ background: C.bg, minHeight: "100vh", width: "100%", color: C.text, fontFamily: "-apple-system,'SF Pro Text',sans-serif" }}>
      {showPine && <PineModal params={params} onClose={() => setShowPine(false)} />}

      {/* ── Top bar ── */}
      <div style={{ borderBottom: `1px solid ${C.border}`, background: C.panel, padding: "10px 16px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <select value={symbol} onChange={e => setSymbol(e.target.value)} style={{ background: C.panel2, border: `1px solid ${C.border2}`, color: C.text, borderRadius: 7, padding: "6px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "monospace" }}>
            {SYMBOLS.map(s => <option key={s}>{s}</option>)}
          </select>

          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {INTERVALS.map(iv => (
              <Pill key={iv.label} active={interval === iv.label} onClick={() => setInterval(iv.label)}>{iv.label}</Pill>
            ))}
          </div>

          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ background: C.panel2, border: `1px solid ${C.border2}`, color: C.label, borderRadius: 6, padding: "5px 8px", fontSize: 11 }} />
            <span style={{ color: C.sub, fontSize: 11 }}>to</span>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={{ background: C.panel2, border: `1px solid ${C.border2}`, color: C.label, borderRadius: 6, padding: "5px 8px", fontSize: 11 }} />
          </div>

          <div style={{ display: "flex", gap: 4 }}>
            {PRESETS.map(p => <Pill key={p.label} onClick={() => applyPreset(p.days)}>{p.label}</Pill>)}
          </div>

          <button onClick={fetch} disabled={loading} style={{ marginLeft: "auto", padding: "7px 20px", borderRadius: 7, cursor: loading ? "wait" : "pointer", background: loading ? C.border : C.accent + "22", border: `1px solid ${loading ? C.border : C.accent}66`, color: loading ? C.sub : C.accent, fontSize: 12, fontWeight: 700 }}>
            {loading ? `Loading ${progress}%...` : "Fetch & Run"}
          </button>

          <button onClick={() => setShowPine(true)} style={{ padding: "7px 14px", borderRadius: 7, cursor: "pointer", background: C.purple + "18", border: `1px solid ${C.purple}44`, color: C.purple, fontSize: 11, fontWeight: 600 }}>Pine</button>
        </div>

        {error && (
          <div style={{ marginTop: 8, padding: "6px 12px", borderRadius: 6, background: C.red + "18", border: `1px solid ${C.red}44`, color: C.red, fontSize: 11 }}>{error}</div>
        )}
      </div>

      {/* ── Body ── */}
      <div style={{ display: "flex", minHeight: "calc(100vh - 65px)" }}>

        {/* Sidebar */}
        <div style={{ width: 215, flexShrink: 0, borderRight: `1px solid ${C.border}`, padding: "16px 14px", background: C.panel, overflowY: "auto" }}>

          <div style={{ fontSize: 9, color: C.sub, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 14 }}>Core Parameters</div>
          <Slider label="ATR Period" value={params.atrPeriod} min={5} max={30} step={1} onChange={setP("atrPeriod")} />
          <Slider label="Min Factor" value={params.minFactor} min={0.5} max={3.5} step={0.1} onChange={setP("minFactor")} unit="x" color={C.accent} />
          <Slider label="Max Factor" value={params.maxFactor} min={2.0} max={9.0} step={0.1} onChange={setP("maxFactor")} unit="x" color={C.red} />

          <div style={{ fontSize: 9, color: C.sub, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 14, marginTop: 16 }}>Efficiency Engine</div>
          <Slider label="ER Window" value={params.erLength} min={5} max={50} step={1} onChange={setP("erLength")} color={C.purple} />
          <Slider label="EMA Smooth" value={params.smoothLength} min={1} max={20} step={1} onChange={setP("smoothLength")} color={C.yellow} />

          <div style={{ fontSize: 9, color: C.sub, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 14, marginTop: 16 }}>Risk Management</div>
          <Toggle label="Trailing Stop" value={params.useTrailingStop} onChange={setP("useTrailingStop")} color={C.blue} />
          <Toggle label="Break-Even Stop" value={params.useBreakEven} onChange={setP("useBreakEven")} color={C.orange} />
          {params.useBreakEven && (
            <Slider label="BE Trigger %" value={params.breakEvenPct} min={0.5} max={5} step={0.5} onChange={setP("breakEvenPct")} color={C.orange} unit="%" />
          )}
          <Toggle label="ATR-Based Sizing" value={params.useATRSizing} onChange={setP("useATRSizing")} color={C.purple} />
          {params.useATRSizing && (
            <Slider label="ATR Multiplier" value={params.atrMult} min={1} max={5} step={0.5} onChange={setP("atrMult")} color={C.purple} unit="x" />
          )}

          <div style={{ fontSize: 9, color: C.sub, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 14, marginTop: 16 }}>Filters</div>
          <Toggle label="Regime Filter (CI)" value={params.useRegimeFilter} onChange={setP("useRegimeFilter")} color={C.blue} />
          {params.useRegimeFilter && (
            <Slider label="Chop Threshold" value={params.chopThreshold} min={50} max={80} step={1} onChange={setP("chopThreshold")} color={C.blue} />
          )}
          <Toggle label="Volume-Weighted ER" value={params.useVWER} onChange={setP("useVWER")} color={C.orange} />

          <div style={{ fontSize: 9, color: C.sub, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 14, marginTop: 16 }}>Multi-Timeframe</div>
          <div style={{ fontSize: 10, color: C.sub, marginBottom: 8 }}>HTF Confluence</div>
          <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
            {HTF_INTERVALS.map(h => (
              <Pill key={h.label} active={htfMultiplier === h.mult} onClick={() => setHtfMultiplier(h.mult)}>{h.label}</Pill>
            ))}
          </div>
          {htfMultiplier > 0 && (
            <div style={{ fontSize: 9, color: C.accent, marginTop: 6 }}>
              Only taking trades aligned with HTF trend
            </div>
          )}

          {/* Live state */}
          <div style={{ marginTop: 18, padding: "10px", borderRadius: 8, background: C.bg, border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 9, color: C.sub, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Live State</div>
            <StatRow label="ER" value={(lastER * 100).toFixed(1) + "%"} color={regimeColor} mono />
            <StatRow label="Factor" value={lastF.toFixed(2) + "x"} color={C.yellow} mono />
            <StatRow label="Choppiness" value={lastCI.toFixed(1)} color={lastCI > 61.8 ? C.red : lastCI > 50 ? C.yellow : C.accent} mono />
            <StatRow label="Regime" value={regime} color={regimeColor} />
            {candleCount > 0 && <StatRow label="Bars" value={candleCount.toLocaleString()} color={C.sub} mono />}
          </div>

          {/* Enhanced Stats */}
          {s && (
            <>
              <div style={{ fontSize: 9, color: C.sub, letterSpacing: "0.1em", textTransform: "uppercase", margin: "18px 0 10px" }}>Performance</div>
              <div style={{ padding: "10px", borderRadius: 8, background: C.bg, border: `1px solid ${C.border}` }}>
                <StatRow label="Net Return" value={s.netReturn + "%"} color={+s.netReturn >= 0 ? C.accent : C.red} mono />
                <StatRow label="Ann. Return" value={s.annReturn + "%"} color={+s.annReturn >= 0 ? C.accent : C.red} mono />
                <StatRow label="Win Rate" value={s.winRate + "%"} color={C.text} mono />
                <StatRow label="Profit Factor" value={s.profitFactor} color={+s.profitFactor >= 1.5 ? C.accent : +s.profitFactor >= 1 ? C.yellow : C.red} mono />
                <StatRow label="Sharpe" value={s.sharpe} color={+s.sharpe >= 1 ? C.accent : C.sub} mono />
                <StatRow label="Sortino" value={s.sortino} color={+s.sortino >= 1 ? C.accent : C.sub} mono />
                <StatRow label="Calmar" value={s.calmar} color={+s.calmar >= 1 ? C.accent : C.sub} mono />
                <StatRow label="Recovery" value={s.recoveryFactor} color={+s.recoveryFactor >= 2 ? C.accent : C.sub} mono />
                <StatRow label="Max DD" value={s.maxDD + "%"} color={C.red} mono />
                <StatRow label="Max DD Dur." value={s.maxDDD + " bars"} color={C.red} mono />
                <StatRow label="Kelly" value={s.kelly + "%"} color={C.purple} mono />
                <div style={{ borderTop: `1px solid ${C.border}33`, margin: "6px 0", paddingTop: 6 }}>
                  <StatRow label="Long WR" value={s.longWinRate + "%"} color={C.accent} mono />
                  <StatRow label="Short WR" value={s.shortWinRate + "%"} color={C.red} mono />
                </div>
                <div style={{ borderTop: `1px solid ${C.border}33`, margin: "6px 0", paddingTop: 6 }}>
                  <StatRow label="Flip exits" value={s.flipExits} color={C.sub} mono />
                  <StatRow label="Trail exits" value={s.trailExits} color={C.blue} mono />
                  <StatRow label="BE exits" value={s.beExits} color={C.orange} mono />
                </div>
              </div>
            </>
          )}

          {/* CSV Export */}
          {result && (
            <div style={{ marginTop: 12, display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button onClick={() => exportTradesCSV(result.trades, symbol)} style={{ padding: "4px 8px", borderRadius: 5, border: `1px solid ${C.border2}`, background: "transparent", color: C.sub, fontSize: 9, cursor: "pointer", fontFamily: "monospace" }}>
                Export Trades CSV
              </button>
              <button onClick={() => exportEquityCSV(result.equityCurve, candles, symbol)} style={{ padding: "4px 8px", borderRadius: 5, border: `1px solid ${C.border2}`, background: "transparent", color: C.sub, fontSize: 9, cursor: "pointer", fontFamily: "monospace" }}>
                Export Equity CSV
              </button>
            </div>
          )}
        </div>

        {/* Main Content */}
        <div ref={containerRef} style={{ flex: 1, padding: "14px 16px", overflow: "hidden" }}>

          {!candleCount && !loading && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 300, color: C.sub, gap: 12 }}>
              <div style={{ fontSize: 28, color: C.accent, fontWeight: 700 }}>Adaptive Supertrend PRO</div>
              <div style={{ fontSize: 13, color: C.label }}>Select symbol, interval & date range, then click Fetch & Run</div>
              <div style={{ fontSize: 11, color: C.sub }}>Pulls live OHLCV from Binance FAPI — no key needed</div>
              <div style={{ fontSize: 10, color: C.sub + "88", marginTop: 8, textAlign: "center", lineHeight: 1.6 }}>
                v2.1: Trailing Stops &middot; Break-Even &middot; ATR Sizing &middot; Multi-TF Confluence &middot; Walk-Forward &middot; Monte Carlo &middot; Crosshair Tooltips
              </div>
            </div>
          )}

          {candleCount > 0 && result && (
            <>
              {/* Controls */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, color: C.label, fontFamily: "monospace" }}>
                  {symbol} &middot; {interval} &middot; {candleCount.toLocaleString()} bars &middot; {fmtDate(candles[0].t)} to {fmtDate(candles[candleCount - 1].t)}
                  {htfMultiplier > 0 && ` &middot; HTF: ${htfMultiplier}x`}
                </span>
                <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
                  <button onClick={() => zoomView(1)} style={navBtn}>+</button>
                  <button onClick={() => zoomView(-1)} style={navBtn}>-</button>
                  <button onClick={() => moveView(-1)} style={navBtn}>Left</button>
                  <button onClick={() => moveView(1)} style={navBtn}>Right</button>
                  <button onClick={() => setViewRange([0, candleCount])} style={navBtn}>All</button>
                  <button onClick={() => { const n = candleCount, v = Math.min(n, 200); setViewRange([n - v, n]); }} style={navBtn}>Latest</button>
                </div>
                <div style={{ padding: "3px 8px", borderRadius: 4, fontSize: 9, fontWeight: 700, background: regimeColor + "20", color: regimeColor, border: `1px solid ${regimeColor}44` }}>
                  {regime} ER={(lastER * 100).toFixed(0)}% CI={lastCI.toFixed(0)}
                </div>
              </div>

              {/* Tab Navigation */}
              <div style={{ display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
                {tabs.map(tab => (
                  <Pill key={tab} active={activeTab === tab} onClick={() => setActiveTab(tab)}>
                    {tab === "overview" ? "Overview" : tab === "monthly" ? "Monthly" : tab === "optimize" ? "Optimize" : tab === "montecarlo" ? "Monte Carlo" : "Walk-Forward"}
                  </Pill>
                ))}
              </div>

              {/* ── OVERVIEW TAB ── */}
              {activeTab === "overview" && (
                <>
                  <Panel>
                    <PriceChart candles={candles} result={result} width={chartW - 32} height={320} symbol={symbol} viewRange={viewRange} />
                  </Panel>
                  <Panel>
                    <VolumeChart candles={candles} result={result} width={chartW - 32} height={70} viewRange={viewRange} />
                  </Panel>
                  <Panel title="Efficiency Ratio &middot; Multiplier Factor &middot; Choppiness Overlay">
                    <ERChart result={result} width={chartW - 32} height={100} minFactor={params.minFactor} maxFactor={params.maxFactor} viewRange={viewRange} showCI={showCI && params.useRegimeFilter} />
                  </Panel>
                  <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
                    <Panel title={`Equity Curve &middot; $${(params.startEquity / 1000).toFixed(0)}K start`}>
                      <EquityChart result={result} width={chartW * 0.65} height={110} />
                    </Panel>
                    <Panel title="DD Distribution">
                      <DDDistributionChart ddDistribution={result.ddDistribution} width={chartW * 0.3} height={110} />
                    </Panel>
                  </div>
                  <Panel title="Underwater Chart">
                    <UnderwaterChart result={result} width={chartW - 32} height={80} />
                  </Panel>
                  <Panel title={`Trade Log &middot; ${result.trades.length} trades`}>
                    <TradeLog trades={result.trades} />
                  </Panel>
                </>
              )}

              {/* ── MONTHLY TAB ── */}
              {activeTab === "monthly" && (
                <Panel title="Monthly Returns Breakdown">
                  <MonthlyTable monthlyRets={result.monthlyRets} />
                </Panel>
              )}

              {/* ── OPTIMIZE TAB ── */}
              {activeTab === "optimize" && (
                <>
                  <Panel>
                    <div style={{ padding: "12px 14px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                        <span style={{ fontSize: 11, color: C.label }}>Parameter Optimization (minF x maxF heatmap)</span>
                        <button onClick={runOpt} disabled={optRunning} style={{ padding: "5px 14px", borderRadius: 6, border: `1px solid ${optRunning ? C.border : C.accent}66`, background: optRunning ? C.border : C.accent + "22", color: optRunning ? C.sub : C.accent, fontSize: 11, cursor: optRunning ? "wait" : "pointer" }}>
                          {optRunning ? `Running ${optProgress}%...` : "Run Optimization"}
                        </button>
                      </div>
                      {optResults && (
                        <>
                          <OptimizationHeatmap results={optResults} width={chartW - 60} height={200} />
                          <div style={{ marginTop: 10, maxHeight: 250, overflow: "auto" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9 }}>
                              <thead>
                                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                                  <th style={{ padding: "4px 6px", color: C.sub, textAlign: "left" }}>Rank</th>
                                  <th style={{ padding: "4px 6px", color: C.sub, textAlign: "right" }}>ATR</th>
                                  <th style={{ padding: "4px 6px", color: C.sub, textAlign: "right" }}>ER</th>
                                  <th style={{ padding: "4px 6px", color: C.sub, textAlign: "right" }}>Sm</th>
                                  <th style={{ padding: "4px 6px", color: C.sub, textAlign: "right" }}>minF</th>
                                  <th style={{ padding: "4px 6px", color: C.sub, textAlign: "right" }}>maxF</th>
                                  <th style={{ padding: "4px 6px", color: C.sub, textAlign: "right" }}>Return</th>
                                  <th style={{ padding: "4px 6px", color: C.sub, textAlign: "right" }}>Sharpe</th>
                                  <th style={{ padding: "4px 6px", color: C.sub, textAlign: "right" }}>PF</th>
                                  <th style={{ padding: "4px 6px", color: C.sub, textAlign: "right" }}>DD</th>
                                </tr>
                              </thead>
                              <tbody>
                                {optResults.slice(0, 10).map((r, i) => (
                                  <tr key={i} style={{ borderBottom: `1px solid ${C.border}11`, background: i === 0 ? C.accent + "11" : "transparent", cursor: "pointer" }}
                                    onClick={() => { setParams(p => ({ ...p, ...r.params })); }}>
                                    <td style={{ padding: "4px 6px", color: i === 0 ? C.accent : C.sub, fontWeight: i === 0 ? 700 : 400 }}>#{i + 1}</td>
                                    <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "monospace", color: C.label }}>{r.params.atrPeriod}</td>
                                    <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "monospace", color: C.label }}>{r.params.erLength}</td>
                                    <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "monospace", color: C.label }}>{r.params.smoothLength}</td>
                                    <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "monospace", color: C.accent }}>{r.params.minFactor.toFixed(1)}</td>
                                    <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "monospace", color: C.red }}>{r.params.maxFactor.toFixed(1)}</td>
                                    <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: r.netReturn >= 0 ? C.accent : C.red }}>{r.netReturn.toFixed(1)}%</td>
                                    <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "monospace", color: C.yellow }}>{r.sharpe.toFixed(2)}</td>
                                    <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "monospace", color: C.text }}>{r.profitFactor.toFixed(2)}</td>
                                    <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "monospace", color: C.red }}>{r.maxDD.toFixed(1)}%</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            <div style={{ marginTop: 6, fontSize: 9, color: C.sub }}>Click any row to apply parameters</div>
                          </div>
                        </>
                      )}
                    </div>
                  </Panel>
                </>
              )}

              {/* ── MONTE CARLO TAB ── */}
              {activeTab === "montecarlo" && (
                <>
                  <Panel>
                    <div style={{ padding: "12px 14px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                        <span style={{ fontSize: 11, color: C.label }}>Monte Carlo Simulation — Trade Order Randomization</span>
                        <button onClick={runMC} disabled={mcRunning || !result?.trades.length} style={{ padding: "5px 14px", borderRadius: 6, border: `1px solid ${mcRunning ? C.border : C.purple}66`, background: mcRunning ? C.border : C.purple + "22", color: mcRunning ? C.sub : C.purple, fontSize: 11, cursor: mcRunning ? "wait" : "pointer" }}>
                          {mcRunning ? "Running 1000 sims..." : "Run Monte Carlo"}
                        </button>
                      </div>
                      {mcResults && (
                        <>
                          <MonteCarloChart mcResults={mcResults} width={chartW - 60} height={180} />
                          <MonteCarloSummary mcResults={mcResults} />
                        </>
                      )}
                      {!mcResults && !mcRunning && (
                        <div style={{ padding: "20px", textAlign: "center", color: C.sub, fontSize: 11 }}>
                          Run Monte Carlo to see robustness analysis. Shuffles trade order 1000 times to test strategy resilience.
                        </div>
                      )}
                    </div>
                  </Panel>
                </>
              )}

              {/* ── WALK-FORWARD TAB ── */}
              {activeTab === "walkforward" && (
                <>
                  <Panel>
                    <div style={{ padding: "12px 14px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                        <span style={{ fontSize: 11, color: C.label }}>Walk-Forward Analysis — In-Sample Optimize / Out-of-Sample Test</span>
                        <button onClick={runWF} disabled={wfRunning || candleCount < 500} style={{ padding: "5px 14px", borderRadius: 6, border: `1px solid ${wfRunning ? C.border : C.blue}66`, background: wfRunning ? C.border : C.blue + "22", color: wfRunning ? C.sub : C.blue, fontSize: 11, cursor: wfRunning ? "wait" : "pointer" }}>
                          {wfRunning ? "Running..." : "Run Walk-Forward"}
                        </button>
                      </div>
                      {wfResults && wfResults.length > 0 && (
                        <div style={{ overflowX: "auto" }}>
                          <div style={{ padding: "8px 0", fontSize: 10, color: C.label }}>
                            {wfResults.length} windows &middot; {wfResults.filter(r => r.oosReturn > 0).length}/{wfResults.length} profitable OOS &middot; avg OOS return: {(wfResults.reduce((s, r) => s + r.oosReturn, 0) / wfResults.length).toFixed(2)}%
                          </div>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9 }}>
                            <thead>
                              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                                <th style={{ padding: "5px 8px", color: C.sub, textAlign: "left" }}>W</th>
                                <th style={{ padding: "5px 8px", color: C.sub, textAlign: "left" }}>Test Period</th>
                                <th style={{ padding: "5px 8px", color: C.sub, textAlign: "right" }}>ATR</th>
                                <th style={{ padding: "5px 8px", color: C.sub, textAlign: "right" }}>ER</th>
                                <th style={{ padding: "5px 8px", color: C.sub, textAlign: "right" }}>minF</th>
                                <th style={{ padding: "5px 8px", color: C.sub, textAlign: "right" }}>maxF</th>
                                <th style={{ padding: "5px 8px", color: C.sub, textAlign: "right" }}>OOS Return</th>
                                <th style={{ padding: "5px 8px", color: C.sub, textAlign: "right" }}>OOS Sharpe</th>
                                <th style={{ padding: "5px 8px", color: C.sub, textAlign: "right" }}>Trades</th>
                              </tr>
                            </thead>
                            <tbody>
                              {wfResults.map((r, i) => (
                                <tr key={i} style={{ borderBottom: `1px solid ${C.border}11`, background: r.oosReturn > 0 ? C.accent + "08" : C.red + "08" }}>
                                  <td style={{ padding: "4px 8px", color: C.sub }}>#{r.window}</td>
                                  <td style={{ padding: "4px 8px", color: C.label, fontSize: 8 }}>
                                    {fmtDate(candles[r.testStart]?.t)} to {fmtDate(candles[r.testEnd]?.t)}
                                  </td>
                                  <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: C.text }}>{r.bestParams.atrPeriod}</td>
                                  <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: C.text }}>{r.bestParams.erLength}</td>
                                  <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: C.accent }}>{r.bestParams.minFactor.toFixed(1)}</td>
                                  <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: C.red }}>{r.bestParams.maxFactor.toFixed(1)}</td>
                                  <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: r.oosReturn >= 0 ? C.accent : C.red }}>{r.oosReturn.toFixed(1)}%</td>
                                  <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: C.yellow }}>{r.oosSharpe.toFixed(2)}</td>
                                  <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: C.sub }}>{r.testStats.totalTrades}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {(!wfResults || wfResults.length === 0) && !wfRunning && (
                        <div style={{ padding: "20px", textAlign: "center", color: C.sub, fontSize: 11 }}>
                          Requires 500+ bars. Splits data into train/test windows, optimizes on in-sample, validates on out-of-sample.
                        </div>
                      )}
                    </div>
                  </Panel>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const navBtn = {
  padding: "3px 9px", borderRadius: 5, border: `1px solid ${C.border2}`,
  background: "transparent", color: C.sub, fontSize: 11, cursor: "pointer"
};
