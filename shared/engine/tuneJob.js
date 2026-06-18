import { normalizeParams } from "../ml/engine.js";
import { INTERVALS } from "../market.js";
import { AUTO_TUNE_KEYS } from "../constants.js";
import { fetchKlines } from "../binance.js";
import { getAdaptiveConfig, runAdaptiveBacktest } from "./adaptive.js";
import {
  buildOptRanges,
  resolveHtfAligned,
  runEquityPositiveParamSearch,
} from "./optimization.js";

export async function tuneConfigurationJob(job, baseParams, fetchFn = fetchKlines) {
  const ms = INTERVALS.find(i => i.label === job.interval)?.ms ?? 3600e3;
  const barsPerYear = Math.max(1, Math.round((365.25 * 86400e3) / ms));
  const tuneParams = { ...baseParams, barsPerYear };

  const candles = await fetchFn(job.symbol, job.interval, job.startMs, job.endMs);
  if (candles.length < 100) return null;

  const { htfAligned } = await resolveHtfAligned(
    candles, job.symbol, job.interval, job.htfMultiplier, tuneParams, job.startMs, job.endMs, fetchFn,
  ).catch(() => ({ htfAligned: null }));

  const config = getAdaptiveConfig(candles.length);
  const ranges = buildOptRanges(true);
  const r = runAdaptiveBacktest(candles, tuneParams, ranges, config, htfAligned, null, { useML: true });

  const searchEntries = runEquityPositiveParamSearch(candles, tuneParams, htfAligned, null);
  const bestEntry = searchEntries[0];
  const tunedParams = r.tunedParams ?? bestEntry?.params;
  if (!tunedParams) return null;

  const equityStart = tuneParams.startEquity || 10000;
  const equityEnd = r.equityCurve?.filter(v => !isNaN(v)).at(-1) ?? equityStart;
  if (equityEnd <= equityStart) return null;

  return {
    symbol: job.symbol,
    interval: job.interval,
    htfMultiplier: job.htfMultiplier,
    startDate: job.startDate,
    endDate: job.endDate,
    startMs: job.startMs,
    endMs: job.endMs,
    params: normalizeParams(tunedParams, AUTO_TUNE_KEYS),
    equityStart,
    equityEnd,
    equityGain: equityEnd - equityStart,
    netReturn: parseFloat(r.stats?.netReturn ?? bestEntry?.netReturn ?? 0),
    sharpe: r.stats?.sharpe,
    maxDD: r.stats?.maxDD,
    totalTrades: r.stats?.totalTrades,
    regime: r.currentRegime?.label ?? bestEntry?.regime ?? r.mlMeta?.regime?.label,
    regimeConfidence: r.currentRegime?.confidence ?? r.mlMeta?.regime?.confidence,
    barCount: candles.length,
    source: job.source ?? "background",
  };
}
