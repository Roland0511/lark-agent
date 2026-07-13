import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "admin"),
  base: "./",
  plugins: [react()],
  build: { outDir: resolve(__dirname, "admin-dist"), emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/v1": "http://127.0.0.1:3000", "/auth": "http://127.0.0.1:3000" }
  }
});
