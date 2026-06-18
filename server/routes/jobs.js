import { Router } from "express";
import {
  seedFullQueue,
  seedPriorityQueue,
  getWorkerStatus,
  startWorkerLoop,
  stopWorker,
} from "../services/queue.js";
import { jobStats } from "../db.js";

const router = Router();

router.get("/status", (_req, res) => {
  res.json(getWorkerStatus());
});

router.post("/seed", (req, res) => {
  const { mode = "full", current } = req.body ?? {};
  const pending = mode === "priority" && current
    ? seedPriorityQueue(current)
    : seedFullQueue();
  if (!getWorkerStatus().running) startWorkerLoop();
  res.json({ pending, stats: jobStats() });
});

router.post("/start", (_req, res) => {
  startWorkerLoop();
  res.json(getWorkerStatus());
});

router.post("/stop", (_req, res) => {
  stopWorker();
  res.json({ ok: true });
});

export default router;
