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

// Strict content policy for the built app; the dev server injects inline scripts, so build only.
// User pictures come from their own virtual host. frame-ancestors only works as a header, and the
// WebView2 hosts block navigation and new windows anyway.
const contentPolicy = {
  name: "pi-relay-content-policy",
  apply: "build",
  transformIndexHtml() {
    return [{
      tag: "meta",
      attrs: {
        "http-equiv": "Content-Security-Policy",
        content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://pi-relay-icons.local; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'",
      },
      injectTo: "head-prepend",
    }];
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
    host: "127.0.0.1",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), integratedViewer, contentPolicy],
});
