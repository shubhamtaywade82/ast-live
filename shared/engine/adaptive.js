import { buildRegimeModel, normalizeParams, isProfitableBacktest } from "../ml/engine.js";
import { AUTO_TUNE_KEYS } from "../constants.js";
import { runBacktest, computeDDDistribution, computeMonthlyReturns } from "./backtest.js";
import { computeSignalQuality } from "./indicators.js";
import {
  runSmartOptimization,
  attachMLSignalFilter,
  buildTuneEntry,
  buildOptRanges,
} from "./optimization.js";
export function getAdaptiveConfig(candleCount) {
  const lookback = Math.min(Math.max(200, Math.floor(candleCount * 0.25)), 2000);
  const retuneEvery = Math.min(Math.max(100, Math.floor(candleCount * 0.1)), 500);
  return { lookback, retuneEvery };
}

export function assembleBacktestResult(candles, p, indicators, trades, equityCurve, drawdowns, startEquity) {
  const { atr, er, smoothF, stLine, dir, ci } = indicators;
  const n = candles.length;
  const equity = equityCurve[n - 1] ?? equityCurve.filter(v => !isNaN(v)).at(-1) ?? startEquity;

  const sigEvents = [];
  for (let i = 1; i < n; i++) {
    if (dir[i] !== dir[i - 1]) {
      sigEvents.push({ i, type: dir[i] === 1 ? "long" : "short", bar: candles[i] });
    }
  }
  const qualitySignals = computeSignalQuality(candles, dir, sigEvents);

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

  const flipExits = trades.filter(t => t.exitReason === "flip").length;
  const trailExits = trades.filter(t => t.exitReason === "trail").length;
  const beExits = trades.filter(t => t.exitReason === "be").length;

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
    },
  };
}

export function runAdaptiveBacktest(candles, baseParams, optRanges, config, htfAlignedDir = null, onProgress, options = {}) {
  const { useML = true } = options;
  const { lookback, retuneEvery } = config;
  const n = candles.length;
  const startEquity = baseParams.startEquity || 10000;
  const compact = n > 2500;
  let mlMeta = null;
  let lastWindowRegime = null;

  if (n < lookback + 50) {
    const causalModel = n >= 80 ? buildRegimeModel(candles) : null;
    const { results, mlMeta: meta } = runSmartOptimization(
      candles, baseParams, optRanges, onProgress,
      { useML, regimeModel: causalModel, compact, htfAlignedDir },
    );
    mlMeta = meta;
    lastWindowRegime = meta?.regime ?? null;
    const best = results[0];
    const bestParams = best ? normalizeParams({ ...baseParams, ...best.params }) : baseParams;
    const filtered = best ? attachMLSignalFilter(candles, bestParams, htfAlignedDir) : bestParams;
    const result = runBacktest(candles, filtered, htfAlignedDir);
    const finalEquity = result.equityCurve.filter(v => !isNaN(v)).at(-1) ?? startEquity;
    const segmentReturn = startEquity > 0 ? ((finalEquity - startEquity) / startEquity) * 100 : 0;
    const tuneLog = [];
    const profitableParamHistory = [];

    if (best && segmentReturn > 0 && finalEquity > startEquity) {
      const entry = buildTuneEntry({
        window: 1,
        bar: 0,
        barEnd: n - 1,
        params: normalizeParams({ ...best.params }),
        score: best.score,
        trainNetReturn: best.netReturn,
        segmentReturn,
        equityStart: startEquity,
        equityEnd: finalEquity,
        regime: best.regime ?? lastWindowRegime?.label,
        regimeConfidence: best.regimeConfidence ?? lastWindowRegime?.confidence,
        method: useML ? "genetic" : "grid",
        confirmed: true,
        source: "adaptive",
        windows: [1],
      });
      tuneLog.push(entry);
      profitableParamHistory.push({ ...entry });
    }

    return {
      ...result,
      adaptive: true,
      mlPowered: useML,
      mlMeta,
      currentRegime: lastWindowRegime,
      tunedParams: profitableParamHistory.at(-1)?.params ?? best?.params ?? null,
      tuneLog,
      profitableParamHistory,
      adaptiveConfig: config,
      regimeModel: causalModel,
    };
  }

  const mergedEquity = new Array(n).fill(NaN);
  const mergedStLine = new Array(n).fill(NaN);
  const mergedDir = new Array(n).fill(1);
  const mergedEr = new Array(n).fill(0);
  const mergedSmoothF = new Array(n).fill(NaN);
  const mergedAtr = new Array(n).fill(NaN);
  const mergedCi = new Array(n).fill(NaN);
  const allTrades = [];
  const allDrawdowns = [];
  const tuneLog = [];
  const profitableParamHistory = [];
  let equity = startEquity;
  let cursor = 0;
  let lastGoodParams = baseParams;
  let windowNum = 0;
  let lastRegimeModel = null;
  const totalSteps = Math.max(1, Math.ceil((n - lookback) / retuneEvery) + 1);
  let step = 0;

  while (cursor < n) {
    const segStart = cursor;
    const segEnd = cursor === 0 ? Math.min(lookback, n) : Math.min(cursor + retuneEvery, n);
    if (segStart >= n || segEnd <= segStart) break;

    const trainEnd = segStart === 0 ? segEnd : segStart;
    const trainStart = Math.max(0, trainEnd - lookback);
    const trainCandles = candles.slice(trainStart, trainEnd);
    const trainHtf = htfAlignedDir?.slice(trainStart, trainEnd) ?? null;
    const causalCandles = candles.slice(0, trainEnd);
    const windowRegimeModel = causalCandles.length >= 80 ? buildRegimeModel(causalCandles) : null;
    lastRegimeModel = windowRegimeModel;
    const equityBeforeSeg = equity;

    let candidateParams = lastGoodParams;
    let best = null;
    let windowRegime = null;

    if (trainCandles.length >= 50) {
      let optCandles = trainCandles;
      let optHtf = trainHtf;
      let holdoutCandles = null;
      let holdoutHtf = null;

      if (segStart === 0 && trainCandles.length >= 100) {
        const split = Math.floor(trainCandles.length * 0.7);
        optCandles = trainCandles.slice(0, split);
        holdoutCandles = trainCandles.slice(split);
        optHtf = trainHtf?.slice(0, split) ?? null;
        holdoutHtf = trainHtf?.slice(split) ?? null;
      }

      const { results, mlMeta: meta } = runSmartOptimization(
        optCandles, baseParams, optRanges,
        p => { if (onProgress) onProgress(Math.round((step / totalSteps) * 50 + p * 0.5)); },
        {
          useML,
          regimeModel: windowRegimeModel,
          compact,
          htfAlignedDir: optHtf,
        },
      );
      if (meta && !mlMeta) mlMeta = meta;
      windowRegime = meta?.regime ?? null;
      lastWindowRegime = windowRegime;
      best = results[0] ?? null;

      if (best) {
        const tuned = normalizeParams({ ...baseParams, ...best.params });
        candidateParams = attachMLSignalFilter(optCandles, tuned, optHtf);

        if (holdoutCandles?.length >= 30) {
          const holdoutParams = attachMLSignalFilter(holdoutCandles, tuned, holdoutHtf);
          const hv = runBacktest(holdoutCandles, holdoutParams, holdoutHtf);
          if (!isProfitableBacktest(hv.stats, hv.equityCurve, startEquity)) {
            best = null;
            candidateParams = lastGoodParams;
          }
        }
      }
    }

    const warmup = Math.max(0, segStart - lookback);
    const slice = candles.slice(warmup, segEnd);
    const evalStartIdx = segStart - warmup;
    const htfSlice = htfAlignedDir?.slice(warmup, segEnd) ?? null;

    const runSeg = params => runBacktest(slice, params, htfSlice, { initialEquity: equity, evalStartIdx });

    let seg = runSeg(candidateParams);
    let equityAfterSeg = seg.equityCurve[slice.length - 1] ?? equity;
    let segmentReturn = equityBeforeSeg > 0
      ? ((equityAfterSeg - equityBeforeSeg) / equityBeforeSeg) * 100
      : 0;

    const candidateAccepted = best
      && candidateParams !== lastGoodParams
      && segmentReturn > 0
      && equityAfterSeg > equityBeforeSeg;

    if (best && !candidateAccepted && candidateParams !== lastGoodParams) {
      seg = runSeg(lastGoodParams);
      equityAfterSeg = seg.equityCurve[slice.length - 1] ?? equity;
      segmentReturn = equityBeforeSeg > 0
        ? ((equityAfterSeg - equityBeforeSeg) / equityBeforeSeg) * 100
        : 0;
    }

    for (let i = segStart; i < segEnd; i++) {
      const j = i - warmup;
      mergedEquity[i] = seg.equityCurve[j];
      mergedStLine[i] = seg.stLine[j];
      mergedDir[i] = seg.dir[j];
      mergedEr[i] = seg.er[j];
      mergedSmoothF[i] = seg.smoothF[j];
      mergedAtr[i] = seg.atr[j];
      if (seg.ci) mergedCi[i] = seg.ci[j];
    }

    for (const t of seg.trades) {
      allTrades.push({ ...t, n: allTrades.length + 1 });
    }
    allDrawdowns.push(...seg.drawdowns);

    if (candidateAccepted) {
      windowNum++;
      lastGoodParams = candidateParams;
      const entry = buildTuneEntry({
        window: windowNum,
        bar: segStart,
        barEnd: segEnd - 1,
        params: normalizeParams({ ...best.params }),
        score: best.score,
        trainNetReturn: best.netReturn,
        segmentReturn,
        equityStart: equityBeforeSeg,
        equityEnd: equityAfterSeg,
        regime: best.regime ?? windowRegime?.label,
        regimeConfidence: best.regimeConfidence ?? windowRegime?.confidence,
        method: useML ? "genetic" : "grid",
        confirmed: true,
        source: "adaptive",
        windows: [windowNum],
      });
      tuneLog.push(entry);
      profitableParamHistory.push({ ...entry });
    }

    equity = equityAfterSeg;
    cursor = segEnd;
    step++;
    if (onProgress) onProgress(Math.round((step / totalSteps) * 100));
  }

  for (let i = 0; i < n; i++) {
    if (isNaN(mergedEquity[i])) mergedEquity[i] = i > 0 ? mergedEquity[i - 1] : startEquity;
  }

  const latestParams = profitableParamHistory.length
    ? profitableParamHistory[profitableParamHistory.length - 1].params
    : tuneLog.at(-1)?.params ?? null;
  const result = assembleBacktestResult(
    candles,
    latestParams ? { ...baseParams, ...latestParams } : baseParams,
    { atr: mergedAtr, er: mergedEr, smoothF: mergedSmoothF, stLine: mergedStLine, dir: mergedDir, ci: mergedCi },
    allTrades,
    mergedEquity,
    allDrawdowns,
    startEquity,
  );

  return {
    ...result,
    adaptive: true,
    mlPowered: useML,
    mlMeta,
    currentRegime: lastWindowRegime,
    tunedParams: latestParams,
    tuneLog,
    profitableParamHistory,
    adaptiveConfig: config,
    regimeModel: lastRegimeModel,
  };
}