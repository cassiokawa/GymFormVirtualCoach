/**
 * Spec_Validator — schema (structural) + semantic validation of an ExerciseSpec.
 *
 * This module is the build-time gate the design's "Validation and tooling"
 * section describes. It combines two passes into a single entry point,
 * {@link validateSpec}:
 *
 * 1. **Schema pass (task 11.1, Req 5.1, 5.2, 5.8).** A focused, hand-rolled
 *    structural check that mirrors `exercise-spec.schema.json` — no heavy
 *    dependency. On any structural violation it emits a {@link ValidationError}
 *    naming the offending JSON path (e.g. `phases.transitions[1].to`) and the
 *    violated constraint. An unknown smoothing filter type (`signal.smoothing.type`)
 *    is treated as a schema-level failure, cross-checked against the smoothing
 *    factory's known filter types so the two never drift.
 *
 * 2. **Semantic pass (task 11.2, Req 5.3–5.7).** Cross-field checks that the
 *    schema cannot express: expression landmarks must appear in
 *    `requiredLandmarks`; every named phase must exist; the phase graph must be
 *    strongly connected from `initial`; `reps` mode carries exactly one
 *    `RepCompleted` transition; every cue is ≤ 4 words and banned-word-free;
 *    `hysteresisPct` ≥ 0.05 and `minPhaseDurationMs` ≥ 250; a fixture exists for
 *    the spec `id`.
 *
 * The validator collects **all** errors it can rather than stopping at the
 * first, so an author sees every problem in one pass. The semantic pass only
 * runs when the schema pass produced a structurally-usable document; a document
 * that fails schema validation outright would make semantic checks throw or
 * report spurious errors.
 *
 * HARD CONSTRAINT: no exercise `id`, name, or alias appears in this file. The
 * banned-word list is anatomy/coaching-safety vocabulary, never exercise
 * identity. The known filter set comes from the smoothing factory, not literals.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8
 */

import { parseExpression, ParseError } from './expression/parser';
import type { CallArg, ExprNode } from './expression/ast';
import { DEFAULT_SMOOTHING_TYPE } from './smoothing';
import type { ExerciseSpec, LandmarkPairs } from './spec';

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

/** Stable, machine-readable codes for each class of validation failure. */
export type ValidationErrorCode =
  // Schema (structural) codes.
  | 'schema/type'
  | 'schema/required'
  | 'schema/additional-property'
  | 'schema/enum'
  | 'schema/min-length'
  | 'schema/min-items'
  | 'schema/minimum'
  | 'schema/maximum'
  | 'schema/unknown-smoothing-filter'
  // Semantic codes.
  | 'semantic/landmark-not-required'
  | 'semantic/unresolvable-ref'
  | 'semantic/expression-parse'
  | 'semantic/unknown-phase'
  | 'semantic/unreachable-phase'
  | 'semantic/rep-completed-count'
  | 'semantic/cue-too-long'
  | 'semantic/cue-banned-word'
  | 'semantic/hysteresis-too-low'
  | 'semantic/min-phase-duration-too-low'
  | 'semantic/missing-fixture';

/**
 * A single validation failure. `path` is a JSON-pointer-ish dotted path into the
 * document (e.g. `faults[2].cue`, `phases.transitions[0].to`); the empty string
 * denotes the document root. `constraint` names the violated rule in prose.
 */
export interface ValidationError {
  code: ValidationErrorCode;
  /** Dotted path to the offending value; `''` for the document root. */
  path: string;
  /** Human-readable description of the violated constraint. */
  message: string;
}

/** Result of {@link validateSpec}: success, or all collected errors. */
export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options controlling fixture presence resolution (Req 5.7). Fixtures are
 * discovered by the harness (task 12); to keep the validator testable in
 * isolation, the caller injects how "does a fixture exist for this id?" is
 * answered. Provide EITHER a set of known ids OR a lookup predicate. When
 * neither is provided, the fixture check is SKIPPED (not failed) — the build
 * wiring in task 12 supplies the real source; a bare `validateSpec(spec)` call
 * validates structure and semantics without asserting a fixture.
 */
export interface ValidateSpecOptions {
  /** A set (or array) of spec ids that have a fixture. */
  knownFixtureIds?: ReadonlySet<string> | readonly string[];
  /** A predicate answering whether a fixture exists for `id`. */
  hasFixture?: (id: string) => boolean;
}

// ---------------------------------------------------------------------------
// Banned words (coaching-safety.md)
// ---------------------------------------------------------------------------

/**
 * Words banned from all user-facing output by `coaching-safety.md`. Matched
 * case-insensitively on whole words. These are safety vocabulary, not exercise
 * identity.
 */
export const BANNED_CUE_WORDS: readonly string[] = [
  'injury',
  'injure',
  'dysfunction',
  'pathology',
  'diagnose',
  'imbalance',
  'damage',
  'dangerous',
  'unsafe',
  'corrective',
];

const BANNED_CUE_WORD_SET = new Set(BANNED_CUE_WORDS.map((w) => w.toLowerCase()));

/** Maximum number of words permitted in a cue (Req 5.5). */
export const MAX_CUE_WORDS = 4;

/** Minimum permitted `hysteresisPct` (Req 5.6). */
export const MIN_HYSTERESIS_PCT = 0.05;

/** Minimum permitted `minPhaseDurationMs` (Req 5.6). */
export const MIN_PHASE_DURATION_MS = 250;

/** Fault severities permitted by the schema enum. */
const FAULT_SEVERITIES = new Set(['info', 'warning', 'critical']);

/** Modes permitted by the schema enum. */
const MODES = new Set(['reps', 'hold']);

/** The domain event a `reps` spec's single counting transition emits. */
const REP_COMPLETED_EVENT = 'RepCompleted';

/**
 * Smoothing filter types the engine knows how to build. Kept in sync with the
 * factory in `smoothing.ts` via {@link DEFAULT_SMOOTHING_TYPE} rather than a
 * duplicated literal, so an unknown-filter check here can never drift from what
 * the factory actually accepts.
 */
const KNOWN_SMOOTHING_TYPES = new Set<string>([DEFAULT_SMOOTHING_TYPE]);

// ---------------------------------------------------------------------------
// Schema pass — structural walk mirroring exercise-spec.schema.json
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Join a parent path and a key into a dotted path (`''` root → `key`). */
function joinPath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`;
}

/** Join a parent path and an array index into `parent[i]`. */
function indexPath(parent: string, i: number): string {
  return `${parent}[${i}]`;
}

/**
 * Accumulates {@link ValidationError}s across both passes. Callers push errors;
 * `hasErrorsUnder` lets the driver decide whether the semantic pass can safely
 * run against a given subtree.
 */
class ErrorCollector {
  readonly errors: ValidationError[] = [];

  push(code: ValidationErrorCode, path: string, message: string): void {
    this.errors.push({ code, path, message });
  }

  /** True if any collected error's path equals or is nested under `prefix`. */
  hasErrorsUnder(prefix: string): boolean {
    return this.errors.some(
      (e) =>
        e.path === prefix ||
        e.path.startsWith(`${prefix}.`) ||
        e.path.startsWith(`${prefix}[`),
    );
  }
}

// --- small structural assertion helpers ------------------------------------

function expectObject(
  value: unknown,
  path: string,
  errors: ErrorCollector,
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    errors.push('schema/type', path, `expected an object at ${path || 'root'}`);
    return false;
  }
  return true;
}

function expectArray(
  value: unknown,
  path: string,
  errors: ErrorCollector,
): value is unknown[] {
  if (!Array.isArray(value)) {
    errors.push('schema/type', path, `expected an array at ${path}`);
    return false;
  }
  return true;
}

function expectRequired(
  obj: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  errors: ErrorCollector,
): void {
  for (const key of keys) {
    if (!(key in obj) || obj[key] === undefined) {
      errors.push(
        'schema/required',
        joinPath(path, key),
        `missing required property "${key}"`,
      );
    }
  }
}

function forbidAdditional(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: ErrorCollector,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      errors.push(
        'schema/additional-property',
        joinPath(path, key),
        `unexpected additional property "${key}"`,
      );
    }
  }
}

function expectNonEmptyString(
  value: unknown,
  path: string,
  errors: ErrorCollector,
): value is string {
  if (typeof value !== 'string') {
    errors.push('schema/type', path, `expected a string at ${path}`);
    return false;
  }
  if (value.length < 1) {
    errors.push('schema/min-length', path, `${path} must not be empty`);
    return false;
  }
  return true;
}

function expectNumber(
  value: unknown,
  path: string,
  errors: ErrorCollector,
): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push('schema/type', path, `expected a finite number at ${path}`);
    return false;
  }
  return true;
}

function expectInteger(
  value: unknown,
  path: string,
  errors: ErrorCollector,
): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors.push('schema/type', path, `expected an integer at ${path}`);
    return false;
  }
  return true;
}

function expectMinimum(
  value: number,
  minimum: number,
  path: string,
  errors: ErrorCollector,
): void {
  if (value < minimum) {
    errors.push('schema/minimum', path, `${path} must be >= ${minimum}`);
  }
}

function expectMaximum(
  value: number,
  maximum: number,
  path: string,
  errors: ErrorCollector,
): void {
  if (value > maximum) {
    errors.push('schema/maximum', path, `${path} must be <= ${maximum}`);
  }
}

/**
 * Structurally validate `raw` against the ExerciseSpec schema, pushing every
 * violation into `errors`. Mirrors `exercise-spec.schema.json`: required
 * properties, no additional properties, types, enums, min-length, min-items,
 * numeric bounds, and the unknown-smoothing-filter check (Req 5.8). Returns
 * without throwing on any input shape.
 */
function validateSchema(raw: unknown, errors: ErrorCollector): void {
  if (!expectObject(raw, '', errors)) {
    return;
  }

  const topKeys = [
    'id',
    'version',
    'displayName',
    'aliases',
    'facets',
    'mode',
    'bilateral',
    'landmarkPairs',
    'requiredLandmarks',
    'optionalLandmarks',
    'camera',
    'signal',
    'rom',
    'phases',
    'velocity',
    'faults',
  ] as const;
  const requiredTop = topKeys.filter((k) => k !== 'velocity');
  expectRequired(raw, requiredTop, '', errors);
  forbidAdditional(raw, topKeys, '', errors);

  expectNonEmptyString(raw['id'], 'id', errors);
  expectNonEmptyString(raw['version'], 'version', errors);
  expectNonEmptyString(raw['displayName'], 'displayName', errors);

  // aliases: string[] (each non-empty).
  if (expectArray(raw['aliases'], 'aliases', errors)) {
    raw['aliases'].forEach((a, i) =>
      expectNonEmptyString(a, indexPath('aliases', i), errors),
    );
  }

  validateFacets(raw['facets'], errors);

  // mode enum.
  if (typeof raw['mode'] !== 'string' || !MODES.has(raw['mode'])) {
    errors.push('schema/enum', 'mode', 'mode must be "reps" or "hold"');
  }

  if (typeof raw['bilateral'] !== 'boolean') {
    errors.push('schema/type', 'bilateral', 'bilateral must be a boolean');
  }

  validateLandmarkPairs(raw['landmarkPairs'], errors);
  validateIndexArray(raw['requiredLandmarks'], 'requiredLandmarks', errors);
  validateIndexArray(raw['optionalLandmarks'], 'optionalLandmarks', errors);
  validateCamera(raw['camera'], errors);
  validateSignal(raw['signal'], errors);
  validateRom(raw['rom'], errors);
  validatePhases(raw['phases'], errors);
  if ('velocity' in raw && raw['velocity'] !== undefined) {
    validateVelocity(raw['velocity'], errors);
  }
  validateFaults(raw['faults'], errors);
}

function validateFacets(value: unknown, errors: ErrorCollector): void {
  const path = 'facets';
  if (!expectObject(value, path, errors)) {
    return;
  }
  expectRequired(value, ['equipment', 'primaryMuscles', 'position'], path, errors);
  forbidAdditional(value, ['equipment', 'primaryMuscles', 'position'], path, errors);
  expectNonEmptyString(value['equipment'], joinPath(path, 'equipment'), errors);
  expectNonEmptyString(value['position'], joinPath(path, 'position'), errors);
  const musclesPath = joinPath(path, 'primaryMuscles');
  if (expectArray(value['primaryMuscles'], musclesPath, errors)) {
    value['primaryMuscles'].forEach((m, i) =>
      expectNonEmptyString(m, indexPath(musclesPath, i), errors),
    );
  }
}

function validateLandmarkPairs(value: unknown, errors: ErrorCollector): void {
  const path = 'landmarkPairs';
  if (!expectObject(value, path, errors)) {
    return;
  }
  for (const [name, pair] of Object.entries(value)) {
    const pairPath = joinPath(path, name);
    if (!expectObject(pair, pairPath, errors)) {
      continue;
    }
    expectRequired(pair, ['left', 'right'], pairPath, errors);
    forbidAdditional(pair, ['left', 'right'], pairPath, errors);
    for (const side of ['left', 'right'] as const) {
      const sidePath = joinPath(pairPath, side);
      if (expectInteger(pair[side], sidePath, errors)) {
        expectMinimum(pair[side] as number, 0, sidePath, errors);
      }
    }
  }
}

function validateIndexArray(
  value: unknown,
  path: string,
  errors: ErrorCollector,
): void {
  if (!expectArray(value, path, errors)) {
    return;
  }
  value.forEach((v, i) => {
    const itemPath = indexPath(path, i);
    if (expectInteger(v, itemPath, errors)) {
      expectMinimum(v as number, 0, itemPath, errors);
    }
  });
}

function validateCamera(value: unknown, errors: ErrorCollector): void {
  const path = 'camera';
  if (!expectObject(value, path, errors)) {
    return;
  }
  expectRequired(value, ['preferredAngleDeg', 'toleranceDeg', 'view'], path, errors);
  forbidAdditional(value, ['preferredAngleDeg', 'toleranceDeg', 'view'], path, errors);
  expectNumber(value['preferredAngleDeg'], joinPath(path, 'preferredAngleDeg'), errors);
  const tolPath = joinPath(path, 'toleranceDeg');
  if (expectNumber(value['toleranceDeg'], tolPath, errors)) {
    expectMinimum(value['toleranceDeg'] as number, 0, tolPath, errors);
  }
  expectNonEmptyString(value['view'], joinPath(path, 'view'), errors);
}

function validateSignal(value: unknown, errors: ErrorCollector): void {
  const path = 'signal';
  if (!expectObject(value, path, errors)) {
    return;
  }
  expectRequired(value, ['expr', 'smoothing'], path, errors);
  forbidAdditional(value, ['expr', 'smoothing'], path, errors);
  expectNonEmptyString(value['expr'], joinPath(path, 'expr'), errors);

  const smPath = joinPath(path, 'smoothing');
  const smoothing = value['smoothing'];
  if (!expectObject(smoothing, smPath, errors)) {
    return;
  }
  expectRequired(smoothing, ['type', 'minCutoff', 'beta'], smPath, errors);
  forbidAdditional(smoothing, ['type', 'minCutoff', 'beta'], smPath, errors);

  const typePath = joinPath(smPath, 'type');
  if (expectNonEmptyString(smoothing['type'], typePath, errors)) {
    // Req 5.8: an unknown smoothing filter fails validation.
    if (!KNOWN_SMOOTHING_TYPES.has(smoothing['type'] as string)) {
      errors.push(
        'schema/unknown-smoothing-filter',
        typePath,
        `unknown smoothing filter "${String(smoothing['type'])}"; known filters: ${[...KNOWN_SMOOTHING_TYPES].join(', ')}`,
      );
    }
  }
  for (const key of ['minCutoff', 'beta'] as const) {
    const p = joinPath(smPath, key);
    if (expectNumber(smoothing[key], p, errors)) {
      expectMinimum(smoothing[key] as number, 0, p, errors);
    }
  }
}

function validateRom(value: unknown, errors: ErrorCollector): void {
  const path = 'rom';
  if (!expectObject(value, path, errors)) {
    return;
  }
  expectRequired(value, ['source', 'floorPercentile', 'gateTolerance'], path, errors);
  forbidAdditional(value, ['source', 'floorPercentile', 'gateTolerance'], path, errors);
  expectNonEmptyString(value['source'], joinPath(path, 'source'), errors);
  const fpPath = joinPath(path, 'floorPercentile');
  if (expectNumber(value['floorPercentile'], fpPath, errors)) {
    expectMinimum(value['floorPercentile'] as number, 0, fpPath, errors);
    expectMaximum(value['floorPercentile'] as number, 100, fpPath, errors);
  }
  const gtPath = joinPath(path, 'gateTolerance');
  if (expectNumber(value['gateTolerance'], gtPath, errors)) {
    expectMinimum(value['gateTolerance'] as number, 0, gtPath, errors);
  }
}

function validatePhases(value: unknown, errors: ErrorCollector): void {
  const path = 'phases';
  if (!expectObject(value, path, errors)) {
    return;
  }
  const allowed = [
    'states',
    'initial',
    'hysteresisPct',
    'minPhaseDurationMs',
    'transitions',
  ];
  expectRequired(value, allowed, path, errors);
  forbidAdditional(value, allowed, path, errors);

  const statesPath = joinPath(path, 'states');
  if (expectArray(value['states'], statesPath, errors)) {
    if (value['states'].length < 1) {
      errors.push('schema/min-items', statesPath, 'phases.states must not be empty');
    }
    value['states'].forEach((s, i) =>
      expectNonEmptyString(s, indexPath(statesPath, i), errors),
    );
  }
  expectNonEmptyString(value['initial'], joinPath(path, 'initial'), errors);
  expectNumber(value['hysteresisPct'], joinPath(path, 'hysteresisPct'), errors);
  expectNumber(value['minPhaseDurationMs'], joinPath(path, 'minPhaseDurationMs'), errors);

  const trPath = joinPath(path, 'transitions');
  if (expectArray(value['transitions'], trPath, errors)) {
    value['transitions'].forEach((t, i) =>
      validateTransition(t, indexPath(trPath, i), errors),
    );
  }
}

function validateTransition(
  value: unknown,
  path: string,
  errors: ErrorCollector,
): void {
  if (!expectObject(value, path, errors)) {
    return;
  }
  expectRequired(value, ['from', 'to', 'when'], path, errors);
  forbidAdditional(value, ['from', 'to', 'when', 'emits'], path, errors);
  expectNonEmptyString(value['from'], joinPath(path, 'from'), errors);
  expectNonEmptyString(value['to'], joinPath(path, 'to'), errors);
  expectNonEmptyString(value['when'], joinPath(path, 'when'), errors);
  if ('emits' in value && value['emits'] !== undefined) {
    expectNonEmptyString(value['emits'], joinPath(path, 'emits'), errors);
  }
}

function validateVelocity(value: unknown, errors: ErrorCollector): void {
  const path = 'velocity';
  if (!expectObject(value, path, errors)) {
    return;
  }
  expectRequired(value, ['trackedPoint', 'axis', 'normalizeBy'], path, errors);
  forbidAdditional(value, ['trackedPoint', 'axis', 'normalizeBy'], path, errors);
  expectNonEmptyString(value['trackedPoint'], joinPath(path, 'trackedPoint'), errors);
  expectNonEmptyString(value['axis'], joinPath(path, 'axis'), errors);
  expectNonEmptyString(value['normalizeBy'], joinPath(path, 'normalizeBy'), errors);
}

function validateFaults(value: unknown, errors: ErrorCollector): void {
  const path = 'faults';
  if (!expectArray(value, path, errors)) {
    return;
  }
  value.forEach((f, i) => validateFault(f, indexPath(path, i), errors));
}

function validateFault(
  value: unknown,
  path: string,
  errors: ErrorCollector,
): void {
  if (!expectObject(value, path, errors)) {
    return;
  }
  const allowed = ['id', 'phase', 'when', 'minDeviation', 'severity', 'cue'];
  expectRequired(value, allowed, path, errors);
  forbidAdditional(value, allowed, path, errors);
  expectNonEmptyString(value['id'], joinPath(path, 'id'), errors);
  expectNonEmptyString(value['phase'], joinPath(path, 'phase'), errors);
  expectNonEmptyString(value['when'], joinPath(path, 'when'), errors);
  expectNumber(value['minDeviation'], joinPath(path, 'minDeviation'), errors);
  const sevPath = joinPath(path, 'severity');
  if (typeof value['severity'] !== 'string' || !FAULT_SEVERITIES.has(value['severity'])) {
    errors.push('schema/enum', sevPath, 'severity must be info, warning, or critical');
  }
  expectNonEmptyString(value['cue'], joinPath(path, 'cue'), errors);
}

// ---------------------------------------------------------------------------
// Expression ref extraction
// ---------------------------------------------------------------------------

/**
 * Walk a parsed expression AST and collect every joint {@link RefNode} name.
 * String-literal call arguments (e.g. the axis name in `axis(ref,"y")`) are NOT
 * refs and are skipped. Bound variables (`signal`, `romFloor`, …) are not refs.
 */
function collectRefNames(node: ExprNode, out: Set<string>): void {
  switch (node.kind) {
    case 'number':
    case 'boundVar':
      return;
    case 'ref':
      out.add(node.name);
      return;
    case 'binaryOp':
    case 'comparison':
      collectRefNames(node.left, out);
      collectRefNames(node.right, out);
      return;
    case 'call':
      for (const arg of node.args) {
        collectCallArgRefs(arg, out);
      }
      return;
    default: {
      // Exhaustiveness guard: every ExprNode kind is handled above.
      const _never: never = node;
      void _never;
    }
  }
}

function collectCallArgRefs(arg: CallArg, out: Set<string>): void {
  if (arg.kind === 'string') {
    return;
  }
  collectRefNames(arg, out);
}

const LEFT_PREFIX = 'left_';
const RIGHT_PREFIX = 'right_';

/**
 * Resolve a joint ref name to the landmark indices it reads, using
 * `landmarkPairs`:
 * - `left_<base>` → the pair's `left` index.
 * - `right_<base>` → the pair's `right` index.
 * - unprefixed `<base>` → BOTH the `left` and `right` indices (bilateral
 *   midpoint reads both).
 *
 * Returns `undefined` when the base name has no entry in `landmarkPairs` — an
 * unresolvable ref, reported separately.
 */
function landmarkIndicesForRef(
  name: string,
  landmarkPairs: LandmarkPairs,
): number[] | undefined {
  if (name.startsWith(LEFT_PREFIX)) {
    const pair = landmarkPairs[name.slice(LEFT_PREFIX.length)];
    return pair === undefined ? undefined : [pair.left];
  }
  if (name.startsWith(RIGHT_PREFIX)) {
    const pair = landmarkPairs[name.slice(RIGHT_PREFIX.length)];
    return pair === undefined ? undefined : [pair.right];
  }
  const pair = landmarkPairs[name];
  return pair === undefined ? undefined : [pair.left, pair.right];
}

// ---------------------------------------------------------------------------
// Semantic pass
// ---------------------------------------------------------------------------

/**
 * Semantic checks (Req 5.3–5.7). Assumes `spec` is structurally sound (the
 * schema pass ran first and the driver only calls this when the relevant
 * subtree is clean). Collects all errors it can.
 */
function validateSemantics(
  spec: ExerciseSpec,
  options: ValidateSpecOptions | undefined,
  errors: ErrorCollector,
): void {
  const requiredSet = new Set(spec.requiredLandmarks);
  const phaseSet = new Set(spec.phases.states);

  // --- Req 5.3a: expression landmarks appear in requiredLandmarks -----------
  checkExpressionLandmarks(spec.signal.expr, 'signal.expr', spec.landmarkPairs, requiredSet, errors);
  spec.phases.transitions.forEach((t, i) =>
    checkExpressionLandmarks(
      t.when,
      `phases.transitions[${i}].when`,
      spec.landmarkPairs,
      requiredSet,
      errors,
    ),
  );
  spec.faults.forEach((f, i) =>
    checkExpressionLandmarks(
      f.when,
      `faults[${i}].when`,
      spec.landmarkPairs,
      requiredSet,
      errors,
    ),
  );
  if (spec.velocity !== undefined) {
    checkExpressionLandmarks(
      spec.velocity.trackedPoint,
      'velocity.trackedPoint',
      spec.landmarkPairs,
      requiredSet,
      errors,
    );
  }

  // --- Req 5.3b: named phases exist ----------------------------------------
  if (!phaseSet.has(spec.phases.initial)) {
    errors.push(
      'semantic/unknown-phase',
      'phases.initial',
      `initial phase "${spec.phases.initial}" is not declared in phases.states`,
    );
  }
  spec.phases.transitions.forEach((t, i) => {
    if (!phaseSet.has(t.from)) {
      errors.push(
        'semantic/unknown-phase',
        `phases.transitions[${i}].from`,
        `phase "${t.from}" is not declared in phases.states`,
      );
    }
    if (!phaseSet.has(t.to)) {
      errors.push(
        'semantic/unknown-phase',
        `phases.transitions[${i}].to`,
        `phase "${t.to}" is not declared in phases.states`,
      );
    }
  });
  spec.faults.forEach((f, i) => {
    if (!phaseSet.has(f.phase)) {
      errors.push(
        'semantic/unknown-phase',
        `faults[${i}].phase`,
        `phase "${f.phase}" is not declared in phases.states`,
      );
    }
  });

  // --- Req 5.3c: phase graph strongly connected from initial ---------------
  // Only meaningful when initial and every transition endpoint is a real phase.
  if (phaseSet.has(spec.phases.initial)) {
    checkStronglyConnected(spec, phaseSet, errors);
  }

  // --- Req 5.4: exactly one RepCompleted transition for reps mode ----------
  const repCompletedCount = spec.phases.transitions.filter(
    (t) => t.emits === REP_COMPLETED_EVENT,
  ).length;
  if (spec.mode === 'reps') {
    if (repCompletedCount !== 1) {
      errors.push(
        'semantic/rep-completed-count',
        'phases.transitions',
        `mode "reps" requires exactly one transition emitting "${REP_COMPLETED_EVENT}", found ${repCompletedCount}`,
      );
    }
  } else {
    // mode "hold": a hold is timed, not counted. Zero RepCompleted transitions
    // is the rule; any RepCompleted transition is meaningless for a hold.
    if (repCompletedCount !== 0) {
      errors.push(
        'semantic/rep-completed-count',
        'phases.transitions',
        `mode "hold" must not emit "${REP_COMPLETED_EVENT}" (holds are timed, not counted), found ${repCompletedCount}`,
      );
    }
  }

  // --- Req 5.5: cue length + banned words ----------------------------------
  spec.faults.forEach((f, i) => checkCue(f.cue, `faults[${i}].cue`, errors));

  // --- Req 5.6: threshold bounds -------------------------------------------
  if (spec.phases.hysteresisPct < MIN_HYSTERESIS_PCT) {
    errors.push(
      'semantic/hysteresis-too-low',
      'phases.hysteresisPct',
      `hysteresisPct must be >= ${MIN_HYSTERESIS_PCT}, got ${spec.phases.hysteresisPct}`,
    );
  }
  if (spec.phases.minPhaseDurationMs < MIN_PHASE_DURATION_MS) {
    errors.push(
      'semantic/min-phase-duration-too-low',
      'phases.minPhaseDurationMs',
      `minPhaseDurationMs must be >= ${MIN_PHASE_DURATION_MS}, got ${spec.phases.minPhaseDurationMs}`,
    );
  }

  // --- Req 5.7: a fixture exists for the spec id ---------------------------
  const hasFixture = resolveFixturePredicate(options);
  if (hasFixture !== undefined && !hasFixture(spec.id)) {
    errors.push(
      'semantic/missing-fixture',
      'id',
      `no fixture exists for spec id "${spec.id}"`,
    );
  }
}

/** Parse one expression and check each ref resolves and is a required landmark. */
function checkExpressionLandmarks(
  expr: string,
  path: string,
  landmarkPairs: LandmarkPairs,
  requiredSet: ReadonlySet<number>,
  errors: ErrorCollector,
): void {
  let ast: ExprNode;
  try {
    ast = parseExpression(expr);
  } catch (err) {
    const detail = err instanceof ParseError ? err.message : String(err);
    errors.push(
      'semantic/expression-parse',
      path,
      `expression failed to parse: ${detail}`,
    );
    return;
  }

  const refNames = new Set<string>();
  collectRefNames(ast, refNames);

  for (const name of refNames) {
    const indices = landmarkIndicesForRef(name, landmarkPairs);
    if (indices === undefined) {
      errors.push(
        'semantic/unresolvable-ref',
        path,
        `joint reference "${name}" has no entry in landmarkPairs`,
      );
      continue;
    }
    for (const idx of indices) {
      if (!requiredSet.has(idx)) {
        errors.push(
          'semantic/landmark-not-required',
          path,
          `joint reference "${name}" resolves to landmark index ${idx}, which is not in requiredLandmarks`,
        );
      }
    }
  }
}

/**
 * Verify the phase graph is strongly connected from `initial`: every phase is
 * reachable from `initial`, AND `initial` is reachable from every phase.
 * Equivalent to: forward reachability from initial covers all states, and
 * reverse reachability into initial covers all states.
 */
function checkStronglyConnected(
  spec: ExerciseSpec,
  phaseSet: ReadonlySet<string>,
  errors: ErrorCollector,
): void {
  const forward = new Map<string, Set<string>>();
  const backward = new Map<string, Set<string>>();
  for (const s of phaseSet) {
    forward.set(s, new Set());
    backward.set(s, new Set());
  }
  for (const t of spec.phases.transitions) {
    // Only wire edges between known phases; unknown phases are already reported.
    if (phaseSet.has(t.from) && phaseSet.has(t.to)) {
      forward.get(t.from)!.add(t.to);
      backward.get(t.to)!.add(t.from);
    }
  }

  const reachableFromInitial = bfs(spec.phases.initial, forward);
  const canReachInitial = bfs(spec.phases.initial, backward);

  for (const phase of phaseSet) {
    const notForward = !reachableFromInitial.has(phase);
    const notBackward = !canReachInitial.has(phase);
    if (notForward || notBackward) {
      const parts: string[] = [];
      if (notForward) parts.push('not reachable from initial');
      if (notBackward) parts.push('cannot reach initial');
      errors.push(
        'semantic/unreachable-phase',
        'phases',
        `phase "${phase}" breaks strong connectivity (${parts.join('; ')})`,
      );
    }
  }
}

/** Breadth-first reachable-set from `start` over an adjacency map. */
function bfs(start: string, adjacency: Map<string, Set<string>>): Set<string> {
  const seen = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const node = queue.shift()!;
    const neighbours = adjacency.get(node);
    if (neighbours === undefined) {
      continue;
    }
    for (const next of neighbours) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** Split a cue into words on whitespace, dropping empties. */
function cueWords(cue: string): string[] {
  return cue.trim().split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Normalise a word for banned-word matching: lowercase and strip surrounding
 * punctuation so `"corrective,"` matches `corrective`. Whole-word match.
 */
function normaliseWord(word: string): string {
  return word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

/** Check a cue for the ≤4-word and banned-word constraints (Req 5.5). */
function checkCue(cue: string, path: string, errors: ErrorCollector): void {
  const words = cueWords(cue);
  if (words.length > MAX_CUE_WORDS) {
    errors.push(
      'semantic/cue-too-long',
      path,
      `cue must be at most ${MAX_CUE_WORDS} words, got ${words.length}: "${cue}"`,
    );
  }
  for (const word of words) {
    if (BANNED_CUE_WORD_SET.has(normaliseWord(word))) {
      errors.push(
        'semantic/cue-banned-word',
        path,
        `cue contains banned word "${normaliseWord(word)}": "${cue}"`,
      );
    }
  }
}

/**
 * Resolve the fixture-existence predicate from options. Returns `undefined`
 * (check skipped) when neither `hasFixture` nor `knownFixtureIds` is supplied.
 */
function resolveFixturePredicate(
  options: ValidateSpecOptions | undefined,
): ((id: string) => boolean) | undefined {
  if (options === undefined) {
    return undefined;
  }
  if (options.hasFixture !== undefined) {
    return options.hasFixture;
  }
  if (options.knownFixtureIds !== undefined) {
    const set =
      options.knownFixtureIds instanceof Set
        ? options.knownFixtureIds
        : new Set(options.knownFixtureIds);
    return (id: string) => set.has(id);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Validate an ExerciseSpec document: schema (structural) checks first, then
 * semantic checks. Collects ALL errors rather than stopping at the first.
 *
 * `raw` is `unknown` on purpose — the validator is the gate that turns an
 * untrusted parsed JSON value into a trusted {@link ExerciseSpec}. The semantic
 * pass runs only when the schema pass leaves the document structurally usable;
 * a structurally-broken document reports schema errors alone (semantic checks
 * against it would be noise).
 *
 * @param raw     The parsed JSON document (any shape).
 * @param options Fixture-lookup injection (Req 5.7). When omitted, the fixture
 *                check is skipped.
 * @returns `{ ok: true }` or `{ ok: false, errors }` with every collected error.
 */
export function validateSpec(
  raw: unknown,
  options?: ValidateSpecOptions,
): ValidationResult {
  const errors = new ErrorCollector();

  validateSchema(raw, errors);

  // Run semantics only when the structure is sound enough to interpret. The
  // core subtrees the semantic pass reads must be clean; otherwise semantic
  // checks would dereference malformed shapes.
  const structurallyUsable =
    !errors.hasErrorsUnder('phases') &&
    !errors.hasErrorsUnder('signal') &&
    !errors.hasErrorsUnder('faults') &&
    !errors.hasErrorsUnder('landmarkPairs') &&
    !errors.hasErrorsUnder('requiredLandmarks') &&
    !errors.hasErrorsUnder('velocity') &&
    !errors.hasErrorsUnder('mode') &&
    !errors.hasErrorsUnder('id') &&
    isRecord(raw);

  if (structurallyUsable) {
    validateSemantics(raw as unknown as ExerciseSpec, options, errors);
  }

  if (errors.errors.length > 0) {
    return { ok: false, errors: errors.errors };
  }
  return { ok: true };
}
