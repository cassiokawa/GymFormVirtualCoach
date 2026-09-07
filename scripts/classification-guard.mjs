#!/usr/bin/env node
/**
 * classification-guard — the compile-boundary "defense in depth" build scan
 * (spec 06 local-first-privacy, task 3.1; Requirement 3.5; tech.md hard rule #3).
 *
 * ## What this enforces
 *
 * The device-only boundary is enforced primarily by the type system: Classified
 * data (`Classified<T>` / `Sensitive<T>` from src/privacy/Classification.ts)
 * cannot be assigned to a Network_Sink payload; the only sanctioned exit is
 * `encryptForSync()`, which returns an opaque, unbranded Encrypted_Envelope.
 *
 * This scan is a second line of defense behind the compiler. It statically reads
 * every `src/**\/*.ts` file (excluding `*.test.ts`) and fails the build when a
 * module both touches Classified data AND touches a Network_Sink without routing
 * through the sanctioned transform.
 *
 * ## Network sinks
 *
 * The identifiers considered outbound transmission primitives:
 *   fetch, XMLHttpRequest, WebSocket, sendBeacon
 * (`sendBeacon` covers `navigator.sendBeacon`.)
 *
 * ## The rule (a deliberately conservative regex/AST-lite heuristic)
 *
 * A full type-flow analysis — does *this particular Classified value* actually
 * flow into *this particular sink call* — is out of scope for a lightweight
 * text scan. So the guard uses a module-level co-occurrence heuristic instead.
 * A file is FLAGGED when BOTH of the following hold:
 *
 *   (a) it references one of the Network_Sink identifiers, AND
 *   (b) it references Classified data — i.e. it uses `classify`,
 *       `declassifyForDevice`, `Classified`, or `Sensitive` — WITHOUT also
 *       referencing `encryptForSync`.
 *
 * The presence of `encryptForSync` in the module is treated as satisfying the
 * "routes through the sanctioned transform" condition, so a file that legitimately
 * encrypts before sending is clean. (Task 2 introduces `encryptForSync`; until it
 * exists, no file can import it, and any file mixing Classified data with a sink
 * is correctly flagged.)
 *
 * ### Additional hard stop: declassified plaintext next to a sink
 *
 * `declassifyForDevice` yields raw plaintext for on-device use only (review UI,
 * local export). Plaintext must NEVER reach a sink. So any module that references
 * BOTH `declassifyForDevice` AND a Network_Sink is flagged unconditionally —
 * `encryptForSync` does NOT excuse it, because the whole point of declassifying is
 * to hold cleartext, and cleartext + sink in one module is the exact hazard.
 *
 * ### False positives / false negatives (documented tradeoff)
 *
 * - False positive: a module that reads Classified data for an unrelated on-device
 *   purpose AND independently talks to the network for something non-sensitive
 *   (and does not encrypt) will be flagged even though no leak occurs. The fix is
 *   cheap and improves the design: split the concerns into two modules, or route
 *   the (already-safe) payload through the boundary type. This conservatism is
 *   intentional — the guard errs toward flagging.
 * - False negative: because this is text-level, obfuscated indirection (building
 *   the string "fetch" dynamically, aliasing a sink through another module) can
 *   slip past. The type system is the real guarantee; this scan catches the
 *   obvious, review-visible mistakes as defense in depth.
 *
 * ## Comments and string literals are ignored
 *
 * Identifiers are matched against *code only*. Line comments, block comments, and
 * the contents of string/template literals are blanked out before matching, so a
 * module's own documentation that names `fetch` or `declassifyForDevice` in prose
 * (e.g. Classification.ts describing the boundary it defines) is not a violation.
 * This keeps the heuristic focused on real references, not descriptions of them.
 *
 * ## Zero-occurrence case
 *
 * When Classification.ts does not exist yet or has no callers (the current state),
 * no file references Classified symbols, so no co-occurrence can arise and the
 * scan trivially passes (exit 0). A clean tree always passes.
 *
 * ## Usage
 *
 *   node scripts/classification-guard.mjs
 *
 * Exit codes: 0 clean (including the no-occurrence case); 1 on any violation,
 * listing each offending file, the offending sink, and why.
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

const SRC_DIR = join(root, 'src');

const EXIT_OK = 0;
const EXIT_FAIL = 1;

// Network_Sink identifiers (per requirements glossary + tech.md hard rule #3).
// `sendBeacon` matches the method name in `navigator.sendBeacon(...)`.
const NETWORK_SINKS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'sendBeacon'];

// The sanctioned transform. Its presence means the module routes Classified data
// through the one legal exit before it can reach a sink.
const SANCTIONED_TRANSFORM = 'encryptForSync';

// The on-device escape hatch. Yields plaintext; must never share a module with a
// sink (encryptForSync does NOT excuse it).
const DECLASSIFY = 'declassifyForDevice';

// Symbols that indicate a module touches Classified data.
const CLASSIFIED_SYMBOLS = ['classify', 'declassifyForDevice', 'Classified', 'Sensitive'];

/** Identifier-character test used to enforce whole-token matching. */
function isIdentChar(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Blank out comments and string/template literals so identifier matching sees
 * *code only*. Replaces their inner characters with spaces (preserving newlines
 * so line numbers stay accurate). A single-pass character scanner tracks whether
 * we are inside a line comment, block comment, or a '...' / "..." / `...` literal,
 * honoring backslash escapes. This is a lexer-lite approximation — good enough to
 * keep prose that merely names `fetch` or `declassifyForDevice` from tripping the
 * guard, without pulling in a full TypeScript parser.
 */
function stripCommentsAndStrings(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | squote | dquote | tmpl
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        out.push('  ');
        i += 2;
      } else if (ch === '/' && next === '*') {
        state = 'block';
        out.push('  ');
        i += 2;
      } else if (ch === "'") {
        state = 'squote';
        out.push(' ');
        i += 1;
      } else if (ch === '"') {
        state = 'dquote';
        out.push(' ');
        i += 1;
      } else if (ch === '`') {
        state = 'tmpl';
        out.push(' ');
        i += 1;
      } else {
        out.push(ch);
        i += 1;
      }
    } else if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out.push('\n');
      } else {
        out.push(' ');
      }
      i += 1;
    } else if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        out.push('  ');
        i += 2;
      } else {
        out.push(ch === '\n' ? '\n' : ' ');
        i += 1;
      }
    } else {
      // Inside a string/template literal.
      const quote = state === 'squote' ? "'" : state === 'dquote' ? '"' : '`';
      if (ch === '\\') {
        // Escaped char: blank both the backslash and the following character.
        out.push(' ');
        if (next) out.push(next === '\n' ? '\n' : ' ');
        i += next ? 2 : 1;
      } else if (ch === quote) {
        state = 'code';
        out.push(' ');
        i += 1;
      } else {
        out.push(ch === '\n' ? '\n' : ' ');
        i += 1;
      }
    }
  }
  return out.join('');
}

/**
 * True when `token` appears in `content` as a whole identifier token — the
 * characters immediately around a match are not identifier characters. This
 * avoids matching `prefetch` for `fetch`, `myClassify` for `classify`, etc.
 * Returns the 1-based line numbers of each whole-token occurrence.
 */
function tokenOccurrences(content, token) {
  const lines = content.split(/\r\n|\r|\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let from = 0;
    for (;;) {
      const idx = line.indexOf(token, from);
      if (idx === -1) break;
      const before = idx > 0 ? line[idx - 1] : '';
      const after = idx + token.length < line.length ? line[idx + token.length] : '';
      const boundedLeft = before === '' || !isIdentChar(before);
      const boundedRight = after === '' || !isIdentChar(after);
      if (boundedLeft && boundedRight) hits.push(i + 1);
      from = idx + token.length;
    }
  }
  return hits;
}

/** True when `token` appears at least once as a whole token in `content`. */
function hasToken(content, token) {
  return tokenOccurrences(content, token).length > 0;
}

/**
 * Recursively collect files under `dir` whose path passes `keep(absPath)`.
 * Missing directories yield an empty list (so the scan is robust before `src`
 * or any subtree exists).
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
 * Evaluate one file's content against the rule. Returns an array of violation
 * objects { file, sink, reason } (possibly empty).
 */
function evaluateFile(relFile, content) {
  const violations = [];

  // Which sinks does this module reference (as whole tokens)?
  const sinksPresent = NETWORK_SINKS.filter((sink) => hasToken(content, sink));
  if (sinksPresent.length === 0) return violations; // no sink → nothing to guard

  const sinkList = sinksPresent.join(', ');

  // Hard stop: declassified plaintext must never share a module with a sink.
  if (hasToken(content, DECLASSIFY)) {
    violations.push({
      file: relFile,
      sink: sinkList,
      reason:
        `references ${DECLASSIFY} (plaintext escape hatch) in the same module as a ` +
        `Network_Sink — declassified plaintext must never reach a sink`,
    });
    return violations; // a declassify+sink module is already condemned
  }

  // Does this module touch Classified data at all?
  const touchesClassified = CLASSIFIED_SYMBOLS.some((sym) => hasToken(content, sym));
  if (!touchesClassified) return violations; // sink but no classified data → fine

  // It touches Classified data AND a sink. Clean only if it routes through the
  // sanctioned transform.
  if (hasToken(content, SANCTIONED_TRANSFORM)) return violations;

  violations.push({
    file: relFile,
    sink: sinkList,
    reason:
      `touches Classified data (classify/Classified/Sensitive) alongside a ` +
      `Network_Sink without routing through ${SANCTIONED_TRANSFORM}()`,
  });
  return violations;
}

function main() {
  const tsFiles = walk(
    SRC_DIR,
    (abs) => abs.endsWith('.ts') && !abs.endsWith('.test.ts'),
  );

  const violations = [];
  for (const file of tsFiles) {
    const raw = readFileSync(file, 'utf8');
    // Match against code only — comments and string/template literals blanked.
    const content = stripCommentsAndStrings(raw);
    violations.push(...evaluateFile(relative(root, file), content));
  }

  if (violations.length === 0) {
    console.log(
      `classification-guard: clean — ${tsFiles.length} TypeScript file(s) scanned, ` +
        `no Classified data can reach a Network_Sink outside ${SANCTIONED_TRANSFORM}().`,
    );
    process.exit(EXIT_OK);
  }

  console.error(
    `classification-guard: FAIL — ${violations.length} module(s) let Classified data ` +
      `approach a Network_Sink unsafely:`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}  [sink: ${v.sink}]  ${v.reason}`);
  }
  console.error(
    `\nThe device-only boundary (tech.md hard rule #3): Classified data may reach a ` +
      `Network_Sink only as an Encrypted_Envelope produced by ${SANCTIONED_TRANSFORM}(). ` +
      `Route sensitive data through ${SANCTIONED_TRANSFORM}() before it touches the network, ` +
      `and keep ${DECLASSIFY} out of any module that talks to a sink.`,
  );
  process.exit(EXIT_FAIL);
}

main();
