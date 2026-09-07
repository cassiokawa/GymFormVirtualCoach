import { describe, it, expect } from 'vitest';
import { compileSpec } from './engine';
import {
  replayFixture,
  frameFromFixture,
  DEFAULT_TOLERANCE_MS,
  type Fixture,
  type FixtureFrame,
} from './fixture';
import type { ExerciseSpec } from './spec';
import { LANDMARK_COUNT } from './types';

// ---------------------------------------------------------------------------
// A squat-shaped, rep-mode spec (same shape as engine.test.ts). The signal is
// the y-position of the `hip` joint via `axis(hip,'y')`; lower = deeper. A
// knee-valgus-style fault fires in ECCENTRIC. `id`/`displayName`/`aliases` are
// data literals confined to this fixture, never referenced by engine code.
//   phases: TOP -> ECCENTRIC -> BOTTOM -> CONCENTRIC -> TOP
//   CONCENTRIC -> TOP emits RepCompleted.
// ---------------------------------------------------------------------------

function makeSpec(): ExerciseSpec {
  return {
    id: 'fixture_movement_a',
    version: '1.0.0',
    displayName: 'Fixture Movement A',
    aliases: ['fixture-a'],
    facets: { equipment: 'none', primaryMuscles: ['quads'], position: 'standing' },
    mode: 'reps',
    bilateral: true,
    landmarkPairs: {
      hip: { left: 23, right: 24 },
      knee: { left: 25, right: 26 },
      ankle: { left: 27, right: 28 },
    },
    requiredLandmarks: [23, 24, 25, 26, 27, 28],
    optionalLandmarks: [],
    camera: { preferredAngleDeg: 90, toleranceDeg: 20, view: 'side' },
    signal: {
      expr: "axis(hip,'y')",
      smoothing: { type: 'oneEuro', minCutoff: 30, beta: 0.5 },
    },
    rom: { source: 'calibration', floorPercentile: 10, gateTolerance: 0.15 },
    phases: {
      states: ['TOP', 'ECCENTRIC', 'BOTTOM', 'CONCENTRIC'],
      initial: 'TOP',
      hysteresisPct: 0.05,
      minPhaseDurationMs: 250,
      transitions: [
        { from: 'TOP', to: 'ECCENTRIC', when: 'signal < 70' },
        { from: 'ECCENTRIC', to: 'BOTTOM', when: 'signal < 30' },
        { from: 'BOTTOM', to: 'CONCENTRIC', when: 'signal > 40' },
        { from: 'CONCENTRIC', to: 'TOP', when: 'signal > 90', emits: 'RepCompleted' },
      ],
    },
    faults: [
      {
        id: 'fault_valgus',
        phase: 'ECCENTRIC',
        when: "axis(knee,'x') inside axis(ankle,'x')",
        minDeviation: 0,
        severity: 'warning',
        cue: 'knees out',
      },
    ],
  };
}

// Height ramp for ONE rep, matching engine.test.ts's driveRep dwell pattern.
// Each entry is spaced 100 ms; dwells clear the 250 ms min-phase gate. Crossing
// >90 on the way back up closes the rep at the frame where y first exceeds 90.
const REP_HEIGHTS = [
  100, 100, 100, // TOP dwell
  80, 60, // -> ECCENTRIC
  40, 20, 10, // -> BOTTOM
  10, 10,
  35, 55, // -> CONCENTRIC
  75, 95, // -> TOP (rep closes here)
  100, 100,
];

const FRAME_MS = 100;

interface BuiltTimeline {
  frames: FixtureFrame[];
  /** t of the frame that closes each rep (first y > 90 during CONCENTRIC). */
  repCloseTimes: number[];
  /** t of frames while in the ECCENTRIC band (valgus can fire), if valgus set. */
  eccentricTimes: number[];
  endT: number;
}

/**
 * Build a fixture timeline for `n` reps. When `valgus` is true, knee.x is placed
 * inside ankle.x so the ECCENTRIC valgus guard fires; otherwise it is outside.
 */
function buildTimeline(n: number, valgus: boolean, startT = 0): BuiltTimeline {
  const frames: FixtureFrame[] = [];
  const repCloseTimes: number[] = [];
  const eccentricTimes: number[] = [];
  let t = startT;
  const kneeX = valgus ? 0.1 : 0.6;
  const ankleX = 0.4;

  for (let rep = 0; rep < n; rep++) {
    let prevY = REP_HEIGHTS[0] ?? 100;
    for (let i = 0; i < REP_HEIGHTS.length; i++) {
      const y = REP_HEIGHTS[i] ?? 100;
      frames.push({
        t,
        landmarks: [
          { index: 23, x: 0.5, y },
          { index: 24, x: 0.5, y },
          { index: 25, x: kneeX },
          { index: 26, x: kneeX },
          { index: 27, x: ankleX },
          { index: 28, x: ankleX },
        ],
      });
      // The rep closes on the ascending crossing above 90.
      if (prevY <= 90 && y > 90) repCloseTimes.push(t);
      // Track ECCENTRIC-band frames (descending, 30..70) for fault annotation.
      if (y < 70 && y >= 30) eccentricTimes.push(t);
      prevY = y;
      t += FRAME_MS;
    }
  }
  return { frames, repCloseTimes, eccentricTimes, endT: t };
}

// ---------------------------------------------------------------------------
// frameFromFixture
// ---------------------------------------------------------------------------

describe('frameFromFixture', () => {
  it('defaults unlisted landmarks to origin with full confidence', () => {
    const frame = frameFromFixture({ t: 5, landmarks: [{ index: 23, x: 0.5, y: 100 }] });
    expect(frame.t).toBe(5);
    expect(frame.points.length).toBe(LANDMARK_COUNT * 3);
    // Named landmark set.
    expect(frame.points[23 * 3]).toBeCloseTo(0.5);
    expect(frame.points[23 * 3 + 1]).toBeCloseTo(100);
    // Unlisted landmark defaults to origin, but confidently present.
    expect(frame.points[0]).toBe(0);
    expect(frame.visibility[0]).toBe(1);
    expect(frame.presence[0]).toBe(1);
  });

  it('applies explicit visibility/presence overrides', () => {
    const frame = frameFromFixture({
      t: 0,
      landmarks: [{ index: 25, x: 0.1, visibility: 0, presence: 0 }],
    });
    expect(frame.visibility[25]).toBe(0);
    expect(frame.presence[25]).toBe(0);
  });

  it('throws on an out-of-range landmark index', () => {
    expect(() => frameFromFixture({ t: 0, landmarks: [{ index: 99 }] })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// replayFixture — rep timeline parity (Req 6.2)
// ---------------------------------------------------------------------------

describe('replayFixture — rep timeline (Req 6.2)', () => {
  it('replays a known rep timeline to the expected count and marks it matched', () => {
    const compiled = compileSpec(makeSpec(), null);
    const N = 3;
    const built = buildTimeline(N, /* valgus */ false);

    const expectedReps = built.repCloseTimes.map((t, i) => ({ repNumber: i + 1, t }));
    const fixture: Fixture = {
      specId: 'fixture_movement_a',
      frames: built.frames,
      expectedReps,
      expectedFaults: [],
      toleranceMs: 400, // absorb smoothing/hysteresis lag while still parity-checking
    };

    const result = replayFixture(compiled, fixture);

    expect(result.specId).toBe('fixture_movement_a');
    expect(result.frameCount).toBe(built.frames.length);
    expect(result.expectedRepCount).toBe(N);
    expect(result.actualRepCount).toBe(N);
    expect(result.repTimelineMatches).toBe(true);
    expect(result.repTimeline).toHaveLength(N);
    expect(result.repTimeline.every((r) => r.status === 'matched')).toBe(true);
    expect(result.repTimeline.map((r) => r.repNumber)).toEqual([1, 2, 3]);
  });

  it('reports a missing row when an expected rep is not detected', () => {
    const compiled = compileSpec(makeSpec(), null);
    // Drive ONE real rep, but annotate TWO expected reps.
    const built = buildTimeline(1, false);
    const fixture: Fixture = {
      specId: 'fixture_movement_a',
      frames: built.frames,
      expectedReps: [
        { repNumber: 1, t: built.repCloseTimes[0] ?? 0 },
        { repNumber: 2, t: (built.repCloseTimes[0] ?? 0) + 5000 },
      ],
      expectedFaults: [],
      toleranceMs: 400,
    };

    const result = replayFixture(compiled, fixture);
    expect(result.actualRepCount).toBe(1);
    expect(result.repTimelineMatches).toBe(false);
    const missing = result.repTimeline.filter((r) => r.status === 'missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.repNumber).toBe(2);
  });

  it('reports an extra row when a rep is detected but not expected', () => {
    const compiled = compileSpec(makeSpec(), null);
    const built = buildTimeline(2, false);
    // Annotate only the first rep; the second detection is an extra.
    const fixture: Fixture = {
      specId: 'fixture_movement_a',
      frames: built.frames,
      expectedReps: [{ repNumber: 1, t: built.repCloseTimes[0] ?? 0 }],
      expectedFaults: [],
      toleranceMs: 400,
    };

    const result = replayFixture(compiled, fixture);
    expect(result.actualRepCount).toBe(2);
    expect(result.repTimelineMatches).toBe(false);
    const extra = result.repTimeline.filter((r) => r.status === 'extra');
    expect(extra).toHaveLength(1);
    expect(extra[0]?.repNumber).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// replayFixture — per-fault confusion matrix (Req 6.3)
// ---------------------------------------------------------------------------

/** Find the confusion row for a fault id, or undefined. */
function confusionFor(
  result: ReturnType<typeof replayFixture>,
  id: string,
) {
  return result.faultConfusion.find((c) => c.faultId === id);
}

describe('replayFixture — fault confusion matrix (Req 6.3)', () => {
  it('scores true positives when a detected fault matches an annotation in window', () => {
    const compiled = compileSpec(makeSpec(), null);
    const built = buildTimeline(1, /* valgus */ true);
    // Learn where the fault actually fired so we annotate inside the window.
    const probe = replayFixture(compiled, {
      specId: 'fixture_movement_a',
      frames: built.frames,
      expectedReps: [],
      expectedFaults: [],
    });
    const detected = probe.events.filter((e) => e.type === 'FaultDetected');
    expect(detected.length).toBeGreaterThan(0);
    const firstT = (detected[0] as { t: number }).t;

    const result = replayFixture(compiled, {
      specId: 'fixture_movement_a',
      frames: built.frames,
      expectedReps: [],
      expectedFaults: [{ faultId: 'fault_valgus', t: firstT }],
      toleranceMs: 50,
    });

    const row = confusionFor(result, 'fault_valgus');
    expect(row).toBeDefined();
    expect(row?.truePositives).toBe(1);
    expect(row?.falseNegatives).toBe(0);
    // Any additional same-id detections beyond the single annotation are FPs.
    expect(row?.falsePositives).toBe(detected.length - 1);
  });

  it('scores false positives when a fault is detected but not annotated', () => {
    const compiled = compileSpec(makeSpec(), null);
    const built = buildTimeline(1, /* valgus */ true);
    const result = replayFixture(compiled, {
      specId: 'fixture_movement_a',
      frames: built.frames,
      expectedReps: [],
      expectedFaults: [], // annotate nothing: every detection is a false positive
      toleranceMs: 50,
    });

    const row = confusionFor(result, 'fault_valgus');
    expect(row).toBeDefined();
    expect(row?.truePositives).toBe(0);
    expect(row?.falseNegatives).toBe(0);
    expect(row?.falsePositives).toBeGreaterThan(0);
  });

  it('scores false negatives when an annotated fault is never detected', () => {
    const compiled = compileSpec(makeSpec(), null);
    // No valgus: the fault never fires, but we annotate that it should.
    const built = buildTimeline(1, /* valgus */ false);
    const result = replayFixture(compiled, {
      specId: 'fixture_movement_a',
      frames: built.frames,
      expectedReps: [],
      expectedFaults: [
        { faultId: 'fault_valgus', t: 400 },
        { faultId: 'fault_valgus', t: 700 },
      ],
      toleranceMs: 50,
    });

    const row = confusionFor(result, 'fault_valgus');
    expect(row).toBeDefined();
    expect(row?.truePositives).toBe(0);
    expect(row?.falsePositives).toBe(0);
    expect(row?.falseNegatives).toBe(2);
  });

  it('uses the default tolerance when none is provided', () => {
    expect(DEFAULT_TOLERANCE_MS).toBe(250);
  });
});
