import { DEFAULT_BASE_PARAMS } from "../../shared/constants.js";
import { tuneConfigurationJob } from "../../shared/engine/tuneJob.js";
import { isInvalidSymbolError } from "../../shared/binance.js";
import { fetchKlinesCached } from "./klines.js";
import { upsertPreset, completeJob, presetId } from "../db.js";

export async function runTuneJob(job) {
  try {
    const preset = await tuneConfigurationJob(
      { ...job, source: "server" },
      { ...DEFAULT_BASE_PARAMS, ...(job.baseParams ?? {}) },
      fetchKlinesCached,
    );

    if (preset && preset.equityEnd > preset.equityStart) {
      const saved = upsertPreset({ ...preset, id: presetId(preset) });
      completeJob(job.id, saved.id);
      return saved;
    }

    completeJob(job.id, null);
    return null;
  } catch (e) {
    if (isInvalidSymbolError(e)) {
      console.warn(`Skipping invalid FAPI symbol: ${job.symbol}`);
      completeJob(job.id, null);
      return null;
    }
    throw e;
  }
}

export { fetchKlinesCached };
