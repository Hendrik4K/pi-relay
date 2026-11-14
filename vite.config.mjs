import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The bundled noVNC version is part of each Pi Relay build; the native host reads it from here.
const novnc = JSON.parse(readFileSync(new URL("./node_modules/@novnc/novnc/package.json", import.meta.url), "utf8")).version;
const integratedViewer = {
  name: "pi-relay-integrated-viewer",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "integrated-viewer.json", source: JSON.stringify({ novnc }) });
  },
};

export default defineConfig({
  build: {
    outDir: "dist/client",
    // noVNC uses top-level await; WebView2 is a current Chromium.
    target: "es2022",
  },
  define: {
    __NOVNC_VERSION__: JSON.stringify(novnc),
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), integratedViewer],
});
