/**
 * Generic phase-machine interpreter (Analysis context).
 *
 * A {@link PhasesSpec} describes a movement as a finite state machine: named
 * phases, an initial phase, and guarded transitions evaluated in declaration
 * order. This module compiles that spec into a runnable machine and steps it
 * one frame at a time, producing a transition when — and only when — a guard is
 * satisfied *and* the two exercise-agnostic gates below both allow it.
 *
 * This file implements design "Phase machine interpretation" steps 1 and 4–7,
 * the hold-mode `HoldProgressed` cadence, stall detection, and the raw
 * low-confidence tracking that backs the >20%-of-set decision (task 7.3). It
 * deliberately does NOT smooth the signal or compute `dSignal` (that is
 * `smoothing.ts`, upstream).
 *
 * The API is structured so those slot in around it: {@link PhaseMachine.step}
 * takes the *already smoothed* signal plus a fully-populated {@link EvalContext}
 * and returns a {@link StepOutcome} carrying the accepted transition (with its
 * `emits` marker and — on the rep-closing transition — the assembled
 * {@link RepCompleted} event) plus any {@link HoldProgressed} / {@link
 * AnalysisStalled} event produced this frame. The caller/engine publishes the
 * events that are present.
 *
 * ## Exercise mode (Req 3.6, 3.7)
 *
 * The machine is constructed with the exercise {@link ExerciseMode}:
 *
 * - `reps` (default): transitions produce reps; a phase stuck too long emits
 *   {@link AnalysisStalled}.
 * - `hold`: time accumulates while the machine sits in the hold phase and a
 *   {@link HoldProgressed} event is emitted once per whole elapsed second.
 *
 * ### Which phase is the "hold" phase (Req 3.6)
 *
 * The spec does not tag a phase as the hold target, so the machine adopts a
 * total, spec-shape-independent rule: **the hold phase is any phase that is not
 * the `initial` phase.** A hold movement starts in an entry/settle phase
 * (`initial`, e.g. a "SETUP" or "STANDING" state) and transitions into the held
 * position; time accrues only while the machine sits in a non-initial phase.
 * When there is exactly one non-initial phase this is precisely the held
 * position; with several it is the union of all "engaged" phases, which is the
 * right behaviour for a hold that is subdivided (e.g. entry → hold → drift).
 * Time accumulation *pauses* whenever the machine sits in `initial` (the user
 * has left the hold) and *resumes* — continuing the same running total — when a
 * non-initial phase is re-entered, so brief lapses do not reset the clock. A
 * {@link reset} (new set) clears the total.
 *
 * ### Hold cadence (Req 3.6)
 *
 * `HoldProgressed` fires at 1 Hz: on the frame that first pushes the accumulated
 * hold time past each whole-second boundary, exactly one event is emitted
 * carrying that whole second (`1`, then `2`, …). Between boundaries no event is
 * emitted, and no event is emitted while paused in `initial`. Over a hold of
 * `S` whole seconds this yields exactly `S` events (Property 9).
 *
 * ### Stall detection (Req 3.7)
 *
 * In `reps` mode, if the current phase remains unchanged for more than
 * {@link STALL_THRESHOLD_MS} (30 s), the machine emits a single
 * {@link AnalysisStalled} event carrying the stuck phase and how long it has
 * been unchanged. It is emitted **once per stall episode**: after firing, the
 * machine arms a latch that suppresses further stall events until the phase
 * actually changes (a transition re-arms it). This avoids spamming a stall
 * event on every subsequent frame. Hold mode never stalls (a long hold is the
 * point).
 *
 * ### Low-confidence set (Req 3.8)
 *
 * The machine counts total stepped frames and `UNAVAILABLE` frames since the
 * last reset. {@link PhaseMachine.isLowConfidence} is `true` once the
 * `UNAVAILABLE` fraction **exceeds** {@link LOW_CONFIDENCE_THRESHOLD} (20%) of
 * the set; {@link PhaseMachine.suppressVelocity} mirrors it (a low-confidence
 * set suppresses velocity figures). The ratio is exposed via
 * {@link PhaseMachine.lowConfidenceRatio} for callers that want the raw figure.
 *
 * ## Rep records and the ROM gate (Req 3.5, design step 7)
 *
 * The machine tracks per-rep aggregates across the *rep window* — the span of
 * frames from the start of a rep to the frame that closes it via the
 * `emits: "RepCompleted"` transition:
 *
 * - `repNumber`: 1-based, incremented as each rep completes;
 * - `repStartT`: the timestamp the current rep window opened, so time under
 *   tension is `tutMs = t − repStartT`;
 * - `repMinSignal` / `repMaxSignal`: the extremes of the smoothed signal seen
 *   within the current rep window. These are also exposed (see
 *   {@link PhaseMachine.repMinSignal} / {@link PhaseMachine.repMaxSignal}) so
 *   the engine can feed them back into the {@link EvalContext} that fault and
 *   transition guards read (`repMinSignal`, `repMaxSignal` bound vars).
 *
 * When the rep-closing transition fires, the machine assembles a
 * {@link RepCompleted} event and evaluates the ROM gate.
 *
 * ### ROM gate direction convention
 *
 * The signal convention across the engine is **lower = deeper** (a smaller
 * signal means the user reached further into the movement's range; e.g. a
 * squat's knee angle is smallest at the bottom). This matches the design's
 * `shallow_depth` fault guard `repMinSignal > romFloor * 1.15`, which flags a
 * rep as too shallow precisely when its deepest point stayed *above* the floor.
 *
 * Mirroring that, a rep **passes** the ROM gate when its deepest point reached
 * the calibrated floor within tolerance:
 *
 * > `romGatePassed = repMinSignal <= romFloor * (1 + gateTolerance)`
 *
 * `gateTolerance` (from {@link RomSpec}) widens the accepted band above the
 * floor: `gateTolerance = 0.15` accepts a rep whose deepest point is within 15%
 * of the floor. `romFloor` comes from the loaded {@link Calibration}.
 *
 * When calibration is `null` (uncalibrated), the ROM gate is **skipped** and
 * `romGatePassed` defaults to `true`: with no floor to measure against there is
 * no principled way to fail a rep, and the safe default is to count it.
 *
 * ## The two gates (both must pass for a transition to fire)
 *
 * ### 1. Hysteresis band (Req 3.3)
 *
 * A boolean guard alone flips the instant the signal grazes a boundary, so
 * sensor jitter around that boundary produces phantom transitions (and, for the
 * rep-closing transition, phantom reps). The design requires the signal to
 * "cross the boundary by `hysteresisPct` times the observed range" before a
 * transition is accepted.
 *
 * The evaluator's guards are *booleans over a continuous signal* (e.g.
 * `signal < romFloor`), not raw boundary constants the machine can see. So the
 * band is applied to the **signal's own displacement since the current phase was
 * entered**, which is the principled, guard-shape-independent reading of "how
 * far past the boundary the signal has travelled":
 *
 * > A transition fires only if its guard is satisfied AND the signal has moved
 * > at least `hysteresisPct × observedRange` away from the signal value at which
 * > the current phase was entered.
 *
 * `observedRange = observedMax − observedMin`, accumulated across the run from
 * every valid signal sample (this is the movement's realised amplitude, the
 * same quantity ROM calibration works from). Requiring displacement past the
 * phase-entry signal means a guard that is already true the instant a phase is
 * entered (common when phases share a boundary) cannot immediately re-fire on
 * noise — the signal must genuinely travel a fraction of the movement's range
 * first. This is consistent with the design's continuous-signal model and needs
 * no knowledge of the guard's internal boundary constant.
 *
 * Until a range has been observed (`observedRange` is 0, e.g. the very first
 * frames), the band is 0 and only the guard gates the transition; there is no
 * amplitude yet against which a fraction is meaningful.
 *
 * ### 2. Minimum phase duration (Req 3.4)
 *
 * Independently, a transition is rejected while the source phase has been active
 * for less than `minPhaseDurationMs` (`t − phaseEnteredAt`). This is a hard
 * floor on phase dwell time that suppresses ultra-fast oscillation regardless of
 * amplitude.
 *
 * ### UNAVAILABLE (Req 3.1)
 *
 * When the signal is `UNAVAILABLE`, {@link PhaseMachine.step} increments a
 * low-confidence counter and returns no transition for that frame. Silence when
 * uncertain. (Assembling the >20%-of-set `lowConfidence` decision is task 7.3;
 * this counter is the raw input to it.)
 *
 * Pure and stateful-across-frames; allocation-conscious (guards are compiled
 * once at construction, transitions are grouped once, and `step` allocates only
 * the events it actually emits). No exercise `id`, name, or alias appears in
 * this file.
 *
 * Requirements: 3.1, 3.3, 3.4, 3.6, 3.7, 3.8
 */

import { compileExpression, type CompiledExpr } from './expression/compile';
import { parseExpression } from './expression/parser';
import type { ExerciseMode, LandmarkPairs, PhasesSpec, RomSpec, TransitionSpec } from './spec';
import {
  UNAVAILABLE,
  type AnalysisStalled,
  type Calibration,
  type EvalContext,
  type HoldProgressed,
  type LandmarkFrame,
  type RepCompleted,
  type Signal,
} from './types';

/**
 * A transition with its guard compiled to a closure. Grouped under its `from`
 * phase and evaluated in the order it was declared in the spec.
 */
interface CompiledTransition {
  /** The originating spec transition (carries `to`, `emits`, etc.). */
  readonly spec: TransitionSpec;
  /** Compiled `when` guard; non-zero (truthy) means the guard is satisfied. */
  readonly guard: CompiledExpr;
}

/**
 * A fired transition and, when it closes a rep, the assembled event.
 *
 * `transition` is the accepted {@link TransitionSpec} (carrying `to`, `emits`,
 * etc.). `rep` is the fully-populated {@link RepCompleted} event, present only
 * when the fired transition carries `emits: "RepCompleted"`; the engine
 * publishes it verbatim. On every other transition `rep` is `null`.
 */
export interface StepTransition {
  /** The accepted spec transition (the engine acts on its `emits` marker). */
  readonly transition: TransitionSpec;
  /** The assembled rep event, or `null` when this transition closed no rep. */
  readonly rep: RepCompleted | null;
}

/**
 * The full outcome of stepping the machine for one frame.
 *
 * A single frame can produce, independently, a phase transition (with an
 * optional rep event), a {@link HoldProgressed} event (hold mode, at a
 * whole-second boundary), and an {@link AnalysisStalled} event (reps mode, on
 * the frame the stall threshold is first crossed). Each field is `null` when
 * that kind of event was not produced this frame; the engine collects whichever
 * are present into its `DomainEvent[]` output.
 *
 * `step` always returns a {@link StepOutcome} (never `null`); the
 * "no transition fired" case is `transition === null`.
 */
export interface StepOutcome {
  /**
   * The accepted transition and its rep event, or `null` when no transition
   * fired this frame (guard unsatisfied, gated out, or `UNAVAILABLE` signal).
   */
  readonly transition: StepTransition | null;
  /** A hold-progress event when a whole-second boundary was crossed, else `null`. */
  readonly hold: HoldProgressed | null;
  /** A stall event when the stall threshold was first crossed, else `null`. */
  readonly stalled: AnalysisStalled | null;
}

/** The spec `emits` marker that closes a rep and triggers the ROM gate. */
const REP_COMPLETED_EMIT = 'RepCompleted';

/**
 * Milliseconds a phase may remain unchanged in `reps` mode before the machine
 * emits {@link AnalysisStalled}. Design: "Phase stuck > 30 s in mode reps".
 */
export const STALL_THRESHOLD_MS = 30_000;

/**
 * Fraction of a set's frames that may be `UNAVAILABLE` before the set is marked
 * `lowConfidence`. Design: "Signal UNAVAILABLE > 20% of a set". The set is
 * low-confidence when the ratio strictly **exceeds** this value.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.2;

/** One whole second in milliseconds — the {@link HoldProgressed} cadence. */
const ONE_SECOND_MS = 1000;

/** An outcome with no events of any kind (the common per-frame result). */
const EMPTY_OUTCOME: StepOutcome = { transition: null, hold: null, stalled: null };

/** True when a {@link Signal} is a usable finite number (not `UNAVAILABLE`). */
function isNum(s: Signal): s is number {
  return s !== UNAVAILABLE;
}

/**
 * A generic, spec-driven phase machine.
 *
 * Construct once per loaded spec (guards compile at construction). Then call
 * {@link step} once per frame with the smoothed signal and the evaluation
 * context. Call {@link reset} to start a fresh set.
 */
export class PhaseMachine {
  /** Transitions grouped by source phase, each group in declaration order. */
  private readonly byFrom: ReadonlyMap<string, readonly CompiledTransition[]>;

  private readonly initial: string;
  private readonly hysteresisPct: number;
  private readonly minPhaseDurationMs: number;

  /** Whether this exercise is counted (`reps`) or timed (`hold`). */
  private readonly mode: ExerciseMode;

  /** ROM-gate configuration (`gateTolerance`) from the spec. */
  private readonly rom: RomSpec;
  /** Loaded calibration, or `null` when uncalibrated (gate skipped). */
  private calibration: Calibration | null;

  // --- state across frames ---

  /** The phase the machine is currently in. */
  private current: string;
  /** Capture timestamp (ms) at which {@link current} was entered. */
  private phaseEnteredAt: number;
  /** Smoothed signal value at which {@link current} was entered, if known. */
  private phaseEntrySignal: Signal = UNAVAILABLE;
  /** Whether any frame has been stepped since construction / reset. */
  private started = false;

  /** Smallest valid signal observed since the last reset. */
  private observedMin = 0;
  /** Largest valid signal observed since the last reset. */
  private observedMax = 0;
  /** Whether any valid signal has been observed (guards the range). */
  private hasObserved = false;

  /** Count of frames whose signal was `UNAVAILABLE` since the last reset. */
  private lowConfidenceFrames = 0;
  /** Count of all frames stepped since the last reset (the low-conf denominator). */
  private totalFrames = 0;

  // --- hold-mode accumulation (Req 3.6) ---

  /**
   * Milliseconds accumulated while the machine has sat in a non-initial (held)
   * phase since the last reset. Paused — not reset — while in `initial`.
   */
  private holdMs = 0;
  /** Whole seconds of hold already reported via {@link HoldProgressed}. */
  private holdSecondsEmitted = 0;
  /** Timestamp (ms) of the previous stepped valid frame, for hold dt; `null` before any. */
  private lastFrameT: number | null = null;

  // --- stall detection (Req 3.7) ---

  /**
   * Whether an {@link AnalysisStalled} event has already been emitted for the
   * current stall episode. Set on emit, cleared on any phase change so the next
   * stall in a new phase can fire once. Prevents per-frame spam.
   */
  private stallArmed = false;

  // --- per-rep window aggregates ---

  /** Number of reps completed since the last reset (1-based when reported). */
  private repCount = 0;
  /** Timestamp (ms) the current rep window opened; `tutMs = t − repStart`. */
  private repStartT = 0;
  /** Smallest smoothed signal observed within the current rep window. */
  private repMin: Signal = UNAVAILABLE;
  /** Largest smoothed signal observed within the current rep window. */
  private repMax: Signal = UNAVAILABLE;

  /**
   * @param phases the phase-machine definition to interpret
   * @param pairs  the spec's landmark-pair map (for guard joint resolution)
   * @param rom    the spec's ROM-gate configuration (`gateTolerance`)
   * @param calibration the loaded calibration, or `null` when uncalibrated
   *                    (the ROM gate is skipped and `romGatePassed` is `true`)
   * @param mode   the exercise mode; `reps` (default) counts reps and detects
   *               stalls, `hold` accumulates time and emits `HoldProgressed`
   */
  constructor(
    phases: PhasesSpec,
    pairs: LandmarkPairs,
    rom: RomSpec,
    calibration: Calibration | null = null,
    mode: ExerciseMode = 'reps',
  ) {
    this.initial = phases.initial;
    this.hysteresisPct = phases.hysteresisPct;
    this.minPhaseDurationMs = phases.minPhaseDurationMs;
    this.mode = mode;
    this.rom = rom;
    this.calibration = calibration;

    // Group transitions by their source phase, preserving declaration order.
    const byFrom = new Map<string, CompiledTransition[]>();
    for (const t of phases.transitions) {
      const compiled: CompiledTransition = {
        spec: t,
        guard: compileExpression(parseExpression(t.when), pairs),
      };
      const group = byFrom.get(t.from);
      if (group) {
        group.push(compiled);
      } else {
        byFrom.set(t.from, [compiled]);
      }
    }
    this.byFrom = byFrom;

    this.current = this.initial;
    this.phaseEnteredAt = 0;
  }

  /**
   * Set (or replace) the calibration the ROM gate reads. Passing `null` skips
   * the gate so completed reps report `romGatePassed: true`. Used by the engine
   * on `load` and when a spec-version mismatch invalidates calibration.
   */
  setCalibration(calibration: Calibration | null): void {
    this.calibration = calibration;
  }

  /** The phase the machine is currently in. */
  get currentPhase(): string {
    return this.current;
  }

  /**
   * Smallest smoothed signal seen so far in the current rep window, or
   * `UNAVAILABLE` before the window has seen a valid frame. The engine copies
   * this into `EvalContext.repMinSignal` so guards can read it.
   */
  get repMinSignal(): Signal {
    return this.repMin;
  }

  /**
   * Largest smoothed signal seen so far in the current rep window, or
   * `UNAVAILABLE` before the window has seen a valid frame. The engine copies
   * this into `EvalContext.repMaxSignal` so guards can read it.
   */
  get repMaxSignal(): Signal {
    return this.repMax;
  }

  /** Number of reps completed since the last reset. */
  get completedReps(): number {
    return this.repCount;
  }

  /** Capture timestamp (ms) at which the current phase was entered. */
  get currentPhaseEnteredAt(): number {
    return this.phaseEnteredAt;
  }

  /**
   * Number of frames whose signal was `UNAVAILABLE` since the last reset (the
   * raw numerator of the >20%-of-set low-confidence decision).
   */
  get lowConfidenceFrameCount(): number {
    return this.lowConfidenceFrames;
  }

  /** Total number of frames stepped since the last reset (low-conf denominator). */
  get totalFrameCount(): number {
    return this.totalFrames;
  }

  /**
   * Fraction of the set's frames that were `UNAVAILABLE` (`0` when no frame has
   * been stepped yet). The raw figure behind {@link isLowConfidence}.
   */
  get lowConfidenceRatio(): number {
    return this.totalFrames === 0 ? 0 : this.lowConfidenceFrames / this.totalFrames;
  }

  /**
   * Whether the current set is `lowConfidence`: `true` once the `UNAVAILABLE`
   * fraction strictly exceeds {@link LOW_CONFIDENCE_THRESHOLD} (20%) of the set.
   * Empty and mostly-confident sets are `false`.
   */
  isLowConfidence(): boolean {
    return this.lowConfidenceRatio > LOW_CONFIDENCE_THRESHOLD;
  }

  /**
   * Whether velocity figures should be suppressed for this set. A low-confidence
   * set suppresses velocity (Req 3.8); this mirrors {@link isLowConfidence}.
   */
  suppressVelocity(): boolean {
    return this.isLowConfidence();
  }

  /** Whole seconds of hold accumulated in the held phase since the last reset. */
  get holdElapsedSeconds(): number {
    return Math.floor(this.holdMs / ONE_SECOND_MS);
  }

  /** Observed signal range (`max − min`) since the last reset; `0` if none. */
  get observedRange(): number {
    return this.hasObserved ? this.observedMax - this.observedMin : 0;
  }

  /**
   * Step the machine one frame.
   *
   * @param signal the *smoothed* signal for this frame (may be `UNAVAILABLE`)
   * @param ctx    the fully-populated evaluation context (guards read `signal`,
   *               `dSignal`, `romFloor`, `phaseElapsedMs`, etc. from here)
   * @param frame  the landmark frame (guards may resolve joints from it)
   * @param t      capture timestamp of this frame, in milliseconds
   * @returns a {@link StepOutcome} with any transition, hold, and stall events
   */
  step(signal: Signal, ctx: EvalContext, frame: LandmarkFrame, t: number): StepOutcome {
    // On the first frame, anchor the initial phase's entry time/signal so the
    // min-duration and hysteresis gates measure from a real origin.
    if (!this.started) {
      this.started = true;
      this.phaseEnteredAt = t;
      this.phaseEntrySignal = signal;
      // The first rep window opens with the first stepped frame.
      this.repStartT = t;
    }

    // Every stepped frame counts toward the set total (the low-confidence
    // denominator), valid or not.
    this.totalFrames += 1;

    // Advance timers that run on wall-clock regardless of signal validity: the
    // hold accumulator (Req 3.6) and, in reps mode, stall detection (Req 3.7).
    // A dropped frame does not stop the clock; the phase simply cannot change.
    const hold = this.advanceHold(t);
    const stalled = this.detectStall(t);

    // Step 1 — silence when uncertain. Do not advance range or evaluate guards.
    if (!isNum(signal)) {
      this.lowConfidenceFrames += 1;
      return this.outcome(null, hold, stalled);
    }

    // Maintain the observed range from every valid sample.
    if (!this.hasObserved) {
      this.hasObserved = true;
      this.observedMin = signal;
      this.observedMax = signal;
    } else {
      if (signal < this.observedMin) this.observedMin = signal;
      if (signal > this.observedMax) this.observedMax = signal;
    }

    // Maintain the per-rep window extremes from every valid sample. These feed
    // the ROM gate on rep completion and are exposed for the guard context.
    if (!isNum(this.repMin) || signal < this.repMin) this.repMin = signal;
    if (!isNum(this.repMax) || signal > this.repMax) this.repMax = signal;

    // If the phase was entered on an UNAVAILABLE frame, adopt the first valid
    // signal we see in it as the entry anchor for the hysteresis band.
    if (!isNum(this.phaseEntrySignal)) {
      this.phaseEntrySignal = signal;
    }

    // Step 6 — minimum phase duration. A hard dwell-time floor, checked before
    // guards so an ultra-fast oscillation is rejected regardless of amplitude.
    const phaseAgeMs = t - this.phaseEnteredAt;
    if (phaseAgeMs < this.minPhaseDurationMs) {
      return this.outcome(null, hold, stalled);
    }

    const group = this.byFrom.get(this.current);
    if (group === undefined) {
      return this.outcome(null, hold, stalled);
    }

    // Hysteresis band: the signal must have travelled this far from the
    // phase-entry signal (in either direction) before any transition fires.
    const band = this.hysteresisPct * this.observedRange;
    const entry = this.phaseEntrySignal;
    const displacement = isNum(entry) ? Math.abs(signal - entry) : Infinity;
    const bandSatisfied = band <= 0 || displacement >= band;

    // Steps 4–5 — evaluate outgoing transitions in declaration order; the first
    // whose guard is satisfied AND that clears the hysteresis band wins.
    for (const transition of group) {
      const guardValue = transition.guard(frame, ctx);
      // Guards are comparisons: 1/truthy = satisfied, 0/UNAVAILABLE = not.
      const guardSatisfied = isNum(guardValue) && guardValue !== 0;
      if (!guardSatisfied) {
        continue;
      }
      if (!bandSatisfied) {
        // Guard holds but the signal has not travelled far enough yet: reject
        // this frame's transition (premature — likely jitter at the boundary).
        continue;
      }
      // Accept: enter the target phase and re-anchor entry time/signal.
      const changingPhase = transition.spec.to !== this.current;
      this.current = transition.spec.to;
      this.phaseEnteredAt = t;
      this.phaseEntrySignal = signal;
      // A phase change re-arms stall detection for the newly entered phase.
      if (changingPhase) {
        this.stallArmed = false;
      }

      // Step 7 — on the rep-closing transition, assemble the rep record and
      // evaluate the ROM gate, then open a fresh rep window.
      if (transition.spec.emits === REP_COMPLETED_EMIT) {
        const rep = this.assembleRep(t, signal);
        this.openNextRepWindow(t, signal);
        return this.outcome({ transition: transition.spec, rep }, hold, stalled);
      }

      return this.outcome({ transition: transition.spec, rep: null }, hold, stalled);
    }

    return this.outcome(null, hold, stalled);
  }

  /**
   * Advance the hold accumulator and, when a whole-second boundary is crossed,
   * assemble the {@link HoldProgressed} event (Req 3.6).
   *
   * In `reps` mode this is a no-op (returns `null`). In `hold` mode time accrues
   * only while the machine sits in a non-initial (held) phase; sitting in
   * `initial` pauses — but does not reset — the running total. The `dt` is the
   * gap since the previous stepped frame, so the clock survives dropped frames.
   * At most one event is emitted per step (frames step faster than 1 Hz); the
   * event carries the newly reached whole second.
   */
  private advanceHold(t: number): HoldProgressed | null {
    const prevT = this.lastFrameT;
    this.lastFrameT = t;

    if (this.mode !== 'hold') {
      return null;
    }

    // Accrue time only while in a held (non-initial) phase, and only once we
    // have a previous frame to measure the gap from.
    if (prevT !== null && this.current !== this.initial) {
      const dt = t - prevT;
      if (dt > 0) {
        this.holdMs += dt;
      }
    }

    const whole = Math.floor(this.holdMs / ONE_SECOND_MS);
    if (whole > this.holdSecondsEmitted) {
      // Emit one event per step; report the newly reached whole second. (Frames
      // are far faster than 1 Hz, so a single step never skips a second.)
      this.holdSecondsEmitted += 1;
      return {
        type: 'HoldProgressed',
        t,
        elapsedSeconds: this.holdSecondsEmitted,
      };
    }
    return null;
  }

  /**
   * Detect a stall (Req 3.7): in `reps` mode, if the current phase has been
   * unchanged for more than {@link STALL_THRESHOLD_MS}, emit one
   * {@link AnalysisStalled} event for this episode. The {@link stallArmed} latch
   * suppresses repeats until the phase changes; hold mode never stalls.
   */
  private detectStall(t: number): AnalysisStalled | null {
    if (this.mode !== 'reps' || this.stallArmed) {
      return null;
    }
    const stalledMs = t - this.phaseEnteredAt;
    if (stalledMs > STALL_THRESHOLD_MS) {
      this.stallArmed = true;
      return {
        type: 'AnalysisStalled',
        t,
        phase: this.current,
        stalledMs,
      };
    }
    return null;
  }

  /**
   * Assemble a {@link StepOutcome}, reusing the shared empty instance when no
   * event of any kind fired this frame so the common path allocates nothing.
   */
  private outcome(
    transition: StepTransition | null,
    hold: HoldProgressed | null,
    stalled: AnalysisStalled | null,
  ): StepOutcome {
    if (transition === null && hold === null && stalled === null) {
      return EMPTY_OUTCOME;
    }
    return { transition, hold, stalled };
  }

  /**
   * Assemble the {@link RepCompleted} event for the rep that just closed and
   * evaluate the ROM gate. `closeT` is the timestamp of the closing frame and
   * `closeSignal` its smoothed value (already folded into the rep extremes).
   *
   * Time under tension is `closeT − repStartT`. The rep's min/max are the
   * window extremes; if the window somehow saw no valid frame the closing
   * signal stands in for both so the event carries real numbers, never
   * `UNAVAILABLE` (the {@link RepCompleted} contract is numeric).
   */
  private assembleRep(closeT: number, closeSignal: number): RepCompleted {
    const repNumber = this.repCount + 1;
    this.repCount = repNumber;

    const minSignal = isNum(this.repMin) ? this.repMin : closeSignal;
    const maxSignal = isNum(this.repMax) ? this.repMax : closeSignal;

    return {
      type: 'RepCompleted',
      t: closeT,
      repNumber,
      tutMs: closeT - this.repStartT,
      minSignal,
      maxSignal,
      romGatePassed: this.evalRomGate(minSignal),
    };
  }

  /**
   * Evaluate the ROM gate for a rep whose deepest point was `minSignal`.
   *
   * Convention: lower signal = deeper. The rep passes when its deepest point
   * reached the calibrated floor within tolerance:
   * `minSignal <= romFloor * (1 + gateTolerance)`. When calibration is `null`
   * there is no floor to gate against, so the gate is skipped (passes).
   */
  private evalRomGate(minSignal: number): boolean {
    if (this.calibration === null) {
      return true;
    }
    const threshold = this.calibration.romFloor * (1 + this.rom.gateTolerance);
    return minSignal <= threshold;
  }

  /** Open a fresh rep window anchored at the closing frame. */
  private openNextRepWindow(t: number, signal: number): void {
    this.repStartT = t;
    this.repMin = signal;
    this.repMax = signal;
  }

  /** Clear all across-frame state so the next frame starts a fresh set. */
  reset(): void {
    this.current = this.initial;
    this.phaseEnteredAt = 0;
    this.phaseEntrySignal = UNAVAILABLE;
    this.started = false;
    this.observedMin = 0;
    this.observedMax = 0;
    this.hasObserved = false;
    this.lowConfidenceFrames = 0;
    this.totalFrames = 0;
    // Hold accumulation: back to zero with nothing emitted and no last frame.
    this.holdMs = 0;
    this.holdSecondsEmitted = 0;
    this.lastFrameT = null;
    // Stall latch: re-armed so a fresh set can stall once.
    this.stallArmed = false;
    // Per-rep window: back to rep 0 with an empty window.
    this.repCount = 0;
    this.repStartT = 0;
    this.repMin = UNAVAILABLE;
    this.repMax = UNAVAILABLE;
  }
}

/**
 * Build a {@link PhaseMachine} from a {@link PhasesSpec} and its ROM config.
 *
 * Guards are parsed and compiled once here; the returned machine allocates
 * nothing on the per-frame path apart from the {@link RepCompleted} event it
 * hands back on a rep-closing frame plus the hold / stall events it emits (each
 * a single small object, only on the frame it fires — never per frame). Pass the
 * loaded `calibration` (or `null` to skip the ROM gate, see
 * {@link PhaseMachine.setCalibration}) and the exercise `mode` (`reps` default,
 * `hold` to accumulate time and emit `HoldProgressed`).
 */
export function createPhaseMachine(
  phases: PhasesSpec,
  pairs: LandmarkPairs,
  rom: RomSpec,
  calibration: Calibration | null = null,
  mode: ExerciseMode = 'reps',
): PhaseMachine {
  return new PhaseMachine(phases, pairs, rom, calibration, mode);
}
