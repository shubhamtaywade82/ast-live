const STORAGE_KEY = "ast-live-optimized-presets-v1";
const LOG_KEY = "ast-live-tune-log-v1";

export function presetKey({ symbol, interval, htfMultiplier, startDate, endDate }) {
  return `${symbol}|${interval}|${htfMultiplier}|${startDate}|${endDate}`;
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("presetStore write failed:", e);
  }
}

export function loadPresetsLocal() {
  return readJson(STORAGE_KEY, []);
}

export function loadTuneLogLocal() {
  return readJson(LOG_KEY, []);
}

export function savePresetLocal(preset) {
  const presets = loadPresetsLocal();
  const id = preset.id ?? presetKey(preset);
  const idx = presets.findIndex(p => p.id === id);
  const next = { ...preset, id, updatedAt: new Date().toISOString() };

  if (idx >= 0) {
    const prev = presets[idx];
    if ((next.equityEnd ?? 0) >= (prev.equityEnd ?? 0)) {
      presets[idx] = { ...prev, ...next, hits: (prev.hits ?? 1) + 1 };
    }
  } else {
    presets.push({ ...next, hits: 1, createdAt: new Date().toISOString() });
  }

  presets.sort((a, b) => (b.equityEnd ?? 0) - (a.equityEnd ?? 0));
  writeJson(STORAGE_KEY, presets.slice(0, 2000));
  return presets;
}

export function findBestPresetLocal(presets, { symbol, interval, htfMultiplier, startDate, endDate }) {
  if (!presets.length) return null;
  const exact = presets.find(p =>
    p.symbol === symbol && p.interval === interval && p.htfMultiplier === htfMultiplier
    && p.startDate === startDate && p.endDate === endDate && p.equityEnd > p.equityStart,
  );
  if (exact) return exact;
  return presets
    .filter(p => p.symbol === symbol && p.interval === interval && p.htfMultiplier === htfMultiplier && p.equityEnd > p.equityStart)
    .sort((a, b) => (b.equityEnd ?? 0) - (a.equityEnd ?? 0))[0] ?? null;
}

export function listPresetsLocal(filters = {}) {
  let presets = loadPresetsLocal();
  if (filters.symbol) presets = presets.filter(p => p.symbol === filters.symbol);
  if (filters.interval) presets = presets.filter(p => p.interval === filters.interval);
  if (filters.positiveOnly !== false) presets = presets.filter(p => p.equityEnd > p.equityStart);
  return presets.sort((a, b) => (b.equityEnd ?? 0) - (a.equityEnd ?? 0));
}

export function clearPresetsLocal() {
  writeJson(STORAGE_KEY, []);
  return [];
}
