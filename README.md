# AST Live — Adaptive Supertrend Backtester

React/Vite frontend with an Express API for background optimization, preset storage, and kline caching.

## Architecture

```text
Browser (Vite :5173) ── /api proxy ──► Express (:3210)
                                         ├── SQLite (data/ast-live.db)
                                         └── Worker loop (shared/engine tune jobs)
```

- **Frontend** — charts, adaptive backtest, Optimize tab, Optimized preset library
- **Backend** — persistent presets, background scan queue, Binance kline cache
- **Shared** — `shared/engine/` and `shared/ml/` used by the API worker

When the API is offline, the app falls back to localStorage presets and a client-side background tuner.

## Requirements

- Node.js **22+** (uses built-in `node:sqlite`)
- npm

## Quick start

Terminal 1 — API + background worker:

```bash
npm run dev:api
```

Or just the frontend — **the API auto-starts** with Vite on port 3210:

```bash
npm run dev
```

Or both at once:

```bash
npm run dev:all
```

Open http://localhost:5173

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `AST_API_PORT` | `3210` | API listen port |
| `AST_DB_PATH` | `data/ast-live.db` | SQLite database path |
| `AST_AUTO_SEED` | `1` | Set to `0` to skip auto job seed on startup |
| `VITE_API_URL` | `` | Override API base (empty = same origin via Vite proxy) |

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/presets` | List equity-positive presets |
| GET | `/api/presets/best` | Best preset for symbol/interval/HTF |
| POST | `/api/presets` | Save preset |
| DELETE | `/api/presets` | Clear all presets |
| GET | `/api/presets/log` | Tune activity log |
| GET | `/api/jobs/status` | Worker + queue stats |
| POST | `/api/jobs/seed` | Seed full or priority queue |
| GET | `/api/klines` | Cached Binance klines |

## Workflow

1. **Background Scan** (sidebar) — server tunes all symbol × timeframe × HTF configs; only equity-positive results are saved.
2. **Optimized tab** — browse saved configs; click a row to load symbol, dates, HTF, and params into Overview.
3. **Fine Tune (cached)** — applies the best matching preset from the library before adaptive re-tune.
4. **Auto-tune** — rolling regime-aware optimization on the current chart.

## Troubleshooting

### `/api/health` returns 502 in the browser

The Vite dev server proxies `/api` to the Express API. A **502** means the API is not running or not reachable.

1. **Use `npm run dev:all`** — starts the API first, waits for health, then starts Vite.
2. **Or run both terminals** — `npm run dev:api` in one, `npm run dev` in another.
3. **Check the API is up:**
   ```bash
   curl http://127.0.0.1:3210/api/health
   ```
4. **Port in use** — if the API fails with `EADDRINUSE`, pick another port:
   ```bash
   AST_API_PORT=3847 npm run dev:all
   ```
5. **WSL note** — proxy and API bind to `127.0.0.1` (not `localhost`) to avoid IPv6 mismatches.

When the API is offline, the app still works using **client-side fallback** (localStorage + in-browser background scan).

## Scripts

```bash
npm run dev        # Vite frontend
npm run dev:api    # Express API + worker
npm run dev:all    # Both
npm run build      # Production frontend build
npm run lint       # ESLint
```

## Data

SQLite database and kline cache live under `data/` (gitignored).
