import { normalizeParams, isProfitableBacktest, buildRegimeModel, buildTradeTrainingSet, trainLogisticRegression } from "../ml/engine.js";
import { runMLOptimization } from "../ml/optimize.js";
import { fetchKlines } from "../binance.js";
import { INTERVALS } from "../market.js";
import { AUTO_TUNE_KEYS } from "../constants.js";
import { runBacktest } from "./backtest.js";
import { atrRMA, kaufmanER, volumeWeightedER, ema, adaptiveST, alignHTFDir } from "./indicators.js";
export function runOptimization(candles, baseParams, ranges, onProgress, compact = false) {
  const results = [];
  const combos = buildParamCombos(ranges, compact);
  const total = combos.length;
  const defaultStartEquity = baseParams.startEquity || 10000;

  for (let done = 0; done < combos.length; done++) {
    const combo = normalizeParams(combos[done], Object.keys(ranges));
    const p = normalizeParams({ ...baseParams, ...combo });
    const startEquity = p.startEquity || defaultStartEquity;
    try {
      const r = runBacktest(candles, p);
      const s = r.stats;
      if (!isProfitableBacktest(s, r.equityCurve, startEquity)) {
        if (onProgress) onProgress(Math.round(((done + 1) / total) * 100));
        continue;
      }
      const finalEquity = r.equityCurve.filter(v => !isNaN(v)).at(-1) ?? startEquity;
      const netReturn = parseFloat(s.netReturn);
      results.push({
        params: combo,
        netReturn,
        sharpe: s.sharpe === "—" ? -999 : parseFloat(s.sharpe),
        maxDD: parseFloat(s.maxDD),
        profitFactor: s.profitFactor === "∞" ? 999 : parseFloat(s.profitFactor),
        totalTrades: s.totalTrades,
        winRate: parseFloat(s.winRate),
        calmar: s.calmar === "—" ? -999 : parseFloat(s.calmar),
        score: (netReturn * 0.3)
          + (s.sharpe === "—" ? 0 : parseFloat(s.sharpe) * 10)
          - parseFloat(s.maxDD) * 0.5
          + Math.min(s.profitFactor === "∞" ? 0 : parseFloat(s.profitFactor), 5) * 5,
        equityStart: startEquity,
        equityEnd: finalEquity,
        equityGain: finalEquity - startEquity,
        method: "grid",
      });
    } catch (_e) { /* skip invalid combo */ }
    if (onProgress) onProgress(Math.round(((done + 1) / total) * 100));
  }

  return results.sort((a, b) => b.equityEnd - a.equityEnd || b.score - a.score);
}

export function runSmartOptimization(candles, baseParams, ranges, onProgress, options = {}) {
  const {
    useML = true,
    regimeModel = null,
    compact = false,
    htfAlignedDir = null,
  } = options;

  if (useML) {
    const ml = runMLOptimization(
      candles,
      baseParams,
      ranges,
      p => runBacktest(candles, p, htfAlignedDir),
      {
        onProgress,
        regimeModel,
        compact,
        bounds: buildTuneBounds(compact),
        attachMLFn: p => attachMLSignalFilter(candles, p, htfAlignedDir),
      },
    );
    return { results: ml.results, mlMeta: ml };
  }

  return {
    results: runOptimization(candles, baseParams, ranges, onProgress, compact),
    mlMeta: null,
  };
}

export function attachMLSignalFilter(trainCandles, segParams, htfAlignedDir) {
  if (!segParams.useMLFilter) return segParams;
  const probe = runBacktest(trainCandles, { ...segParams, useMLFilter: false }, htfAlignedDir);
  const samples = buildTradeTrainingSet(probe.trades, trainCandles, probe.er, probe.ci, probe.dir);
  const mlModel = trainLogisticRegression(samples);
  if (!mlModel || samples.length < 8) return segParams;
  return { ...segParams, mlModel };
}



const BOOL_TUNE_KEYS = new Set([
  "useRegimeFilter", "useVWER", "useTrailingStop", "useBreakEven", "useATRSizing", "useMLFilter",
]);

export function fullParamsKey(params) {
  const p = normalizeParams(params, AUTO_TUNE_KEYS);
  return AUTO_TUNE_KEYS.map(k => `${k}:${p[k]}`).join("|");
}

export function hasPositiveFinalEquity(entry) {
  const start = entry.equityStart ?? entry.lastEquityStart;
  const end = entry.lastEquityEnd ?? entry.equityEnd ?? entry.bestEquityEnd;
  return start != null && end != null && end > start;
}

export function mergeEquityPositiveParams(existing, incoming) {
  const merged = existing.map(e => ({ ...e, windows: [...(e.windows || [])] }));
  for (const entry of incoming) {
    if (!entry.params || !hasPositiveFinalEquity(entry)) continue;
    const normalized = {
      ...entry,
      params: normalizeParams(entry.params, AUTO_TUNE_KEYS),
      equityStart: entry.equityStart ?? entry.lastEquityStart,
      equityEnd: entry.lastEquityEnd ?? entry.equityEnd,
    };
    normalized.equityGain = normalized.equityEnd - normalized.equityStart;
    const idx = merged.findIndex(e => fullParamsKey(e.params) === fullParamsKey(normalized.params));
    if (idx >= 0) {
      const prev = merged[idx];
      merged[idx] = {
        ...prev,
        ...normalized,
        hits: (prev.hits || 1) + 1,
        bestEquityEnd: Math.max(prev.bestEquityEnd ?? prev.equityEnd, normalized.equityEnd),
        equityEnd: Math.max(prev.equityEnd, normalized.equityEnd),
        equityGain: Math.max(prev.equityGain ?? 0, normalized.equityGain),
        netReturn: Math.max(prev.netReturn ?? 0, normalized.netReturn ?? 0),
        score: Math.max(prev.score ?? 0, normalized.score ?? 0),
        windows: [...new Set([...(prev.windows || []), ...(normalized.windows || [])])],
        sources: [...new Set([...(prev.sources || []), normalized.source].filter(Boolean))],
      };
    } else {
      merged.push({
        ...normalized,
        hits: 1,
        bestEquityEnd: normalized.equityEnd,
        sources: normalized.source ? [normalized.source] : [],
      });
    }
  }
  return merged.sort((a, b) => (b.equityEnd ?? 0) - (a.equityEnd ?? 0));
}

export function buildPresetFromView(ctx) {
  const {
    symbol, interval, htfMultiplier, startDate, endDate, candles, result, params, source = "manual",
  } = ctx;
  if (!candles?.length || !result) return null;
  const equityStart = params.startEquity || 10000;
  const equityEnd = result.equityCurve?.filter(v => !isNaN(v)).at(-1) ?? equityStart;
  if (equityEnd <= equityStart) return null;

  const tuned = result.tunedParams ?? params;
  return {
    symbol,
    interval,
    htfMultiplier,
    startDate,
    endDate,
    startMs: candles[0].t,
    endMs: candles.at(-1).t,
    params: normalizeParams(tuned, AUTO_TUNE_KEYS),
    equityStart,
    equityEnd,
    equityGain: equityEnd - equityStart,
    netReturn: parseFloat(result.stats?.netReturn ?? 0),
    sharpe: result.stats?.sharpe,
    maxDD: result.stats?.maxDD,
    totalTrades: result.stats?.totalTrades,
    regime: result.currentRegime?.label ?? result.mlMeta?.regime?.label,
    regimeConfidence: result.currentRegime?.confidence ?? result.mlMeta?.regime?.confidence,
    barCount: candles.length,
    source,
  };
}

export async function resolveHtfAligned(candles, symbol, interval, htfMultiplier, tuneParams, startMs, endMs, fetchFn = fetchKlines) {
  if (!htfMultiplier || htfMultiplier <= 0) return { htfAligned: null, htfCandles: null, htfResult: null };

  const htfMs = (INTERVALS.find(i => i.label === interval)?.ms ?? 3600e3) * htfMultiplier;
  const htfLabel = INTERVALS.find(i => i.ms >= htfMs)?.label || interval;
  const htfData = await fetchFn(symbol, htfLabel, startMs, endMs);
  const htfAtr = atrRMA(htfData, tuneParams.atrPeriod);
  const htfEr = tuneParams.useVWER
    ? volumeWeightedER(htfData, tuneParams.erLength)
    : kaufmanER(htfData, tuneParams.erLength);
  const htfRawF = htfEr.map(e => tuneParams.maxFactor - e * (tuneParams.maxFactor - tuneParams.minFactor));
  const htfSmoothF = ema(htfRawF, tuneParams.smoothLength);
  const htfST = adaptiveST(htfData, htfAtr, htfSmoothF);
  const htfAligned = alignHTFDir(candles, htfData, htfST.dir);
  return { htfAligned, htfCandles: htfData, htfResult: htfST };
}

export function runBacktestFromPreset(candles, baseParams, preset, htfAligned) {
  const merged = normalizeParams({ ...baseParams, ...preset.params });
  const filtered = attachMLSignalFilter(candles, merged, htfAligned);
  const r = runBacktest(candles, filtered, htfAligned);
  return {
    ...r,
    adaptive: true,
    fromPreset: true,
    presetId: preset.id,
    tunedParams: preset.params,
    currentRegime: preset.regime ? { label: preset.regime, confidence: preset.regimeConfidence } : null,
  };
}

export function prioritizeJobs(jobs, current) {
  if (!current?.symbol) return jobs;
  const head = [];
  const tail = [];
  for (const job of jobs) {
    const isCurrent = job.symbol === current.symbol
      && job.interval === current.interval
      && job.htfMultiplier === current.htfMultiplier;
    (isCurrent ? head : tail).push(job);
  }
  return [...head, ...tail];
}

export function resultsToEquityEntries(results, startEquity, source = "full-search") {
  return results
    .filter(r => r.equityEnd != null && r.equityEnd > (r.equityStart ?? startEquity))
    .map((r, i) => ({
      params: normalizeParams(r.params, AUTO_TUNE_KEYS),
      netReturn: r.netReturn,
      score: r.score ?? 0,
      equityStart: r.equityStart ?? startEquity,
      equityEnd: r.equityEnd,
      equityGain: r.equityGain ?? (r.equityEnd - (r.equityStart ?? startEquity)),
      sharpe: r.sharpe,
      maxDD: r.maxDD,
      totalTrades: r.totalTrades,
      source,
      confirmed: true,
      hits: 1,
      windows: [source],
      window: i + 1,
      bar: 0,
      method: r.method ?? "genetic",
    }));
}

export function runEquityPositiveParamSearch(candles, baseParams, htfAlignedDir, onProgress) {
  const compact = candles.length > 2500;
  const ranges = buildOptRanges(compact);
  const { results } = runSmartOptimization(
    candles,
    baseParams,
    ranges,
    onProgress,
    { useML: true, compact, htfAlignedDir },
  );
  return resultsToEquityEntries(results, baseParams.startEquity || 10000, "full-search");
}

export function mergeProfitableParamHistory(existing, incoming) {
  return mergeEquityPositiveParams(existing, incoming);
}

export function buildTuneEntry(fields) {
  const entry = { confirmed: false, hits: 1, windows: [], ...fields };
  if (entry.params) entry.params = normalizeParams(entry.params, AUTO_TUNE_KEYS);
  return entry;
}

export function tuneHistoryToOptResults(history) {
  return history.map((t, i) => ({
    params: normalizeParams(t.params, AUTO_TUNE_KEYS),
    netReturn: t.netReturn ?? t.lastSegmentReturn ?? t.segmentReturn ?? t.trainNetReturn ?? 0,
    trainNetReturn: t.trainNetReturn ?? 0,
    segmentReturn: t.lastSegmentReturn ?? t.segmentReturn ?? 0,
    sharpe: t.sharpe ?? 0,
    maxDD: t.maxDD ?? 0,
    profitFactor: t.profitFactor ?? 0,
    totalTrades: t.totalTrades ?? 0,
    winRate: t.winRate ?? 0,
    calmar: t.calmar ?? 0,
    score: t.score ?? 0,
    window: t.window ?? i + 1,
    bar: t.lastBar ?? t.bar,
    hits: t.hits ?? 1,
    windows: t.windows ?? [t.window],
    equityStart: t.equityStart ?? t.lastEquityStart,
    equityEnd: t.bestEquityEnd ?? t.lastEquityEnd ?? t.equityEnd,
    equityGain: t.equityGain ?? ((t.bestEquityEnd ?? t.lastEquityEnd ?? t.equityEnd ?? 0) - (t.equityStart ?? 0)),
    source: t.source ?? t.sources?.[0] ?? "adaptive",
    regime: t.regime,
    regimeConfidence: t.regimeConfidence,
    method: t.method,
  })).sort((a, b) => (b.equityEnd ?? 0) - (a.equityEnd ?? 0));
}

export function buildOptRanges(compact = false) {
  return {
    atrPeriod: compact ? [8, 10, 14] : [7, 10, 14, 18, 21],
    erLength: compact ? [10, 14, 20] : [8, 14, 20, 28],
    smoothLength: compact ? [3, 5, 8] : [3, 5, 8, 13],
    minFactor: compact ? [1.0, 1.5, 2.0, 2.5] : [1.0, 1.5, 2.0, 2.5],
    maxFactor: compact ? [3.0, 4.0, 5.0, 6.0] : [3.0, 4.0, 5.0, 6.0, 7.0],
    chopThreshold: compact ? [55, 61.8, 68] : [50, 55, 61.8, 68, 75],
    breakEvenPct: compact ? [0.5, 1.0, 2.0] : [0.5, 1.0, 1.5, 2.0, 3.0],
    atrMult: compact ? [1.5, 2, 3] : [1, 1.5, 2, 2.5, 3, 4],
    mlThreshold: compact ? [0.38, 0.42, 0.50] : [0.35, 0.38, 0.42, 0.48, 0.55],
    riskPct: compact ? [0.01, 0.02] : [0.01, 0.02],
    useRegimeFilter: [true, false],
    useVWER: [true, false],
    useTrailingStop: [true, false],
    useBreakEven: [true, false],
    useATRSizing: [true, false],
    useMLFilter: [true, false],
  };
}

export function sampleParamCombo(ranges) {
  const combo = {};
  for (const [key, values] of Object.entries(ranges)) {
    combo[key] = values[Math.floor(Math.random() * values.length)];
  }
  return normalizeParams(combo, Object.keys(ranges));
}

export function buildParamCombos(ranges, compact = false) {
  const keys = Object.keys(ranges);
  let gridSize = 1;
  for (const key of keys) gridSize *= ranges[key].length;

  if (gridSize <= 500) {
    const combos = [];
    const build = (idx, current) => {
      if (idx >= keys.length) {
        const normalized = normalizeParams(current, keys);
        if (normalized.minFactor < normalized.maxFactor) combos.push(normalized);
        return;
      }
      const key = keys[idx];
      for (const v of ranges[key]) build(idx + 1, { ...current, [key]: v });
    };
    build(0, {});
    return combos;
  }

  const target = compact ? 160 : 280;
  const combos = [];
  const seen = new Set();
  while (combos.length < target) {
    const combo = sampleParamCombo(ranges);
    const sig = fullParamsKey(combo);
    if (seen.has(sig)) continue;
    seen.add(sig);
    combos.push(combo);
  }
  return combos;
}

export function buildTuneBounds(compact = false) {
  return {
    atrPeriod: [5, 30],
    erLength: [5, 50],
    smoothLength: [1, 20],
    minFactor: [0.5, 3.5],
    maxFactor: [2, 9],
    chopThreshold: [50, 80],
    breakEvenPct: [0.5, 5],
    atrMult: [1, 5],
    mlThreshold: compact ? [0.35, 0.55] : [0.3, 0.7],
    riskPct: compact ? [0.005, 0.015] : [0.005, 0.02],
    useRegimeFilter: "bool",
    useVWER: "bool",
    useTrailingStop: "bool",
    useBreakEven: "bool",
    useATRSizing: "bool",
    useMLFilter: "bool",
  };
}