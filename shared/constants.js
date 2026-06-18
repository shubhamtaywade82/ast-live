export const FAPI = "https://fapi.binance.com/fapi/v1/klines";
export const BATCH = 1500;
export const FEE_RT = 0.0008;
export const SLIP_RT = 0.0004;
export const COST_RT = FEE_RT + SLIP_RT;

export const DEFAULT_BASE_PARAMS = {
  atrPeriod: 10,
  erLength: 14,
  smoothLength: 5,
  minFactor: 1.5,
  maxFactor: 4.5,
  useRegimeFilter: true,
  useVWER: false,
  chopThreshold: 61.8,
  riskPct: 0.01,
  startEquity: 10000,
  minStopPct: 0.001,
  barsPerYear: 365 * 24,
  useTrailingStop: false,
  useBreakEven: false,
  breakEvenPct: 1.0,
  useATRSizing: false,
  atrMult: 2,
  sessionFilter: false,
  sessionHours: [0, 24],
  useMLFilter: true,
  mlThreshold: 0.42,
};

export const AUTO_TUNE_KEYS = [
  "atrPeriod", "erLength", "smoothLength", "minFactor", "maxFactor",
  "useRegimeFilter", "chopThreshold", "useVWER",
  "useTrailingStop", "useBreakEven", "breakEvenPct",
  "useATRSizing", "atrMult", "useMLFilter", "mlThreshold", "riskPct",
];
