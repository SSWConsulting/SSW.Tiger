import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(() => {
  const apiTarget = process.env.TIGER_API_TARGET || "http://localhost:7071";
  const functionKey = process.env.TIGER_FUNCTION_KEY;

  return {
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
