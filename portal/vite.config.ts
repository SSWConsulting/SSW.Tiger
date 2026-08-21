import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  // Load .env from the repo root (one level up from portal/) so a single
  // root .env can configure the dev proxy. Empty prefix loads all vars,
  // including the non-VITE_ TIGER_* ones used only by this config.
  const envDir = resolve(process.cwd(), "..");
  const env = loadEnv(mode, envDir, "");
  const apiTarget = env.TIGER_API_TARGET || "http://localhost:7071";

  // In production SWA injects the trusted x-ms-client-principal header; locally
  // there is no SWA edge, so inject a mock principal for the anonymous Portal API
  // (matches the dev principal used by the SPA). Override via TIGER_DEV_PRINCIPAL.
  const devPrincipal =
    env.TIGER_DEV_PRINCIPAL ||
    Buffer.from(
      JSON.stringify({
        identityProvider: "dev",
        userId: "dev-user",
        userDetails: "dev@ssw.com.au",
        userRoles: ["authenticated"],
      }),
    ).toString("base64");

  return {
    envDir,
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          configure(proxy) {
            proxy.on("proxyReq", (proxyRequest) => {
              proxyRequest.setHeader("x-ms-client-principal", devPrincipal);
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
