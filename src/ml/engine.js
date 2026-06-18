// Client-side ML for adaptive Supertrend — no external deps, runs in browser.

import { yieldToMain } from "../lib/yield.js";

const REGIME_LABELS = ["Trending", "Mixed", "Choppy"];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

const PARAM_BOOL_KEYS = new Set([
  "useRegimeFilter", "useVWER", "useTrailingStop", "useBreakEven", "useATRSizing", "useMLFilter",
]);

const PARAM_INT_KEYS = new Set(["atrPeriod", "erLength", "smoothLength"]);

const PARAM_STEP = 0.01;

export function roundParamValue(key, value) {
  if (PARAM_BOOL_KEYS.has(key)) return !!value;
  if (PARAM_INT_KEYS.has(key)) return Math.round(Number(value));
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return Math.round(n * 100) / 100;
}

export function fmtParamValue(key, value) {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "Y" : "N";
  if (PARAM_INT_KEYS.has(key)) return String(Math.round(value));
  if (typeof value === "number") return value.toFixed(2);
  return String(value);
}

export function normalizeParams(params, keys = null) {
  if (!params) return params;
  const out = { ...params };
  const targetKeys = keys ?? Object.keys(out);
  for (const key of targetKeys) {
    if (out[key] == null || typeof out[key] === "boolean") continue;
    if (typeof out[key] === "number") out[key] = roundParamValue(key, out[key]);
  }
  if (out.minFactor != null && out.maxFactor != null && out.minFactor >= out.maxFactor) {
    out.maxFactor = roundParamValue("maxFactor", out.minFactor + PARAM_STEP);
  }
  return out;
}

function normalizeIndividual(ind) {
  const out = {};
  for (const [key, value] of Object.entries(ind)) {
    out[key] = roundParamValue(key, value);
  }
  if (out.minFactor != null && out.maxFactor != null && out.minFactor >= out.maxFactor) {
    out.maxFactor = roundParamValue("maxFactor", out.minFactor + PARAM_STEP);
  }
  return out;
}

function paramStep(key) {
  return PARAM_INT_KEYS.has(key) ? 1 : PARAM_STEP;
}

function mean(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

export function extractMarketFeatures(candles, endIdx = null, lookback = 50) {
  const end = endIdx ?? candles.length;
  const start = Math.max(0, end - lookback);
  const slice = candles.slice(start, end);
  if (slice.length < 10) return null;

  const closes = slice.map(c => c.close);
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }

  const net = Math.abs(closes.at(-1) - closes[0]);
  let path = 0;
  for (let i = 1; i < closes.length; i++) path += Math.abs(closes[i] - closes[i - 1]);
  const er = path > 0 ? net / path : 0;

  const highs = slice.map(c => c.high);
  const lows = slice.map(c => c.low);
  const rangePct = closes[0] > 0 ? (Math.max(...highs) - Math.min(...lows)) / closes[0] : 0;
  const vol = std(returns);
  const momentum = closes.length > 5
    ? (closes.at(-1) - closes.at(-6)) / closes.at(-6)
    : 0;

  const vols = slice.map(c => c.vol);
  const volRatio = mean(vols.slice(-10)) / (mean(vols) || 1);

  const n = closes.length;
  const xMean = (n - 1) / 2;
  const yMean = mean(closes);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (closes[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const trendSlope = den > 0 ? num / den / yMean : 0;

  return { er, vol, rangePct, momentum, volRatio, trendSlope };
}

export function featuresToVector(f) {
  return [f.er, f.vol * 100, f.rangePct, f.momentum, f.volRatio, f.trendSlope * 100];
}

function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

export function kMeansRegime(featureHistory, k = 3, maxIter = 25) {
  if (!featureHistory.length) return { centroids: [], labels: REGIME_LABELS };

  const vectors = featureHistory.map(featuresToVector);
  const dims = vectors[0].length;

  let centroids = [];
  if (vectors.length >= k) {
    const erOrder = featureHistory
      .map((f, i) => ({ i, er: f.er }))
      .sort((a, b) => b.er - a.er);
    const picks = [
      erOrder[0]?.i ?? 0,
      erOrder[Math.floor(erOrder.length / 2)]?.i ?? 0,
      erOrder[erOrder.length - 1]?.i ?? 0,
    ];
    const used = new Set();
    for (const idx of picks) {
      if (used.has(idx)) continue;
      used.add(idx);
      centroids.push([...vectors[idx]]);
    }
  }
  while (centroids.length < k && centroids.length < vectors.length) {
    const idx = centroids.length % vectors.length;
    centroids.push([...vectors[idx]]);
  }
  if (!centroids.length) centroids = [vectors[0].slice()];

  let assignments = new Array(vectors.length).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < vectors.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = dist(vectors[i], centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }
    if (!changed) break;

    const sums = Array.from({ length: centroids.length }, () => new Array(dims).fill(0));
    const counts = new Array(centroids.length).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      const a = assignments[i];
      counts[a]++;
      for (let d = 0; d < dims; d++) sums[a][d] += vectors[i][d];
    }
    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] === 0) continue;
      for (let d = 0; d < dims; d++) centroids[c][d] = sums[c][d] / counts[c];
    }
  }

  const erOrder = centroids
    .map((c, i) => ({ i, er: c[0] }))
    .sort((a, b) => b.er - a.er);

  const labelMap = {};
  labelMap[erOrder[0]?.i ?? 0] = "Trending";
  labelMap[erOrder[1]?.i ?? 1] = "Mixed";
  labelMap[erOrder[2]?.i ?? 2] = "Choppy";

  return { centroids, labelMap, labels: REGIME_LABELS };
}

export function classifyRegime(features, model) {
  if (!features || !model?.centroids?.length) return { id: 1, label: "Mixed", confidence: 0.5 };
  const v = featuresToVector(features);
  let best = 0;
  let bestD = Infinity;
  for (let c = 0; c < model.centroids.length; c++) {
    const d = dist(v, model.centroids[c]);
    if (d < bestD) { bestD = d; best = c; }
  }
  const label = model.labelMap?.[best] ?? "Mixed";
  const confidence = clamp(1 / (1 + bestD), 0.3, 0.99);
  return { id: best, label, confidence };
}

export function regimeParamBias(regimeLabel, baseParams) {
  const b = { ...baseParams };
  if (regimeLabel === "Trending") {
    b.atrPeriod = clamp((b.atrPeriod || 10) - 2, 5, 30);
    b.erLength = clamp((b.erLength || 14) - 2, 5, 50);
    b.minFactor = clamp((b.minFactor || 1.5) - 0.25, 0.5, 3.5);
    b.maxFactor = clamp((b.maxFactor || 4.5) + 0.5, 2, 9);
    b.smoothLength = clamp((b.smoothLength || 5) - 1, 1, 20);
  } else if (regimeLabel === "Choppy") {
    b.atrPeriod = clamp((b.atrPeriod || 10) + 2, 5, 30);
    b.erLength = clamp((b.erLength || 14) + 4, 5, 50);
    b.minFactor = clamp((b.minFactor || 1.5) + 0.5, 0.5, 3.5);
    b.maxFactor = clamp((b.maxFactor || 4.5) - 0.5, 2, 9);
    b.smoothLength = clamp((b.smoothLength || 5) + 2, 1, 20);
  }
  return normalizeParams(b);
}

export function buildRegimeAwareBounds(baseBounds, regimeLabel) {
  const b = { ...baseBounds };
  if (regimeLabel === "Trending") {
    b.minFactor = [0.5, 2.5];
    b.maxFactor = [3, 9];
    b.chopThreshold = [50, 65];
    b.smoothLength = [1, 12];
    b.useTrailingStop = "bool";
  } else if (regimeLabel === "Choppy") {
    b.minFactor = [1.0, 3.5];
    b.maxFactor = [2, 5.5];
    b.chopThreshold = [58, 80];
    b.smoothLength = [3, 20];
    b.riskPct = [0.005, 0.012];
  } else {
    b.minFactor = [0.8, 3.0];
    b.maxFactor = [2.5, 7];
    b.chopThreshold = [52, 72];
  }
  return b;
}

export function regimeAdjustedScore(baseScore, regime, stats) {
  let score = baseScore * (regime?.confidence ?? 1);
  if (regime?.label === "Choppy") {
    score -= parseFloat(stats.maxDD) * 0.35;
    if (stats.totalTrades > 40) score -= (stats.totalTrades - 40) * 0.15;
  }
  if (regime?.label === "Trending") {
    score += Math.min(parseFloat(stats.profitFactor === "∞" ? 5 : stats.profitFactor), 5) * 1.5;
  }
  return score;
}

function randomInt(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function roundStep(v, step) {
  return Math.round(v / step) * step;
}

function pickFromBounds(bounds, key, seed = null) {
  const spec = bounds[key];
  if (spec === "bool") {
    if (seed?.[key] != null) return Math.random() < 0.65 ? seed[key] : !seed[key];
    return Math.random() < 0.5;
  }
  const [lo, hi] = spec;
  const floatStep = paramStep(key);
  if (seed?.[key] != null) {
    const jitter = (Math.random() - 0.5) * (hi - lo) * 0.3;
    return floatStep === 1
      ? clamp(Math.round(seed[key] + jitter), lo, hi)
      : clamp(roundStep(seed[key] + jitter, floatStep), lo, hi);
  }
  return floatStep === 1
    ? randomInt(lo, hi)
    : roundStep(lo + Math.random() * (hi - lo), floatStep);
}

function randomIndividual(bounds, seed = null) {
  const ind = {};
  for (const key of Object.keys(bounds)) {
    ind[key] = pickFromBounds(bounds, key, seed);
  }
  return normalizeIndividual(ind);
}

function mutate(ind, bounds, rate = 0.22) {
  const next = { ...ind };
  for (const key of Object.keys(bounds)) {
    if (Math.random() > rate) continue;
    if (bounds[key] === "bool") {
      next[key] = !next[key];
      continue;
    }
    const [lo, hi] = bounds[key];
    const step = paramStep(key);
    const delta = (Math.random() - 0.5) * (hi - lo) * 0.4;
    next[key] = step === 1
      ? clamp(Math.round(next[key] + delta), lo, hi)
      : clamp(roundStep(next[key] + delta, step), lo, hi);
  }
  return normalizeIndividual(next);
}

function crossover(a, b) {
  const child = {};
  for (const key of Object.keys(a)) {
    child[key] = Math.random() < 0.5 ? a[key] : b[key];
  }
  return normalizeIndividual(child);
}

export function scoreBacktestStats(s) {
  return (parseFloat(s.netReturn) * 0.3)
    + (s.sharpe === "—" ? 0 : parseFloat(s.sharpe) * 10)
    - parseFloat(s.maxDD) * 0.5
    + Math.min(s.profitFactor === "∞" ? 0 : parseFloat(s.profitFactor), 5) * 5;
}

export function isProfitableBacktest(stats, equityCurve = null, startEquity = null) {
  const netReturn = parseFloat(stats.netReturn);
  if (!Number.isFinite(netReturn) || netReturn <= 0) return false;

  if (equityCurve?.length && startEquity != null) {
    const finalEquity = equityCurve.filter(v => !isNaN(v)).at(-1);
    if (finalEquity != null && finalEquity <= startEquity) return false;
  }

  return true;
}

export function filterProfitableResults(results) {
  return results.filter(r => {
    if (!Number.isFinite(r.netReturn) || r.netReturn <= 0) return false;
    if (r.equityEnd != null && r.equityStart != null) return r.equityEnd > r.equityStart;
    return true;
  });
}

export async function geneticOptimize(candles, baseParams, bounds, evaluate, config = {}) {
  const {
    populationSize = 28,
    generations = 10,
    eliteCount = 4,
    seedParams = null,
    regimeSeedRatio = 0.4,
    onProgress = null,
  } = config;

  const regimeSeedCount = seedParams
    ? Math.max(4, Math.floor(populationSize * regimeSeedRatio))
    : 0;

  let population = [];
  for (let i = 0; i < populationSize; i++) {
    population.push(randomIndividual(bounds, i < regimeSeedCount ? seedParams : null));
  }

  const allResults = [];

  for (let gen = 0; gen < generations; gen++) {
    const scored = [];
    for (const ind of population) {
      const p = { ...baseParams, ...ind };
      const r = evaluate(p);
      if (!r) continue;
      const entry = { params: { ...ind }, ...r };
      scored.push(entry);
      allResults.push(entry);
    }

    scored.sort((a, b) => b.score - a.score);
    const profitable = scored.filter(s => s.netReturn > 0);
    const ranked = profitable.length ? profitable : [];
    const nextPop = ranked.slice(0, eliteCount).map(s => ({ ...s.params }));

    while (nextPop.length < populationSize) {
      const pool = ranked.length ? ranked : scored;
      const a = pool[Math.floor(Math.random() * Math.min(8, pool.length))]?.params;
      const b = pool[Math.floor(Math.random() * Math.min(8, pool.length))]?.params;
      if (a && b) nextPop.push(mutate(crossover(a, b), bounds));
      else nextPop.push(randomIndividual(bounds, seedParams));
    }
    population = nextPop;

    if (onProgress) onProgress(Math.round(((gen + 1) / generations) * 100));
    await yieldToMain();
  }

  return filterProfitableResults(allResults).sort((a, b) => b.score - a.score);
}

export function buildParamBounds(_ranges, compact = false) {
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

function dot(w, x) {
  let s = w[0];
  for (let i = 0; i < x.length; i++) s += w[i + 1] * x[i];
  return s;
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-clamp(z, -20, 20)));
}

export function trainLogisticRegression(samples, iterations = 120, lr = 0.08) {
  if (samples.length < 8) return null;
  const dims = samples[0].x.length;
  const w = new Array(dims + 1).fill(0);

  for (let iter = 0; iter < iterations; iter++) {
    const grad = new Array(dims + 1).fill(0);
    for (const { x, y } of samples) {
      const pred = sigmoid(dot(w, x));
      const err = pred - y;
      grad[0] += err;
      for (let i = 0; i < dims; i++) grad[i + 1] += err * x[i];
    }
    for (let i = 0; i < w.length; i++) {
      w[i] -= (lr * grad[i]) / samples.length;
    }
  }
  return { weights: w };
}

export function predictLogistic(model, x) {
  if (!model) return 0.5;
  return sigmoid(dot(model.weights, x));
}

export function buildSignalFeatures(candles, idx, dir, erSeries, ciSeries) {
  const er = erSeries?.[idx] ?? 0;
  const ci = ciSeries?.[idx] ?? 50;
  const lookback = Math.min(20, idx);
  const slice = candles.slice(idx - lookback, idx + 1);
  const vol = std(slice.map((c, i, a) => i === 0 ? 0 : (c.close - a[i - 1].close) / a[i - 1].close).slice(1));
  const bar = candles[idx];
  const bodyPct = bar.close !== 0 ? Math.abs(bar.close - bar.open) / bar.close : 0;
  const dirBias = dir[idx] === 1 ? 1 : -1;
  const momentum = idx >= 5 ? (bar.close - candles[idx - 5].close) / candles[idx - 5].close : 0;

  return [er, ci / 100, vol * 100, bodyPct, dirBias, momentum, bar.vol / (mean(candles.slice(idx - 10, idx + 1).map(c => c.vol)) || 1)];
}

export function buildTradeTrainingSet(trades, candles, erSeries, ciSeries, dir) {
  const samples = [];
  for (const t of trades) {
    const idx = candles.findIndex(c => c.t === t.entryTime);
    if (idx < 5) continue;
    samples.push({
      x: buildSignalFeatures(candles, idx, dir, erSeries, ciSeries),
      y: t.win ? 1 : 0,
    });
  }
  return samples;
}

export function buildRegimeModel(candles, windowSize = 80, step = 40) {
  const history = [];
  for (let i = windowSize; i < candles.length; i += step) {
    const f = extractMarketFeatures(candles, i, windowSize);
    if (f) history.push(f);
  }
  if (!history.length) {
    const f = extractMarketFeatures(candles);
    if (f) history.push(f);
  }
  return kMeansRegime(history);
}
