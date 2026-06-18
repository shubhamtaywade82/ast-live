import {
  loadPresetsLocal,
  savePresetLocal,
  findBestPresetLocal,
  listPresetsLocal,
  clearPresetsLocal,
  loadTuneLogLocal,
} from "./presetStore.local.js";
import {
  fetchPresets,
  fetchBestPreset,
  savePresetApi,
  clearPresetsApi,
  fetchTuneLog,
  isApiAvailable,
  resetApiHealthCache,
  seedJobs,
  fetchJobStatus,
} from "../api/client.js";

let apiOnline = null;
let ensurePromise = null;

async function ensureApi() {
  if (apiOnline !== null) return apiOnline;
  if (!ensurePromise) {
    ensurePromise = isApiAvailable()
      .then(ok => {
        apiOnline = ok;
        return ok;
      })
      .finally(() => {
        ensurePromise = null;
      });
  }
  return ensurePromise;
}

function markApiOffline() {
  apiOnline = false;
  resetApiHealthCache();
}

export async function loadPresets() {
  if (await ensureApi()) {
    try { return await fetchPresets(); } catch { markApiOffline(); }
  }
  return loadPresetsLocal();
}

export async function listPresets(filters = {}) {
  if (await ensureApi()) {
    try { return await fetchPresets(filters); } catch { markApiOffline(); }
  }
  return listPresetsLocal(filters);
}

export async function findBestPreset(query) {
  if (await ensureApi()) {
    try {
      const p = await fetchBestPreset(query);
      if (p) return p;
    } catch { markApiOffline(); }
  }
  return findBestPresetLocal(loadPresetsLocal(), query);
}

export async function savePreset(preset) {
  if (await ensureApi()) {
    try { await savePresetApi(preset); } catch { markApiOffline(); }
  }
  return savePresetLocal(preset);
}

export async function clearPresets() {
  if (await ensureApi()) {
    try { await clearPresetsApi(); } catch { markApiOffline(); }
  }
  return clearPresetsLocal();
}

export async function loadTuneLog() {
  if (await ensureApi()) {
    try { return await fetchTuneLog(); } catch { markApiOffline(); }
  }
  return loadTuneLogLocal();
}

export async function startBackgroundScan(current = null) {
  if (await ensureApi()) {
    try {
      return await seedJobs(current ? "priority" : "full", current);
    } catch { markApiOffline(); }
  }
  return null;
}

export async function getBackgroundStatus() {
  if (await ensureApi()) {
    try { return await fetchJobStatus(); } catch { markApiOffline(); }
  }
  return null;
}

export function isUsingBackend() {
  return apiOnline === true;
}

export { presetKey } from "./presetStore.local.js";
