import {
  BACKGROUND_SYMBOLS,
  BACKGROUND_INTERVALS,
  BACKGROUND_HTF_MULTIPLIERS,
  buildBackgroundJobQueue,
} from "../../shared/market.js";
import { enqueueJobs, claimNextJob, completeJob, jobStats } from "../db.js";
import { runTuneJob } from "./tuner.js";

let workerRunning = false;
let workerStop = false;
let currentJob = null;

export function prioritizeJobs(jobs, current) {
  if (!current?.symbol) return jobs;
  const head = [];
  const tail = [];
  for (const job of jobs) {
    const match = job.symbol === current.symbol
      && job.interval === current.interval
      && job.htfMultiplier === current.htfMultiplier;
    (match ? head : tail).push(job);
  }
  return [...head, ...tail];
}

export function seedFullQueue(priority = 0) {
  const jobs = buildBackgroundJobQueue(
    BACKGROUND_SYMBOLS,
    BACKGROUND_INTERVALS,
    BACKGROUND_HTF_MULTIPLIERS,
  );
  return enqueueJobs(jobs, priority);
}

export function seedPriorityQueue(current, priority = 10) {
  const jobs = prioritizeJobs(
    buildBackgroundJobQueue([current.symbol], [current.interval], [current.htfMultiplier ?? 0]),
    current,
  );
  return enqueueJobs(jobs, priority);
}

export function getWorkerStatus() {
  return {
    running: workerRunning,
    currentJob,
    stats: jobStats(),
  };
}

export function stopWorker() {
  workerStop = true;
}

export async function startWorkerLoop() {
  if (workerRunning) return;
  workerRunning = true;
  workerStop = false;

  while (!workerStop) {
    const job = claimNextJob();
    if (!job) {
      await sleep(2000);
      continue;
    }

    currentJob = job;
    try {
      await runTuneJob(job);
    } catch (e) {
      console.error("Tune job failed:", job, e);
      completeJob(job.id, null, e.message);
    }
    currentJob = null;
    await sleep(150);
  }

  workerRunning = false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
