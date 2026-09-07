import { describe, it, expect } from 'vitest';
import { compileSpec, createAnalysisEngine, type CompiledSpec } from './engine';
import type { ExerciseSpec } from './spec';
import {
  UNAVAILABLE,
  LANDMARK_COUNT,
  type Calibration,
  type DomainEvent,
  type FaultDetected,
  type LandmarkFrame,
  type RepCompleted,
} from './types';

// ---------------------------------------------------------------------------
// Synthetic spec + fixtures
//
// A squat-shaped, rep-mode spec. The signal is the y-position of the `hip`
// joint (via `axis(hip,'y')`); we drive it with a triangle wave so the phase
// machine sees a clean up/down cycle per rep. No exercise identity leaks here:
// `id`/`displayName`/`aliases` are data literals confined to this fixture, not
// referenced by the engine code under test.
//
// Signal convention across the engine: lower = deeper. So a squat descends to a
// small signal at the bottom and rises back to a large signal at the top.
//
//   phases: TOP -> ECCENTRIC -> BOTTOM -> CONCENTRIC -> TOP
//   the CONCENTRIC -> TOP transition emits RepCompleted.
// ---------------------------------------------------------------------------

const HIP_PAIR = { left: 23, right: 24 } as const;

/** Build a spec driven by `axis(hip,'y')`, with a knee-valgus-style fault. */
function makeSpec(overrides: Partial<ExerciseSpec> = {}): ExerciseSpec {
  const spec: ExerciseSpec = {
    id: 'fixture_movement_a',
    version: '1.0.0',
    displayName: 'Fixture Movement A',
    aliases: ['fixture-a'],
    facets: { equipment: 'none', primaryMuscles: ['quads'], position: 'standing' },
    mode: 'reps',
    bilateral: true,
    landmarkPairs: {
      hip: { left: HIP_PAIR.left, right: HIP_PAIR.right },
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
        // Descending past the high threshold: begin eccentric.
        { from: 'TOP', to: 'ECCENTRIC', when: 'signal < 70' },
        // Reached depth: bottom.
        { from: 'ECCENTRIC', to: 'BOTTOM', when: 'signal < 30' },
        // Rising off the bottom: concentric.
        { from: 'BOTTOM', to: 'CONCENTRIC', when: 'signal > 40' },
        // Back to the top closes the rep.
        { from: 'CONCENTRIC', to: 'TOP', when: 'signal > 90', emits: 'RepCompleted' },
      ],
    },
    faults: [
      // Knee tracked medially inside the ankle during ECCENTRIC.
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
  return { ...spec, ...overrides };
}

/**
 * Build a frame placing the `hip` landmarks at height `y` (both sides equal so
 * the bilateral midpoint is exactly `y`), knee/ankle confidently present. `x`
 * of knee/ankle default to a non-valgus arrangement (|knee.x| > |ankle.x|).
 */
function frameAtHeight(
  t: number,
  y: number,
  opts: { valgus?: boolean; lowConfidence?: number[] } = {},
): LandmarkFrame {
  const points = new Float32Array(LANDMARK_COUNT * 3);
  const visibility = new Float32Array(LANDMARK_COUNT).fill(1);
  const presence = new Float32Array(LANDMARK_COUNT).fill(1);

  // hip landmarks (23, 24): y set to the driven signal value.
  points[23 * 3 + 1] = y;
  points[24 * 3 + 1] = y;

  // knee (25,26) / ankle (27,28): x arranged so the valgus guard is
  // false by default (knee farther from midline than ankle).
  const kneeX = opts.valgus ? 0.1 : 0.6;
  const ankleX = 0.4;
  points[25 * 3] = kneeX;
  points[26 * 3] = kneeX;
  points[27 * 3] = ankleX;
  points[28 * 3] = ankleX;

  for (const idx of opts.lowConfidence ?? []) {
    visibility[idx] = 0;
    presence[idx] = 0;
  }
  return { t, points, visibility, presence };
}

/**
 * Drive one full rep cycle through the engine, returning all events emitted.
 * Frames are spaced 100 ms apart starting at `startT`. The triangle path is
 * TOP(100) -> BOTTOM(10) -> TOP(100), dwelling long enough at each phase to
 * clear the 250 ms min-phase-duration gate.
 *
 * @param valgus when true, the descent frames trigger the ECCENTRIC valgus fault
 */
function driveRep(
  engine: ReturnType<typeof createAnalysisEngine>,
  startT: number,
  valgus = false,
): { events: DomainEvent[]; endT: number } {
  const events: DomainEvent[] = [];
  // A descending then ascending ramp. Each value dwells via repeated frames so
  // every phase satisfies minPhaseDurationMs (250 ms) before transitioning.
  const heights = [
    100, 100, 100, // TOP dwell
    80, 60, // crossing 70 -> ECCENTRIC
    40, 20, 10, // crossing 30 -> BOTTOM (dwell)
    10, 10,
    35, 55, // crossing 40 -> CONCENTRIC
    75, 95, // dwell then crossing 90 -> TOP (rep closes)
    100, 100,
  ];
  let t = startT;
  for (const y of heights) {
    const frame = frameAtHeight(t, y, { valgus });
    for (const e of engine.ingest(frame)) events.push(e);
    t += 100;
  }
  return { events, endT: t };
}

function reps(events: readonly DomainEvent[]): RepCompleted[] {
  return events.filter((e): e is RepCompleted => e.type === 'RepCompleted');
}

function faults(events: readonly DomainEvent[]): FaultDetected[] {
  return events.filter((e): e is FaultDetected => e.type === 'FaultDetected');
}

// ---------------------------------------------------------------------------
// compileSpec — Req 1.2 (fields preserved into the CompiledSpec meta)
// ---------------------------------------------------------------------------

describe('compileSpec (Req 1.2)', () => {
  it('projects the declared spec fields into CompiledSpec.meta', () => {
    const spec = makeSpec();
    const compiled = compileSpec(spec, null);

    expect(compiled.id).toBe(spec.id);
    expect(compiled.meta.id).toBe(spec.id);
    expect(compiled.meta.version).toBe(spec.version);
    expect(compiled.meta.displayName).toBe(spec.displayName);
    expect(compiled.meta.mode).toBe('reps');
    expect(compiled.meta.bilateral).toBe(true);
    expect(compiled.meta.requiredLandmarks).toEqual(spec.requiredLandmarks);
    expect(compiled.meta.camera.view).toBe('side');
  });

  it('compiles the signal, machine, and fault evaluator', () => {
    const compiled = compileSpec(makeSpec(), null);
    expect(typeof compiled.signal).toBe('function');
    expect(compiled.machine.currentPhase).toBe('TOP');
    expect(compiled.faults).toBeDefined();
  });

  it('compiles a velocity config when present, and null when absent', () => {
    const withVel = compileSpec(
      makeSpec({
        velocity: { trackedPoint: 'midpoint(left_hip,right_hip)', axis: 'y', normalizeBy: 'femur' },
      }),
      null,
    );
    expect(withVel.velocity).not.toBeNull();
    expect(withVel.velocity?.axis).toBe('y');

    const noVel = compileSpec(makeSpec(), null);
    expect(noVel.velocity).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ingest — full synthetic set produces the expected rep count (Req 3.5)
// and phase-scoped faults (Req 4.4)
// ---------------------------------------------------------------------------

describe('AnalysisEngine.ingest — synthetic set', () => {
  it('counts exactly N RepCompleted events for N synthetic cycles', () => {
    const engine = createAnalysisEngine();
    engine.load(compileSpec(makeSpec(), null), null);

    const all: DomainEvent[] = [];
    let t = 0;
    const N = 3;
    for (let i = 0; i < N; i++) {
      const { events, endT } = driveRep(engine, t);
      all.push(...events);
      t = endT;
    }

    const completed = reps(all);
    expect(completed).toHaveLength(N);
    expect(completed.map((r) => r.repNumber)).toEqual([1, 2, 3]);
  });

  it('emits FaultDetected during ECCENTRIC when the guard is confidently true', () => {
    const engine = createAnalysisEngine();
    engine.load(compileSpec(makeSpec(), null), null);

    const { events } = driveRep(engine, 0, /* valgus */ true);
    const detected = faults(events);

    expect(detected.length).toBeGreaterThan(0);
    for (const f of detected) {
      expect(f.faultId).toBe('fault_valgus');
      expect(f.phase).toBe('ECCENTRIC');
      expect(f.cue).toBe('knees out');
      expect(f.severity).toBe('warning');
    }
  });

  it('emits no faults when the guard is false', () => {
    const engine = createAnalysisEngine();
    engine.load(compileSpec(makeSpec(), null), null);
    const { events } = driveRep(engine, 0, /* valgus */ false);
    expect(faults(events)).toHaveLength(0);
  });

  it('returns a (frozen) empty array on a quiet frame and does not throw before load', () => {
    const engine = createAnalysisEngine();
    // Before load: inert, no events.
    expect(engine.ingest(frameAtHeight(0, 100))).toEqual([]);

    engine.load(compileSpec(makeSpec(), null), null);
    // A single steady TOP frame produces no events.
    const out = engine.ingest(frameAtHeight(0, 100));
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Frame-not-retained guarantee
// ---------------------------------------------------------------------------

describe('AnalysisEngine.ingest — frame retention', () => {
  it('does not retain the frame reference after ingest returns', () => {
    const engine = createAnalysisEngine();
    engine.load(compileSpec(makeSpec(), null), null);

    // Mutating the frame after ingest must not change any produced event, and
    // the engine must hold no reference we can observe via a later ingest.
    const frame = frameAtHeight(0, 100);
    const events = engine.ingest(frame);
    const before = JSON.stringify(events);

    // Corrupt the buffer the engine "had" — if it retained the reference and
    // read from it lazily, a subsequent read would change. It must not.
    frame.points.fill(-999);
    frame.visibility.fill(0);
    expect(JSON.stringify(events)).toBe(before);

    // A fresh frame drives normally; the engine derived its state from copied
    // numbers, not from the retained (now-corrupted) previous frame.
    const next = engine.ingest(frameAtHeight(100, 100));
    expect(Array.isArray(next)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Calibration version mismatch (Req 6.4)
// ---------------------------------------------------------------------------

describe('AnalysisEngine.load — calibration version (Req 6.4)', () => {
  const goodCalib: Calibration = {
    romFloor: 15,
    romTop: 100,
    velocityThreshold: 0.2,
    version: '1.0.0',
  };

  it('keeps a matching-version calibration and does not prompt recalibration', () => {
    const engine = createAnalysisEngine();
    engine.load(compileSpec(makeSpec(), goodCalib), goodCalib);
    expect(engine.needsRecalibration()).toBe(false);
  });

  it('invalidates a version-mismatched calibration and prompts recalibration', () => {
    const engine = createAnalysisEngine();
    const stale: Calibration = { ...goodCalib, version: '0.9.0' };
    const compiled = compileSpec(makeSpec(), stale);
    engine.load(compiled, stale);

    expect(engine.needsRecalibration()).toBe(true);

    // The ROM gate is skipped when calibration is invalidated, so a shallow rep
    // still passes the gate (uncalibrated default is romGatePassed: true).
    const { events } = driveRep(engine, 0);
    const completed = reps(events);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.romGatePassed).toBe(true);
  });

  it('treats a null calibration as uncalibrated without prompting', () => {
    const engine = createAnalysisEngine();
    engine.load(compileSpec(makeSpec(), null), null);
    expect(engine.needsRecalibration()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reset — clears across-frame state
// ---------------------------------------------------------------------------

describe('AnalysisEngine.reset', () => {
  it('clears rep and phase state so the next set starts fresh', () => {
    const compiled: CompiledSpec = compileSpec(makeSpec(), null);
    const engine = createAnalysisEngine();
    engine.load(compiled, null);

    driveRep(engine, 0);
    expect(compiled.machine.completedReps).toBe(1);
    expect(compiled.machine.currentPhase).toBe('TOP');

    engine.reset();
    expect(compiled.machine.completedReps).toBe(0);
    expect(compiled.machine.currentPhase).toBe('TOP');
    expect(compiled.machine.repMinSignal).toBe(UNAVAILABLE);
    expect(engine.needsRecalibration()).toBe(false);

    // After reset a fresh set counts from rep 1 again.
    const { events } = driveRep(engine, 0);
    expect(reps(events).map((r) => r.repNumber)).toEqual([1]);
  });
});
