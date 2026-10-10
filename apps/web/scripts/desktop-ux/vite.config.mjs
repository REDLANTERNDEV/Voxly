import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root,
  publicDir: fileURLToPath(new URL("../../public", import.meta.url)),
  plugins: [
    {
      name: "fixture-protocol",
      enforce: "pre",
      resolveId(source) {
        if (source.endsWith("/desktopLinks.js")) return `${root}links.mjs`;
      }
    },
    react()
  ],
  resolve: { dedupe: ["react", "react-dom"] },
  define: { __VOXLY_WEB_VERSION__: JSON.stringify("0.1.0") },
  server: {
    host: "127.0.0.1",
    port: 1422,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("../../../../", import.meta.url))] }
  }
});
