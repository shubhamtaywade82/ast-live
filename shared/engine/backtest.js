import { COST_RT } from "../constants.js";
import { predictLogistic, buildSignalFeatures } from "../ml/engine.js";
import {
  atrRMA, kaufmanER, volumeWeightedER, choppinessIndex, ema, adaptiveST, computeSignalQuality,
} from "./indicators.js";
export function runBacktest(candles, p, htfAlignedDir = null, options = {}) {
  const { initialEquity = null, evalStartIdx = 0 } = options;
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
  const startEquity = initialEquity ?? p.startEquity ?? 10000;
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
    if (i < evalStartIdx) {
      equityCurve[i] = equity;
      continue;
    }

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
        const htfDir = htfAlignedDir[i];
        if (sig.type === "long" && htfDir === -1) { equityCurve[i] = equity; continue; }
        if (sig.type === "short" && htfDir === 1) { equityCurve[i] = equity; continue; }
      }

      if (p.useMLFilter && p.mlModel) {
        const mlProb = predictLogistic(p.mlModel, buildSignalFeatures(candles, i, dir, er, ci));
        if (mlProb < (p.mlThreshold ?? 0.42)) { equityCurve[i] = equity; continue; }
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

export function computeDDDistribution(equityCurve) {
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

export function computeMonthlyReturns(trades, startEquity) {
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