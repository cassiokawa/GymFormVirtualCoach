/**
 * Unit tests for the closure-tree compiler (task 5.1).
 *
 * Covers every node kind — number, boundVar, ref, arithmetic, comparisons,
 * and the calls angle/distance/axis/midpoint/normalize/delta — plus the
 * UNAVAILABLE propagation basics (arithmetic → UNAVAILABLE, comparison →
 * false). Property tests for totality and propagation are separate (5.2/5.3).
 */

import { describe, expect, it } from 'vitest';
import { compileExpression } from './compile';
import { parseExpression } from './parser';
import type { LandmarkPairs } from '../spec';
import {
  LANDMARK_COUNT,
  UNAVAILABLE,
  type EvalContext,
  type LandmarkFrame,
  type Signal,
} from '../types';

// --- test scaffolding -------------------------------------------------------

/** A landmark-pair map: hip/knee/ankle each map to a left/right index. */
const PAIRS: LandmarkPairs = {
  hip: { left: 23, right: 24 },
  knee: { left: 25, right: 26 },
  ankle: { left: 27, right: 28 },
};

interface Lm {
  index: number;
  x: number;
  y: number;
  z: number;
  vis?: number;
  pres?: number;
}

/** Build a frame with the given landmarks; all others are zeroed/unconfident. */
function frameOf(landmarks: readonly Lm[], t = 0): LandmarkFrame {
  const points = new Float32Array(LANDMARK_COUNT * 3);
  const visibility = new Float32Array(LANDMARK_COUNT);
  const presence = new Float32Array(LANDMARK_COUNT);
  for (const lm of landmarks) {
    const b = lm.index * 3;
    points[b] = lm.x;
    points[b + 1] = lm.y;
    points[b + 2] = lm.z;
    visibility[lm.index] = lm.vis ?? 1;
    presence[lm.index] = lm.pres ?? 1;
  }
  return { t, points, visibility, presence };
}

/** A context with every bound var defined; override per test as needed. */
function ctxOf(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    signal: 0,
    dSignal: 0,
    romFloor: 0,
    romTop: 0,
    velocityThreshold: 0,
    repMinSignal: 0,
    repMaxSignal: 0,
    phaseElapsedMs: 0,
    ...overrides,
  };
}

/** Parse + compile in one step. */
function build(expr: string, pairs: LandmarkPairs = PAIRS) {
  return compileExpression(parseExpression(expr), pairs);
}

const emptyFrame = frameOf([]);

// --- number + boundVar ------------------------------------------------------

describe('compile — literals and bound variables', () => {
  it('evaluates a number literal', () => {
    expect(build('12.5')(emptyFrame, ctxOf())).toBe(12.5);
  });

  it('reads each bound variable from the context', () => {
    expect(build('signal')(emptyFrame, ctxOf({ signal: 42 }))).toBe(42);
    expect(build('romFloor')(emptyFrame, ctxOf({ romFloor: 90 }))).toBe(90);
    expect(
      build('phaseElapsedMs')(emptyFrame, ctxOf({ phaseElapsedMs: 300 })),
    ).toBe(300);
  });

  it('passes UNAVAILABLE bound vars through unchanged', () => {
    expect(build('signal')(emptyFrame, ctxOf({ signal: UNAVAILABLE }))).toBe(
      UNAVAILABLE,
    );
  });
});

// --- arithmetic -------------------------------------------------------------

describe('compile — arithmetic', () => {
  it('adds, subtracts, multiplies, and divides', () => {
    expect(build('2 + 3')(emptyFrame, ctxOf())).toBe(5);
    expect(build('10 - 4')(emptyFrame, ctxOf())).toBe(6);
    expect(build('6 * 7')(emptyFrame, ctxOf())).toBe(42);
    expect(build('20 / 5')(emptyFrame, ctxOf())).toBe(4);
  });

  it('honours precedence and grouping', () => {
    expect(build('1 + 2 * 3')(emptyFrame, ctxOf())).toBe(7);
    expect(build('(1 + 2) * 3')(emptyFrame, ctxOf())).toBe(9);
  });

  it('returns UNAVAILABLE on division by zero', () => {
    expect(build('5 / 0')(emptyFrame, ctxOf())).toBe(UNAVAILABLE);
  });

  it('propagates UNAVAILABLE through every arithmetic op', () => {
    const c = ctxOf({ signal: UNAVAILABLE });
    expect(build('signal + 1')(emptyFrame, c)).toBe(UNAVAILABLE);
    expect(build('1 - signal')(emptyFrame, c)).toBe(UNAVAILABLE);
    expect(build('signal * 2')(emptyFrame, c)).toBe(UNAVAILABLE);
    expect(build('signal / 2')(emptyFrame, c)).toBe(UNAVAILABLE);
  });
});

// --- comparisons ------------------------------------------------------------

describe('compile — comparisons', () => {
  it('evaluates ordering comparators to 1 (true) / 0 (false)', () => {
    expect(build('1 < 2')(emptyFrame, ctxOf())).toBe(1);
    expect(build('2 < 1')(emptyFrame, ctxOf())).toBe(0);
    expect(build('2 > 1')(emptyFrame, ctxOf())).toBe(1);
    expect(build('2 <= 2')(emptyFrame, ctxOf())).toBe(1);
    expect(build('3 >= 4')(emptyFrame, ctxOf())).toBe(0);
  });

  it('yields false (0) when either operand is UNAVAILABLE', () => {
    const c = ctxOf({ signal: UNAVAILABLE });
    expect(build('signal < 10')(emptyFrame, c)).toBe(0);
    expect(build('10 > signal')(emptyFrame, c)).toBe(0);
  });

  it('inside: |a| < |b|', () => {
    // knee x = 0.4 (nearer midline), ankle x = 0.6 → knee inside ankle.
    expect(build('0.4 inside 0.6')(emptyFrame, ctxOf())).toBe(1);
    expect(build('0.6 inside 0.4')(emptyFrame, ctxOf())).toBe(0);
    expect(build('0.5 inside 0.5')(emptyFrame, ctxOf())).toBe(0); // equal → neither
    // magnitude, not signed: -0.7 is farther out than 0.5.
    expect(build('(0 - 0.5) inside 0.7')(emptyFrame, ctxOf())).toBe(1);
  });

  it('outside: |a| > |b|', () => {
    expect(build('0.6 outside 0.4')(emptyFrame, ctxOf())).toBe(1);
    expect(build('0.4 outside 0.6')(emptyFrame, ctxOf())).toBe(0);
    expect(build('0.5 outside 0.5')(emptyFrame, ctxOf())).toBe(0);
  });

  it('inside/outside yield false when an operand is UNAVAILABLE', () => {
    const c = ctxOf({ signal: UNAVAILABLE });
    expect(build('signal inside 1')(emptyFrame, c)).toBe(0);
    expect(build('1 outside signal')(emptyFrame, c)).toBe(0);
  });
});

// --- calls ------------------------------------------------------------------

describe('compile — angle', () => {
  it('computes the interior angle at the vertex in degrees', () => {
    // Build a right angle at "knee": hip straight up, ankle straight right.
    // Use side-specific refs so we control exact coordinates.
    const frame = frameOf([
      { index: 25, x: 0, y: 0, z: 0 }, // left_knee (vertex)
      { index: 23, x: 0, y: 1, z: 0 }, // left_hip  (up)
      { index: 27, x: 1, y: 0, z: 0 }, // left_ankle (right)
    ]);
    const deg = build('angle(left_hip, left_knee, left_ankle)')(frame, ctxOf());
    expect(deg).toBeCloseTo(90, 5);
  });

  it('computes a straight (180°) angle', () => {
    const frame = frameOf([
      { index: 25, x: 0, y: 0, z: 0 },
      { index: 23, x: -1, y: 0, z: 0 },
      { index: 27, x: 1, y: 0, z: 0 },
    ]);
    expect(
      build('angle(left_hip, left_knee, left_ankle)')(frame, ctxOf()),
    ).toBeCloseTo(180, 5);
  });

  it('returns UNAVAILABLE when a joint is unconfident', () => {
    const frame = frameOf([
      { index: 25, x: 0, y: 0, z: 0 },
      { index: 23, x: 0, y: 1, z: 0, vis: 0.1 }, // below threshold
      { index: 27, x: 1, y: 0, z: 0 },
    ]);
    expect(build('angle(left_hip, left_knee, left_ankle)')(frame, ctxOf())).toBe(
      UNAVAILABLE,
    );
  });

  it('returns UNAVAILABLE on a zero-length edge vector', () => {
    // hip coincides with the vertex → zero-length edge.
    const frame = frameOf([
      { index: 25, x: 0, y: 0, z: 0 },
      { index: 23, x: 0, y: 0, z: 0 },
      { index: 27, x: 1, y: 0, z: 0 },
    ]);
    expect(build('angle(left_hip, left_knee, left_ankle)')(frame, ctxOf())).toBe(
      UNAVAILABLE,
    );
  });

  it('resolves unprefixed joints to the bilateral midpoint', () => {
    // Midpoints: hip=(0,1), knee=(0,0), ankle=(1,0) → 90°.
    const frame = frameOf([
      { index: 23, x: 0, y: 1, z: 0 },
      { index: 24, x: 0, y: 1, z: 0 },
      { index: 25, x: 0, y: 0, z: 0 },
      { index: 26, x: 0, y: 0, z: 0 },
      { index: 27, x: 1, y: 0, z: 0 },
      { index: 28, x: 1, y: 0, z: 0 },
    ]);
    expect(build('angle(hip, knee, ankle)')(frame, ctxOf())).toBeCloseTo(90, 5);
  });
});

describe('compile — distance', () => {
  it('computes Euclidean distance', () => {
    const frame = frameOf([
      { index: 23, x: 0, y: 0, z: 0 }, // left_hip
      { index: 25, x: 3, y: 4, z: 0 }, // left_knee
    ]);
    expect(build('distance(left_hip, left_knee)')(frame, ctxOf())).toBeCloseTo(
      5,
      5,
    );
  });

  it('returns UNAVAILABLE when a joint is unavailable', () => {
    const frame = frameOf([{ index: 23, x: 0, y: 0, z: 0 }]);
    expect(build('distance(left_hip, left_knee)')(frame, ctxOf())).toBe(
      UNAVAILABLE,
    );
  });
});

describe('compile — axis', () => {
  it('projects the named coordinate', () => {
    const frame = frameOf([{ index: 23, x: 0.2, y: 0.7, z: -0.3 }]);
    expect(build('axis(left_hip, "x")')(frame, ctxOf())).toBeCloseTo(0.2, 6);
    expect(build('axis(left_hip, "y")')(frame, ctxOf())).toBeCloseTo(0.7, 6);
    expect(build('axis(left_hip, "z")')(frame, ctxOf())).toBeCloseTo(-0.3, 6);
  });

  it('returns UNAVAILABLE for an unavailable joint', () => {
    expect(build('axis(left_hip, "x")')(emptyFrame, ctxOf())).toBe(UNAVAILABLE);
  });

  it('supports the design knee-valgus reading via inside', () => {
    // left_knee tracked medially (x=0.4) inside left_ankle (x=0.6).
    const frame = frameOf([
      { index: 25, x: 0.4, y: 0, z: 0 },
      { index: 27, x: 0.6, y: 0, z: 0 },
    ]);
    const guard = build('axis(left_knee, "x") inside axis(left_ankle, "x")');
    expect(guard(frame, ctxOf())).toBe(1);
  });
});

describe('compile — midpoint', () => {
  it('projects the midpoint to its magnitude', () => {
    // midpoint of (0,0,0) and (6,8,0) = (3,4,0), magnitude 5.
    const frame = frameOf([
      { index: 23, x: 0, y: 0, z: 0 },
      { index: 24, x: 6, y: 8, z: 0 },
    ]);
    expect(build('midpoint(left_hip, right_hip)')(frame, ctxOf())).toBeCloseTo(
      5,
      5,
    );
  });

  it('returns UNAVAILABLE when a joint is unavailable', () => {
    const frame = frameOf([{ index: 23, x: 0, y: 0, z: 0 }]);
    expect(build('midpoint(left_hip, right_hip)')(frame, ctxOf())).toBe(
      UNAVAILABLE,
    );
  });
});

describe('compile — normalize', () => {
  it('passes the inner expression through (segment scaling not yet wired)', () => {
    const frame = frameOf([
      { index: 23, x: 0, y: 0, z: 0 },
      { index: 25, x: 3, y: 4, z: 0 },
    ]);
    expect(
      build('normalize(distance(left_hip, left_knee), "femur")')(frame, ctxOf()),
    ).toBeCloseTo(5, 5);
  });

  it('propagates UNAVAILABLE from the inner expression', () => {
    expect(
      build('normalize(distance(left_hip, left_knee), "femur")')(
        emptyFrame,
        ctxOf(),
      ),
    ).toBe(UNAVAILABLE);
  });
});

describe('compile — delta', () => {
  it('yields UNAVAILABLE on the first sample, then the difference', () => {
    const d = build('delta(signal)');
    // delta(signal) reads through to the windowed rate via the inner signal
    // value; first call has no previous value.
    expect(d(emptyFrame, ctxOf({ signal: 10 }))).toBe(UNAVAILABLE);
    expect(d(emptyFrame, ctxOf({ signal: 13 }))).toBe(3);
    expect(d(emptyFrame, ctxOf({ signal: 8 }))).toBe(-5);
  });

  it('does not advance the previous value across an UNAVAILABLE sample', () => {
    const d = build('delta(signal)');
    expect(d(emptyFrame, ctxOf({ signal: 10 }))).toBe(UNAVAILABLE); // seed
    expect(d(emptyFrame, ctxOf({ signal: UNAVAILABLE }))).toBe(UNAVAILABLE);
    // previous is still 10, so next diff is against 10.
    expect(d(emptyFrame, ctxOf({ signal: 12 }))).toBe(2);
  });
});

// --- totality spot-check ----------------------------------------------------

describe('compile — totality basics', () => {
  it('never throws and always returns number | UNAVAILABLE', () => {
    const exprs = [
      '12',
      'signal + romFloor',
      'angle(hip, knee, ankle)',
      'axis(left_hip, "y") inside axis(left_ankle, "y")',
      'distance(left_hip, right_hip) / romTop',
      'normalize(delta(signal), "femur")',
    ];
    for (const src of exprs) {
      const f = build(src);
      const out: Signal = f(emptyFrame, ctxOf());
      expect(out === UNAVAILABLE || typeof out === 'number').toBe(true);
    }
  });
});
