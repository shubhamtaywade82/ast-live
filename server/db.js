import { DatabaseSync } from "node:sqlite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = process.env.AST_DB_PATH || path.join(DATA_DIR, "ast-live.db");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS presets (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    htf_multiplier INTEGER NOT NULL DEFAULT 0,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    params_json TEXT NOT NULL,
    equity_start REAL NOT NULL,
    equity_end REAL NOT NULL,
    equity_gain REAL NOT NULL,
    net_return REAL,
    sharpe TEXT,
    max_dd TEXT,
    total_trades INTEGER,
    regime TEXT,
    regime_confidence REAL,
    bar_count INTEGER,
    source TEXT,
    hits INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_presets_symbol ON presets(symbol);
  CREATE INDEX IF NOT EXISTS idx_presets_equity ON presets(equity_end DESC);

  CREATE TABLE IF NOT EXISTS tune_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    htf_multiplier INTEGER NOT NULL DEFAULT 0,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    preset_id TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_status ON tune_jobs(status, priority DESC, id ASC);

  CREATE TABLE IF NOT EXISTS tune_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    preset_id TEXT,
    symbol TEXT,
    interval TEXT,
    htf_multiplier INTEGER,
    equity_end REAL,
    net_return REAL,
    regime TEXT,
    source TEXT,
    logged_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kline_cache (
    cache_key TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    bar_count INTEGER NOT NULL,
    fetched_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_kline_lookup ON kline_cache(symbol, interval);
`);

export function presetId(job) {
  return `${job.symbol}|${job.interval}|${job.htfMultiplier}|${job.startDate}|${job.endDate}`;
}

export function upsertPreset(preset) {
  const id = preset.id ?? presetId(preset);
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM presets WHERE id = ?").get(id);

  if (existing && (preset.equityEnd ?? 0) <= existing.equity_end) {
    return { ...rowToPreset(existing), kept: true };
  }

  const row = {
    id,
    symbol: preset.symbol,
    interval: preset.interval,
    htf_multiplier: preset.htfMultiplier ?? 0,
    start_date: preset.startDate,
    end_date: preset.endDate,
    start_ms: preset.startMs,
    end_ms: preset.endMs,
    params_json: JSON.stringify(preset.params),
    equity_start: preset.equityStart,
    equity_end: preset.equityEnd,
    equity_gain: preset.equityGain,
    net_return: preset.netReturn,
    sharpe: String(preset.sharpe ?? ""),
    max_dd: String(preset.maxDD ?? ""),
    total_trades: preset.totalTrades ?? 0,
    regime: preset.regime ?? null,
    regime_confidence: preset.regimeConfidence ?? null,
    bar_count: preset.barCount ?? 0,
    source: preset.source ?? "background",
    hits: existing ? existing.hits + 1 : 1,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };

  db.prepare(`
    INSERT INTO presets (
      id, symbol, interval, htf_multiplier, start_date, end_date, start_ms, end_ms,
      params_json, equity_start, equity_end, equity_gain, net_return, sharpe, max_dd,
      total_trades, regime, regime_confidence, bar_count, source, hits, created_at, updated_at
    ) VALUES (
      @id, @symbol, @interval, @htf_multiplier, @start_date, @end_date, @start_ms, @end_ms,
      @params_json, @equity_start, @equity_end, @equity_gain, @net_return, @sharpe, @max_dd,
      @total_trades, @regime, @regime_confidence, @bar_count, @source, @hits, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      params_json = excluded.params_json,
      equity_start = excluded.equity_start,
      equity_end = excluded.equity_end,
      equity_gain = excluded.equity_gain,
      net_return = excluded.net_return,
      sharpe = excluded.sharpe,
      max_dd = excluded.max_dd,
      total_trades = excluded.total_trades,
      regime = excluded.regime,
      regime_confidence = excluded.regime_confidence,
      bar_count = excluded.bar_count,
      source = excluded.source,
      hits = excluded.hits,
      updated_at = excluded.updated_at
  `).run(row);

  db.prepare(`
    INSERT INTO tune_log (preset_id, symbol, interval, htf_multiplier, equity_end, net_return, regime, source, logged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, preset.symbol, preset.interval, preset.htfMultiplier ?? 0, preset.equityEnd, preset.netReturn, preset.regime, preset.source, now);

  return rowToPreset(row);
}

function rowToPreset(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    interval: row.interval,
    htfMultiplier: row.htf_multiplier,
    startDate: row.start_date,
    endDate: row.end_date,
    startMs: row.start_ms,
    endMs: row.end_ms,
    params: JSON.parse(row.params_json),
    equityStart: row.equity_start,
    equityEnd: row.equity_end,
    equityGain: row.equity_gain,
    netReturn: row.net_return,
    sharpe: row.sharpe,
    maxDD: row.max_dd,
    totalTrades: row.total_trades,
    regime: row.regime,
    regimeConfidence: row.regime_confidence,
    barCount: row.bar_count,
    source: row.source,
    hits: row.hits,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listPresets({ symbol, interval, limit = 500 } = {}) {
  let sql = "SELECT * FROM presets WHERE equity_end > equity_start";
  const params = [];
  if (symbol) { sql += " AND symbol = ?"; params.push(symbol); }
  if (interval) { sql += " AND interval = ?"; params.push(interval); }
  sql += " ORDER BY equity_end DESC LIMIT ?";
  params.push(limit);
  return db.prepare(sql).all(...params).map(rowToPreset);
}

export function findBestPreset({ symbol, interval, htfMultiplier, startDate, endDate }) {
  const exact = db.prepare(`
    SELECT * FROM presets WHERE symbol = ? AND interval = ? AND htf_multiplier = ?
      AND start_date = ? AND end_date = ? AND equity_end > equity_start
  `).get(symbol, interval, htfMultiplier ?? 0, startDate, endDate);
  if (exact) return rowToPreset(exact);

  const best = db.prepare(`
    SELECT * FROM presets WHERE symbol = ? AND interval = ? AND htf_multiplier = ?
      AND equity_end > equity_start ORDER BY equity_end DESC LIMIT 1
  `).get(symbol, interval, htfMultiplier ?? 0);
  return best ? rowToPreset(best) : null;
}

export function deletePreset(id) {
  return db.prepare("DELETE FROM presets WHERE id = ?").run(id).changes;
}

export function clearPresets() {
  db.prepare("DELETE FROM presets").run();
  db.prepare("DELETE FROM tune_log").run();
}

export function getTuneLog(limit = 50) {
  return db.prepare("SELECT * FROM tune_log ORDER BY id DESC LIMIT ?").all(limit);
}

export function enqueueJobs(jobs, priority = 0) {
  const insert = db.prepare(`
    INSERT INTO tune_jobs (symbol, interval, htf_multiplier, start_date, end_date, start_ms, end_ms, status, priority, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `);
  const existsStmt = db.prepare(`
    SELECT id FROM tune_jobs WHERE symbol = ? AND interval = ? AND htf_multiplier = ?
      AND start_date = ? AND end_date = ? AND status IN ('pending', 'running')
  `);
  const now = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const j of jobs) {
      const exists = existsStmt.get(j.symbol, j.interval, j.htfMultiplier ?? 0, j.startDate, j.endDate);
      if (!exists) {
        insert.run(j.symbol, j.interval, j.htfMultiplier ?? 0, j.startDate, j.endDate, j.startMs, j.endMs, priority, now);
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return db.prepare("SELECT COUNT(*) as c FROM tune_jobs WHERE status = 'pending'").get().c;
}

export function claimNextJob() {
  const job = db.prepare(`
    SELECT * FROM tune_jobs WHERE status = 'pending'
    ORDER BY priority DESC, id ASC LIMIT 1
  `).get();
  if (!job) return null;
  const now = new Date().toISOString();
  db.prepare("UPDATE tune_jobs SET status = 'running', started_at = ? WHERE id = ?").run(now, job.id);
  return {
    id: job.id,
    symbol: job.symbol,
    interval: job.interval,
    htfMultiplier: job.htf_multiplier,
    startDate: job.start_date,
    endDate: job.end_date,
    startMs: job.start_ms,
    endMs: job.end_ms,
  };
}

export function completeJob(jobId, presetIdValue, error = null) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tune_jobs SET status = ?, preset_id = ?, error = ?, finished_at = ? WHERE id = ?
  `).run(error ? "failed" : presetIdValue ? "done" : "skipped", presetIdValue, error, now, jobId);
}

export function jobStats() {
  const rows = db.prepare(`
    SELECT status, COUNT(*) as c FROM tune_jobs GROUP BY status
  `).all();
  const map = Object.fromEntries(rows.map(r => [r.status, r.c]));
  return {
    pending: map.pending ?? 0,
    running: map.running ?? 0,
    done: map.done ?? 0,
    failed: map.failed ?? 0,
    skipped: map.skipped ?? 0,
    total: Object.values(map).reduce((a, b) => a + b, 0),
  };
}

export function skipPendingJobsForSymbols(symbols) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE tune_jobs SET status = 'skipped', error = 'invalid symbol', finished_at = ?
    WHERE symbol = ? AND status = 'pending'
  `);
  let total = 0;
  for (const symbol of symbols) {
    total += stmt.run(now, symbol).changes;
  }
  return total;
}

export function getKlineCache(symbol, interval, startMs, endMs) {
  const key = `${symbol}|${interval}|${startMs}|${endMs}`;
  const row = db.prepare("SELECT * FROM kline_cache WHERE cache_key = ?").get(key);
  if (!row) return null;
  return JSON.parse(row.data_json);
}

export function setKlineCache(symbol, interval, startMs, endMs, candles) {
  const key = `${symbol}|${interval}|${startMs}|${endMs}`;
  db.prepare(`
    INSERT INTO kline_cache (cache_key, symbol, interval, start_ms, end_ms, data_json, bar_count, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET data_json = excluded.data_json, bar_count = excluded.bar_count, fetched_at = excluded.fetched_at
  `).run(key, symbol, interval, startMs, endMs, JSON.stringify(candles), candles.length, new Date().toISOString());
}

export default db;
