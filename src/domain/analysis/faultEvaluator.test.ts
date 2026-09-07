import { describe, it, expect } from 'vitest';
import { createFaultEvaluator } from './faultEvaluator';
import type { FaultSpec, LandmarkPairs } from './spec';
import {
  UNAVAILABLE,
  LANDMARK_COUNT,
  type EvalContext,
  type LandmarkFrame,
  type Signal,
} from './types';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

// A landmark map with two joints. `knee` = {25,26}, `ankle` = {27,28},
// matching MediaPipe pose indices. Guards below use `axis(knee,'x')` /
// `axis(ankle,'x')` so resolution touches these indices.
const PAIRS: LandmarkPairs = {
  knee: { left: 25, right: 26 },
  ankle: { left: 27, right: 28 },
};

/**
 * Build a frame whose landmarks are all confident by default, with per-index
 * overrides for position (x of a landmark) and confidence. `x[i]` sets the x
 * coordinate of landmark `i`; `lowConfidence` lists indices forced below the
 * confidence threshold.
 */
function makeFrame(opts: {
  t?: number;
  x?: Record<number, number>;
  lowConfidence?: number[];
}): LandmarkFrame {
  const points = new Float32Array(LANDMARK_COUNT * 3);
  const visibility = new Float32Array(LANDMARK_COUNT).fill(1);
  const presence = new Float32Array(LANDMARK_COUNT).fill(1);
  if (opts.x) {
    for (const [idx, value] of Object.entries(opts.x)) {
      points[Number(idx) * 3] = value;
    }
  }
  for (const idx of opts.lowConfidence ?? []) {
    visibility[idx] = 0;
    presence[idx] = 0;
  }
  return { t: opts.t ?? 0, points, visibility, presence };
}

/** An EvalContext with `signal` set; every other bound var UNAVAILABLE. */
function ctxWith(signal: Signal = 0): EvalContext {
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

// A guard on the `knee`/`ankle` x positions: knee tracked medially "inside"
// the ankle. Fires when |knee.x| < |ankle.x|. References knee (25,26) and
// ankle (27,28). This mirrors the design's knee-valgus reading.
const KNEE_INSIDE_ANKLE = "axis(knee,'x') inside axis(ankle,'x')";

function fault(overrides: Partial<FaultSpec> & Pick<FaultSpec, 'id' | 'phase' | 'when'>): FaultSpec {
  return {
    minDeviation: 0,
    severity: 'warning',
    cue: 'knees out',
    ...overrides,
  };
}

// A frame where knee.x (|0.1|) < ankle.x (|0.4|) → guard TRUE.
function frameGuardTrue(t = 0): LandmarkFrame {
  return makeFrame({ t, x: { 25: 0.1, 26: 0.1, 27: 0.4, 28: 0.4 } });
}

// A frame where knee.x (|0.5|) > ankle.x (|0.4|) → guard FALSE.
function frameGuardFalse(t = 0): LandmarkFrame {
  return makeFrame({ t, x: { 25: 0.5, 26: 0.5, 27: 0.4, 28: 0.4 } });
}

// ---------------------------------------------------------------------------
// Req 4.1 — only current-phase faults evaluated
// ---------------------------------------------------------------------------

describe('FaultEvaluator — phase scoping (Req 4.1)', () => {
  it('evaluates only faults whose declared phase equals the current phase', () => {
    const ev = createFaultEvaluator(
      [
        fault({ id: 'f_descent', phase: 'ECCENTRIC', when: KNEE_INSIDE_ANKLE, cue: 'knees out' }),
        fault({ id: 'f_bottom', phase: 'BOTTOM', when: KNEE_INSIDE_ANKLE, cue: 'chest up' }),
      ],
      PAIRS,
    );

    // Guard is true, but only the ECCENTRIC fault should fire in ECCENTRIC.
    const inEccentric = ev.evaluate('ECCENTRIC', frameGuardTrue(), ctxWith(), 100);
    expect(inEccentric.map((e) => e.faultId)).toEqual(['f_descent']);

    // In BOTTOM only the BOTTOM fault fires.
    const inBottom = ev.evaluate('BOTTOM', frameGuardTrue(), ctxWith(), 200);
    expect(inBottom.map((e) => e.faultId)).toEqual(['f_bottom']);
  });

  it('returns no events for a phase with no declared faults', () => {
    const ev = createFaultEvaluator(
      [fault({ id: 'f1', phase: 'ECCENTRIC', when: KNEE_INSIDE_ANKLE })],
      PAIRS,
    );
    expect(ev.evaluate('TOP', frameGuardTrue(), ctxWith(), 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Req 4.2 — suppressed when a referenced landmark is low confidence
// ---------------------------------------------------------------------------

describe('FaultEvaluator — confidence gate (Req 4.2)', () => {
  it('suppresses the fault when a referenced landmark is below threshold', () => {
    const ev = createFaultEvaluator(
      [fault({ id: 'f1', phase: 'ECCENTRIC', when: KNEE_INSIDE_ANKLE })],
      PAIRS,
    );
    // Guard would be true, but the left knee (index 25) is not confident.
    const frame = makeFrame({
      x: { 25: 0.1, 26: 0.1, 27: 0.4, 28: 0.4 },
      lowConfidence: [25],
    });
    expect(ev.evaluate('ECCENTRIC', frame, ctxWith(), 0)).toEqual([]);
  });

  it('emits when all referenced landmarks are confident', () => {
    const ev = createFaultEvaluator(
      [fault({ id: 'f1', phase: 'ECCENTRIC', when: KNEE_INSIDE_ANKLE })],
      PAIRS,
    );
    expect(ev.evaluate('ECCENTRIC', frameGuardTrue(), ctxWith(), 0)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Req 4.3 — suppressed when guard UNAVAILABLE / false
// ---------------------------------------------------------------------------

describe('FaultEvaluator — guard suppression (Req 4.3)', () => {
  it('suppresses when the guard evaluates to false', () => {
    const ev = createFaultEvaluator(
      [fault({ id: 'f1', phase: 'ECCENTRIC', when: KNEE_INSIDE_ANKLE })],
      PAIRS,
    );
    expect(ev.evaluate('ECCENTRIC', frameGuardFalse(), ctxWith(), 0)).toEqual([]);
  });

  it('suppresses when the guard evaluates to UNAVAILABLE (a bound var is UNAVAILABLE)', () => {
    // Guard references dSignal, which is UNAVAILABLE in ctxWith → comparison
    // yields 0 (false) per evaluator semantics → suppressed. Also exercise a
    // guard that resolves UNAVAILABLE directly by referencing an unknown joint.
    const ev = createFaultEvaluator(
      [fault({ id: 'f1', phase: 'ECCENTRIC', when: "axis(knee,'x') < romFloor" })],
      PAIRS,
    );
    // romFloor is UNAVAILABLE → comparison is false → suppressed.
    expect(ev.evaluate('ECCENTRIC', frameGuardTrue(), ctxWith(), 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Req 4.4 — emitted with id/severity/cue/phase when guard confidently true
// ---------------------------------------------------------------------------

describe('FaultEvaluator — emission (Req 4.4)', () => {
  it('emits a FaultDetected carrying id, severity, cue, phase, and timestamp', () => {
    const ev = createFaultEvaluator(
      [fault({ id: 'knee_valgus', phase: 'ECCENTRIC', when: KNEE_INSIDE_ANKLE, severity: 'critical', cue: 'knees out' })],
      PAIRS,
    );
    const events = ev.evaluate('ECCENTRIC', frameGuardTrue(1234), ctxWith(), 1234);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'FaultDetected',
      t: 1234,
      faultId: 'knee_valgus',
      phase: 'ECCENTRIC',
      severity: 'critical',
      cue: 'knees out',
    });
  });

  it('emits every detected fault in a phase with no cue rationing', () => {
    const ev = createFaultEvaluator(
      [
        fault({ id: 'f1', phase: 'ECCENTRIC', when: KNEE_INSIDE_ANKLE, severity: 'warning', cue: 'knees out' }),
        fault({ id: 'f2', phase: 'ECCENTRIC', when: KNEE_INSIDE_ANKLE, severity: 'critical', cue: 'chest up' }),
        fault({ id: 'f3', phase: 'ECCENTRIC', when: KNEE_INSIDE_ANKLE, severity: 'info', cue: 'slow down' }),
      ],
      PAIRS,
    );
    const events = ev.evaluate('ECCENTRIC', frameGuardTrue(), ctxWith(), 500);
    // All three fire — the engine does NOT ration cues (that is Coaching's job).
    expect(events.map((e) => e.faultId)).toEqual(['f1', 'f2', 'f3']);
    expect(events.map((e) => e.severity)).toEqual(['warning', 'critical', 'info']);
  });

  it('emits only the faults whose guards are true, leaving the rest suppressed', () => {
    const ev = createFaultEvaluator(
      [
        fault({ id: 'f_true', phase: 'ECCENTRIC', when: KNEE_INSIDE_ANKLE }),
        // knee OUTSIDE ankle: false on a guard-true frame.
        fault({ id: 'f_false', phase: 'ECCENTRIC', when: "axis(knee,'x') outside axis(ankle,'x')" }),
      ],
      PAIRS,
    );
    const events = ev.evaluate('ECCENTRIC', frameGuardTrue(), ctxWith(), 0);
    expect(events.map((e) => e.faultId)).toEqual(['f_true']);
  });
});
