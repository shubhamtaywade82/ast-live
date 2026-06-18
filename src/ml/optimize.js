import {
  buildParamBounds,
  buildRegimeModel,
  classifyRegime,
  extractMarketFeatures,
  geneticOptimize,
  regimeParamBias,
  scoreBacktestStats,
  isProfitableBacktest,
  filterProfitableResults,
} from "./engine.js";

export function runMLOptimization(candles, baseParams, ranges, runBacktestFn, options = {}) {
  const { onProgress, regimeModel = null, compact = false } = options;

  const bounds = options.bounds ?? buildParamBounds(ranges, compact);
  const features = extractMarketFeatures(candles);
  const model = regimeModel ?? buildRegimeModel(candles);
  const regime = classifyRegime(features, model);
  const seedParams = regimeParamBias(regime.label, baseParams);

  const evaluate = (p) => {
    try {
      const r = runBacktestFn(p);
      const s = r.stats;
      if (s.totalTrades < 2) return null;
      if (!isProfitableBacktest(s, r.equityCurve, p.startEquity ?? baseParams.startEquity ?? 10000)) return null;
      return {
        netReturn: parseFloat(s.netReturn),
        sharpe: s.sharpe === "—" ? -999 : parseFloat(s.sharpe),
        maxDD: parseFloat(s.maxDD),
        profitFactor: s.profitFactor === "∞" ? 999 : parseFloat(s.profitFactor),
        totalTrades: s.totalTrades,
        winRate: parseFloat(s.winRate),
        calmar: s.calmar === "—" ? -999 : parseFloat(s.calmar),
        score: scoreBacktestStats(s),
      };
    } catch {
      return null;
    }
  };

  const gaConfig = compact
    ? { populationSize: 20, generations: 8, eliteCount: 3, seedParams, onProgress }
    : { populationSize: 32, generations: 12, eliteCount: 5, seedParams, onProgress };

  const results = geneticOptimize(candles, baseParams, bounds, evaluate, gaConfig);

  const deduped = [];
  const seen = new Set();
  for (const r of results) {
    const key = JSON.stringify(r.params);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...r, regime: regime.label, regimeConfidence: regime.confidence });
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
