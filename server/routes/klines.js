import { Router } from "express";
import { fetchKlinesCached } from "../services/klines.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const { symbol, interval, startMs, endMs } = req.query;
    if (!symbol || !interval || !startMs || !endMs) {
      return res.status(400).json({ error: "symbol, interval, startMs, endMs required" });
    }
    const candles = await fetchKlinesCached(
      symbol,
      interval,
      +startMs,
      +endMs,
    );
    res.json({ candles, count: candles.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
