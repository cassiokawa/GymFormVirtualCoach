/**
 * Hot-path ingest benchmark (Task 14, Requirement 2.2).
 *
 * The design's testing strategy names a hard steering budget: `ingest`
 * (signal + phase + faults, all 22 specs loaded) must stay ≤ 3 ms p95 per
 * frame on target hardware (see `tech.md` per-stage latency budgets, and
 * design.md "Testing strategy → Hot path"). Requirement 2.2 further demands
 * that the per-frame path do no parsing, no string work, and no heap
 * allocation — all of which live in `compileSpec` at load time, never in
 * `ingest`.
 *
 * ## Why this runs as a normal vitest test, not a bench runner
 *
 * The task asks to keep this in the normal suite so it exercises the full
 * `ingest` path on every run (a regression that made `ingest` allocate or
 * re-parse would show up as a latency blow-out). It is written to be tolerant
 * of CI jitter: shared runners are heavily contended and a hard 3 ms assertion
 * would flake constantly.
 *
 * ## The assertion strategy (deliberate, documented)
 *
 * - We MEASURE and LOG p50 / p95 / max per-ingest wall time.
 * - The 3 ms figure is the DESIGN TARGET on target hardware — we do NOT
 *   hard-assert it here because CI wall-clock is unreliable. Instead we assert
 *   against a generous CI-safe ceiling (`CI_SAFE_P95_MS`) that still catches a
 *   real regression (an accidental per-frame parse or large allocation pushes
 *   p95 well past this ceiling) without flaking on a noisy runner.
 * - We ALSO assert a correctness invariant during the run (reps are actually
 *   counted), so the benchmark exercises the full signal → phase → fault path
 *   and can never silently degrade into timing a no-op.
 *
 * ## Load model — "all 22 specs loaded"
 *
 * The budget is per-`ingest` for the ACTIVE spec while all specs are compiled
 * and resident in memory. Real exercise JSONs may not exist yet, so we
 * synthesise a representative set of ~22 specs (a realistic
 * `angle(hip,knee,ankle)` signal, a four-phase machine with guarded
 * transitions, and 2–3 phase-scoped faults each), compile every one (holding
 * all CompiledSpecs live), and load ONE into the engine to time its per-frame
 * cost. No exercise names are hardcoded — synthetic ids are `synthetic-<n>`.
 */

import { describe, it, expect } from 'vitest';
import { compileSpec, createAnalysisEngine, type CompiledSpec } from './engine';
import type { ExerciseSpec } from './spec';
import {
  LANDMARK_COUNT,
  type DomainEvent,
  type LandmarkFrame,
} from './types';

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * The design budget on TARGET hardware. Documented here, reported against, but
 * NOT hard-asserted in CI (wall-clock on shared runners is too noisy). See the
 * module header.
 */
const DESIGN_TARGET_P95_MS = 3;

/**
 * The CI-safe ceiling we DO assert. Generous enough to survive a contended
 * runner, tight enough that an accidental per-frame parse / heap allocation
 * (which would blow p95 into the tens of ms) is still caught.
 */
const CI_SAFE_P95_MS = 25;

/** How many synthetic specs are compiled and held resident. */
const SPEC_COUNT = 22;

// ---------------------------------------------------------------------------
// Synthetic spec factory — realistic squat-shaped, rep-mode exercise
// ---------------------------------------------------------------------------

/**
 * Build a representative rep-mode spec with a realistic knee-angle signal
 * (`angle(hip,knee,ankle)`), a four-phase machine, and three phase-scoped
 * faults. The id is a generic `synthetic-<n>` — never an exercise name.
 *
 * Signal convention: larger knee angle = more extended (standing); smaller =
 * deeper. So the descent drives the angle DOWN and the ascent brings it back UP.
 */
function makeSyntheticSpec(n: number): ExerciseSpec {
  return {
    id: `synthetic-${n}`,
    version: '1.0.0',
    displayName: `Synthetic ${n}`,
    aliases: [`syn-${n}`],
    facets: { equipment: 'none', primaryMuscles: ['quads'], position: 'standing' },
    mode: 'reps',
    bilateral: true,
    landmarkPairs: {
      hip: { left: 23, right: 24 },
      knee: { left: 25, right: 26 },
      ankle: { left: 27, right: 28 },
      shoulder: { left: 11, right: 12 },
    },
    requiredLandmarks: [11, 12, 23, 24, 25, 26, 27, 28],
    optionalLandmarks: [],
    camera: { preferredAngleDeg: 90, toleranceDeg: 20, view: 'side' },
    signal: {
      // A realistic three-point joint angle — the workhorse signal expression.
      expr: 'angle(hip,knee,ankle)',
      smoothing: { type: 'oneEuro', minCutoff: 30, beta: 0.5 },
    },
    rom: { source: 'calibration', floorPercentile: 10, gateTolerance: 0.15 },
    phases: {
      states: ['TOP', 'ECCENTRIC', 'BOTTOM', 'CONCENTRIC'],
      initial: 'TOP',
      hysteresisPct: 0.05,
      minPhaseDurationMs: 250,
      transitions: [
        { from: 'TOP', to: 'ECCENTRIC', when: 'signal < 150' },
        { from: 'ECCENTRIC', to: 'BOTTOM', when: 'signal < 95' },
        { from: 'BOTTOM', to: 'CONCENTRIC', when: 'signal > 110' },
        {
          from: 'CONCENTRIC',
          to: 'TOP',
          when: 'signal > 165',
          emits: 'RepCompleted',
        },
      ],
    },
    faults: [
      {
        id: `synthetic-${n}-fault-a`,
        phase: 'ECCENTRIC',
        when: "axis(knee,'x') inside axis(ankle,'x')",
        minDeviation: 0,
        severity: 'warning',
        cue: 'knees out',
      },
      {
        id: `synthetic-${n}-fault-b`,
        phase: 'BOTTOM',
        when: "axis(shoulder,'y') < axis(hip,'y')",
        minDeviation: 0,
        severity: 'info',
        cue: 'chest up',
      },
      {
        id: `synthetic-${n}-fault-c`,
        phase: 'CONCENTRIC',
        when: 'dSignal < 0',
        minDeviation: 0,
        severity: 'warning',
        cue: 'drive up',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Frame stream — a realistic triangle-driven knee-angle sweep
// ---------------------------------------------------------------------------

/**
 * Place landmarks so `angle(hip,knee,ankle)` evaluates to `angleDeg`, with full
 * landmark confidence. We keep the hip and ankle fixed and rotate the hip/ankle
 * around the knee to realise the requested interior angle at the knee vertex.
 *
 * The knee is the vertex at the origin; the ankle points straight down; the hip
 * arm is rotated by `angleDeg` from the ankle arm. This yields exactly
 * `angleDeg` at the knee.
 */
function frameForKneeAngle(t: number, angleDeg: number): LandmarkFrame {
  const points = new Float32Array(LANDMARK_COUNT * 3);
  const visibility = new Float32Array(LANDMARK_COUNT).fill(1);
  const presence = new Float32Array(LANDMARK_COUNT).fill(1);

  const rad = (angleDeg * Math.PI) / 180;

  // Knee vertex (25, 26) at origin.
  const kneeX = 0;
  const kneeY = 0;
  // Ankle arm (27, 28): straight down from the knee.
  const ankleX = 0;
  const ankleY = -1;
  // Hip arm (23, 24): rotated `angleDeg` from the down-pointing ankle arm.
  const hipX = Math.sin(rad);
  const hipY = -Math.cos(rad);

  // hip
  points[23 * 3] = hipX;
  points[23 * 3 + 1] = hipY;
  points[24 * 3] = hipX;
  points[24 * 3 + 1] = hipY;
  // knee
  points[25 * 3] = kneeX;
  points[25 * 3 + 1] = kneeY;
  points[26 * 3] = kneeX;
  points[26 * 3 + 1] = kneeY;
  // ankle
  points[27 * 3] = ankleX;
  points[27 * 3 + 1] = ankleY;
  points[28 * 3] = ankleX;
  points[28 * 3 + 1] = ankleY;

  // shoulder (11, 12): above the hip so the "chest up" guard stays false.
  points[11 * 3] = hipX;
  points[11 * 3 + 1] = hipY + 0.5;
  points[12 * 3] = hipX;
  points[12 * 3 + 1] = hipY + 0.5;

  return { t, points, visibility, presence };
}

/**
 * Build a long, realistic frame stream: repeated squat cycles as a triangle
 * sweep of the knee angle between an extended TOP (~175°) and a deep
 * BOTTOM (~80°), spaced 33 ms apart (~30 fps). Each phase dwells long enough to
 * clear the 250 ms min-phase-duration gate. Returns both the frames and the
 * number of full cycles (expected reps) so the run can assert rep parity.
 */
function buildFrameStream(cycles: number): {
  frames: LandmarkFrame[];
  expectedReps: number;
} {
  const frames: LandmarkFrame[] = [];
  const dtMs = 33;
  let t = 0;

  // One cycle: hold TOP, descend, hold BOTTOM, ascend. Values chosen to cross
  // each transition boundary (150 / 95 / 110 / 165) with margin, and to dwell
  // ≥ 250 ms (≈ 8 frames at 33 ms) in each phase.
  const topHold = [178, 178, 178, 178, 178, 178, 178, 178];
  const descend = [170, 160, 145, 130, 115, 100, 88, 82];
  const bottomHold = [80, 80, 80, 80, 80, 80, 80, 80];
  const ascend = [90, 100, 112, 128, 145, 160, 168, 178];
  const oneCycle = [...topHold, ...descend, ...bottomHold, ...ascend];

  for (let c = 0; c < cycles; c++) {
    for (const angle of oneCycle) {
      frames.push(frameForKneeAngle(t, angle));
      t += dtMs;
    }
  }

  return { frames, expectedReps: cycles };
}

// ---------------------------------------------------------------------------
// Percentile helper
// ---------------------------------------------------------------------------

/** Return the p-th percentile (0..100) of `samples` via nearest-rank. */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] as number;
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

describe('hot-path ingest benchmark (Req 2.2)', () => {
  it('measures per-ingest p50/p95/max with all 22 specs compiled and resident', () => {
    // Compile all ~22 synthetic specs and HOLD them live, so the measurement
    // reflects the memory footprint of "all specs loaded". We reference the
    // array after timing so the compiled forms cannot be GC'd away early.
    const compiled: CompiledSpec[] = [];
    for (let i = 0; i < SPEC_COUNT; i++) {
      compiled.push(compileSpec(makeSyntheticSpec(i), null));
    }
    expect(compiled).toHaveLength(SPEC_COUNT);

    // Activate ONE spec — the budget is per-ingest for the active spec.
    const engine = createAnalysisEngine();
    const active = compiled[0] as CompiledSpec;
    engine.load(active, null);

    const { frames, expectedReps } = buildFrameStream(20);

    // Warm-up pass: let the JIT settle and any first-call lazy work complete so
    // the measured pass reflects steady-state per-frame cost (also an implicit
    // allocation-sensitivity smoke: a hot path that allocated per frame would
    // not stabilise). We reset afterward so timing starts from a clean set.
    for (const f of frames) engine.ingest(f);
    engine.reset();

    // Measured pass: time each ingest individually and collect the domain
    // events so we can assert rep parity — proving the full path ran.
    const samples: number[] = new Array(frames.length);
    let repCount = 0;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i] as LandmarkFrame;
      const start = performance.now();
      const events: readonly DomainEvent[] = engine.ingest(frame);
      const end = performance.now();
      samples[i] = end - start;
      for (const e of events) {
        if (e.type === 'RepCompleted') repCount++;
      }
    }

    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const max = Math.max(...samples);

    // Report the real numbers next to the design target so a human reading CI
    // output can see how close the run is to the 3 ms budget.
    // eslint-disable-next-line no-console
    console.log(
      `[ingest bench] ${SPEC_COUNT} specs resident, ${frames.length} frames | ` +
        `p50=${p50.toFixed(4)}ms p95=${p95.toFixed(4)}ms max=${max.toFixed(4)}ms | ` +
        `design target p95 ≤ ${DESIGN_TARGET_P95_MS}ms (target hardware) | ` +
        `CI ceiling p95 ≤ ${CI_SAFE_P95_MS}ms`,
    );

    // Correctness invariant: the benchmark must exercise the full pipeline, not
    // a no-op. The triangle stream describes `expectedReps` full cycles; the
    // engine must count reps proportional to that (the very last cycle can be
    // clipped by where the stream ends relative to the rep-closing boundary, so
    // we allow one boundary rep of slack rather than asserting an exact count —
    // exact rep-count parity is Property 8's job, not this latency benchmark's).
    expect(repCount).toBeGreaterThan(0);
    expect(repCount).toBeGreaterThanOrEqual(expectedReps - 1);
    expect(repCount).toBeLessThanOrEqual(expectedReps);

    // Latency assertion: generous CI-safe ceiling (see module header). This is
    // NOT the design's 3 ms figure — that holds on target hardware and is only
    // reported here — but it still catches a per-frame parse/allocation
    // regression, which would push p95 far past this ceiling.
    expect(p95).toBeLessThanOrEqual(CI_SAFE_P95_MS);
  });
});
