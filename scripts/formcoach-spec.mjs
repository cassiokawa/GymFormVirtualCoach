#!/usr/bin/env node
/**
 * formcoach-spec — the Exercise Spec Engine CLI (spec 02, task 12.2).
 *
 *   formcoach-spec validate <file>
 *   formcoach-spec replay   <file> --fixture <id> [--fixtures-dir <dir>] [--tolerance <ms>]
 *
 * ## Why this is plain Node that loads TypeScript through Vite
 *
 * The engine's validate/replay logic is authored ONCE in TypeScript
 * (`src/domain/analysis/validator.ts`, `engine.ts`, `fixture.ts`, `loader.ts`).
 * Node cannot import `.ts` directly and this repo ships no compiled `dist`
 * (the build IS `tsc --noEmit`). Rather than duplicating validation/replay in
 * JavaScript — which would inevitably drift from the TS source — this CLI uses
 * Vite (already a dependency) as an on-the-fly TypeScript loader via
 * `createServer().ssrLoadModule`. The TS modules are the single source of
 * truth; this file is a thin argument parser + printer around them.
 *
 * So the real `validate`/`replay` behaviour is exactly what the TS unit tests
 * exercise (`fixture.test.ts`, `validator.test.ts`). Run it with:
 *
 *   npm run spec:validate -- src/domain/exercises/<file>.json
 *   npm run spec:replay   -- src/domain/exercises/<file>.json --fixture <id>
 *
 * or directly: `node scripts/formcoach-spec.mjs validate <file>`.
 *
 * ## Fixture resolution
 *
 * `replay` loads the fixture named by `--fixture <id>` from the fixtures
 * directory (default `src/domain/exercises/fixtures`), trying `<id>.json` and
 * `<id>.fixture.json`. A fixture is the JSON form of the `Fixture` type in
 * `fixture.ts`.
 *
 * HARD CONSTRAINT: no exercise id/name/alias is a literal here — everything is
 * read from the files named on the command line.
 *
 * Exit codes: 0 success; 1 validation/replay failure or divergence; 2 usage error.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const DEFAULT_FIXTURES_DIR = join('src', 'domain', 'exercises', 'fixtures');

// ---------------------------------------------------------------------------
// TypeScript module loading via Vite (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Start a middleware-mode Vite server and load the Analysis-context TS modules
 * through its SSR loader. Returns the loaded exports plus a `close()` to shut
 * the server down.
 */
async function loadEngineModules() {
  const { createServer } = await import('vite');
  const server = await createServer({
    root,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  try {
    const [validator, engine, fixture, loader] = await Promise.all([
      server.ssrLoadModule('/src/domain/analysis/validator.ts'),
      server.ssrLoadModule('/src/domain/analysis/engine.ts'),
      server.ssrLoadModule('/src/domain/analysis/fixture.ts'),
      server.ssrLoadModule('/src/domain/analysis/loader.ts'),
    ]);
    return {
      validateSpec: validator.validateSpec,
      compileSpec: engine.compileSpec,
      replayFixture: fixture.replayFixture,
      loadSpecFromJson: loader.loadSpecFromJson,
      close: () => server.close(),
    };
  } catch (err) {
    await server.close();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Resolve a possibly-relative path against the project root. */
function resolvePath(p) {
  return isAbsolute(p) ? p : resolve(root, p);
}

/** Read + parse a JSON file, exiting with a clear message on failure. */
function readJson(path) {
  const abs = resolvePath(path);
  if (!existsSync(abs)) {
    console.error(`error: file not found: ${path}`);
    process.exit(EXIT_USAGE);
  }
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    console.error(`error: ${path} is not valid JSON: ${err.message}`);
    process.exit(EXIT_FAIL);
  }
}

/** Parse `--flag value` style options from an argv slice. */
function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

/**
 * `formcoach-spec validate <file>` — run schema + semantic checks against the
 * named spec file and report every violation (code, path, message). Exits 0 on
 * success, 1 on any violation. A fixture presence check is included when a
 * fixture for the spec id exists in the fixtures directory.
 */
async function cmdValidate(args) {
  const { flags, positional } = parseFlags(args);
  const file = positional[0];
  if (file === undefined) {
    console.error('usage: formcoach-spec validate <file> [--fixtures-dir <dir>]');
    process.exit(EXIT_USAGE);
  }

  const raw = readJson(file);
  const fixturesDir = resolvePath(
    typeof flags['fixtures-dir'] === 'string' ? flags['fixtures-dir'] : DEFAULT_FIXTURES_DIR,
  );

  const mods = await loadEngineModules();
  try {
    // Answer "does a fixture exist for this id?" from the fixtures directory so
    // the validator's Req 5.7 fixture check runs against real files.
    const hasFixture = (id) => findFixtureFile(fixturesDir, id) !== null;
    const result = mods.validateSpec(raw, { hasFixture });

    if (result.ok) {
      const id = typeof raw?.id === 'string' ? raw.id : '(unknown id)';
      console.log(`ok: ${file} is valid (${id})`);
      process.exit(EXIT_OK);
    }

    console.error(`FAIL: ${file} has ${result.errors.length} violation(s):`);
    for (const e of result.errors) {
      const path = e.path === '' ? '(root)' : e.path;
      console.error(`  [${e.code}] ${path}: ${e.message}`);
    }
    process.exit(EXIT_FAIL);
  } finally {
    await mods.close();
  }
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

/** Locate a fixture file for `id` in `dir`, trying known suffixes. Null if none. */
function findFixtureFile(dir, id) {
  const candidates = [join(dir, `${id}.json`), join(dir, `${id}.fixture.json`)];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * `formcoach-spec replay <file> --fixture <id>` — compile the spec, load the
 * named fixture, replay it through the engine, and print the expected-vs-actual
 * rep timeline and the per-fault confusion matrix. Exits 1 when the actual rep
 * timeline diverges from the expected one.
 */
async function cmdReplay(args) {
  const { flags, positional } = parseFlags(args);
  const file = positional[0];
  const fixtureId = typeof flags['fixture'] === 'string' ? flags['fixture'] : undefined;
  if (file === undefined || fixtureId === undefined) {
    console.error(
      'usage: formcoach-spec replay <file> --fixture <id> [--fixtures-dir <dir>] [--tolerance <ms>]',
    );
    process.exit(EXIT_USAGE);
  }

  const raw = readJson(file);
  const fixturesDir = resolvePath(
    typeof flags['fixtures-dir'] === 'string' ? flags['fixtures-dir'] : DEFAULT_FIXTURES_DIR,
  );
  const fixturePath = findFixtureFile(fixturesDir, fixtureId);
  if (fixturePath === null) {
    console.error(
      `error: no fixture "${fixtureId}" found in ${fixturesDir} (looked for ${fixtureId}.json, ${fixtureId}.fixture.json)`,
    );
    process.exit(EXIT_USAGE);
  }
  const fixture = readJson(fixturePath);
  if (typeof flags['tolerance'] === 'string') {
    const tol = Number(flags['tolerance']);
    if (Number.isFinite(tol)) fixture.toleranceMs = tol;
  }

  const mods = await loadEngineModules();
  try {
    const spec = mods.loadSpecFromJson(raw);
    const compiled = mods.compileSpec(spec, null);
    const result = mods.replayFixture(compiled, fixture, null);
    printReplayResult(result, fixtureId);
    process.exit(result.repTimelineMatches ? EXIT_OK : EXIT_FAIL);
  } finally {
    await mods.close();
  }
}

/** Print the rep timeline and fault confusion matrix in a readable form. */
function printReplayResult(result, fixtureId) {
  console.log(`replay: spec "${result.specId}" x fixture "${fixtureId}"`);
  console.log(`  frames: ${result.frameCount}`);
  console.log(`  reps: expected ${result.expectedRepCount}, actual ${result.actualRepCount}`);
  console.log('');
  console.log('  Rep timeline (expected vs actual):');
  console.log('    rep  status    expected(ms)  actual(ms)');
  for (const r of result.repTimeline) {
    const exp = r.expectedT === null ? '-' : String(r.expectedT);
    const act = r.actualT === null ? '-' : String(r.actualT);
    console.log(
      `    ${String(r.repNumber).padEnd(4)} ${r.status.padEnd(9)} ${exp.padStart(12)}  ${act.padStart(10)}`,
    );
  }
  if (result.repTimeline.length === 0) console.log('    (no reps)');
  console.log('');
  console.log('  Per-fault confusion matrix:');
  console.log('    faultId                          TP   FP   FN');
  for (const c of result.faultConfusion) {
    console.log(
      `    ${c.faultId.padEnd(32)} ${String(c.truePositives).padStart(2)}   ${String(c.falsePositives).padStart(2)}   ${String(c.falseNegatives).padStart(2)}`,
    );
  }
  if (result.faultConfusion.length === 0) console.log('    (no faults annotated or detected)');
  console.log('');
  console.log(
    result.repTimelineMatches
      ? '  RESULT: rep timeline matches ✓'
      : '  RESULT: rep timeline DIVERGES ✗',
  );
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function usage() {
  console.error('formcoach-spec — Exercise Spec Engine CLI');
  console.error('');
  console.error('Usage:');
  console.error('  formcoach-spec validate <file> [--fixtures-dir <dir>]');
  console.error('  formcoach-spec replay <file> --fixture <id> [--fixtures-dir <dir>] [--tolerance <ms>]');
}

async function main() {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case 'validate':
      await cmdValidate(rest);
      break;
    case 'replay':
      await cmdReplay(rest);
      break;
    case undefined:
    case '-h':
    case '--help':
      usage();
      process.exit(EXIT_USAGE);
      break;
    default:
      console.error(`error: unknown command "${command}"`);
      usage();
      process.exit(EXIT_USAGE);
  }
}

// Only run when invoked directly (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`error: ${err?.stack ?? err}`);
    process.exit(EXIT_FAIL);
  });
}
