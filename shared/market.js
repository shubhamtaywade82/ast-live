export const SYMBOLS = [
  "SOLUSDT", "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT",
  "NEARUSDT", "ATOMUSDT", "INJUSDT", "SUIUSDT", "WIFUSDT",
  "1000PEPEUSDT", "TIAUSDT", "SEIUSDT", "AAVEUSDT", "LTCUSDT",
];

export const INTERVALS = [
  { label: "1m", ms: 60e3 }, { label: "3m", ms: 3 * 60e3 }, { label: "5m", ms: 5 * 60e3 },
  { label: "15m", ms: 15 * 60e3 }, { label: "30m", ms: 30 * 60e3 },
  { label: "1h", ms: 3600e3 }, { label: "2h", ms: 2 * 3600e3 }, { label: "4h", ms: 4 * 3600e3 },
  { label: "6h", ms: 6 * 3600e3 }, { label: "12h", ms: 12 * 3600e3 },
  { label: "1d", ms: 86400e3 }, { label: "3d", ms: 3 * 86400e3 },
  { label: "1w", ms: 7 * 86400e3 }, { label: "1M", ms: 30 * 86400e3 },
];

export const BACKGROUND_SYMBOLS = SYMBOLS;
export const BACKGROUND_INTERVALS = ["5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w"];
export const BACKGROUND_HTF_MULTIPLIERS = [0, 4, 6, 12, 24];

export const MAX_HISTORY_DAYS = {
  "1m": 7, "3m": 14, "5m": 30, "15m": 60, "30m": 90,
  "1h": 180, "2h": 365, "4h": 365, "6h": 730, "12h": 730,
  "1d": 1095, "3d": 1095, "1w": 1825, "1M": 1825,
};

export function maxHistoryDays(interval) {
  return MAX_HISTORY_DAYS[interval] ?? 90;
}

export function maxDateRangeForInterval(interval, now = Date.now()) {
  const days = maxHistoryDays(interval);
  const endMs = now;
  const startMs = now - days * 86400e3;
  return {
    startMs,
    endMs,
    startDate: new Date(startMs).toISOString().slice(0, 10),
    endDate: new Date(endMs).toISOString().slice(0, 10),
    days,
  };
}

export function buildBackgroundJobQueue(symbols, intervals, htfMultipliers, now = Date.now()) {
  const jobs = [];
  for (const symbol of symbols) {
    for (const interval of intervals) {
      const range = maxDateRangeForInterval(interval, now);
      for (const htfMultiplier of htfMultipliers) {
        jobs.push({ symbol, interval, htfMultiplier, ...range });
      }
    }
  }
  return jobs;
}

export function intervalMs(label) {
  return INTERVALS.find(i => i.label === label)?.ms ?? 3600e3;
}

export function htfLabelFor(interval, htfMultiplier) {
  const htfMs = intervalMs(interval) * htfMultiplier;
  return INTERVALS.find(i => i.ms >= htfMs)?.label || interval;
}
