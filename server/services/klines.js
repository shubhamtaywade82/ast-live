import { fetchKlines } from "../../shared/binance.js";
import { getKlineCache, setKlineCache } from "../db.js";

export async function fetchKlinesCached(symbol, interval, startMs, endMs) {
  const cached = getKlineCache(symbol, interval, startMs, endMs);
  if (cached?.length) return cached;

  const candles = await fetchKlines(symbol, interval, startMs, endMs);
  if (candles.length) setKlineCache(symbol, interval, startMs, endMs, candles);
  return candles;
}
