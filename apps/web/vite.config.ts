import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

export default defineConfig({
  plugins: [react()],
  define: { __VOXLY_WEB_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version) },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/socket.io": {
        target: "http://127.0.0.1:3000",
        ws: true
      }
    }
  },
  build: {
    sourcemap: true
  }
});
