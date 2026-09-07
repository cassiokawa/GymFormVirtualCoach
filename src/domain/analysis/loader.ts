/**
 * Loader — reads exercise JSON documents from `src/domain/exercises` and parses
 * each into an in-memory {@link ExerciseSpec}.
 *
 * SOURCE BOUNDARY: this loader reads exercise definitions *exclusively* from the
 * `src/domain/exercises` directory (Requirement 1.1). Nothing else is a source
 * of exercise data. Discovery is by glob — the loader finds whatever JSON exists
 * and never names an exercise `id`, `displayName`, or alias in TypeScript.
 *
 * This task (2.2) is parse-into-{@link ExerciseSpec} only. Compiling a spec into
 * a `CompiledSpec` (closure trees + phase machine) happens in later tasks; full
 * schema + semantic validation is task 11. {@link loadSpecFromJson} performs only
 * a light top-level shape check — just enough to type the value and fail clearly
 * on obviously-wrong input.
 *
 * Requirements: 1.1, 1.2
 */

import type {
  ExerciseSpec,
  ExerciseMode,
  SignalSpec,
  PhasesSpec,
  FaultSpec,
} from './spec';

/** Thrown when a raw document does not have the minimal ExerciseSpec shape. */
export class SpecParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecParseError';
  }
}

// ---------------------------------------------------------------------------
// Light top-level shape checks
//
// Deliberately minimal: enough to type the value and fail clearly on garbage.
// Structural (schema) and semantic validation live in task 11.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string') {
    throw new SpecParseError(`ExerciseSpec.${key} must be a string`);
  }
  return v;
}

function requireMode(obj: Record<string, unknown>): ExerciseMode {
  const v = obj['mode'];
  if (v !== 'reps' && v !== 'hold') {
    throw new SpecParseError(`ExerciseSpec.mode must be "reps" or "hold"`);
  }
  return v;
}

function requireObject(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = obj[key];
  if (!isRecord(v)) {
    throw new SpecParseError(`ExerciseSpec.${key} must be an object`);
  }
  return v;
}

function requireArray(obj: Record<string, unknown>, key: string): unknown[] {
  const v = obj[key];
  if (!Array.isArray(v)) {
    throw new SpecParseError(`ExerciseSpec.${key} must be an array`);
  }
  return v;
}

/**
 * Parse an unknown value into a typed {@link ExerciseSpec}.
 *
 * Pure and synchronous. Validates the top-level shape minimally (the presence
 * and coarse type of each required field), then returns the value typed as an
 * `ExerciseSpec`. It does NOT enforce the full JSON schema or any semantic bound
 * (cue length, `hysteresisPct` >= 0.05, landmark coverage, phase reachability,
 * etc.) — that is task 11. It throws {@link SpecParseError} on obviously-wrong
 * input so a malformed document fails loudly rather than flowing downstream as
 * a mis-typed object.
 */
export function loadSpecFromJson(raw: unknown): ExerciseSpec {
  if (!isRecord(raw)) {
    throw new SpecParseError('ExerciseSpec document must be a JSON object');
  }

  // Top-level primitives.
  const id = requireString(raw, 'id');
  const version = requireString(raw, 'version');
  const displayName = requireString(raw, 'displayName');
  const mode = requireMode(raw);

  if (typeof raw['bilateral'] !== 'boolean') {
    throw new SpecParseError('ExerciseSpec.bilateral must be a boolean');
  }

  // Composite fields — presence + coarse type only.
  requireArray(raw, 'aliases');
  requireObject(raw, 'facets');
  requireObject(raw, 'landmarkPairs');
  requireArray(raw, 'requiredLandmarks');
  requireArray(raw, 'optionalLandmarks');
  requireObject(raw, 'camera');
  const signal = requireObject(raw, 'signal');
  requireObject(raw, 'rom');
  const phases = requireObject(raw, 'phases');
  requireArray(raw, 'faults');

  // Minimal look inside the pieces the engine cannot function without.
  if (typeof signal['expr'] !== 'string') {
    throw new SpecParseError('ExerciseSpec.signal.expr must be a string');
  }
  if (!Array.isArray(phases['states']) || typeof phases['initial'] !== 'string') {
    throw new SpecParseError('ExerciseSpec.phases must declare states[] and initial');
  }

  // `velocity` is optional; if present it must be an object.
  if ('velocity' in raw && raw['velocity'] !== undefined && !isRecord(raw['velocity'])) {
    throw new SpecParseError('ExerciseSpec.velocity, when present, must be an object');
  }

  // Shape checks passed. The document is trusted to match ExerciseSpec at the
  // coarse level; deeper structure is the schema validator's responsibility.
  // Reference the fields we validated closely so the cast is meaningful.
  void id;
  void version;
  void displayName;
  void mode;
  void (signal as unknown as SignalSpec);
  void (phases as unknown as PhasesSpec);
  void (raw['faults'] as unknown as FaultSpec[]);

  return raw as unknown as ExerciseSpec;
}

// ---------------------------------------------------------------------------
// Directory discovery
// ---------------------------------------------------------------------------

/**
 * Eagerly import every JSON document under `src/domain/exercises`.
 *
 * Vite resolves `import.meta.glob` at build time against the source tree, so the
 * exercises directory is the only place documents can come from — the source
 * boundary is enforced by the glob pattern itself, not a runtime check.
 *
 * The glob is scoped to this context's sibling `../exercises/` directory. When
 * no JSON files exist the map is empty and {@link loadAllSpecs} returns `[]`.
 *
 * `import.meta.glob` is a Vite extension not present in the TypeScript lib, so
 * we reach it through a narrow cast — the same safe-cast approach used for
 * `import.meta.env` in `src/account/AuthClient.ts`.
 */
type GlobFn = (
  pattern: string,
  options: { eager: true; import: 'default' },
) => Record<string, unknown>;

function globExerciseModules(): Record<string, unknown> {
  const glob = (import.meta as unknown as { glob?: GlobFn }).glob;
  if (typeof glob !== 'function') {
    // Non-Vite context (e.g. some test runners without the plugin). No modules
    // are discoverable through the glob; callers get an empty result.
    return {};
  }
  return glob('../exercises/**/*.json', { eager: true, import: 'default' });
}

/**
 * Discover and parse every exercise JSON document under
 * `src/domain/exercises`, returning one {@link ExerciseSpec} per document.
 *
 * Returns `[]` when the directory contains no JSON documents. Discovery is by
 * glob, so no exercise identity is named in TypeScript. Each discovered
 * document is parsed with {@link loadSpecFromJson}; a malformed document throws
 * {@link SpecParseError} naming the offending file.
 */
export function loadAllSpecs(): ExerciseSpec[] {
  const modules = globExerciseModules();
  const paths = Object.keys(modules).sort();

  const specs: ExerciseSpec[] = [];
  for (const path of paths) {
    try {
      specs.push(loadSpecFromJson(modules[path]));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new SpecParseError(`Failed to parse exercise document "${path}": ${detail}`);
    }
  }
  return specs;
}
