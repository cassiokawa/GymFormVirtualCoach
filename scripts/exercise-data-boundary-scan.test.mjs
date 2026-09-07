#!/usr/bin/env node
/**
 * Tests for the exercises-are-data build scan (spec 02, task 13; Req 7.1-7.3).
 *
 * The scan reads its project root from SCAN_ROOT, so each case builds a tiny
 * temp workspace (src/domain/exercises + src/**\/*.ts) and runs the real script
 * as a child process, asserting on exit code and reported output. Deterministic:
 * no network, no shared state, each case gets its own temp dir.
 *
 * Run: node --test scripts/exercise-data-boundary-scan.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCAN = join(here, 'exercise-data-boundary-scan.mjs');

/** Build a temp workspace; returns its root. Caller removes it. */
function makeWorkspace() {
  const wsRoot = mkdtempSync(join(tmpdir(), 'exscan-'));
  mkdirSync(join(wsRoot, 'src', 'domain', 'exercises'), { recursive: true });
  mkdirSync(join(wsRoot, 'src', 'domain', 'analysis'), { recursive: true });
  return wsRoot;
}

function writeExercise(wsRoot, name, doc) {
  writeFileSync(
    join(wsRoot, 'src', 'domain', 'exercises', `${name}.json`),
    JSON.stringify(doc, null, 2),
  );
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

test('empty exercise set passes (exit 0)', () => {
  const ws = makeWorkspace();
  try {
    writeTs(ws, 'domain/analysis/engine.ts', 'export const x = 1;\n');
    const { code, stdout } = runScan(ws);
    assert.equal(code, 0);
    assert.match(stdout, /0 exercise documents|trivially clean/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('clean TS file passes when an exercise exists (exit 0)', () => {
  const ws = makeWorkspace();
  try {
    writeExercise(ws, 'ex1', {
      id: 'fixture_move_alpha',
      displayName: 'Fixture Move Alpha',
      aliases: ['Alpha Lift'],
    });
    // Code that never names the identifier — loads data generically.
    writeTs(
      ws,
      'domain/analysis/engine.ts',
      'export function load(id: string) {\n  return id;\n}\n',
    );
    const { code, stdout } = runScan(ws);
    assert.equal(code, 0);
    assert.match(stdout, /clean/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('TS file containing the exercise id fails (exit 1) and names file + identifier', () => {
  const ws = makeWorkspace();
  try {
    writeExercise(ws, 'ex1', {
      id: 'fixture_move_alpha',
      displayName: 'Fixture Move Alpha',
      aliases: [],
    });
    writeTs(
      ws,
      'domain/analysis/leaky.ts',
      'export const DEFAULT = "fixture_move_alpha";\n',
    );
    const { code, stderr } = runScan(ws);
    assert.equal(code, 1);
    assert.match(stderr, /leaky\.ts/);
    assert.match(stderr, /fixture_move_alpha/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('displayName phrase leak is detected (exit 1)', () => {
  const ws = makeWorkspace();
  try {
    writeExercise(ws, 'ex1', {
      id: 'fixture_move_beta',
      displayName: 'Fixture Move Beta',
      aliases: [],
    });
    writeTs(ws, 'domain/analysis/leaky.ts', 'const label = "Fixture Move Beta";\n');
    const { code, stderr } = runScan(ws);
    assert.equal(code, 1);
    assert.match(stderr, /Fixture Move Beta/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('alias leak is detected (exit 1)', () => {
  const ws = makeWorkspace();
  try {
    writeExercise(ws, 'ex1', {
      id: 'fixture_move_gamma',
      displayName: 'Fixture Move Gamma',
      aliases: ['gamma_variant'],
    });
    writeTs(ws, 'domain/analysis/leaky.ts', 'const a = gamma_variant;\n');
    const { code, stderr } = runScan(ws);
    assert.equal(code, 1);
    assert.match(stderr, /gamma_variant/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('whole-token rule avoids false positive on superstring', () => {
  const ws = makeWorkspace();
  try {
    writeExercise(ws, 'ex1', {
      id: 'squat',
      displayName: 'Squat',
      aliases: [],
    });
    // "squats" and "squat_variant" contain "squat" but are different tokens.
    writeTs(
      ws,
      'domain/analysis/engine.ts',
      'const squats = 3;\nconst squat_variant = 4;\nfunction resquatify() {}\n',
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
    writeExercise(ws, 'ex1', {
      id: 'fixture_move_delta',
      displayName: 'Fixture Move Delta',
      aliases: [],
    });
    // A .test.ts file may legitimately reference an id in a fixture; excluded.
    writeTs(
      ws,
      'domain/analysis/engine.test.ts',
      'const id = "fixture_move_delta";\n',
    );
    const { code } = runScan(ws);
    assert.equal(code, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('fixtures directory documents do not contribute identifiers', () => {
  const ws = makeWorkspace();
  try {
    // A fixture-shaped JSON under fixtures/ that happens to carry an id-like
    // field must NOT be treated as an exercise spec source of identity.
    mkdirSync(join(ws, 'src', 'domain', 'exercises', 'fixtures'), { recursive: true });
    writeFileSync(
      join(ws, 'src', 'domain', 'exercises', 'fixtures', 'f.json'),
      JSON.stringify({ id: 'fixture_only_id', frames: [] }),
    );
    // Referencing that fixture id in code must still pass — no exercise spec exists.
    writeTs(ws, 'domain/analysis/engine.ts', 'const x = "fixture_only_id";\n');
    const { code } = runScan(ws);
    assert.equal(code, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
