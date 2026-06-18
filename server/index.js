import express from "express";
import cors from "cors";
import presetsRouter from "./routes/presets.js";
import jobsRouter from "./routes/jobs.js";
import klinesRouter from "./routes/klines.js";
import { startWorkerLoop, seedFullQueue } from "./services/queue.js";
import { skipPendingJobsForSymbols } from "./db.js";

const LEGACY_INVALID_SYMBOLS = ["PEPEUSDT"];

const app = express();
const PORT = process.env.AST_API_PORT || 3210;
const HOST = process.env.AST_API_HOST || "127.0.0.1";

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "ast-live-api", ts: new Date().toISOString() });
});

app.use("/api/presets", presetsRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/klines", klinesRouter);

app.listen(PORT, HOST, () => {
  console.log(`AST Live API http://${HOST}:${PORT}`);
  if (process.env.AST_AUTO_SEED !== "0") {
    const skipped = skipPendingJobsForSymbols(LEGACY_INVALID_SYMBOLS);
    if (skipped > 0) console.log(`Skipped ${skipped} pending jobs with invalid FAPI symbols`);
    const pending = seedFullQueue();
    console.log(`Seeded ${pending} tune jobs`);
    startWorkerLoop();
  }
}).on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} in use — set AST_API_PORT to another port`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
