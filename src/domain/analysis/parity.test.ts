/**
 * Migration parity gate (task 15).
 *
 * The design's testing strategy calls for a "migration parity" check: run the
 * old and new implementations over all fixtures and *block merge on any
 * rep-count regression relative to the human-annotated fixtures*. The essential,
 * testable guarantee behind that framing is:
 *
 *   The new engine's rep counts over the annotated fixtures MUST match the
 *   fixtures' expected (human-annotated) rep timelines, and any mismatch MUST
 *   fail the build.
 *
 * This file is that gate. It is a normal vitest test, so it runs in `npm test`
 * and therefore blocks CI on any regression. An optional `gate:parity` script
 * runs this file alone for a fast, focused check.
 *
 * ## What the gate does
 *
 *   1. DISCOVERS every fixture under `src/domain/exercises/fixtures/**` /*.json`.
 *      There may be zero fixtures right now — the gate handles that gracefully:
 *      it passes but LOGS a loud warning so it can never *silently* pass forever
 *      once fixtures are expected to exist.
 *   2. For each discovered fixture, loads its spec (matched by `specId`),
 *      compiles it, replays the fixture through {@link replayFixture}, and
 *      asserts EXACT rep-count parity plus a fully-matched rep timeline (every
 *      row `matched`, within the fixture's documented tolerance). Any miss/extra
 *      row fails the gate — that is the block-on-regression behaviour.
 *   3. Proves the gate LOGIC itself on synthesized in-test fixtures so the gate
 *      is meaningful today even before any on-disk fixtures land:
 *        (a) a correct-engine fixture with a known N-cycle timeline replays to
 *            exactly N reps and a matched timeline (the gate ACCEPTS a correct
 *            engine); and
 *        (b) a divergent fixture whose annotated timeline deliberately differs
 *            from what the engine produces (the gate DETECTS the divergence and
 *            would block).
 *
 * No exercise `id`, name, or alias is hardcoded in this file: the synthesized
 * fixtures carry their own ids as data, and on-disk fixtures/specs flow through
 * as runtime values discovered by glob.
 *
 * Requirements: 3.5, 6.2
 */

import { describe, it, expect } from 'vitest';
import { compileSpec } from './engine';
import { loadSpecFromJson } from './loader';
import { replayFixture, type Fixture, type FixtureFrame, type ReplayResult } from './fixture';
import type { ExerciseSpec } from './spec';

// ---------------------------------------------------------------------------
// Fixture + spec discovery (glob, no hardcoded exercise identity)
// ---------------------------------------------------------------------------

/**
 * `import.meta.glob` is a Vite/Vitest extension not present in the TypeScript
 * lib, so we reach it through the same narrow cast the loader uses. Under a
 * non-Vite runner the glob is absent and discovery yields nothing — the gate
 * then falls back to its "no fixtures found" path rather than throwing.
 */
type GlobFn = (
  pattern: string,
  options: { eager: true; import: 'default' },
) => Record<string, unknown>;

function glob(pattern: string): Record<string, unknown> {
  const g = (import.meta as unknown as { glob?: GlobFn }).glob;
  if (typeof g !== 'function') return {};
  return g(pattern, { eager: true, import: 'default' });
}

/** A discovered on-disk fixture paired with the path it came from. */
interface DiscoveredFixture {
  path: string;
  fixture: Fixture;
}

/**
 * Discover every fixture JSON under `src/domain/exercises/fixtures/**`. The glob
 * pattern is the only source of fixtures, so no exercise identity is named in
 * TypeScript. Returns `[]` when the directory holds no fixtures.
 */
function discoverFixtures(): DiscoveredFixture[] {
  const modules = glob('../exercises/fixtures/**/*.json');
  return Object.keys(modules)
    .sort()
    .map((path) => ({ path, fixture: modules[path] as Fixture }));
}

/**
 * Discover every exercise spec JSON under `src/domain/exercises` (excluding the
 * fixtures subtree, which is matched separately) and index it by `id`. Parsing
 * goes through {@link loadSpecFromJson} so a malformed spec fails loudly.
 */
function discoverSpecsById(): Map<string, ExerciseSpec> {
  const modules = glob('../exercises/**/*.json');
  const byId = new Map<string, ExerciseSpec>();
  for (const path of Object.keys(modules).sort()) {
    // Skip anything under the fixtures subtree — those are fixtures, not specs.
    if (path.includes('/fixtures/')) continue;
    const spec = loadSpecFromJson(modules[path]);
    byId.set(spec.id, spec);
  }
  return byId;
}

// ---------------------------------------------------------------------------
// The parity assertion — the single source of "does the engine match ground
// truth". Used by both the on-disk gate and the synthesized proof fixtures.
// ---------------------------------------------------------------------------

/**
 * Assert that a replay result reflects EXACT parity with the fixture's
 * human-annotated rep timeline: the actual rep count equals the expected count,
 * and every timeline row is `matched` (no `missing`, no `extra`) within the
 * fixture's documented tolerance. Throws with a descriptive message otherwise —
 * this is the block-on-regression behaviour.
 */
function assertRepTimelineParity(result: ReplayResult, label: string): void {
  const misses = result.repTimeline.filter((r) => r.status === 'missing');
  const extras = result.repTimeline.filter((r) => r.status === 'extra');
  const detail =
    `${label}: expected ${result.expectedRepCount} rep(s), got ${result.actualRepCount}; ` +
    `${misses.length} missing, ${extras.length} extra`;

  expect(result.actualRepCount, detail).toBe(result.expectedRepCount);
  expect(misses, detail).toHaveLength(0);
  expect(extras, detail).toHaveLength(0);
  expect(result.repTimelineMatches, detail).toBe(true);
}

// ---------------------------------------------------------------------------
// On-disk fixture gate — the actual regression gate over shipped fixtures.
// ---------------------------------------------------------------------------

describe('migration parity gate — on-disk fixtures (Req 3.5, 6.2)', () => {
  const fixtures = discoverFixtures();
  const specsById = discoverSpecsById();

  if (fixtures.length === 0) {
    // GRACEFUL EMPTY PATH: with no fixtures the gate passes trivially, but it
    // must not do so SILENTLY — otherwise a fixture regression could hide behind
    // an empty directory forever. Log loudly and record a passing marker test so
    // the empty state is visible in the run output.
    it('passes trivially when no fixtures exist, but logs that none were found', () => {
      // eslint-disable-next-line no-console
      console.warn(
        '[parity gate] No fixtures found under src/domain/exercises/fixtures/**' +
          '/*.json. The rep-count regression gate has nothing to check. Add an ' +
          'annotated fixture per exercise spec so the gate can enforce parity.',
      );
      expect(fixtures).toHaveLength(0);
    });
  } else {
    for (const { path, fixture } of fixtures) {
      it(`rep-count parity for fixture ${path} (spec "${fixture.specId}")`, () => {
        const spec = specsById.get(fixture.specId);
        expect(
          spec,
          `fixture ${path} references specId "${fixture.specId}" but no matching ` +
            `spec was found under src/domain/exercises`,
        ).toBeDefined();

        const compiled = compileSpec(spec as ExerciseSpec, null);
        const result = replayFixture(compiled, fixture);
        assertRepTimelineParity(result, `fixture ${path}`);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Gate-logic proof — synthesized fixtures that prove the gate both ACCEPTS a
// correct engine and DETECTS a divergence, deterministically, right now.
// ---------------------------------------------------------------------------

/**
 * A squat-shaped, rep-mode spec. The signal is the y-position of the `hip` joint
 * via `axis(hip,'y')` (lower = deeper). `id`/`displayName`/`aliases` are data
 * literals confined to this test, never referenced by engine code.
 *   phases: TOP -> ECCENTRIC -> BOTTOM -> CONCENTRIC -> TOP
 *   CONCENTRIC -> TOP emits RepCompleted.
 */
function makeSyntheticSpec(): ExerciseSpec {
  return {
    id: 'parity_synth_movement',
    version: '1.0.0',
    displayName: 'Parity Synth Movement',
    aliases: ['parity-synth'],
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
    faults: [],
  };
}

// One rep's worth of hip-height samples, spaced 100 ms; dwells clear the 250 ms
// min-phase gate. The rep closes on the ascending crossing above 90.
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

/** A synthesized timeline of `n` rep cycles + the t of each rep-close frame. */
interface BuiltTimeline {
  frames: FixtureFrame[];
  repCloseTimes: number[];
}

function buildTimeline(n: number, startT = 0): BuiltTimeline {
  const frames: FixtureFrame[] = [];
  const repCloseTimes: number[] = [];
  let t = startT;

  for (let rep = 0; rep < n; rep++) {
    let prevY = REP_HEIGHTS[0] ?? 100;
    for (let i = 0; i < REP_HEIGHTS.length; i++) {
      const y = REP_HEIGHTS[i] ?? 100;
      frames.push({
        t,
        landmarks: [
          { index: 23, x: 0.5, y },
          { index: 24, x: 0.5, y },
          { index: 25, x: 0.6 },
          { index: 26, x: 0.6 },
          { index: 27, x: 0.4 },
          { index: 28, x: 0.4 },
        ],
      });
      if (prevY <= 90 && y > 90) repCloseTimes.push(t);
      prevY = y;
      t += FRAME_MS;
    }
  }
  return { frames, repCloseTimes };
}

describe('migration parity gate — gate logic proof (Req 3.5, 6.2)', () => {
  it('ACCEPTS a correct engine: a known N-cycle timeline replays to exactly N reps', () => {
    const compiled = compileSpec(makeSyntheticSpec(), null);
    const N = 3;
    const built = buildTimeline(N);

    // Human-annotated ground truth: one rep expected at each true close time.
    const fixture: Fixture = {
      specId: 'parity_synth_movement',
      frames: built.frames,
      expectedReps: built.repCloseTimes.map((t, i) => ({ repNumber: i + 1, t })),
      expectedFaults: [],
      // Absorb smoothing/hysteresis lag while still enforcing exact count parity.
      toleranceMs: 400,
    };

    const result = replayFixture(compiled, fixture);

    // The gate accepts: exact count + fully-matched timeline, no throw.
    expect(result.actualRepCount).toBe(N);
    assertRepTimelineParity(result, 'accept-case');
  });

  it('DETECTS a divergence: an annotated timeline that differs from the engine fails the gate', () => {
    const compiled = compileSpec(makeSyntheticSpec(), null);
    // Engine will produce exactly 2 reps from this timeline...
    const built = buildTimeline(2);

    // ...but the human annotation deliberately claims THREE reps, the third at a
    // time no rep can occur (well past the end of the timeline). A correct gate
    // must flag the missing third rep and refuse to pass. Deterministic: the
    // engine's output is fixed, and the extra annotation cannot be matched.
    const divergentFixture: Fixture = {
      specId: 'parity_synth_movement',
      frames: built.frames,
      expectedReps: [
        { repNumber: 1, t: built.repCloseTimes[0] ?? 0 },
        { repNumber: 2, t: built.repCloseTimes[1] ?? 0 },
        { repNumber: 3, t: (built.repCloseTimes[1] ?? 0) + 100_000 },
      ],
      expectedFaults: [],
      toleranceMs: 400,
    };

    const result = replayFixture(compiled, divergentFixture);

    // Sanity: the engine really did produce 2 reps, not 3.
    expect(result.actualRepCount).toBe(2);
    expect(result.expectedRepCount).toBe(3);

    // The gate DETECTS the divergence: repTimelineMatches is false, and the
    // parity assertion the on-disk gate uses would throw for this fixture. We
    // assert that it throws, proving the gate actually blocks a regression.
    expect(result.repTimelineMatches).toBe(false);
    expect(() => assertRepTimelineParity(result, 'reject-case')).toThrow();
  });

  it('DETECTS an extra rep: engine produces more reps than annotated', () => {
    const compiled = compileSpec(makeSyntheticSpec(), null);
    // Engine produces 2 reps, but only 1 is annotated: the second is an extra.
    const built = buildTimeline(2);
    const fixture: Fixture = {
      specId: 'parity_synth_movement',
      frames: built.frames,
      expectedReps: [{ repNumber: 1, t: built.repCloseTimes[0] ?? 0 }],
      expectedFaults: [],
      toleranceMs: 400,
    };

    const result = replayFixture(compiled, fixture);

    expect(result.actualRepCount).toBe(2);
    expect(result.expectedRepCount).toBe(1);
    expect(result.repTimelineMatches).toBe(false);
    expect(() => assertRepTimelineParity(result, 'extra-case')).toThrow();
  });
});
