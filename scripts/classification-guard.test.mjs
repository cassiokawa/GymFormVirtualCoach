#!/usr/bin/env node
/**
 * Tests for the classification-guard build scan
 * (spec 06 local-first-privacy, task 3.1; Req 3.5).
 *
 * The scan reads its project root from SCAN_ROOT, so each case builds a tiny
 * temp workspace (src/**\/*.ts) and runs the real script as a child process,
 * asserting on exit code and reported output. Deterministic: no network, no
 * shared state, each case gets its own temp dir.
 *
 * Run: node --test scripts/classification-guard.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCAN = join(here, 'classification-guard.mjs');

/** Build a temp workspace; returns its root. Caller removes it. */
function makeWorkspace() {
  const wsRoot = mkdtempSync(join(tmpdir(), 'clsguard-'));
  mkdirSync(join(wsRoot, 'src', 'privacy'), { recursive: true });
  return wsRoot;
}

function writeTs(wsRoot, relPath, content) {
  const abs = join(wsRoot, 'src', relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Run the scan against `wsRoot`. Returns { code, stdout, stderr }. */
function runScan(wsRoot) {
  try {
    const stdout = execFileSync('node', [SCAN], {
      env: { ...process.env, SCAN_ROOT: wsRoot },
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : '',
    };
  }
}

test('empty tree passes (exit 0)', () => {
  const ws = makeWorkspace();
  try {
    const { code, stdout } = runScan(ws);
    assert.equal(code, 0);
    assert.match(stdout, /clean/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('clean file: classify + encryptForSync + fetch passes (exit 0)', () => {
  const ws = makeWorkspace();
  try {
    writeTs(
      ws,
      'privacy/sync.ts',
      [
        "import { classify } from './Classification';",
        "import { encryptForSync } from './Classification';",
        'export async function push(vault: unknown, scans: unknown[]) {',
        '  const data = classify(scans);',
        '  const env = await encryptForSync(vault, data);',
        "  await fetch('/sync', { method: 'POST', body: JSON.stringify(env) });",
        '}',
        '',
      ].join('\n'),
    );
    const { code, stdout } = runScan(ws);
    assert.equal(code, 0);
    assert.match(stdout, /clean/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('violation: classify + fetch WITHOUT encryptForSync fails (exit 1) naming file + sink', () => {
  const ws = makeWorkspace();
  try {
    writeTs(
      ws,
      'privacy/leaky.ts',
      [
        "import { classify } from './Classification';",
        'export async function push(scans: unknown[]) {',
        '  const data = classify(scans);',
        "  await fetch('/sync', { method: 'POST', body: JSON.stringify(data) });",
        '}',
        '',
      ].join('\n'),
    );
    const { code, stderr } = runScan(ws);
    assert.equal(code, 1);
    assert.match(stderr, /leaky\.ts/);
    assert.match(stderr, /fetch/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('file using neither classified data nor sink passes (exit 0)', () => {
  const ws = makeWorkspace();
  try {
    writeTs(
      ws,
      'privacy/util.ts',
      'export function add(a: number, b: number) {\n  return a + b;\n}\n',
    );
    const { code } = runScan(ws);
    assert.equal(code, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('file with a sink but no classified data passes (exit 0)', () => {
  const ws = makeWorkspace();
  try {
    writeTs(
      ws,
      'privacy/ping.ts',
      "export async function ping() {\n  await fetch('/health');\n}\n",
    );
    const { code } = runScan(ws);
    assert.equal(code, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('violation: declassifyForDevice next to fetch fails (exit 1) even with encryptForSync present', () => {
  const ws = makeWorkspace();
  try {
    writeTs(
      ws,
      'privacy/danger.ts',
      [
        "import { declassifyForDevice, encryptForSync } from './Classification';",
        'export async function leak(vault: unknown, data: any) {',
        '  await encryptForSync(vault, data);',
        '  const plain = declassifyForDevice(data);',
        "  await fetch('/sync', { method: 'POST', body: JSON.stringify(plain) });",
        '}',
        '',
      ].join('\n'),
    );
    const { code, stderr } = runScan(ws);
    assert.equal(code, 1);
    assert.match(stderr, /danger\.ts/);
    assert.match(stderr, /declassifyForDevice/);
    assert.match(stderr, /fetch/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('whole-token boundary: prefetch does not count as a fetch sink', () => {
  const ws = makeWorkspace();
  try {
    writeTs(
      ws,
      'privacy/prefetch.ts',
      [
        "import { classify } from './Classification';",
        'export function warm(scans: unknown[]) {',
        '  const data = classify(scans);',
        '  return prefetch(data);', // "prefetch" must NOT match "fetch"
        '}',
        '',
      ].join('\n'),
    );
    const { code } = runScan(ws);
    assert.equal(code, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('test files are excluded from the scan (exit 0)', () => {
  const ws = makeWorkspace();
  try {
    writeTs(
      ws,
      'privacy/leaky.test.ts',
      [
        "import { classify } from './Classification';",
        "const data = classify([1]);",
        "await fetch('/sync', { body: JSON.stringify(data) });",
        '',
      ].join('\n'),
    );
    const { code } = runScan(ws);
    assert.equal(code, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('sendBeacon is recognized as a sink (exit 1)', () => {
  const ws = makeWorkspace();
  try {
    writeTs(
      ws,
      'privacy/beacon.ts',
      [
        "import { classify } from './Classification';",
        'export function report(scans: unknown[]) {',
        '  const data = classify(scans);',
        '  navigator.sendBeacon(\'/telemetry\', JSON.stringify(data));',
        '}',
        '',
      ].join('\n'),
    );
    const { code, stderr } = runScan(ws);
    assert.equal(code, 1);
    assert.match(stderr, /beacon\.ts/);
    assert.match(stderr, /sendBeacon/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
