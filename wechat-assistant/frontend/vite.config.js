import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL("index.html", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/auth": "http://127.0.0.1:8000",
      "/chat": "http://127.0.0.1:8000",
      "/faqs": "http://127.0.0.1:8000",
      "/materials": "http://127.0.0.1:8000",
      "/health": "http://127.0.0.1:8000",
    },
  },
});
