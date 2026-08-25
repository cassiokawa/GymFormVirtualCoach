#!/usr/bin/env node
/**
 * Copy the MediaPipe Tasks Vision WASM runtime from the installed package into
 * public/mediapipe-wasm/ so it is served locally at /mediapipe-wasm.
 *
 * Serving the WASM that ships with the installed @mediapipe/tasks-vision keeps
 * the WASM runtime version matched to the bundled JS. A mismatched CDN version
 * fails with "ModuleFactory not set" when initializing inside a Web Worker.
 *
 * Runs automatically on `postinstall` and as part of `npm run fetch-models`.
 * Safe to run repeatedly; it overwrites the destination files.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dest = join(root, 'public', 'mediapipe-wasm');

if (!existsSync(src)) {
  console.warn(
    '@mediapipe/tasks-vision WASM not found at',
    src,
    '- run `npm install` first. Skipping WASM copy.',
  );
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`Copied MediaPipe WASM runtime -> ${dest}`);
