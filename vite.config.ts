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
});
