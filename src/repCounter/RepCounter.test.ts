/**
 * Unit tests for RepCounter.
 *
 * Focus: correct rep counting for a clean movement cycle, resistance to
 * pose-estimation jitter (the debounce), and that the deadlift/squat configs
 * count real reps 1:1 rather than over-counting.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.5, 2.6
 */

import { describe, it, expect } from 'vitest';
import { RepCounter } from './RepCounter.js';
import { squatConfig, deadliftConfig, allConfigs, validateFSMConfig, transitionRangesDisjoint, ISOMETRIC_HOLDS } from '../config/exerciseConfigs.js';
import type { ExerciseFSMConfig, KeypointMessage, Keypoint } from '../types/index.js';

// ---------------------------------------------------------------------------
// Keypoint synthesis: build a frame whose tracked joints resolve to a target
// angle. We construct each joint triplet [proximal, center, distal] so the
// interior angle at `center` equals `deg`.
// ---------------------------------------------------------------------------

const JOINT_MAP: Record<string, [number, number, number]> = {
  left_knee: [23, 25, 27],
  right_knee: [24, 26, 28],
  left_hip: [11, 23, 25],
  right_hip: [12, 24, 26],
  left_elbow: [11, 13, 15],
  right_elbow: [12, 14, 16],
  left_shoulder: [13, 11, 23],
  right_shoulder: [14, 12, 24],
};

/** Place three points so the interior angle at B equals `deg` degrees. */
function tripletFor(deg: number): { a: [number, number]; b: [number, number]; c: [number, number] } {
  // B at origin-ish; A straight up; C at angle `deg` from A around B.
  const rad = (deg * Math.PI) / 180;
  const bx = 0.5;
  const by = 0.5;
  const len = 0.2;
  // A directly above B.
  const a: [number, number] = [bx, by - len];
  // C rotated `deg` from the B->A direction.
  const c: [number, number] = [bx + len * Math.sin(rad), by - len * Math.cos(rad)];
  return { a: [bx, by - len] === a ? a : a, b: [bx, by], c };
}

function makeFrame(config: ExerciseFSMConfig, deg: number, frameId: number): KeypointMessage {
  // 33 default keypoints, all low-confidence/off; we set only the tracked joints.
  const kps: Keypoint[] = Array.from({ length: 33 }, (_, index) => ({
    index, x: 0.5, y: 0.5, z: 0, confidence: 0,
  }));

  for (const joint of config.joints) {
    const idx = JOINT_MAP[joint];
    if (!idx) continue;
    const { a, b, c } = tripletFor(deg);
    const [ai, bi, ci] = idx;
    kps[ai] = { index: ai, x: a[0], y: a[1], z: 0, confidence: 0.9 };
    kps[bi] = { index: bi, x: b[0], y: b[1], z: 0, confidence: 0.9 };
    kps[ci] = { index: ci, x: c[0], y: c[1], z: 0, confidence: 0.9 };
  }

  return { type: 'keypoints', frameId, timestampMs: frameId * 33, keypoints: kps };
}

/** Feed `n` frames at a fixed angle to satisfy the debounce. */
function hold(counter: RepCounter, config: ExerciseFSMConfig, deg: number, n: number, startId: number): number {
  let id = startId;
  for (let i = 0; i < n; i++) {
    counter.update(makeFrame(config, deg, id));
    id++;
  }
  return id;
}

/** Perform one clean rep: START angle -> INFLECTION -> COMPLETE -> back to START. */
function oneRep(counter: RepCounter, config: ExerciseFSMConfig, startId: number): number {
  const startDeg = (config.startThreshold.min + config.startThreshold.max) / 2;
  const inflDeg = (config.inflectionThreshold.min + config.inflectionThreshold.max) / 2;
  const compDeg = (config.completeThreshold.min + config.completeThreshold.max) / 2;
  let id = startId;
  id = hold(counter, config, startDeg, 8, id);   // settle in START
  id = hold(counter, config, inflDeg, 8, id);    // move through INFLECTION
  id = hold(counter, config, compDeg, 8, id);    // reach COMPLETE
  id = hold(counter, config, startDeg, 8, id);   // return to START -> rep++
  return id;
}

describe('RepCounter — clean counting', () => {
  it('counts exactly 10 squat reps for 10 clean cycles', () => {
    const counter = new RepCounter(squatConfig);
    let id = 1;
    for (let r = 0; r < 10; r++) id = oneRep(counter, squatConfig, id);
    expect(counter.getRepCount()).toBe(10);
  });

  it('counts exactly 10 deadlift reps for 10 clean cycles', () => {
    const counter = new RepCounter(deadliftConfig);
    let id = 1;
    for (let r = 0; r < 10; r++) id = oneRep(counter, deadliftConfig, id);
    expect(counter.getRepCount()).toBe(10);
  });
});

describe('RepCounter — jitter resistance', () => {
  it('does not count when the user only jitters near the START range', () => {
    const counter = new RepCounter(squatConfig);
    const startDeg = 170;
    let id = 1;
    // Wobble around standing without ever descending.
    for (let i = 0; i < 60; i++) {
      const deg = startDeg - (i % 2 === 0 ? 0 : 6); // 170 / 164 alternating
      counter.update(makeFrame(squatConfig, deg, id++));
    }
    expect(counter.getRepCount()).toBe(0);
  });

  it('a single stray deep-angle frame does not complete a rep (debounce)', () => {
    const counter = new RepCounter(squatConfig);
    let id = 1;
    id = hold(counter, squatConfig, 170, 5, id);         // START
    // one stray "bottom" frame then back up — must NOT advance to COMPLETE alone
    counter.update(makeFrame(squatConfig, 70, id++));
    id = hold(counter, squatConfig, 170, 5, id);
    expect(counter.getRepCount()).toBe(0);
  });
});

describe('RepCounter — all configs count cleanly', () => {
  it('every rep-based exercise config has disjoint FSM transition ranges', () => {
    for (const config of allConfigs) {
      expect(validateFSMConfig(config), `${config.exerciseName} invalid`).toBe(true);
      if (!ISOMETRIC_HOLDS.has(config.exerciseName)) {
        expect(transitionRangesDisjoint(config), `${config.exerciseName} overlaps`).toBe(true);
      }
    }
  });

  it('counts exactly 10 reps for 10 clean cycles across every exercise', () => {
    // Near-isometric holds do not have a distinct 3-phase rep cycle by design.
    for (const config of allConfigs) {
      if (ISOMETRIC_HOLDS.has(config.exerciseName)) continue;
      const counter = new RepCounter(config);
      let id = 1;
      for (let r = 0; r < 10; r++) id = oneRep(counter, config, id);
      expect(
        counter.getRepCount(),
        `${config.exerciseName} miscounted`,
      ).toBe(10);
    }
  });

  it('a single noisy joint (of two) does not trigger counts', () => {
    // Simulate squat where ONE knee reads a spurious deep angle while the other
    // stays standing. Strict consensus must prevent any rep.
    const counter = new RepCounter(squatConfig);
    let id = 1;
    for (let i = 0; i < 60; i++) {
      // left knee standing (170), right knee flickers deep (70) — no consensus.
      const kps = Array.from({ length: 33 }, (_, index) => ({
        index, x: 0.5, y: 0.5, z: 0, confidence: 0,
      }));
      const setJoint = (idx: [number, number, number], deg: number) => {
        const rad = (deg * Math.PI) / 180;
        const [ai, bi, ci] = idx;
        kps[ai] = { index: ai, x: 0.5, y: 0.3, z: 0, confidence: 0.9 };
        kps[bi] = { index: bi, x: 0.5, y: 0.5, z: 0, confidence: 0.9 };
        kps[ci] = { index: ci, x: 0.5 + 0.2 * Math.sin(rad), y: 0.5 - 0.2 * Math.cos(rad), z: 0, confidence: 0.9 };
      };
      setJoint([23, 25, 27], 170);                 // left knee standing
      setJoint([24, 26, 28], i % 2 === 0 ? 70 : 170); // right knee flickering
      counter.update({ type: 'keypoints', frameId: id, timestampMs: id * 33, keypoints: kps });
      id++;
    }
    expect(counter.getRepCount()).toBe(0);
  });
});

