import { defineConfig } from "vite";

// Dev server proxies the relay API so `npm run dev` works against `go run .` on :8000.
// transformers.js fetches the onnxruntime-web .wasm from jsDelivr (matching its exact version),
// so the copy Vite would emit is never used. Dropping it keeps the relay binary small.
const dropUnusedWasm = {
  name: "drop-unused-ort-wasm",
  generateBundle(_: unknown, bundle: Record<string, unknown>) {
    for (const k of Object.keys(bundle)) if (/ort-wasm.*\.wasm$/.test(k)) delete bundle[k];
  },
};

export default defineConfig({
  plugins: [dropUnusedWasm],
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8000", "/mcp": "http://127.0.0.1:8000", "/healthz": "http://127.0.0.1:8000" },
  },
  build: { outDir: "../server/dist", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 7000 },
  worker: { format: "es" },
  test: { environment: "node" },
} as Parameters<typeof defineConfig>[0]);
