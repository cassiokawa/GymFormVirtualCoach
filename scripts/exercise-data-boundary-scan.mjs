#!/usr/bin/env node
/**
 * exercise-data-boundary-scan — the "exercises are data, not code" build scan
 * (spec 02, task 13; Requirements 7.1, 7.2, 7.3; tech.md hard rule #1).
 *
 * ## What this enforces
 *
 * An exercise is a JSON document under `src/domain/exercises/**\/*.json`. Its
 * *identity* — the `id`, the human `displayName`, and every `aliases` entry —
 * must NEVER appear in TypeScript source. If it did, the exercises-are-data
 * boundary would have silently half-collapsed: some code would branch on an
 * exercise name and adding a new exercise would require a code change, which is
 * exactly what this project forbids.
 *
 * This scan collects every declared exercise identifier from the JSON documents
 * and fails the build if any of them appears in a file matching `src/**\/*.ts`,
 * naming the offending file, the leaked identifier, and the line number.
 *
 * ## Matching rule (deliberately conservative to avoid false positives)
 *
 * A raw exercise `id` like `barbell_squat` is an incidental substring of many
 * unrelated words, so matching a bare substring would produce noise. Instead:
 *
 *   - The identifier is matched as a **whole token** when it looks like a bare
 *     identifier token (letters, digits, underscore, hyphen, dot — no spaces).
 *     "Whole token" means the characters immediately before and after the match
 *     are NOT identifier characters (`[A-Za-z0-9_$]`). So `barbell_squat`
 *     matches the string literal "barbell_squat" and the token barbell_squat,
 *     but NOT `barbell_squat_variant` or `xbarbell_squat`.
 *   - A `displayName` or alias that contains spaces or other punctuation (e.g.
 *     "Barbell Back Squat") is matched as an **exact literal substring**. Such a
 *     phrase cannot occur incidentally in code except inside a string, so a
 *     substring match is both safe and correct.
 *
 * In both cases the point is: if the identifier shows up in code at all — as a
 * string literal, a key, an enum member, whatever — the scan catches it.
 *
 * ## Zero-exercises case
 *
 * When there are no exercise JSON documents yet (the current state), the
 * identifier set is empty and the scan trivially passes (exit 0). Adding the
 * first exercise activates enforcement automatically — no code change needed.
 *
 * ## Usage
 *
 *   node scripts/exercise-data-boundary-scan.mjs
 *   npm run scan:exercise-boundary
 *   npm run check   # tsc --noEmit && this scan
 *
 * Exit codes: 0 clean (including the empty-set case); 1 on any violation.
 *
 * Plain Node ESM, no dependencies beyond node builtins.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Project root. Overridable via SCAN_ROOT so the scan can be exercised against a
// temp fixture tree in tests; defaults to the repository root in normal use.
const root = process.env.SCAN_ROOT ? process.env.SCAN_ROOT : join(here, '..');

const EXERCISES_DIR = join(root, 'src', 'domain', 'exercises');
const SRC_DIR = join(root, 'src');

// Fixtures live under the exercises directory but are annotated landmark
// timelines, not exercise specs — they carry no exercise identity to collect.
const FIXTURES_DIR = join(EXERCISES_DIR, 'fixtures');

const EXIT_OK = 0;
const EXIT_FAIL = 1;

/** Identifier-character test used to enforce whole-token matching. */
function isIdentChar(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}

/** True when a string is a bare token (no whitespace / phrase punctuation). */
function isBareToken(s) {
  return /^[A-Za-z0-9_.\-]+$/.test(s);
}

/**
 * Recursively collect files under `dir` whose path passes `keep(absPath)`.
 * Missing directories yield an empty list (so the scan is robust before the
 * exercises directory has any content).
 */
function walk(dir, keep, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, keep, out);
    } else if (entry.isFile() && keep(abs)) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Collect the set of exercise identifiers (id, displayName, every alias) from
 * every exercise JSON document under `src/domain/exercises`, excluding the
 * `fixtures/` subtree. Only documents that actually declare a string `id` are
 * treated as exercise specs.
 *
 * Returns a Map from identifier string -> a short description of where it came
 * from (for the violation report), so duplicate identifiers are de-duplicated.
 */
function collectIdentifiers() {
  const identifiers = new Map();

  const jsonFiles = walk(
    EXERCISES_DIR,
    (abs) => abs.endsWith('.json') && !abs.startsWith(FIXTURES_DIR + '/') && abs !== FIXTURES_DIR,
  );

  for (const file of jsonFiles) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      // A malformed exercise document is the schema/semantic validator's
      // problem (task 11), not this scan's. Skip it here rather than crash.
      console.warn(
        `warning: could not parse ${relative(root, file)} as JSON, skipping: ${err.message}`,
      );
      continue;
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) continue;
    if (typeof doc.id !== 'string' || doc.id.length === 0) continue; // not an exercise spec

    const rel = relative(root, file);
    const add = (value, kind) => {
      if (typeof value === 'string' && value.length > 0 && !identifiers.has(value)) {
        identifiers.set(value, `${kind} in ${rel}`);
      }
    };

    add(doc.id, 'id');
    add(doc.displayName, 'displayName');
    if (Array.isArray(doc.aliases)) {
      for (const alias of doc.aliases) add(alias, 'alias');
    }
  }

  return identifiers;
}

/**
 * Find every occurrence of `identifier` in `content` under the configured
 * matching rule, returning 1-based line numbers. Bare tokens require whole-token
 * boundaries; phrases match as exact substrings.
 */
function findOccurrences(content, identifier) {
  const bare = isBareToken(identifier);
  const lines = content.split(/\r\n|\r|\n/);
  const hits = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let from = 0;
    for (;;) {
      const idx = line.indexOf(identifier, from);
      if (idx === -1) break;
      if (bare) {
        const before = idx > 0 ? line[idx - 1] : '';
        const after =
          idx + identifier.length < line.length ? line[idx + identifier.length] : '';
        const boundedLeft = before === '' || !isIdentChar(before);
        const boundedRight = after === '' || !isIdentChar(after);
        if (boundedLeft && boundedRight) hits.push(i + 1);
      } else {
        hits.push(i + 1);
      }
      from = idx + identifier.length;
    }
  }

  return hits;
}

function main() {
  const identifiers = collectIdentifiers();

  if (identifiers.size === 0) {
    console.log(
      'exercise-data-boundary-scan: no exercise identifiers declared ' +
        '(0 exercise documents) — boundary trivially clean.',
    );
    process.exit(EXIT_OK);
  }

  // Scan TS source, excluding test files and the exercises dir (JSON-only).
  const tsFiles = walk(
    SRC_DIR,
    (abs) =>
      abs.endsWith('.ts') &&
      !abs.endsWith('.test.ts') &&
      !abs.startsWith(EXERCISES_DIR + '/'),
  );

  const violations = [];
  for (const file of tsFiles) {
    const content = readFileSync(file, 'utf8');
    for (const [identifier, origin] of identifiers) {
      const lines = findOccurrences(content, identifier);
      for (const line of lines) {
        violations.push({ file: relative(root, file), identifier, origin, line });
      }
    }
  }

  if (violations.length === 0) {
    console.log(
      `exercise-data-boundary-scan: clean — ${identifiers.size} exercise ` +
        `identifier(s) checked against ${tsFiles.length} TypeScript file(s), no leaks.`,
    );
    process.exit(EXIT_OK);
  }

  console.error(
    `exercise-data-boundary-scan: FAIL — ${violations.length} exercise identity ` +
      `leak(s) into TypeScript source:`,
  );
  for (const v of violations) {
    console.error(
      `  ${v.file}:${v.line}  leaked identifier "${v.identifier}" (${v.origin})`,
    );
  }
  console.error(
    '\nExercises are data, not code (tech.md hard rule #1): no exercise id, ' +
      'displayName, or alias may appear in src/**/*.ts. Move the branch into the ' +
      'exercise JSON document instead.',
  );
  process.exit(EXIT_FAIL);
}

main();
