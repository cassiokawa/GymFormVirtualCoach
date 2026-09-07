import { describe, it, expect } from 'vitest';
import { createPhaseMachine, PhaseMachine } from './phaseMachine';
import type { PhasesSpec, LandmarkPairs, RomSpec } from './spec';
import {
  UNAVAILABLE,
  LANDMARK_COUNT,
  type Calibration,
  type EvalContext,
  type LandmarkFrame,
  type Signal,
} from './types';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

// The guards in these tests read the `signal` bound variable only, so no joint
// resolution is needed and the landmark map / frame can be empty stand-ins.
const NO_PAIRS: LandmarkPairs = {};

// A ROM config with a 15% tolerance, matching the design's shallow_depth guard.
const ROM: RomSpec = { source: 'calibration', floorPercentile: 25, gateTolerance: 0.15 };

/** Build a Calibration with the given ROM floor (other fields are inert here). */
function calWithFloor(romFloor: number): Calibration {
  return { romFloor, romTop: 200, velocityThreshold: 0.2, version: '1' };
}

/** Construct a reps-mode machine; calibration defaults to null (ROM gate skipped). */
function machine(spec: PhasesSpec, calibration: Calibration | null = null): PhaseMachine {
  return createPhaseMachine(spec, NO_PAIRS, ROM, calibration);
}

/** Construct a hold-mode machine. */
function holdMachine(spec: PhasesSpec): PhaseMachine {
  return createPhaseMachine(spec, NO_PAIRS, ROM, null, 'hold');
}

/** A throwaway landmark frame; guards under test never read from it. */
function frameAt(t: number): LandmarkFrame {
  return {
    t,
    points: new Float32Array(LANDMARK_COUNT * 3),
    visibility: new Float32Array(LANDMARK_COUNT),
    presence: new Float32Array(LANDMARK_COUNT),
  };
}

/** An EvalContext with `signal` set and every other bound var UNAVAILABLE. */
function ctxWith(signal: Signal): EvalContext {
  return {
    signal,
    dSignal: UNAVAILABLE,
    romFloor: UNAVAILABLE,
    romTop: UNAVAILABLE,
    velocityThreshold: UNAVAILABLE,
    repMinSignal: UNAVAILABLE,
    repMaxSignal: UNAVAILABLE,
    phaseElapsedMs: UNAVAILABLE,
  };
}

/**
 * Drive one frame and return the transition part of the outcome (or `null`).
 *
 * The transition-focused tests below assert on `.transition` / `.rep`, so this
 * helper projects the {@link StepOutcome} down to its `transition` field to keep
 * those assertions unchanged. Tests that need the hold / stall events call
 * {@link stepFull} instead.
 *
 * Keeps `ctx.signal` in sync with the smoothed value we hand the machine so
 * guards over `signal` see the same number.
 */
function step(m: PhaseMachine, signal: Signal, t: number) {
  return m.step(signal, ctxWith(signal), frameAt(t), t).transition;
}

/** Drive one frame and return the full {@link StepOutcome}. */
function stepFull(m: PhaseMachine, signal: Signal, t: number) {
  return m.step(signal, ctxWith(signal), frameAt(t), t);
}

// A two-phase machine with a low min-duration and tiny hysteresis so gates are
// out of the way unless a test targets them specifically.
function twoPhaseSpec(overrides: Partial<PhasesSpec> = {}): PhasesSpec {
  return {
    states: ['LOW', 'HIGH'],
    initial: 'LOW',
    hysteresisPct: 0.05,
    minPhaseDurationMs: 250,
    transitions: [
      { from: 'LOW', to: 'HIGH', when: 'signal > 50' },
      { from: 'HIGH', to: 'LOW', when: 'signal < 50', emits: 'RepCompleted' },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Declaration order tie-break (Req 3.3)
// ---------------------------------------------------------------------------

describe('PhaseMachine — declaration order', () => {
  it('picks the first satisfied transition when several guards hold', () => {
    // Two outgoing transitions from START both satisfied by signal > 10; the
    // FIRST declared (to A) must win.
    const spec: PhasesSpec = {
      states: ['START', 'A', 'B'],
      initial: 'START',
      hysteresisPct: 0.05,
      minPhaseDurationMs: 0,
      transitions: [
        { from: 'START', to: 'A', when: 'signal > 10' },
        { from: 'START', to: 'B', when: 'signal > 5' },
      ],
    };
    const m = machine(spec);
    // First frame anchors entry; establish a range with a low sample.
    step(m, 0, 0);
    const result = step(m, 100, 400);
    expect(result).not.toBeNull();
    expect(result?.transition.to).toBe('A');
    expect(m.currentPhase).toBe('A');
  });

  it('falls through to a later transition when the earlier guard fails', () => {
    const spec: PhasesSpec = {
      states: ['START', 'A', 'B'],
      initial: 'START',
      hysteresisPct: 0.05,
      minPhaseDurationMs: 0,
      transitions: [
        { from: 'START', to: 'A', when: 'signal > 90' },
        { from: 'START', to: 'B', when: 'signal > 5' },
      ],
    };
    const m = machine(spec);
    step(m, 0, 0);
    const result = step(m, 50, 400);
    expect(result?.transition.to).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// Hysteresis prevents premature transition (Req 3.3)
// ---------------------------------------------------------------------------

describe('PhaseMachine — hysteresis band', () => {
  it('blocks a transition when displacement from entry is below the band', () => {
    // Guard fires on a DOWNWARD move (`signal < 40`); we grow the observed range
    // UPWARD first, which keeps the guard false so the phase entry stays anchored
    // at the starting signal while the range (and hence the band) grows.
    const spec: PhasesSpec = {
      states: ['P', 'Q'],
      initial: 'P',
      hysteresisPct: 0.2, // band = 0.2 * range
      minPhaseDurationMs: 0,
      transitions: [{ from: 'P', to: 'Q', when: 'signal < 40' }],
    };
    const m = machine(spec);
    // Frame 0 anchors P entry at signal 50 (guard signal<40 is false).
    step(m, 50, 0);
    // Grow the range upward with the guard still false → entry stays 50.
    step(m, 100, 100);
    step(m, 150, 200); // observedMin=50, observedMax=150 → range=100, band=20.
    // Signal 38: guard true (<40) but displacement |38-50|=12 < band 20 → blocked.
    // (observedMin drops to 38 → range 112, band 22.4; 12 < 22.4, still blocked.)
    const blocked = step(m, 38, 300);
    expect(blocked).toBeNull();
    expect(m.currentPhase).toBe('P');
    // Signal 20: observedMin=20 → range 130, band 26; displacement |20-50|=30 ≥ 26 → fires.
    const fired = step(m, 20, 400);
    expect(fired?.transition.to).toBe('Q');
  });
});

// ---------------------------------------------------------------------------
// Minimum phase duration rejects early transition (Req 3.4)
// ---------------------------------------------------------------------------

describe('PhaseMachine — minimum phase duration', () => {
  it('rejects a transition while the source phase is younger than minPhaseDurationMs', () => {
    const spec = twoPhaseSpec({ minPhaseDurationMs: 250, hysteresisPct: 0.05 });
    const m = machine(spec);
    // Frame 0 at t=0 anchors LOW. Establish a small range.
    step(m, 40, 0);
    // t=100 (< 250 since entry at 0): guard signal>50 true but too young → null.
    const early = step(m, 100, 100);
    expect(early).toBeNull();
    expect(m.currentPhase).toBe('LOW');
    // t=300 (>= 250): guard true, band cleared by the big move → fires.
    const late = step(m, 100, 300);
    expect(late?.transition.to).toBe('HIGH');
    expect(m.currentPhase).toBe('HIGH');
  });

  it('re-applies the duration floor to the newly entered phase', () => {
    const spec = twoPhaseSpec({ minPhaseDurationMs: 250, hysteresisPct: 0.05 });
    const m = machine(spec);
    step(m, 40, 0);
    step(m, 100, 300); // → HIGH, entered at t=300.
    // t=400 (< 300+250): the HIGH→LOW guard (signal<50) is true but too young.
    const early = step(m, 10, 400);
    expect(early).toBeNull();
    expect(m.currentPhase).toBe('HIGH');
    // t=600: old enough → fires RepCompleted transition.
    const rep = step(m, 10, 600);
    expect(rep?.transition.to).toBe('LOW');
    expect(rep?.transition.emits).toBe('RepCompleted');
    expect(rep?.rep?.type).toBe('RepCompleted');
  });
});

// ---------------------------------------------------------------------------
// UNAVAILABLE yields no transition and increments the counter (Req 3.1)
// ---------------------------------------------------------------------------

describe('PhaseMachine — UNAVAILABLE signal', () => {
  it('emits no transition and increments the low-confidence counter', () => {
    const spec = twoPhaseSpec({ minPhaseDurationMs: 0, hysteresisPct: 0.05 });
    const m = machine(spec);
    expect(m.lowConfidenceFrameCount).toBe(0);

    const r1 = step(m, UNAVAILABLE, 0);
    expect(r1).toBeNull();
    expect(m.lowConfidenceFrameCount).toBe(1);
    expect(m.currentPhase).toBe('LOW');

    const r2 = step(m, UNAVAILABLE, 33);
    expect(r2).toBeNull();
    expect(m.lowConfidenceFrameCount).toBe(2);
  });

  it('does not advance the observed range across an UNAVAILABLE frame', () => {
    const spec = twoPhaseSpec({ minPhaseDurationMs: 0 });
    const m = machine(spec);
    step(m, 10, 0);
    step(m, 90, 100); // range now 80
    const before = m.observedRange;
    step(m, UNAVAILABLE, 200);
    expect(m.observedRange).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe('PhaseMachine — reset', () => {
  it('returns to the initial phase and clears counters and range', () => {
    const spec = twoPhaseSpec({ minPhaseDurationMs: 0 });
    const m = machine(spec);
    step(m, 40, 0);
    step(m, 100, 300); // → HIGH
    step(m, 10, 400); // → LOW, completes rep 1
    step(m, UNAVAILABLE, 500);
    expect(m.currentPhase).toBe('LOW');
    expect(m.completedReps).toBe(1);
    expect(m.lowConfidenceFrameCount).toBe(1);

    m.reset();
    expect(m.currentPhase).toBe('LOW');
    expect(m.lowConfidenceFrameCount).toBe(0);
    expect(m.observedRange).toBe(0);
    expect(m.completedReps).toBe(0);
    expect(m.repMinSignal).toBe(UNAVAILABLE);
    expect(m.repMaxSignal).toBe(UNAVAILABLE);
  });
});

// ---------------------------------------------------------------------------
// Full cycle sanity — one rep
// ---------------------------------------------------------------------------

describe('PhaseMachine — full cycle', () => {
  it('completes one LOW→HIGH→LOW cycle emitting exactly one RepCompleted', () => {
    const spec = twoPhaseSpec({ minPhaseDurationMs: 250, hysteresisPct: 0.1 });
    const m = machine(spec);
    const emits: string[] = [];
    // Simulate a rising then falling signal at 100 ms steps.
    const samples: Array<[Signal, number]> = [
      [10, 0],
      [30, 100],
      [60, 300], // LOW→HIGH (old enough, moved far)
      [90, 400],
      [60, 500],
      [20, 600], // HIGH→LOW → RepCompleted (entered HIGH at 300, now 600)
    ];
    for (const [s, t] of samples) {
      const r = step(m, s, t);
      if (r?.transition.emits) emits.push(r.transition.emits);
    }
    expect(emits).toEqual(['RepCompleted']);
    expect(m.currentPhase).toBe('LOW');
  });
});

// ---------------------------------------------------------------------------
// Rep records and the ROM gate (Req 3.5)
// ---------------------------------------------------------------------------

/**
 * Drive one full LOW→HIGH→LOW cycle and return the closing StepResult (the one
 * carrying the assembled RepCompleted).
 *
 * The two-phase toy spec closes a rep (HIGH→LOW) when the signal drops back
 * below 50, so within a rep window the *smallest* signal (`bottom`, the deepest
 * point under the ROM convention) is the value the rep closes on, and the
 * *largest* is the peak reached while in HIGH.
 *
 * Timeline (100 ms steps): enter at t0 (`bottomStart`), rise past 50 to HIGH
 * (`peak`), then fall to `bottom` (< 50) to close the rep. Both `bottomStart`
 * and `bottom` sit below 50; `bottom` is the deepest point that the ROM gate
 * measures.
 */
function oneRep(
  m: PhaseMachine,
  opts: { bottomStart: number; peak: number; bottom: number; startT: number },
) {
  const { bottomStart, peak, bottom, startT } = opts;
  step(m, bottomStart, startT); // anchor LOW; rep window opens here
  step(m, peak, startT + 300); // LOW→HIGH (guard signal>50)
  return step(m, bottom, startT + 600); // HIGH→LOW (signal<50) → RepCompleted
}

describe('PhaseMachine — rep records', () => {
  it('increments the rep number across consecutive reps', () => {
    const m = machine(twoPhaseSpec({ minPhaseDurationMs: 250, hysteresisPct: 0.05 }));
    const r1 = oneRep(m, { bottomStart: 40, peak: 90, bottom: 10, startT: 0 });
    expect(r1?.rep?.repNumber).toBe(1);
    expect(m.completedReps).toBe(1);
    // A second cycle continues from where the first left off (now in LOW).
    step(m, 90, 900); // LOW→HIGH again
    const r2 = step(m, 12, 1200); // HIGH→LOW → RepCompleted #2
    expect(r2?.rep?.repNumber).toBe(2);
    expect(m.completedReps).toBe(2);
  });

  it('computes tutMs as the span from the rep window start to the closing frame', () => {
    const m = machine(twoPhaseSpec({ minPhaseDurationMs: 250, hysteresisPct: 0.05 }));
    // Window opens at t=0, closes at t=600 → tutMs = 600.
    const r = oneRep(m, { bottomStart: 40, peak: 90, bottom: 10, startT: 0 });
    expect(r?.rep?.tutMs).toBe(600);
  });

  it('captures the min and max signal observed during the rep window', () => {
    const m = machine(twoPhaseSpec({ minPhaseDurationMs: 250, hysteresisPct: 0.05 }));
    // Values across the window: 40 (start), 95 (peak), 8 (bottom, close).
    const r = oneRep(m, { bottomStart: 40, peak: 95, bottom: 8, startT: 0 });
    expect(r?.rep?.minSignal).toBe(8);
    expect(r?.rep?.maxSignal).toBe(95);
  });

  it('exposes the running rep min/max for the guard context, reset per rep', () => {
    const m = machine(twoPhaseSpec({ minPhaseDurationMs: 250, hysteresisPct: 0.05 }));
    step(m, 40, 0);
    step(m, 90, 300);
    expect(m.repMinSignal).toBe(40);
    expect(m.repMaxSignal).toBe(90);
    step(m, 20, 600); // closes rep → window re-opens anchored at 20
    expect(m.repMinSignal).toBe(20);
    expect(m.repMaxSignal).toBe(20);
  });
});

describe('PhaseMachine — ROM gate', () => {
  // Convention: lower signal = deeper. Pass when
  // repMinSignal <= romFloor * (1 + gateTolerance). ROM.gateTolerance = 0.15.

  it('passes the gate when the deepest point reaches the floor within tolerance', () => {
    // romFloor = 20 → threshold = 20 * 1.15 = 23. bottom = 10 <= 23 → pass.
    const m = machine(twoPhaseSpec({ minPhaseDurationMs: 250, hysteresisPct: 0.05 }), calWithFloor(20));
    const r = oneRep(m, { bottomStart: 40, peak: 90, bottom: 10, startT: 0 });
    expect(r?.rep?.romGatePassed).toBe(true);
  });

  it('fails the gate when the deepest point stays too shallow', () => {
    // romFloor = 20 → threshold = 23. bottom = 30 > 23 → fail (too shallow).
    // (bottom < 50 so the rep still closes; 30 stays above the gated threshold.)
    const m = machine(twoPhaseSpec({ minPhaseDurationMs: 250, hysteresisPct: 0.05 }), calWithFloor(20));
    const r = oneRep(m, { bottomStart: 45, peak: 90, bottom: 30, startT: 0 });
    expect(r?.rep?.romGatePassed).toBe(false);
  });

  it('passes exactly at the tolerance boundary', () => {
    // romFloor = 20 → threshold = 23. bottom = 23 → 23 <= 23 → pass.
    const m = machine(twoPhaseSpec({ minPhaseDurationMs: 250, hysteresisPct: 0.05 }), calWithFloor(20));
    const r = oneRep(m, { bottomStart: 45, peak: 90, bottom: 23, startT: 0 });
    expect(r?.rep?.romGatePassed).toBe(true);
  });

  it('skips the gate (passes) when calibration is null', () => {
    // No calibration → gate skipped even though bottom (40) is shallow.
    const m = machine(twoPhaseSpec({ minPhaseDurationMs: 250, hysteresisPct: 0.05 }), null);
    const r = oneRep(m, { bottomStart: 45, peak: 90, bottom: 40, startT: 0 });
    expect(r?.rep?.romGatePassed).toBe(true);
  });

  it('honours calibration supplied after construction via setCalibration', () => {
    const m = machine(twoPhaseSpec({ minPhaseDurationMs: 250, hysteresisPct: 0.05 }), null);
    m.setCalibration(calWithFloor(20));
    // bottom = 30 > threshold 23 → now fails.
    const r = oneRep(m, { bottomStart: 45, peak: 90, bottom: 30, startT: 0 });
    expect(r?.rep?.romGatePassed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hold mode — HoldProgressed at 1 Hz (Req 3.6)
// ---------------------------------------------------------------------------

describe('PhaseMachine — hold mode', () => {
  // A hold spec: start in SETUP (initial), transition into HOLD once the signal
  // rises past the boundary, then time accrues while sitting in HOLD.
  function holdSpec(): PhasesSpec {
    return {
      states: ['SETUP', 'HOLD'],
      initial: 'SETUP',
      hysteresisPct: 0.05,
      minPhaseDurationMs: 0,
      transitions: [
        { from: 'SETUP', to: 'HOLD', when: 'signal > 50' },
        { from: 'HOLD', to: 'SETUP', when: 'signal < 10' },
      ],
    };
  }

  it('emits one HoldProgressed per whole elapsed second while held', () => {
    const m = holdMachine(holdSpec());
    // Enter HOLD at t=0 (anchor) then rise; from t=0 onward frames sit in HOLD.
    stepFull(m, 20, 0); // SETUP anchor (no dt yet)
    stepFull(m, 90, 100); // SETUP→HOLD; still no whole second accrued
    const secondsEmitted: number[] = [];
    // Step every 250 ms up to t=3100 (3 s after entering HOLD at t=100).
    for (let t = 350; t <= 3100; t += 250) {
      const out = stepFull(m, 90, t);
      if (out.hold) secondsEmitted.push(out.hold.elapsedSeconds);
    }
    // Held for ~3 whole seconds → exactly 3 events, at seconds 1, 2, 3.
    expect(secondsEmitted).toEqual([1, 2, 3]);
    expect(m.holdElapsedSeconds).toBe(3);
  });

  it('does not accumulate hold time while sitting in the initial phase', () => {
    const m = holdMachine(holdSpec());
    // Sit in SETUP for 2 s without ever entering HOLD.
    for (let t = 0; t <= 2000; t += 250) {
      const out = stepFull(m, 20, t);
      expect(out.hold).toBeNull();
    }
    expect(m.holdElapsedSeconds).toBe(0);
  });

  it('pauses (does not reset) accumulation when leaving and re-entering the hold', () => {
    const m = holdMachine(holdSpec());
    stepFull(m, 20, 0); // SETUP anchor
    stepFull(m, 90, 100); // → HOLD
    stepFull(m, 90, 900); // +800 ms held (total 800)
    stepFull(m, 5, 1000); // HOLD→SETUP (leaves hold); +100 ms held (total 900)
    // Sit in SETUP a while — no accrual.
    stepFull(m, 5, 3000);
    expect(m.holdElapsedSeconds).toBe(0); // still under 1 s
    stepFull(m, 90, 3100); // → HOLD again (re-enters); accrual resumes
    const out = stepFull(m, 90, 3300); // +200 ms → total 1100 ms → crosses 1 s
    expect(out.hold?.elapsedSeconds).toBe(1);
    expect(m.holdElapsedSeconds).toBe(1);
  });

  it('emits no stall event in hold mode however long it is held', () => {
    const m = holdMachine(holdSpec());
    stepFull(m, 90, 0); // enters via anchor then rise
    stepFull(m, 90, 100);
    const out = stepFull(m, 90, 100_000); // 100 s in HOLD
    expect(out.stalled).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stall detection — AnalysisStalled after 30 s in reps mode (Req 3.7)
// ---------------------------------------------------------------------------

describe('PhaseMachine — stall detection', () => {
  it('emits AnalysisStalled once after the phase is unchanged for more than 30 s', () => {
    const m = machine(twoPhaseSpec({ minPhaseDurationMs: 250 }));
    stepFull(m, 40, 0); // anchor LOW at t=0
    // At t=30s the phase has been unchanged for exactly 30s → not yet (> 30s).
    expect(stepFull(m, 40, 30_000).stalled).toBeNull();
    // Just past 30s → stall fires once, carrying phase + stalledMs.
    const fired = stepFull(m, 40, 30_100);
    expect(fired.stalled).not.toBeNull();
    expect(fired.stalled?.type).toBe('AnalysisStalled');
    expect(fired.stalled?.phase).toBe('LOW');
    expect(fired.stalled?.stalledMs).toBe(30_100);
    // Subsequent frames in the same stuck phase do NOT re-emit (once per episode).
    expect(stepFull(m, 40, 30_200).stalled).toBeNull();
    expect(stepFull(m, 40, 40_000).stalled).toBeNull();
  });

  it('re-arms the stall latch after a phase change so a new stall can fire', () => {
    const m = machine(twoPhaseSpec({ minPhaseDurationMs: 250, hysteresisPct: 0.05 }));
    stepFull(m, 40, 0);
    stepFull(m, 40, 30_100); // first stall in LOW
    // Move to HIGH (guard signal>50) → re-arms.
    const moved = stepFull(m, 100, 30_400);
    expect(moved.transition?.transition.to).toBe('HIGH');
    // Now sit in HIGH past 30 s → a fresh stall fires for HIGH.
    expect(stepFull(m, 100, 60_500).stalled?.phase).toBe('HIGH');
  });

  it('detects a stall even across UNAVAILABLE frames', () => {
    const m = machine(twoPhaseSpec({ minPhaseDurationMs: 250 }));
    stepFull(m, 40, 0);
    // Feed only UNAVAILABLE frames; the phase cannot change, so it stalls.
    stepFull(m, UNAVAILABLE, 15_000);
    const fired = stepFull(m, UNAVAILABLE, 30_100);
    expect(fired.stalled?.phase).toBe('LOW');
  });
});

// ---------------------------------------------------------------------------
// Low-confidence set — >20% UNAVAILABLE suppresses velocity (Req 3.8)
// ---------------------------------------------------------------------------

describe('PhaseMachine — low-confidence set', () => {
  it('is not low-confidence when 20% or fewer frames are UNAVAILABLE', () => {
    const m = machine(twoPhaseSpec({ minPhaseDurationMs: 0 }));
    // 10 frames, 2 UNAVAILABLE → ratio 0.2, which does not EXCEED 0.2.
    for (let i = 0; i < 8; i++) step(m, 40, i * 100);
    step(m, UNAVAILABLE, 800);
    step(m, UNAVAILABLE, 900);
    expect(m.totalFrameCount).toBe(10);
    expect(m.lowConfidenceRatio).toBeCloseTo(0.2, 10);
    expect(m.isLowConfidence()).toBe(false);
    expect(m.suppressVelocity()).toBe(false);
  });

  it('is low-confidence and suppresses velocity when more than 20% are UNAVAILABLE', () => {
    const m = machine(twoPhaseSpec({ minPhaseDurationMs: 0 }));
    // 10 frames, 3 UNAVAILABLE → ratio 0.3 > 0.2.
    for (let i = 0; i < 7; i++) step(m, 40, i * 100);
    step(m, UNAVAILABLE, 700);
    step(m, UNAVAILABLE, 800);
    step(m, UNAVAILABLE, 900);
    expect(m.lowConfidenceRatio).toBeCloseTo(0.3, 10);
    expect(m.isLowConfidence()).toBe(true);
    expect(m.suppressVelocity()).toBe(true);
  });

  it('is not low-confidence for an empty (unstepped) set', () => {
    const m = machine(twoPhaseSpec());
    expect(m.totalFrameCount).toBe(0);
    expect(m.lowConfidenceRatio).toBe(0);
    expect(m.isLowConfidence()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reset() clears hold accumulation, stall arming, and frame counters (Req 3.6–3.8)
// ---------------------------------------------------------------------------

describe('PhaseMachine — reset clears 7.3 state', () => {
  it('clears hold accumulation on reset', () => {
    const m = holdMachine({
      states: ['SETUP', 'HOLD'],
      initial: 'SETUP',
      hysteresisPct: 0.05,
      minPhaseDurationMs: 0,
      transitions: [{ from: 'SETUP', to: 'HOLD', when: 'signal > 50' }],
    });
    stepFull(m, 90, 0);
    stepFull(m, 90, 100);
    stepFull(m, 90, 2100); // ~2 s held
    expect(m.holdElapsedSeconds).toBeGreaterThan(0);
    m.reset();
    expect(m.holdElapsedSeconds).toBe(0);
    // After reset a fresh hold accrues from zero again.
    stepFull(m, 90, 5000); // anchor (SETUP, no dt)
    stepFull(m, 90, 5100); // → HOLD
    const out = stepFull(m, 90, 6200); // ~1.1 s held → crosses 1 s
    expect(out.hold?.elapsedSeconds).toBe(1);
  });

  it('clears frame counters and re-arms the stall latch on reset', () => {
    const m = machine(twoPhaseSpec({ minPhaseDurationMs: 250 }));
    step(m, 40, 0);
    step(m, UNAVAILABLE, 100);
    stepFull(m, 40, 30_100); // fire a stall
    expect(m.totalFrameCount).toBe(3);

    m.reset();
    expect(m.totalFrameCount).toBe(0);
    expect(m.lowConfidenceFrameCount).toBe(0);
    expect(m.lowConfidenceRatio).toBe(0);
    // Latch re-armed: a fresh set can stall once again.
    step(m, 40, 0);
    const fired = stepFull(m, 40, 30_100);
    expect(fired.stalled?.phase).toBe('LOW');
  });
});
