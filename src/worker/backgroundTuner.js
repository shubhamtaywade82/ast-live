import {
  BACKGROUND_SYMBOLS,
  BACKGROUND_INTERVALS,
  BACKGROUND_HTF_MULTIPLIERS,
  buildBackgroundJobQueue,
} from "../../shared/market.js";

export function createBackgroundQueue(options = {}) {
  const symbols = options.symbols ?? BACKGROUND_SYMBOLS;
  const intervals = options.intervals ?? BACKGROUND_INTERVALS;
  const htfMultipliers = options.htfMultipliers ?? BACKGROUND_HTF_MULTIPLIERS;
  return buildBackgroundJobQueue(symbols, intervals, htfMultipliers, options.now);
}

export async function runBackgroundTuner({
  jobs,
  runJob,
  onProgress,
  onJobStart,
  onJobComplete,
  shouldStop,
  shouldPause,
  delayMs = 120,
}) {
  const total = jobs.length;
  let completed = 0;
  let saved = 0;
  const errors = [];

  for (const job of jobs) {
    while (shouldPause?.()) {
      if (shouldStop?.()) break;
      await new Promise(r => setTimeout(r, 400));
    }
    if (shouldStop?.()) break;

    onJobStart?.(job, completed, total);

    try {
      const preset = await runJob(job);
      if (preset?.equityEnd > preset?.equityStart) saved += 1;
      onJobComplete?.(job, preset, { completed: completed + 1, total, saved });
    } catch (e) {
      errors.push({ job, message: e.message });
      onJobComplete?.(job, null, { completed: completed + 1, total, saved, error: e.message });
    }

    completed += 1;
    onProgress?.(Math.round((completed / total) * 100), { completed, total, saved, current: job });

    if (shouldStop?.()) break;
    await new Promise(r => setTimeout(r, delayMs));
  }

  return { completed, total, saved, errors };
}
