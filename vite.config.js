import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { astApiDevPlugin } from "./scripts/vite-api-plugin.js";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = env.AST_API_PORT || "3210";
  const apiHost = env.AST_API_HOST || "127.0.0.1";

  return {
    plugins: [
      react(),
      astApiDevPlugin({ host: apiHost, port: apiPort }),
    ],
    server: {
      proxy: {
        "/api": {
          target: `http://${apiHost}:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
