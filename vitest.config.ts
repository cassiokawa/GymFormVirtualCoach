import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration, kept separate from `vite.config.ts`.
 *
 * The app's `vite.config.ts` aliases `@mediapipe/pose` for the browser/worker
 * bundle. Unit tests never touch that dependency (model-dependent code is
 * stubbed), so the test config stays minimal and does not import from `vite`
 * — avoiding the ESM/CJS loader conflict vitest's bundled esbuild hits when it
 * tries to evaluate the main vite config.
 */
export default defineConfig({
  test: {
    // vitest auto-detects the environment per file via the
    // `@vitest-environment` docblock; no global environment needed.
  },
});
