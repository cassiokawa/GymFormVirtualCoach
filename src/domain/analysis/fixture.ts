/**
 * Fixture harness — replays an annotated landmark timeline through a compiled
 * ExerciseSpec and scores the engine's output against the fixture's annotations.
 *
 * A **Fixture** is the tested, exercise-agnostic ground truth for one spec: an
 * ordered timeline of landmark frames plus two kinds of annotation — the
 * expected rep timeline (when each rep should close) and the expected faults
 * (which fault fired around when). {@link replayFixture} drives every frame
 * through {@link AnalysisEngine.ingest}, collects the actual
 * {@link RepCompleted} and {@link FaultDetected} events, and produces:
 *
 *   1. an expected-vs-actual REP TIMELINE (Req 6.2), and
 *   2. a per-fault CONFUSION MATRIX (Req 6.3) — true positives, false
 *      positives, and false negatives per fault `id`.
 *
 * The harness is pure and deterministic: given the same spec, fixture, and
 * calibration it always produces the same result. It hardcodes NO exercise
 * `id`, name, or alias — the fixture carries its own target id as data, and the
 * spec's identity flows through as runtime values.
 *
 * ## Fixture format
 *
 * ```jsonc
 * {
 *   "specId": "some_movement",        // which spec this fixture exercises (data)
 *   "frames": [                        // ordered, ascending `t` (ms)
 *     {
 *       "t": 0,
 *       "landmarks": [                 // per-landmark, sparse OR full (0..32)
 *         { "index": 23, "x": 0.5, "y": 100, "z": 0, "visibility": 1, "presence": 1 }
 *       ]
 *     }
 *   ],
 *   "expectedReps": [                  // when each rep is expected to close
 *     { "repNumber": 1, "t": 1400 }
 *   ],
 *   "expectedFaults": [                // which fault, around when
 *     { "faultId": "fault_valgus", "t": 500 }
 *   ],
 *   "toleranceMs": 200                 // optional match window (default 250 ms)
 * }
 * ```
 *
 * Any landmark not named in a frame's `landmarks` defaults to coordinates `0`
 * with `visibility`/`presence` `1` (confidently present at the origin). This
 * lets a fixture stay compact — only the joints that matter are annotated.
 *
 * ## Matching rule
 *
 * A detected event MATCHES an annotation when they share the same identity
 * (rep: same `repNumber`; fault: same `faultId`) AND the detected timestamp
 * falls within ± `toleranceMs` of the annotation's `t`. Each annotation and
 * each detected event is consumed by at most one match (greedy nearest-first),
 * so duplicate detections cannot inflate the true-positive count.
 *
 * Requirements: 6.2, 6.3
 */

import { AnalysisEngine } from './engine';
import type { CompiledSpec } from './engine';
import { LANDMARK_COUNT } from './types';
import type {
  Calibration,
  DomainEvent,
  FaultDetected,
  LandmarkFrame,
  RepCompleted,
} from './types';

// ---------------------------------------------------------------------------
// Fixture format
// ---------------------------------------------------------------------------

/** Default ± window (ms) within which a detection matches an annotation. */
export const DEFAULT_TOLERANCE_MS = 250;

/**
 * One landmark's value within a fixture frame. `index` is the 0-based landmark
 * index (0..32). Coordinates are in the same normalised space the spec's signal
 * expression reads. `visibility`/`presence` default to `1` when omitted.
 */
export interface FixtureLandmark {
  /** 0-based landmark index into the 33-landmark array. */
  index: number;
  /** Normalised x coordinate. */
  x?: number;
  /** Normalised y coordinate. */
  y?: number;
  /** Normalised z coordinate. */
  z?: number;
  /** Visibility score `[0, 1]`; defaults to `1`. */
  visibility?: number;
  /** Presence score `[0, 1]`; defaults to `1`. */
  presence?: number;
}

/**
 * One annotated frame of the fixture timeline. `landmarks` may be sparse: any
 * landmark not listed defaults to `(0, 0, 0)` with `visibility`/`presence` `1`.
 */
export interface FixtureFrame {
  /** Capture timestamp in milliseconds; frames must ascend in `t`. */
  t: number;
  /** Per-landmark values for this frame (sparse or full). */
  landmarks: FixtureLandmark[];
}

/** An annotation marking when a rep is expected to close. */
export interface ExpectedRep {
  /** 1-based rep index expected within the set. */
  repNumber: number;
  /** Timestamp (ms) at which the rep is expected to close. */
  t: number;
}

/** An annotation marking a fault expected to fire near a timestamp. */
export interface ExpectedFault {
  /** Fault identifier declared in the spec. */
  faultId: string;
  /** Timestamp (ms) around which the fault is expected. */
  t: number;
}

/**
 * A complete fixture: an annotated landmark timeline plus the expected rep
 * timeline and expected faults. `specId` names the spec this fixture exercises
 * (data, never a TS literal in the engine).
 */
export interface Fixture {
  /** The spec id this fixture is authored for. */
  specId: string;
  /** Ordered timeline of annotated frames (ascending `t`). */
  frames: FixtureFrame[];
  /** Expected rep timeline. */
  expectedReps: ExpectedRep[];
  /** Expected faults (id + approximate time). */
  expectedFaults: ExpectedFault[];
  /** Match window (ms); defaults to {@link DEFAULT_TOLERANCE_MS} when omitted. */
  toleranceMs?: number;
}

// ---------------------------------------------------------------------------
// Replay result
// ---------------------------------------------------------------------------

/**
 * One row of the expected-vs-actual rep timeline. A row exists for every
 * expected rep and for every actual rep that could not be matched to one, so
 * the timeline shows misses (expected but not detected) and extras (detected
 * but not expected) side by side.
 */
export interface RepTimelineRow {
  /** Rep number this row concerns (from the annotation or the detection). */
  repNumber: number;
  /** Timestamp the fixture expected this rep to close, or `null` if none. */
  expectedT: number | null;
  /** Timestamp the engine actually closed this rep, or `null` if none. */
  actualT: number | null;
  /**
   * `matched` — expected and actual within tolerance; `missing` — expected but
   * not detected; `extra` — detected but not expected.
   */
  status: 'matched' | 'missing' | 'extra';
}

/**
 * Confusion-matrix counts for a single fault `id`. `truePositives` are detected
 * faults matched to an annotation within tolerance; `falsePositives` are
 * detections with no matching annotation; `falseNegatives` are annotations with
 * no matching detection.
 */
export interface FaultConfusion {
  /** The fault identifier these counts concern. */
  faultId: string;
  /** Detected faults matched to an annotation within tolerance. */
  truePositives: number;
  /** Detected faults with no matching annotation. */
  falsePositives: number;
  /** Annotations with no matching detection. */
  falseNegatives: number;
}

/** The full result of replaying a fixture through a compiled spec. */
export interface ReplayResult {
  /** The spec id replayed (echoed from {@link CompiledSpec.id}). */
  specId: string;
  /** Number of frames replayed. */
  frameCount: number;
  /** Expected count of reps from the fixture annotations. */
  expectedRepCount: number;
  /** Actual count of `RepCompleted` events the engine produced. */
  actualRepCount: number;
  /** The expected-vs-actual rep timeline, ordered by rep number then time. */
  repTimeline: RepTimelineRow[];
  /** Whether the actual rep timeline matches the expected timeline exactly. */
  repTimelineMatches: boolean;
  /** Per-fault confusion matrix, one row per fault id seen in either source. */
  faultConfusion: FaultConfusion[];
  /** Every domain event produced, in emission order (for detailed inspection). */
  events: DomainEvent[];
}

// ---------------------------------------------------------------------------
// Frame construction
// ---------------------------------------------------------------------------

/**
 * Build a real {@link LandmarkFrame} from a compact {@link FixtureFrame}. Every
 * landmark not named in `landmarks` defaults to `(0, 0, 0)` with
 * `visibility`/`presence` `1`. Named landmarks override those defaults.
 *
 * The resulting frame is a fresh, self-contained buffer — the harness does not
 * mutate or retain fixture input, keeping replay pure and deterministic.
 */
export function frameFromFixture(frame: FixtureFrame): LandmarkFrame {
  const points = new Float32Array(LANDMARK_COUNT * 3);
  const visibility = new Float32Array(LANDMARK_COUNT).fill(1);
  const presence = new Float32Array(LANDMARK_COUNT).fill(1);

  for (const lm of frame.landmarks) {
    const i = lm.index;
    if (!Number.isInteger(i) || i < 0 || i >= LANDMARK_COUNT) {
      throw new RangeError(
        `fixture landmark index ${i} out of range [0, ${LANDMARK_COUNT})`,
      );
    }
    points[i * 3] = lm.x ?? 0;
    points[i * 3 + 1] = lm.y ?? 0;
    points[i * 3 + 2] = lm.z ?? 0;
    visibility[i] = lm.visibility ?? 1;
    presence[i] = lm.presence ?? 1;
  }

  return { t: frame.t, points, visibility, presence };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Greedily match detected timestamps to expected timestamps within `tolerance`.
 * Each expected and each detected item is used at most once; matches are made
 * nearest-first so a duplicate detection cannot claim two annotations. Returns
 * the matched index pairs plus the unmatched indices on each side.
 */
function matchWithinTolerance(
  expected: readonly number[],
  detected: readonly number[],
  tolerance: number,
): {
  matched: Array<{ expectedIdx: number; detectedIdx: number }>;
  unmatchedExpected: number[];
  unmatchedDetected: number[];
} {
  // Build every candidate pair inside the window, then take them in ascending
  // time-distance order, skipping pairs whose endpoints are already claimed.
  const candidates: Array<{
    expectedIdx: number;
    detectedIdx: number;
    dist: number;
  }> = [];
  for (let e = 0; e < expected.length; e++) {
    const et = expected[e];
    if (et === undefined) continue;
    for (let d = 0; d < detected.length; d++) {
      const dt = detected[d];
      if (dt === undefined) continue;
      const dist = Math.abs(dt - et);
      if (dist <= tolerance) {
        candidates.push({ expectedIdx: e, detectedIdx: d, dist });
      }
    }
  }
  candidates.sort((a, b) => a.dist - b.dist);

  const expectedUsed = new Array<boolean>(expected.length).fill(false);
  const detectedUsed = new Array<boolean>(detected.length).fill(false);
  const matched: Array<{ expectedIdx: number; detectedIdx: number }> = [];

  for (const c of candidates) {
    if (expectedUsed[c.expectedIdx] || detectedUsed[c.detectedIdx]) continue;
    expectedUsed[c.expectedIdx] = true;
    detectedUsed[c.detectedIdx] = true;
    matched.push({ expectedIdx: c.expectedIdx, detectedIdx: c.detectedIdx });
  }

  const unmatchedExpected: number[] = [];
  for (let e = 0; e < expected.length; e++) {
    if (!expectedUsed[e]) unmatchedExpected.push(e);
  }
  const unmatchedDetected: number[] = [];
  for (let d = 0; d < detected.length; d++) {
    if (!detectedUsed[d]) unmatchedDetected.push(d);
  }

  return { matched, unmatchedExpected, unmatchedDetected };
}

// ---------------------------------------------------------------------------
// Rep timeline
// ---------------------------------------------------------------------------

/**
 * Build the expected-vs-actual rep timeline (Req 6.2). An expected rep matched
 * to an actual rep within tolerance becomes a `matched` row; an unmatched
 * expected rep becomes `missing`; an unmatched actual rep becomes `extra`. Rows
 * are sorted by rep number, then by whichever timestamp is present.
 *
 * Reps are matched on `repNumber` first (an expected rep only pairs with an
 * actual rep of the same number) and then required to fall within the window,
 * so a mis-timed rep of the right number still shows as a `missing`/`extra`
 * pair rather than a spurious match.
 */
function buildRepTimeline(
  expectedReps: readonly ExpectedRep[],
  actualReps: readonly RepCompleted[],
  tolerance: number,
): { rows: RepTimelineRow[]; matches: boolean } {
  const rows: RepTimelineRow[] = [];

  // Group by rep number so numbers are compared like-for-like.
  const numbers = new Set<number>();
  const expectedByNum = new Map<number, ExpectedRep[]>();
  const actualByNum = new Map<number, RepCompleted[]>();
  for (const e of expectedReps) {
    numbers.add(e.repNumber);
    (expectedByNum.get(e.repNumber) ?? setDefault(expectedByNum, e.repNumber)).push(e);
  }
  for (const a of actualReps) {
    numbers.add(a.repNumber);
    (actualByNum.get(a.repNumber) ?? setDefault(actualByNum, a.repNumber)).push(a);
  }

  for (const num of [...numbers].sort((a, b) => a - b)) {
    const exp = expectedByNum.get(num) ?? [];
    const act = actualByNum.get(num) ?? [];
    const expTs = exp.map((e) => e.t);
    const actTs = act.map((a) => a.t);
    const { matched, unmatchedExpected, unmatchedDetected } = matchWithinTolerance(
      expTs,
      actTs,
      tolerance,
    );
    for (const m of matched) {
      rows.push({
        repNumber: num,
        expectedT: expTs[m.expectedIdx] ?? null,
        actualT: actTs[m.detectedIdx] ?? null,
        status: 'matched',
      });
    }
    for (const e of unmatchedExpected) {
      rows.push({ repNumber: num, expectedT: expTs[e] ?? null, actualT: null, status: 'missing' });
    }
    for (const d of unmatchedDetected) {
      rows.push({ repNumber: num, expectedT: null, actualT: actTs[d] ?? null, status: 'extra' });
    }
  }

  rows.sort((a, b) => {
    if (a.repNumber !== b.repNumber) return a.repNumber - b.repNumber;
    const at = a.expectedT ?? a.actualT ?? 0;
    const bt = b.expectedT ?? b.actualT ?? 0;
    return at - bt;
  });

  const matches = rows.every((r) => r.status === 'matched');
  return { rows, matches };
}

/** Create-and-store an empty array for `key` in `map`, returning it. */
function setDefault<K, V>(map: Map<K, V[]>, key: K): V[] {
  const arr: V[] = [];
  map.set(key, arr);
  return arr;
}

// ---------------------------------------------------------------------------
// Fault confusion matrix
// ---------------------------------------------------------------------------

/**
 * Build the per-fault confusion matrix (Req 6.3). For each fault `id` seen in
 * either the annotations or the detections, count true positives (a detection
 * matched to an annotation of the same id within tolerance), false positives
 * (unmatched detections), and false negatives (unmatched annotations). Rows are
 * ordered by fault id for stable output.
 */
function buildFaultConfusion(
  expectedFaults: readonly ExpectedFault[],
  actualFaults: readonly FaultDetected[],
  tolerance: number,
): FaultConfusion[] {
  const ids = new Set<string>();
  const expectedById = new Map<string, number[]>();
  const actualById = new Map<string, number[]>();
  for (const e of expectedFaults) {
    ids.add(e.faultId);
    (expectedById.get(e.faultId) ?? setDefault(expectedById, e.faultId)).push(e.t);
  }
  for (const a of actualFaults) {
    ids.add(a.faultId);
    (actualById.get(a.faultId) ?? setDefault(actualById, a.faultId)).push(a.t);
  }

  const rows: FaultConfusion[] = [];
  for (const id of [...ids].sort()) {
    const exp = expectedById.get(id) ?? [];
    const act = actualById.get(id) ?? [];
    const { matched, unmatchedExpected, unmatchedDetected } = matchWithinTolerance(
      exp,
      act,
      tolerance,
    );
    rows.push({
      faultId: id,
      truePositives: matched.length,
      falsePositives: unmatchedDetected.length,
      falseNegatives: unmatchedExpected.length,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// replayFixture
// ---------------------------------------------------------------------------

/**
 * Replay a fixture's annotated landmark timeline through a compiled spec and
 * score the engine's output against the fixture annotations.
 *
 * Pure and deterministic. A fresh {@link AnalysisEngine} is created and loaded
 * for the call, every frame is ingested in `t` order, and the collected
 * {@link RepCompleted}/{@link FaultDetected} events are compared against the
 * fixture's `expectedReps`/`expectedFaults` using the ± `toleranceMs` match
 * rule. Produces the expected-vs-actual rep timeline (Req 6.2) and the per-fault
 * confusion matrix (Req 6.3).
 *
 * @param spec        the compiled spec to drive
 * @param fixture     the annotated timeline + expectations
 * @param calibration optional calibration passed to {@link AnalysisEngine.load}
 */
export function replayFixture(
  spec: CompiledSpec,
  fixture: Fixture,
  calibration: Calibration | null = null,
): ReplayResult {
  const tolerance = fixture.toleranceMs ?? DEFAULT_TOLERANCE_MS;

  const engine = new AnalysisEngine();
  engine.load(spec, calibration);

  const events: DomainEvent[] = [];
  const actualReps: RepCompleted[] = [];
  const actualFaults: FaultDetected[] = [];

  for (const fFrame of fixture.frames) {
    const frame = frameFromFixture(fFrame);
    for (const ev of engine.ingest(frame)) {
      events.push(ev);
      if (ev.type === 'RepCompleted') actualReps.push(ev);
      else if (ev.type === 'FaultDetected') actualFaults.push(ev);
    }
  }

  const { rows: repTimeline, matches: repTimelineMatches } = buildRepTimeline(
    fixture.expectedReps,
    actualReps,
    tolerance,
  );
  const faultConfusion = buildFaultConfusion(
    fixture.expectedFaults,
    actualFaults,
    tolerance,
  );

  return {
    specId: spec.id,
    frameCount: fixture.frames.length,
    expectedRepCount: fixture.expectedReps.length,
    actualRepCount: actualReps.length,
    repTimeline,
    repTimelineMatches,
    faultConfusion,
    events,
  };
}
