import {
  buildParamBounds,
  buildRegimeAwareBounds,
  buildRegimeModel,
  classifyRegime,
  extractMarketFeatures,
  geneticOptimize,
  regimeParamBias,
  regimeAdjustedScore,
  scoreBacktestStats,
  isProfitableBacktest,
  filterProfitableResults,
} from "./engine.js";

function rescoreTopWithML(results, baseParams, attachMLFn, runBacktestFn, regime, limit = 12) {
  const rescored = [];
  const seen = new Set();

  for (const r of results.slice(0, limit)) {
    const key = JSON.stringify(r.params);
    if (seen.has(key)) continue;
    seen.add(key);

    let p = { ...baseParams, ...r.params };
    if (p.useMLFilter && attachMLFn) {
      p = attachMLFn(p);
      if (p.useMLFilter && !p.mlModel) continue;
    }

    try {
      const bt = runBacktestFn(p);
      const s = bt.stats;
      if (s.totalTrades < 2) continue;
      if (!isProfitableBacktest(s, bt.equityCurve, p.startEquity ?? baseParams.startEquity ?? 10000)) continue;
      const startEquity = p.startEquity ?? baseParams.startEquity ?? 10000;
      const finalEquity = bt.equityCurve.filter(v => !isNaN(v)).at(-1) ?? startEquity;
      const baseScore = scoreBacktestStats(s);
      rescored.push({
        params: r.params,
        netReturn: parseFloat(s.netReturn),
        sharpe: s.sharpe === "—" ? -999 : parseFloat(s.sharpe),
        maxDD: parseFloat(s.maxDD),
        profitFactor: s.profitFactor === "∞" ? 999 : parseFloat(s.profitFactor),
        totalTrades: s.totalTrades,
        winRate: parseFloat(s.winRate),
        calmar: s.calmar === "—" ? -999 : parseFloat(s.calmar),
        score: regimeAdjustedScore(baseScore, regime, s),
        equityStart: startEquity,
        equityEnd: finalEquity,
        equityGain: finalEquity - startEquity,
        regime: regime.label,
        regimeConfidence: regime.confidence,
        mlRescored: true,
      });
    } catch {
      /* skip */
    }
  }

  if (!rescored.length) return results;
  return filterProfitableResults(rescored).sort((a, b) => b.score - a.score);
}

export function runMLOptimization(candles, baseParams, ranges, runBacktestFn, options = {}) {
  const { onProgress, regimeModel = null, compact = false, attachMLFn = null } = options;

  const baseBounds = options.bounds ?? buildParamBounds(ranges, compact);
  const features = extractMarketFeatures(candles);
  const model = regimeModel ?? buildRegimeModel(candles);
  const regime = classifyRegime(features, model);
  const seedParams = regimeParamBias(regime.label, baseParams);
  const bounds = buildRegimeAwareBounds(baseBounds, regime.label);

  const evaluate = (p) => {
    try {
      let params = { ...baseParams, ...p };
      if (params.useMLFilter && attachMLFn) {
        params = attachMLFn(params);
        if (params.useMLFilter && !params.mlModel) return null;
      }

      const r = runBacktestFn(params);
      const s = r.stats;
      if (s.totalTrades < 2) return null;
      if (!isProfitableBacktest(s, r.equityCurve, params.startEquity ?? baseParams.startEquity ?? 10000)) return null;
      const startEquity = params.startEquity ?? baseParams.startEquity ?? 10000;
      const finalEquity = r.equityCurve.filter(v => !isNaN(v)).at(-1) ?? startEquity;
      const baseScore = scoreBacktestStats(s);
      return {
        netReturn: parseFloat(s.netReturn),
        sharpe: s.sharpe === "—" ? -999 : parseFloat(s.sharpe),
        maxDD: parseFloat(s.maxDD),
        profitFactor: s.profitFactor === "∞" ? 999 : parseFloat(s.profitFactor),
        totalTrades: s.totalTrades,
        winRate: parseFloat(s.winRate),
        calmar: s.calmar === "—" ? -999 : parseFloat(s.calmar),
        score: regimeAdjustedScore(baseScore, regime, s),
        equityStart: startEquity,
        equityEnd: finalEquity,
        equityGain: finalEquity - startEquity,
      };
    } catch {
      return null;
    }
  };

  const gaConfig = compact
    ? { populationSize: 20, generations: 8, eliteCount: 3, seedParams, regimeSeedRatio: 0.45, onProgress }
    : { populationSize: 32, generations: 12, eliteCount: 5, seedParams, regimeSeedRatio: 0.4, onProgress };

  let results = geneticOptimize(candles, baseParams, bounds, evaluate, gaConfig);

  if (attachMLFn) {
    results = rescoreTopWithML(results, baseParams, attachMLFn, runBacktestFn, regime, 12);
  }

  const deduped = [];
  const seen = new Set();
  for (const r of results) {
    const key = JSON.stringify(r.params);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      ...r,
      regime: r.regime ?? regime.label,
      regimeConfidence: r.regimeConfidence ?? regime.confidence,
    });
  }

  return {
    results: filterProfitableResults(deduped).sort((a, b) => b.score - a.score),
    regime,
    regimeModel: model,
    features,
    method: "genetic",
  };
}

export { buildRegimeModel, classifyRegime, extractMarketFeatures, scoreBacktestStats, isProfitableBacktest, filterProfitableResults };
