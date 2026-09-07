/**
 * AnalysisEngine — the load-time compiler and per-frame interpreter that wires
 * the Analysis-context components (expression evaluator, smoothing + dSignal,
 * phase machine, fault evaluator) into one exercise-agnostic engine.
 *
 * ## Two halves
 *
 * 1. {@link compileSpec} — LOAD TIME. Turns a parsed {@link ExerciseSpec} plus
 *    an optional {@link Calibration} into a {@link CompiledSpec}: the signal
 *    expression is parsed and compiled to a closure once, a smoothing filter and
 *    {@link DSignalTracker} are built, a {@link PhaseMachine} is constructed
 *    (with mode, ROM config, and calibration), a {@link FaultEvaluator} is built,
 *    and the spec's descriptive fields are captured into {@link SpecMeta}. All
 *    parsing, allocation, and string work lives here — never in the hot path.
 *
 * 2. {@link AnalysisEngine} — RUN TIME. `load` activates a compiled spec;
 *    `ingest` runs the per-frame flow synchronously and returns the domain
 *    events produced by that frame; `reset` clears all across-frame state.
 *
 * ## Per-frame flow (design "Phase machine interpretation")
 *
 * `ingest(frame)` performs these steps in exactly this order:
 *
 *   1. Evaluate the raw signal expression against the frame (UNAVAILABLE-safe).
 *   2. If the raw signal is `UNAVAILABLE`, push nothing through smoothing; the
 *      phase machine is stepped with an `UNAVAILABLE` signal so it increments its
 *      low-confidence counter and emits no events. Silence when uncertain.
 *   3. Otherwise smooth the raw signal (One Euro) and compute `dSignal` over the
 *      3-frame window from the smoothed series.
 *   4. Assemble the {@link EvalContext} (see below), then step the phase machine.
 *   5. Collect the machine's transition (rep), hold, and stall events.
 *   6. Run the fault evaluator scoped to the machine's CURRENT phase (after the
 *      transition), collecting {@link FaultDetected} events.
 *   7. Return the collected {@link DomainEvent}s (0..n).
 *
 * ## EvalContext assembly
 *
 * A SINGLE {@link EvalContext} object is created once per engine and its fields
 * are MUTATED in place every frame — no per-frame allocation on the hot path.
 * The fields are bound from three sources each frame:
 *
 * - `signal` / `dSignal`: this frame's smoothed signal and windowed rate (both
 *   `UNAVAILABLE` on a low-confidence frame).
 * - `romFloor` / `romTop` / `velocityThreshold`: from the active
 *   {@link Calibration}, or `UNAVAILABLE` when uncalibrated.
 * - `repMinSignal` / `repMaxSignal`: read back from the phase machine's current
 *   rep window (so transition/fault guards see the rep extremes so far).
 * - `phaseElapsedMs`: `frame.t − phaseEnteredAt` for the current phase.
 *
 * The context is populated BEFORE stepping the machine; the machine's guards and
 * the fault guards read the same context object for the frame.
 *
 * ## Frame-not-retained guarantee
 *
 * `ingest` reads from `frame` only during the synchronous call and returns
 * without storing the reference anywhere. The engine keeps no field pointing at
 * a {@link LandmarkFrame}; every value it needs across frames (smoothed signal,
 * dSignal history, rep extremes, timers) is copied into plain numbers held by
 * the filter, tracker, and machine. Frames are transferable and reused via a
 * ring buffer upstream; the engine never retains one beyond `ingest`.
 *
 * ## Calibration version mismatch (Req 6.4)
 *
 * On {@link AnalysisEngine.load}, if the calibration's `version` does not match
 * the compiled spec's `version`, the calibration is INVALIDATED (treated as
 * `null` — the ROM gate is skipped, ROM bound vars are `UNAVAILABLE`) and a
 * recalibration-needed flag is raised, readable via
 * {@link AnalysisEngine.needsRecalibration}. A type error, not a thrown error:
 * the engine keeps running uncalibrated and the session surfaces the prompt.
 *
 * HARD CONSTRAINT: no exercise `id`, name, or alias appears in this file. The
 * spec `id` flows through as runtime data (into {@link SpecMeta.id}); it is
 * never a literal here.
 *
 * Requirements: 1.2, 3.5, 4.4, 6.4
 */

import { compileExpression, type CompiledExpr } from './expression/compile';
import { parseExpression } from './expression/parser';
import { createFaultEvaluator, type FaultEvaluator } from './faultEvaluator';
import { createPhaseMachine, type PhaseMachine } from './phaseMachine';
import {
  createSmoothingFilter,
  DSignalTracker,
  type SmoothingFilter,
} from './smoothing';
import type {
  CameraSpec,
  ExerciseMode,
  ExerciseSpec,
  SpecFacets,
  VelocitySpec,
} from './spec';
import {
  UNAVAILABLE,
  type Calibration,
  type DomainEvent,
  type EvalContext,
  type LandmarkFrame,
  type Signal,
} from './types';

// ---------------------------------------------------------------------------
// CompiledSpec + supporting shapes
// ---------------------------------------------------------------------------

/**
 * The descriptive, non-behavioural fields of a spec, re-projected onto the
 * compiled form so consumers (grid, review, session UX) can read them without
 * touching the raw document. Carries no exercise identity as a literal — the
 * `id`, `displayName`, and `aliases` are runtime data copied from the spec.
 */
export interface SpecMeta {
  /** Stable exercise identifier (runtime data, never a TS literal). */
  readonly id: string;
  /** Spec version; a mismatch with stored calibration invalidates it. */
  readonly version: string;
  /** Human-readable name shown in the exercise grid. */
  readonly displayName: string;
  /** Alternate names used for search / filtering. */
  readonly aliases: readonly string[];
  /** Filterable classification facets. */
  readonly facets: SpecFacets;
  /** Whether the exercise is counted (`reps`) or timed (`hold`). */
  readonly mode: ExerciseMode;
  /** Whether the movement is bilateral (left/right symmetric). */
  readonly bilateral: boolean;
  /** Preferred camera framing. */
  readonly camera: CameraSpec;
  /** Landmark indices that must be confidently present. */
  readonly requiredLandmarks: readonly number[];
}

/**
 * Compiled relative-velocity tracking. The tracked-point expression is compiled
 * once; the axis and normalisation segment are carried verbatim. The engine
 * reports only RELATIVE velocity loss (%) — no absolute velocity units are ever
 * exposed (tech hard rule 2).
 */
export interface CompiledVelocity {
  /** Compiled tracked-point expression (a `midpoint(...)` in practice). */
  readonly trackedPoint: CompiledExpr;
  /** Axis along which velocity is measured (data-defined value). */
  readonly axis: string;
  /** Segment used to normalise the displacement (data-defined value). */
  readonly normalizeBy: string;
}

/**
 * The load-time compilation of one {@link ExerciseSpec}: closure trees + a phase
 * machine + a fault evaluator, ready for the per-frame hot path. Produced by
 * {@link compileSpec}; consumed by {@link AnalysisEngine.load}.
 */
export interface CompiledSpec {
  /** Stable exercise identifier (runtime data). */
  readonly id: string;
  /** Re-projected descriptive fields. */
  readonly meta: SpecMeta;
  /** Compiled signal expression; evaluated once per frame. */
  readonly signal: CompiledExpr;
  /** The generic phase machine, constructed with mode / rom / calibration. */
  readonly machine: PhaseMachine;
  /** The phase-scoped fault evaluator. */
  readonly faults: FaultEvaluator;
  /** Compiled velocity config, or `null` when the spec declares none. */
  readonly velocity: CompiledVelocity | null;
  /** The smoothing filter for the raw signal (One Euro by default). */
  readonly filter: SmoothingFilter;
  /** The windowed rate-of-change tracker feeding `dSignal`. */
  readonly dSignalTracker: DSignalTracker;
}

// ---------------------------------------------------------------------------
// compileSpec — load-time compilation
// ---------------------------------------------------------------------------

/**
 * Compile a parsed {@link ExerciseSpec} into a {@link CompiledSpec}.
 *
 * All parsing, closure compilation, filter construction, and phase-machine
 * setup happen here, ONCE per spec load. The returned compiled form does no
 * parsing or string work per frame.
 *
 * @param spec        the parsed exercise document
 * @param calibration the loaded calibration, or `null` when uncalibrated. The
 *                    phase machine is built with it; the engine re-validates the
 *                    version on {@link AnalysisEngine.load}.
 */
export function compileSpec(
  spec: ExerciseSpec,
  calibration: Calibration | null,
): CompiledSpec {
  const pairs = spec.landmarkPairs;

  // Signal expression: parse to AST then compile to a closure, once.
  const signal = compileExpression(parseExpression(spec.signal.expr), pairs);

  // Smoothing + dSignal for the raw signal series.
  const filter = createSmoothingFilter(spec.signal.smoothing);
  const dSignalTracker = new DSignalTracker();

  // Generic phase machine, driven by the spec's mode, ROM config, calibration.
  const machine = createPhaseMachine(
    spec.phases,
    pairs,
    spec.rom,
    calibration,
    spec.mode,
  );

  // Phase-scoped fault evaluator.
  const faults = createFaultEvaluator(spec.faults, pairs);

  // Optional relative-velocity tracking.
  const velocity = compileVelocity(spec.velocity, pairs);

  const meta: SpecMeta = {
    id: spec.id,
    version: spec.version,
    displayName: spec.displayName,
    aliases: spec.aliases,
    facets: spec.facets,
    mode: spec.mode,
    bilateral: spec.bilateral,
    camera: spec.camera,
    requiredLandmarks: spec.requiredLandmarks,
  };

  return {
    id: spec.id,
    meta,
    signal,
    machine,
    faults,
    velocity,
    filter,
    dSignalTracker,
  };
}

/** Compile the optional velocity config, or return `null` when absent. */
function compileVelocity(
  spec: VelocitySpec | undefined,
  pairs: ExerciseSpec['landmarkPairs'],
): CompiledVelocity | null {
  if (spec === undefined) {
    return null;
  }
  return {
    trackedPoint: compileExpression(parseExpression(spec.trackedPoint), pairs),
    axis: spec.axis,
    normalizeBy: spec.normalizeBy,
  };
}

// ---------------------------------------------------------------------------
// AnalysisEngine — per-frame interpreter
// ---------------------------------------------------------------------------

/** A shared empty result reused on frames that produce no events (no alloc). */
const NO_EVENTS: readonly DomainEvent[] = Object.freeze([]);

/**
 * The Analysis-context engine. Load a {@link CompiledSpec} with
 * {@link AnalysisEngine.load}, then call {@link AnalysisEngine.ingest} once per
 * frame. `ingest` is pure and synchronous, returns the frame's domain events,
 * and never retains the frame reference.
 */
export class AnalysisEngine {
  /** The active compiled spec, or `null` before the first {@link load}. */
  private active: CompiledSpec | null = null;

  /** The active calibration (post-validation), or `null` when uncalibrated. */
  private calibration: Calibration | null = null;

  /**
   * Raised when {@link load} invalidated a calibration whose `version` did not
   * match the spec's. Cleared by a subsequent {@link load} with matching (or
   * absent) calibration, and by {@link reset}. Read via
   * {@link needsRecalibration}.
   */
  private recalibrationNeeded = false;

  /**
   * The single per-frame evaluation context, allocated once and MUTATED in
   * place each frame. Reusing it keeps the hot path allocation-free.
   */
  private readonly ctx: EvalContext = {
    signal: UNAVAILABLE,
    dSignal: UNAVAILABLE,
    romFloor: UNAVAILABLE,
    romTop: UNAVAILABLE,
    velocityThreshold: UNAVAILABLE,
    repMinSignal: UNAVAILABLE,
    repMaxSignal: UNAVAILABLE,
    phaseElapsedMs: UNAVAILABLE,
  };

  /**
   * Activate a compiled spec and its calibration.
   *
   * If `calibration` is non-null and its `version` does not match
   * `spec.meta.version`, the calibration is INVALIDATED: it is treated as `null`
   * (ROM gate skipped, ROM bound vars `UNAVAILABLE`) and {@link
   * needsRecalibration} is set so the session can prompt recalibration (Req 6.4).
   * A matching or absent calibration clears that flag.
   *
   * `load` also resets the spec's across-frame state so the newly loaded spec
   * starts a fresh set.
   */
  load(spec: CompiledSpec, calibration: Calibration | null): void {
    let effective = calibration;
    let mismatch = false;
    if (calibration !== null && calibration.version !== spec.meta.version) {
      // Version mismatch: the calibration was produced against a different spec
      // version and can no longer be trusted. Invalidate it and flag recalibrate.
      effective = null;
      mismatch = true;
    }

    this.active = spec;
    this.calibration = effective;
    this.recalibrationNeeded = mismatch;

    // Point the machine's ROM gate at the (possibly invalidated) calibration and
    // clear all across-frame state for the fresh spec/set.
    spec.machine.setCalibration(effective);
    spec.filter.reset();
    spec.dSignalTracker.reset();
    spec.machine.reset();
  }

  /**
   * Whether the last {@link load} invalidated a version-mismatched calibration
   * and the user should be prompted to recalibrate (Req 6.4).
   */
  needsRecalibration(): boolean {
    return this.recalibrationNeeded;
  }

  /** The current phase of the active machine, or `null` before any load. */
  get currentPhase(): string | null {
    return this.active === null ? null : this.active.machine.currentPhase;
  }

  /**
   * Whether the active set is `lowConfidence` (`> 20%` of frames `UNAVAILABLE`);
   * velocity figures are suppressed for such a set (Req 3.8). `false` before any
   * load.
   */
  isLowConfidence(): boolean {
    return this.active !== null && this.active.machine.isLowConfidence();
  }

  /**
   * Ingest one landmark frame and return the domain events it produced (0..n).
   *
   * PURE and SYNCHRONOUS: no I/O; reads `frame` only during this call and does
   * NOT retain the reference (see the module header's frame-not-retained
   * guarantee). Returns a shared frozen empty array when the frame produced no
   * events, so a quiet frame allocates nothing.
   *
   * @throws never for a well-formed frame; before any {@link load} it returns no
   *         events (the engine is inert until a spec is loaded).
   */
  ingest(frame: LandmarkFrame): readonly DomainEvent[] {
    const spec = this.active;
    if (spec === null) {
      return NO_EVENTS;
    }

    const ctx = this.ctx;
    const t = frame.t;

    // Bind calibration-sourced context fields (same every frame while loaded).
    const calib = this.calibration;
    ctx.romFloor = calib === null ? UNAVAILABLE : calib.romFloor;
    ctx.romTop = calib === null ? UNAVAILABLE : calib.romTop;
    ctx.velocityThreshold =
      calib === null ? UNAVAILABLE : calib.velocityThreshold;

    // Bind the rep-window extremes the machine has accumulated so far, so both
    // transition guards and fault guards read the same rep context this frame.
    ctx.repMinSignal = spec.machine.repMinSignal;
    ctx.repMaxSignal = spec.machine.repMaxSignal;

    // Phase-elapsed time for the current phase (ms). UNAVAILABLE before the
    // machine has anchored an entry time (i.e. before the first stepped frame).
    const enteredAt = spec.machine.currentPhaseEnteredAt;
    ctx.phaseElapsedMs = t - enteredAt;

    // Step 1 — evaluate the raw signal. `ctx.signal`/`ctx.dSignal` are not yet
    // this frame's values, but the signal expression is (in practice) a joint
    // computation that does not read them; bind them defensively to UNAVAILABLE
    // for the raw pass so a stray `signal` reference cannot see a stale value.
    ctx.signal = UNAVAILABLE;
    ctx.dSignal = UNAVAILABLE;
    const raw = spec.signal(frame, ctx);

    let smoothed: Signal;
    let dSignal: Signal;
    if (raw === UNAVAILABLE) {
      // Steps 2 (low-confidence): do not advance smoothing / dSignal state; step
      // the machine with UNAVAILABLE so it counts the low-confidence frame and
      // stays silent. Silence when uncertain.
      smoothed = UNAVAILABLE;
      dSignal = UNAVAILABLE;
    } else {
      // Steps 2–3: smooth the raw signal and compute dSignal from the smoothed
      // series over the 3-frame window.
      const s = spec.filter.filter(raw, t);
      smoothed = s;
      dSignal = spec.dSignalTracker.push(s, t);
    }

    // Publish this frame's signal + rate into the shared context.
    ctx.signal = smoothed;
    ctx.dSignal = dSignal;

    // Step 4 — step the phase machine with the smoothed signal and the context.
    const outcome = spec.machine.step(smoothed, ctx, frame, t);

    // Step 6 — evaluate faults scoped to the machine's CURRENT phase (which may
    // have just changed via the transition). Refresh the rep extremes in the
    // context first: a rep-closing transition opened a new window.
    ctx.repMinSignal = spec.machine.repMinSignal;
    ctx.repMaxSignal = spec.machine.repMaxSignal;
    const faultEvents = spec.faults.evaluate(
      spec.machine.currentPhase,
      frame,
      ctx,
      t,
    );

    // Step 5 + 7 — collect the machine's events and the fault events. Allocate
    // the output array only when at least one event fired.
    const transition = outcome.transition;
    const rep = transition === null ? null : transition.rep;
    const hold = outcome.hold;
    const stalled = outcome.stalled;

    const machineEventCount =
      (rep === null ? 0 : 1) + (hold === null ? 0 : 1) + (stalled === null ? 0 : 1);
    if (machineEventCount === 0 && faultEvents.length === 0) {
      return NO_EVENTS;
    }

    const events: DomainEvent[] = [];
    if (rep !== null) events.push(rep);
    if (hold !== null) events.push(hold);
    if (stalled !== null) events.push(stalled);
    for (let i = 0; i < faultEvents.length; i++) {
      const fault = faultEvents[i];
      if (fault !== undefined) events.push(fault);
    }
    // `frame` is not stored anywhere; it goes out of scope when this returns.
    return events;
  }

  /**
   * Clear all across-frame state so the next frame starts a fresh set: reset the
   * smoothing filter, the dSignal tracker, and the phase machine. Does NOT
   * unload the spec or change the calibration; the recalibration flag is cleared.
   */
  reset(): void {
    const spec = this.active;
    if (spec !== null) {
      spec.filter.reset();
      spec.dSignalTracker.reset();
      spec.machine.reset();
    }
    this.recalibrationNeeded = false;

    // Reset the shared context fields; signal/dSignal are rebound each frame.
    this.ctx.signal = UNAVAILABLE;
    this.ctx.dSignal = UNAVAILABLE;
    this.ctx.romFloor = UNAVAILABLE;
    this.ctx.romTop = UNAVAILABLE;
    this.ctx.velocityThreshold = UNAVAILABLE;
    this.ctx.repMinSignal = UNAVAILABLE;
    this.ctx.repMaxSignal = UNAVAILABLE;
    this.ctx.phaseElapsedMs = UNAVAILABLE;
  }
}

/** Construct a fresh {@link AnalysisEngine}. */
export function createAnalysisEngine(): AnalysisEngine {
  return new AnalysisEngine();
}
