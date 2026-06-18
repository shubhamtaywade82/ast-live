import { Router } from "express";
import {
  listPresets,
  findBestPreset,
  upsertPreset,
  deletePreset,
  clearPresets,
  getTuneLog,
  presetId,
} from "../db.js";

const router = Router();

router.get("/", (req, res) => {
  const presets = listPresets({
    symbol: req.query.symbol || undefined,
    interval: req.query.interval || undefined,
    limit: Math.min(2000, +(req.query.limit || 500)),
  });
  res.json({ presets, count: presets.length });
});

router.get("/best", (req, res) => {
  const { symbol, interval, htfMultiplier, startDate, endDate } = req.query;
  if (!symbol || !interval) {
    return res.status(400).json({ error: "symbol and interval required" });
  }
  const preset = findBestPreset({
    symbol,
    interval,
    htfMultiplier: +(htfMultiplier || 0),
    startDate,
    endDate,
  });
  res.json({ preset });
});

router.get("/log", (_req, res) => {
  res.json({ log: getTuneLog(100) });
});

router.post("/", (req, res) => {
  const preset = req.body;
  if (!preset?.symbol || !preset?.params) {
    return res.status(400).json({ error: "invalid preset" });
  }
  preset.id = preset.id ?? presetId(preset);
  const saved = upsertPreset(preset);
  res.json({ preset: saved });
});

router.delete("/:id", (req, res) => {
  deletePreset(req.params.id);
  res.json({ ok: true });
});

router.delete("/", (_req, res) => {
  clearPresets();
  res.json({ ok: true });
});

export default router;
