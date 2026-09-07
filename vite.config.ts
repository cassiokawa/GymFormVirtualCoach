import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Vite configuration for the CV Fitness & Form Assistant.
 *
 * The only non-default setting aliases the legacy `@mediapipe/pose` package to
 * an empty shim. `@tensorflow-models/pose-detection` references it for the
 * BlazePose model, but its ESM build has a broken `Pose` named export that
 * breaks worker bundling. The lab only uses MoveNet (self-contained) from that
 * package, so stubbing the unused dependency keeps both the main and worker
 * bundles building cleanly.
 */
const emptyShim = fileURLToPath(new URL('./src/lab/shims/empty.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@mediapipe/pose': emptyShim,
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    // Mirror the production Vercel headers (see vercel.json) so cross-origin
    // isolation — and therefore SharedArrayBuffer + threaded WASM SIMD — behaves
    // the same in local dev as in production. COEP is 'credentialless' so the
    // MediaPipe WASM/model CDNs still load; 'require-corp' would block them.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    proxy: {
      // Proxy /ollama/* to the local Ollama server. This eliminates CORS issues
      // because the browser only talks to the Vite dev server's origin.
      '/ollama': {
        target: 'http://localhost:11434',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ollama/, ''),
      },
      // Proxy /sync-api/* to the local zero-knowledge sync server.
      '/sync-api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sync-api/, ''),
      },
    },
  },
});
