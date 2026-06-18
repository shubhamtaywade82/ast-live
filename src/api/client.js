const API_BASE = import.meta.env.VITE_API_URL || "";

let healthCache = { ok: false, ts: 0 };
let healthPromise = null;
const HEALTH_TTL_MS = 10000;

async function fetchHealth() {
  try {
    const res = await fetch(`${API_BASE}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok && data?.service === "ast-live-api" ? data : null;
  } catch {
    return null;
  }
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `API ${res.status}`);
  }
  return res.json();
}

export async function apiHealth() {
  return fetchHealth();
}

export async function fetchPresets(filters = {}) {
  const q = new URLSearchParams();
  if (filters.symbol) q.set("symbol", filters.symbol);
  if (filters.interval) q.set("interval", filters.interval);
  if (filters.limit) q.set("limit", String(filters.limit));
  const data = await request(`/api/presets?${q}`);
  return data.presets ?? [];
}

export async function fetchBestPreset(query) {
  const q = new URLSearchParams(query);
  const data = await request(`/api/presets/best?${q}`);
  return data.preset ?? null;
}

export async function savePresetApi(preset) {
  const data = await request("/api/presets", { method: "POST", body: JSON.stringify(preset) });
  return data.preset;
}

export async function clearPresetsApi() {
  return request("/api/presets", { method: "DELETE" });
}

export async function fetchTuneLog() {
  const data = await request("/api/presets/log");
  return data.log ?? [];
}

export async function fetchJobStatus() {
  return request("/api/jobs/status");
}

export async function seedJobs(mode = "full", current = null) {
  return request("/api/jobs/seed", {
    method: "POST",
    body: JSON.stringify({ mode, current }),
  });
}

export async function fetchKlinesApi(symbol, interval, startMs, endMs) {
  const q = new URLSearchParams({
    symbol, interval, startMs: String(startMs), endMs: String(endMs),
  });
  const data = await request(`/api/klines?${q}`);
  return data.candles ?? [];
}

export async function isApiAvailable() {
  const now = Date.now();
  if (now - healthCache.ts < HEALTH_TTL_MS) return healthCache.ok;

  if (!healthPromise) {
    healthPromise = fetchHealth()
      .then(h => {
        healthCache = { ok: !!h?.ok, ts: Date.now() };
        return healthCache.ok;
      })
      .finally(() => {
        healthPromise = null;
      });
  }

  return healthPromise;
}

export function resetApiHealthCache() {
  healthCache = { ok: false, ts: 0 };
  healthPromise = null;
}
