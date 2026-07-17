import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  // Load .env from the repo root (one level up from portal/) so a single
  // root .env can configure the dev proxy. Empty prefix loads all vars,
  // including the non-VITE_ TIGER_* ones used only by this config.
  const envDir = resolve(process.cwd(), "..");
  const env = loadEnv(mode, envDir, "");
  const apiTarget = env.TIGER_API_TARGET || "http://localhost:7071";
  const functionKey = env.TIGER_FUNCTION_KEY;

  return {
    envDir,
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          configure(proxy) {
            proxy.on("proxyReq", (proxyRequest) => {
              if (functionKey) proxyRequest.setHeader("x-functions-key", functionKey);
            });
          },
        },
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: "./src/testSetup.ts",
    },
  };
});
