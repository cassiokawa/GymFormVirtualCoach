#!/usr/bin/env node
/**
 * Download CV Algorithm Lab model weights into public/models/.
 *
 * There is no single canonical, license-clean CDN for these weights, so this
 * script does NOT hardcode source URLs. Instead it reads them from environment
 * variables (or a local models.config.json), downloads with progress, and
 * prints clear guidance when a URL is not provided.
 *
 * Usage:
 *   YOLO_POSE_URL=https://.../yolov8n-pose.onnx \
 *   RTMPOSE_URL=https://.../rtmpose-m.onnx \
 *   npm run fetch-models
 *
 * Or create scripts/models.config.json:
 *   { "yolov8n-pose.onnx": "https://...", "rtmpose-m.onnx": "https://..." }
 *
 * Files that already exist are skipped. See public/models/README.md for how to
 * export the weights yourself.
 */

import { createWriteStream, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'public', 'models');

/** Target files and the env var that can supply each source URL. */
const TARGETS = [
  { file: 'yolov8n-pose.onnx', env: 'YOLO_POSE_URL' },
  { file: 'rtmpose-m.onnx', env: 'RTMPOSE_URL' },
];

function loadConfig() {
  const cfgPath = join(here, 'models.config.json');
  if (!existsSync(cfgPath)) return {};
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    console.warn(`Could not parse ${cfgPath}: ${err.message}`);
    return {};
  }
}

function resolveUrl(target, config) {
  return process.env[target.env] ?? config[target.file] ?? null;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  let received = 0;
  const out = createWriteStream(dest);
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    if (total > 0) {
      const pct = Math.round((received / total) * 100);
      process.stdout.write(`\r  downloading… ${pct}% (${received}/${total} bytes)`);
    } else {
      process.stdout.write(`\r  downloading… ${received} bytes`);
    }
  });
  await new Promise((resolve, reject) => {
    body.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    body.on('error', reject);
  });
  process.stdout.write('\n');
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const config = loadConfig();
  let missing = 0;

  for (const target of TARGETS) {
    const dest = join(outDir, target.file);
    if (existsSync(dest)) {
      console.log(`✓ ${target.file} already present — skipping.`);
      continue;
    }
    const url = resolveUrl(target, config);
    if (!url) {
      missing += 1;
      console.log(
        `• ${target.file}: no source URL. Set ${target.env}=<url> or add it to ` +
          `scripts/models.config.json, or export it yourself (see public/models/README.md).`,
      );
      continue;
    }
    console.log(`↓ ${target.file} from ${url}`);
    try {
      await download(url, dest);
      console.log(`✓ saved ${target.file}`);
    } catch (err) {
      missing += 1;
      console.error(`✗ ${target.file}: ${err.message}`);
    }
  }

  if (missing > 0) {
    console.log(
      `\n${missing} model(s) not fetched. The app still runs; MediaPipe and ` +
        `MoveNet work without local files. YOLOv8-Pose / RTMPose need the ` +
        `weights above before they can be benchmarked.`,
    );
  } else {
    console.log('\nAll models present.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
