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
/**
 * Number of consecutive frames a joint must satisfy the next state's range
 * before the FSM transitions. This debounce absorbs pose-estimation jitter so
 * a single noisy frame near a boundary can't trigger a spurious transition
 * (which previously caused large over-counts).
 */
const TRANSITION_CONFIRM_FRAMES = 4;

export class RepCounter {
  private state: FSMState = 'START';
  private repCount: number = 0;
  private readonly config: ExerciseFSMConfig;

  /**
   * Count of consecutive frames the *next* target range has been satisfied.
   * Reset whenever the target range is not met, so only sustained movement
   * advances the FSM.
   */
  private confirmFrames: number = 0;

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
   * FSM state. Unavailable joints are skipped (not counted). Transitions
   * fire when a MAJORITY (>= 50%) of available joints satisfy the range.
   * This makes tracking forgiving when the camera partially cuts the body.
   *
   * On the first call after construction or reset, captures `startTimestamp`
   * for TUT measurement.
   */
  update(message: KeypointMessage): void {
    const angles = this.computeAngles(message);

    // Filter to only available angles — skip joints the camera can't see
    const available = angles.filter((a) => a.available);

    // Need at least 1 available joint to make a decision
    if (available.length === 0) {
      return;
    }

    // Capture start timestamp on the very first valid frame
    if (this.startTimestamp === null) {
      this.startTimestamp = message.timestampMs;
    }

    switch (this.state) {
      case 'START':
        if (this.confirmed(available, this.config.inflectionThreshold)) {
          this.state = 'INFLECTION';
          this.confirmFrames = 0;
        }
        break;

      case 'INFLECTION':
        if (this.confirmed(available, this.config.completeThreshold)) {
          this.state = 'COMPLETE';
          this.confirmFrames = 0;
        }
        break;

      case 'COMPLETE':
        if (this.confirmed(available, this.config.startThreshold)) {
          // --- TUT calculation ---
          const tutMs = message.timestampMs - (this.startTimestamp as number);
          this.lastRepTutMs = tutMs;

          // Rep count increments (1-based).
          this.repCount += 1;

          // Record the completed rep
          const rep: Rep = {
            repNumber: this.repCount,
            tutMs,
            category: 'correct',
            deviationEvents: [],
          };
          this.completedReps.push(rep);

          // Reset TUT start to this frame
          this.startTimestamp = message.timestampMs;
          this.state = 'START';
          this.confirmFrames = 0;
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
    this.confirmFrames = 0;
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
   * Returns `true` when at least half of the available angles fall within [min, max].
   * This makes tracking forgiving — partial body visibility still allows counting.
   */
  private majorityWithin(angles: JointAngle[], min: number, max: number): boolean {
    if (angles.length === 0) return false;
    const inRange = angles.filter((a) => withinRange(a.degrees, min, max)).length;
    // Strict consensus: require MORE than half of the visible joints to agree.
    // For a single visible joint that one must agree; for two, both must; for
    // three, at least two; for four, at least three. This prevents a single
    // noisy joint (common for knees/elbows seen at an angle) from driving
    // spurious state transitions while still tolerating a fully-occluded side.
    const needed = Math.floor(angles.length / 2) + 1;
    return inRange >= needed;
  }

  /**
   * Debounced range check used for state transitions. Returns `true` only when
   * the majority of available joints have satisfied `threshold` for
   * {@link TRANSITION_CONFIRM_FRAMES} consecutive frames. A frame that fails the
   * range resets the confirmation streak, so only sustained movement advances
   * the FSM. This absorbs single-frame pose jitter that previously caused
   * spurious transitions and large over-counts.
   */
  private confirmed(angles: JointAngle[], threshold: { min: number; max: number }): boolean {
    if (this.majorityWithin(angles, threshold.min, threshold.max)) {
      this.confirmFrames += 1;
    } else {
      this.confirmFrames = 0;
    }
    return this.confirmFrames >= TRANSITION_CONFIRM_FRAMES;
  }
}
