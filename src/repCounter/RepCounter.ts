/**
 * Rep_Counter FSM for the CV Fitness & Form Assistant.
 *
 * Implements a three-state finite-state machine (START → INFLECTION → COMPLETE)
 * that counts repetitions, records Time-Under-Tension (TUT) per rep, and exposes
 * a reset() method for starting a new set.
 *
 * Requirements covered: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import type { KeypointMessage, ExerciseFSMConfig, JointAngle, Rep } from '../types/index.js';
import { calculateJointAngle } from '../utils/jointAngle.js';

// ---------------------------------------------------------------------------
// FSM State
// ---------------------------------------------------------------------------

/** The three states of the repetition finite-state machine. */
export type FSMState = 'START' | 'INFLECTION' | 'COMPLETE';

// ---------------------------------------------------------------------------
// Joint → keypoint index mapping
// ---------------------------------------------------------------------------

/**
 * Maps a joint name to the three MediaPipe landmark indices that form the
 * angle triplet: [proximal, center (joint), distal].
 *
 * Indices follow the MediaPipe Pose 33-landmark schema (0–32).
 */
const JOINT_KEYPOINT_MAP: Record<string, [number, number, number]> = {
  left_knee:      [23, 25, 27], // left_hip       → left_knee     → left_ankle
  right_knee:     [24, 26, 28], // right_hip      → right_knee    → right_ankle
  left_hip:       [11, 23, 25], // left_shoulder  → left_hip      → left_knee
  right_hip:      [12, 24, 26], // right_shoulder → right_hip     → right_knee
  left_elbow:     [11, 13, 15], // left_shoulder  → left_elbow    → left_wrist
  right_elbow:    [12, 14, 16], // right_shoulder → right_elbow   → right_wrist
  left_shoulder:  [13, 11, 23], // left_elbow     → left_shoulder → left_hip
  right_shoulder: [14, 12, 24], // right_elbow    → right_shoulder → right_hip
};

// ---------------------------------------------------------------------------
// Threshold helper
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `degrees` falls within the inclusive range
 * [threshold.min, threshold.max].
 */
function withinRange(degrees: number, min: number, max: number): boolean {
  return degrees >= min && degrees <= max;
}

// ---------------------------------------------------------------------------
// RepCounter class
// ---------------------------------------------------------------------------

/**
 * Finite-state machine that counts exercise repetitions by observing
 * `KeypointMessage` frames from the Pose_Detector worker.
 *
 * State transitions:
 *   START      → INFLECTION : all tracked joints enter inflection range
 *   INFLECTION → COMPLETE   : all tracked joints enter complete range
 *   COMPLETE   → START      : all tracked joints return to start range
 *                             → increment rep count; record TUT; push Rep to completedReps
 *
 * If any required joint angle is `available: false` the FSM holds its current
 * state until keypoints are valid again (Requirement 2.4).
 *
 * TUT is measured from the first `update()` call after construction/reset
 * (i.e., when `startTimestamp` is first captured) to the moment the
 * `COMPLETE → START` transition fires (Requirement 2.5).
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */
export class RepCounter {
  private state: FSMState = 'START';
  private repCount: number = 0;
  private readonly config: ExerciseFSMConfig;

  /**
   * Timestamp (ms) of the first `update()` call after construction or reset.
   * Also updated to the frame timestamp on each `COMPLETE → START` transition
   * to begin timing the next rep immediately.
   *
   * Requirement 2.5 — TUT starts when FSM first enters START.
   */
  private startTimestamp: number | null = null;

  /**
   * TUT (ms) of the most recently completed rep.
   * null until the first rep completes.
   *
   * Requirement 2.6
   */
  private lastRepTutMs: number | null = null;

  /**
   * Ordered list of all completed reps in this set.
   * category defaults to 'correct'; Form_Evaluator may update it later.
   *
   * Requirement 2.6, 8.1
   */
  private completedReps: Rep[] = [];

  constructor(config: ExerciseFSMConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Process a single keypoint frame.
   *
   * Computes joint angles for every joint listed in `config.joints`, then
   * evaluates the appropriate state-transition predicate for the current
   * FSM state.  If any joint angle is unavailable the current state is
   * held unchanged.
   *
   * On the first call after construction or reset, captures `startTimestamp`
   * for TUT measurement (Requirement 2.5).
   *
   * Requirement 2.3 — transitions fire when ALL joints satisfy the range.
   * Requirement 2.4 — hold state when any angle is unavailable.
   */
  update(message: KeypointMessage): void {
    const angles = this.computeAngles(message);

    // Requirement 2.4: if any angle is unavailable, hold current state.
    if (angles.some((a) => !a.available)) {
      return;
    }

    // Capture start timestamp on the very first valid frame (Requirement 2.5).
    if (this.startTimestamp === null) {
      this.startTimestamp = message.timestampMs;
    }

    switch (this.state) {
      case 'START':
        if (this.allWithin(angles, this.config.inflectionThreshold.min, this.config.inflectionThreshold.max)) {
          this.state = 'INFLECTION';
        }
        break;

      case 'INFLECTION':
        if (this.allWithin(angles, this.config.completeThreshold.min, this.config.completeThreshold.max)) {
          this.state = 'COMPLETE';
        }
        break;

      case 'COMPLETE':
        if (this.allWithin(angles, this.config.startThreshold.min, this.config.startThreshold.max)) {
          // --- TUT calculation (Requirement 2.5, 2.6) ---
          // startTimestamp is guaranteed non-null here because it was set on
          // the first valid frame processed by this instance.
          const tutMs = message.timestampMs - (this.startTimestamp as number);
          this.lastRepTutMs = tutMs;

          // Rep count increments (1-based).
          this.repCount += 1;

          // Record the completed rep (category defaults to 'correct';
          // Form_Evaluator will update it if deviations were observed).
          const rep: Rep = {
            repNumber: this.repCount,
            tutMs,
            category: 'correct',
            deviationEvents: [],
          };
          this.completedReps.push(rep);

          // Reset TUT start to this frame so the next rep is timed from now.
          this.startTimestamp = message.timestampMs;
          this.state = 'START';
        }
        break;
    }
  }

  /** Returns the current rep count for this set. */
  getRepCount(): number {
    return this.repCount;
  }

  /** Returns the current FSM state. */
  getState(): FSMState {
    return this.state;
  }

  /**
   * Returns the TUT (ms) of the most recently completed rep.
   * Returns `null` if no rep has been completed since construction or the
   * last `reset()` call.
   *
   * Requirement 2.6
   */
  getLastRepTutMs(): number | null {
    return this.lastRepTutMs;
  }

  /**
   * Returns a copy of the completed reps array for this set.
   * Callers receive a shallow copy; the inner `deviationEvents` arrays are
   * the same references (Form_Evaluator may mutate them).
   *
   * Requirement 2.6, 8.1
   */
  getCompletedReps(): Rep[] {
    return this.completedReps.slice();
  }

  /**
   * Resets the FSM to its initial state for a new set.
   *
   * - state       → 'START'
   * - repCount    → 0
   * - startTimestamp → null (re-captured on the next valid `update()` call)
   * - lastRepTutMs   → null
   * - completedReps  → []
   *
   * Requirement 2.5
   */
  reset(): void {
    this.state = 'START';
    this.repCount = 0;
    this.startTimestamp = null;
    this.lastRepTutMs = null;
    this.completedReps = [];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Computes a `JointAngle` for each joint in `config.joints` by looking up
   * the three relevant keypoints from the message.
   *
   * If a joint name is not found in `JOINT_KEYPOINT_MAP` or a keypoint index
   * falls outside the 0–32 range, the angle is returned as unavailable so the
   * FSM safely holds its current state.
   */
  private computeAngles(message: KeypointMessage): JointAngle[] {
    return this.config.joints.map((jointName) => {
      const indices = JOINT_KEYPOINT_MAP[jointName];
      if (indices === undefined) {
        // Unknown joint — return unavailable to hold FSM state.
        return {
          jointName,
          degrees: 0,
          available: false,
          frameId: message.frameId,
          timestampMs: message.timestampMs,
        };
      }

      const [ai, bi, ci] = indices;
      const a = message.keypoints[ai];
      const b = message.keypoints[bi];
      const c = message.keypoints[ci];

      if (a === undefined || b === undefined || c === undefined) {
        return {
          jointName,
          degrees: 0,
          available: false,
          frameId: message.frameId,
          timestampMs: message.timestampMs,
        };
      }

      return calculateJointAngle(a, b, c, jointName, message.frameId, message.timestampMs);
    });
  }

  /**
   * Returns `true` when every angle in the array falls within [min, max].
   * Assumes all angles are available (caller must check before calling).
   */
  private allWithin(angles: JointAngle[], min: number, max: number): boolean {
    return angles.every((a) => withinRange(a.degrees, min, max));
  }
}
