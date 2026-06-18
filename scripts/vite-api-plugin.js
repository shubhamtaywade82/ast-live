import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function waitForHealth(host, port, timeoutMs = 30000) {
  const url = `http://${host}:${port}/api/health`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (data?.ok && data?.service === "ast-live-api") return true;
    } catch {
      // API still starting or wrong service on port
    }
    await new Promise(r => setTimeout(r, 250));
  }

  return false;
}

export function astApiDevPlugin({ host, port }) {
  let proc = null;

  const stop = () => {
    if (!proc) return;
    proc.kill("SIGTERM");
    proc = null;
  };

  return {
    name: "ast-api-dev",
    async configureServer() {
      if (process.env.AST_SKIP_EMBED_API === "1") return;

      const serverEntry = path.join(root, "server/index.js");
      proc = spawn(process.execPath, [serverEntry], {
        cwd: root,
        env: {
          ...process.env,
          AST_API_HOST: host,
          AST_API_PORT: String(port),
        },
        stdio: "inherit",
      });

      proc.on("exit", (code, signal) => {
        if (signal !== "SIGTERM" && code !== 0 && code !== null) {
          console.error(`[ast-api] exited (code=${code}, signal=${signal})`);
        }
        proc = null;
      });

      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);

      const ready = await waitForHealth(host, port);
      if (!ready) {
        console.warn("[ast-api] API not ready yet — /api may 502 briefly");
      }
    },
    closeBundle: stop,
  };
}
