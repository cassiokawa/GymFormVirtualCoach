/**
 * Analysis bounded-context types — the Exercise Spec Engine core contracts.
 *
 * This is the canonical Analysis context. It depends on nothing outward: it
 * consumes {@link LandmarkFrame} (published by Capture) and publishes
 * {@link DomainEvent}s. It knows nothing about UI, audio, storage, or exercise
 * *names* — exercises are data only (`src/domain/exercises/**` /*.json`).
 *
 * HARD CONSTRAINT: no exercise `id`, name, or alias appears in this file or in
 * any other `src/**` /*.ts`. These types are exercise-agnostic by construction.
 *
 * Requirements: 1.1, 4.4, 3.6, 3.7
 */

import type { Keypoint } from '../../types/index';

// Re-export Keypoint so Analysis-context consumers have a single import surface
// for landmark data without reaching across contexts for the primitive shape.
export type { Keypoint };

// ---------------------------------------------------------------------------
// Landmark frame (input from Capture)
// ---------------------------------------------------------------------------

/** Number of pose landmarks per frame (MediaPipe Pose indices 0–32). */
export const LANDMARK_COUNT = 33;

/**
 * A single frame of pose landmarks handed to the engine by the Capture context.
 *
 * `points` is a flat, packed array of `LANDMARK_COUNT × 3` values laid out as
 * `[x0, y0, z0, x1, y1, z1, …]`, normalised. `visibility` and `presence` each
 * carry one value per landmark.
 *
 * Frames are transferable and reused via a ring buffer; the engine never
 * retains a frame beyond the `ingest` call.
 */
export interface LandmarkFrame {
  /** Capture timestamp in milliseconds. */
  t: number;
  /** Flat `33 × (x, y, z)` normalised coordinates. */
  points: Float32Array;
  /** Per-landmark visibility score `[0, 1]`, length `33`. */
  visibility: Float32Array;
  /** Per-landmark presence score `[0, 1]`, length `33`. */
  presence: Float32Array;
}

// ---------------------------------------------------------------------------
// Signal + UNAVAILABLE sentinel
// ---------------------------------------------------------------------------

/**
 * Sentinel result meaning a value could not be computed with confidence.
 *
 * `UNAVAILABLE` propagates: any arithmetic with it yields `UNAVAILABLE`; any
 * comparison with it yields `false`. Silence when uncertain.
 */
export const UNAVAILABLE: unique symbol = Symbol('UNAVAILABLE');

/** A scalar signal value, or the {@link UNAVAILABLE} sentinel. */
export type Signal = number | typeof UNAVAILABLE;

// ---------------------------------------------------------------------------
// Evaluation context (bound variables for the expression evaluator)
// ---------------------------------------------------------------------------

/**
 * The bound variables available to a compiled expression during a single
 * per-frame evaluation. All fields are `Signal` so `UNAVAILABLE` propagates
 * uniformly through the evaluator.
 */
export interface EvalContext {
  /** Current smoothed signal value. */
  signal: Signal;
  /** Rate of change of the signal over the 3-frame window. */
  dSignal: Signal;
  /** Calibrated range-of-motion floor. */
  romFloor: Signal;
  /** Calibrated range-of-motion top. */
  romTop: Signal;
  /** Relative velocity threshold for set termination / velocity gating. */
  velocityThreshold: Signal;
  /** Minimum signal value observed so far within the current rep. */
  repMinSignal: Signal;
  /** Maximum signal value observed so far within the current rep. */
  repMaxSignal: Signal;
  /** Time elapsed in the current phase, in milliseconds. */
  phaseElapsedMs: Signal;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * Per-user calibration consumed by the engine. A `version` mismatch against a
 * spec invalidates the calibration and prompts recalibration.
 */
export interface Calibration {
  /** Calibrated range-of-motion floor. */
  romFloor: number;
  /** Calibrated range-of-motion top. */
  romTop: number;
  /** Relative velocity threshold. */
  velocityThreshold: number;
  /** Spec version this calibration was produced against. */
  version: string;
}

// ---------------------------------------------------------------------------
// Domain events (output published by the engine)
// ---------------------------------------------------------------------------

/** Severity of a detected fault. Rationing is the Coaching context's job. */
export type FaultSeverity = 'info' | 'warning' | 'critical';

/**
 * Emitted when a full movement cycle completes. Consumed by Coaching (tone),
 * Session UX (count), and Autoregulation.
 */
export interface RepCompleted {
  type: 'RepCompleted';
  /** Capture timestamp of the frame that closed the rep, in milliseconds. */
  t: number;
  /** 1-based index of this rep within the current set. */
  repNumber: number;
  /** Time under tension for this rep, in milliseconds. */
  tutMs: number;
  /** Minimum signal value observed during the rep. */
  minSignal: number;
  /** Maximum signal value observed during the rep. */
  maxSignal: number;
  /** True when the rep satisfied the ROM gate (`romFloor` + `gateTolerance`). */
  romGatePassed: boolean;
}

/**
 * Emitted when a phase-scoped fault guard evaluates true with confident
 * landmarks. The engine emits every detected fault without cue rationing.
 */
export interface FaultDetected {
  type: 'FaultDetected';
  /** Capture timestamp of the emitting frame, in milliseconds. */
  t: number;
  /** Fault identifier declared in the spec. */
  faultId: string;
  /** The phase active at the moment of emission. */
  phase: string;
  /** Severity of the detected fault. */
  severity: FaultSeverity;
  /** Movement-focused cue text (≤ 4 words, banned-word-free by validation). */
  cue: string;
}

/**
 * Emitted at 1 Hz while accumulating time in the target phase of a hold-mode
 * exercise. Consumed by Session UX.
 */
export interface HoldProgressed {
  type: 'HoldProgressed';
  /** Capture timestamp of the emitting frame, in milliseconds. */
  t: number;
  /** Whole seconds of hold accumulated so far in the target phase. */
  elapsedSeconds: number;
}

/**
 * Emitted when the current phase remains unchanged beyond the stall threshold
 * in `reps` mode. Consumed by Session UX to surface "not detecting movement".
 */
export interface AnalysisStalled {
  type: 'AnalysisStalled';
  /** Capture timestamp of the emitting frame, in milliseconds. */
  t: number;
  /** The phase the machine has been stuck in. */
  phase: string;
  /** How long the phase has been unchanged, in milliseconds. */
  stalledMs: number;
}

/** The discriminated union of every event the Analysis context publishes. */
export type DomainEvent =
  | RepCompleted
  | FaultDetected
  | HoldProgressed
  | AnalysisStalled;
