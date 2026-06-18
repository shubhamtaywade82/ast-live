import { DEFAULT_BASE_PARAMS } from "../../shared/constants.js";
import { tuneConfigurationJob } from "../../shared/engine/tuneJob.js";
import { fetchKlinesCached } from "./klines.js";
import { upsertPreset, completeJob, presetId } from "../db.js";

export async function runTuneJob(job) {
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
}

export { fetchKlinesCached };
