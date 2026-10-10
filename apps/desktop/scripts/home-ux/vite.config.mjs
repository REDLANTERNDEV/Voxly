import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
export default defineConfig({
  root,
  plugins: [
    {
      name: "fixture-label",
      transformIndexHtml(html) {
        return html.replace("<title>Voxly · Home</title>", "<title>Voxly Home regression fixture</title>");
      }
    }
  ],
  resolve: {
    alias: {
      "@tauri-apps/api/core": fileURLToPath(new URL("core.mjs", import.meta.url)),
      "@tauri-apps/api/event": fileURLToPath(new URL("events.mjs", import.meta.url))
    }
  },
  server: { host: "127.0.0.1", port: 1423, strictPort: true }
});
