/**
 * The ExerciseSpec document contract — the parsed shape of an exercise JSON
 * document under `src/domain/exercises/**` /*.json`.
 *
 * This is a DATA CONTRACT type describing the *shape* of a spec document. It is
 * NOT an exercise itself, so it declares no concrete exercise `id`, name, or
 * alias literals — those live only in the JSON data. Keeping the contract here
 * lets the loader (task 2.2), validator (task 11), and compiler (later tasks)
 * share one authoritative shape.
 *
 * Structural validation is performed against `exercise-spec.schema.json`;
 * semantic bounds (e.g. `hysteresisPct` >= 0.05, `minPhaseDurationMs` >= 250,
 * cue length/banned-words) are enforced by the validator in task 11, not by
 * this type. Numbers here are plain numbers.
 *
 * Requirements: 1.2, 1.3
 */

import type { FaultSeverity } from './types';

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/**
 * How the engine interprets the exercise:
 * - `reps`: counted repetitions driven by phase transitions.
 * - `hold`: a timed isometric hold rather than counted reps.
 */
export type ExerciseMode = 'reps' | 'hold';

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

/** Filterable classification facets used by the exercise grid. */
export interface SpecFacets {
  /** Equipment classification (data-defined value). */
  equipment: string;
  /** Primary muscles worked (data-defined values). */
  primaryMuscles: string[];
  /** Body position classification (data-defined value). */
  position: string;
}

// ---------------------------------------------------------------------------
// Landmark references
// ---------------------------------------------------------------------------

/**
 * The left/right landmark indices an unprefixed joint name resolves to. The
 * evaluator resolves an unprefixed joint to the midpoint of these two indices.
 */
export interface LandmarkPair {
  /** Left-side landmark index (0-based into the 33-landmark array). */
  left: number;
  /** Right-side landmark index (0-based into the 33-landmark array). */
  right: number;
}

/**
 * Maps an unprefixed joint name (e.g. the key `"hip"`) to its left/right
 * landmark indices for bilateral-midpoint resolution.
 */
export type LandmarkPairs = Record<string, LandmarkPair>;

// ---------------------------------------------------------------------------
// Camera framing
// ---------------------------------------------------------------------------

/** Preferred camera framing for the exercise. */
export interface CameraSpec {
  /** Preferred camera angle relative to the user, in degrees. */
  preferredAngleDeg: number;
  /** Acceptable deviation from the preferred angle, in degrees. */
  toleranceDeg: number;
  /** View classification (data-defined value, e.g. side / front). */
  view: string;
}

// ---------------------------------------------------------------------------
// Signal + smoothing
// ---------------------------------------------------------------------------

/**
 * Smoothing filter configuration. `type` names the filter (an unknown filter
 * fails the build in the validator). `minCutoff` and `beta` parameterise the
 * One Euro filter, the default.
 */
export interface SmoothingSpec {
  /** Filter name; an unknown filter is rejected by the validator. */
  type: string;
  /** Minimum cutoff frequency for the One Euro filter. */
  minCutoff: number;
  /** Speed coefficient for the One Euro filter. */
  beta: number;
}

/** The scalar signal expression and its smoothing configuration. */
export interface SignalSpec {
  /** Signal expression in the evaluator grammar, e.g. `angle(hip,knee,ankle)`. */
  expr: string;
  /** Smoothing applied to the raw signal before phase evaluation. */
  smoothing: SmoothingSpec;
}

// ---------------------------------------------------------------------------
// Range of motion
// ---------------------------------------------------------------------------

/** Range-of-motion gate configuration evaluated on rep completion. */
export interface RomSpec {
  /** Where the ROM bounds come from (data-defined value, e.g. calibration). */
  source: string;
  /** Percentile used to derive the ROM floor from calibration. */
  floorPercentile: number;
  /** Tolerance applied to the floor when gating a rep. */
  gateTolerance: number;
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/**
 * A guarded phase transition. Transitions are evaluated in declaration order.
 * `emits` optionally names a domain event fired on this transition; for
 * `reps` mode exactly one transition carries `emits: "RepCompleted"`.
 */
export interface TransitionSpec {
  /** Source phase name; must exist in `PhasesSpec.states`. */
  from: string;
  /** Target phase name; must exist in `PhasesSpec.states`. */
  to: string;
  /** Guard expression in the evaluator grammar. */
  when: string;
  /** Optional domain event name emitted when this transition fires. */
  emits?: string;
}

/** The generic phase-machine definition interpreted by the engine. */
export interface PhasesSpec {
  /** The named phases of the movement. */
  states: string[];
  /** The starting phase; must appear in `states`. */
  initial: string;
  /**
   * Fraction of the observed range the signal must cross past a boundary
   * before a transition is accepted. The validator enforces `>= 0.05`.
   */
  hysteresisPct: number;
  /**
   * Minimum milliseconds a phase must be active before an outgoing transition
   * is accepted. The validator enforces `>= 250`.
   */
  minPhaseDurationMs: number;
  /** Guarded transitions, evaluated in declaration order. */
  transitions: TransitionSpec[];
}

// ---------------------------------------------------------------------------
// Velocity
// ---------------------------------------------------------------------------

/**
 * Optional relative-velocity tracking configuration. The engine reports only
 * relative velocity loss (%); no absolute velocity units are ever exposed.
 */
export interface VelocitySpec {
  /** Expression naming the tracked point, e.g. `midpoint(left_hip,right_hip)`. */
  trackedPoint: string;
  /** Axis along which velocity is measured (data-defined value). */
  axis: string;
  /** Segment used to normalise the displacement (data-defined value). */
  normalizeBy: string;
}

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

/**
 * A phase-scoped fault rule. Evaluated only within its declared `phase`; the
 * engine emits every detected fault without cue rationing (rationing is the
 * Coaching context's job).
 */
export interface FaultSpec {
  /** Fault identifier. */
  id: string;
  /** The phase this fault is evaluated within; must exist in `phases.states`. */
  phase: string;
  /** Guard expression; an `UNAVAILABLE` result suppresses the fault. */
  when: string;
  /** Minimum deviation before the fault is considered triggered. */
  minDeviation: number;
  /** Severity of the fault. */
  severity: FaultSeverity;
  /**
   * Movement-focused cue text. The validator enforces `<= 4` words and a
   * banned-word-free constraint.
   */
  cue: string;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * The parsed shape of one exercise JSON document. This is the in-memory
 * representation the loader produces and the compiler consumes.
 *
 * `velocity` is optional; every other field is required by the schema.
 */
export interface ExerciseSpec {
  /** Stable exercise identifier (data-only; never referenced in TypeScript). */
  id: string;
  /** Spec version; a mismatch with stored calibration invalidates it. */
  version: string;
  /** Human-readable name shown in the exercise grid. */
  displayName: string;
  /** Alternate names used for search/filtering. */
  aliases: string[];
  /** Filterable classification facets. */
  facets: SpecFacets;
  /** Whether the exercise is counted (`reps`) or timed (`hold`). */
  mode: ExerciseMode;
  /** Whether the movement is bilateral (left/right symmetric). */
  bilateral: boolean;
  /** Unprefixed-joint to left/right landmark index mapping. */
  landmarkPairs: LandmarkPairs;
  /** Landmark indices that must be confidently present. */
  requiredLandmarks: number[];
  /** Landmark indices used when available but not required. */
  optionalLandmarks: number[];
  /** Preferred camera framing. */
  camera: CameraSpec;
  /** Signal expression and smoothing. */
  signal: SignalSpec;
  /** Range-of-motion gate configuration. */
  rom: RomSpec;
  /** The phase-machine definition. */
  phases: PhasesSpec;
  /** Optional relative-velocity tracking configuration. */
  velocity?: VelocitySpec;
  /** Phase-scoped fault rules. */
  faults: FaultSpec[];
}
