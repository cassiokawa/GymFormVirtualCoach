/**
 * Form_Evaluator for the CV Fitness & Form Assistant.
 *
 * Processes each `KeypointMessage` frame to detect form deviations against
 * the warning and critical thresholds defined in `ExerciseFSMConfig`.
 *
 * Dual-threshold classification per joint:
 *   - outside warningThreshold  → DeviationEvent (severity: 'warning'), logged once at onset
 *   - outside criticalThreshold → DeviationEvent (severity: 'critical'), dispatched immediately
 *                                 via `onCriticalDeviation` callback (≤10 ms requirement)
 *
 * Requirements covered: 3.1, 3.2, 4.1, 4.2, 4.3, 4.4, 4.5, 12.2
 */

import type {
  KeypointMessage,
  ExerciseFSMConfig,
  DeviationEvent,
  JointAngle,
} from '../types/index.js';
import { calculateJointAngle } from '../utils/jointAngle.js';

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
  left_knee:       [23, 25, 27], // left_hip        → left_knee      → left_ankle
  right_knee:      [24, 26, 28], // right_hip       → right_knee     → right_ankle
  left_hip:        [11, 23, 25], // left_shoulder   → left_hip       → left_knee
  right_hip:       [12, 24, 26], // right_shoulder  → right_hip      → right_knee
  left_elbow:      [11, 13, 15], // left_shoulder   → left_elbow     → left_wrist
  right_elbow:     [12, 14, 16], // right_shoulder  → right_elbow    → right_wrist
  left_shoulder:   [13, 11, 23], // left_elbow      → left_shoulder  → left_hip
  right_shoulder:  [14, 12, 24], // right_elbow     → right_shoulder → right_hip
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Callback invoked synchronously whenever a critical deviation is detected.
 * Must be called within ≤10 ms of receiving the keypoint frame.
 *
 * Requirement 4.4
 */
export type CriticalDeviationCallback = (event: DeviationEvent) => void;

// ---------------------------------------------------------------------------
// FormEvaluator class
// ---------------------------------------------------------------------------

/**
 * Evaluates every keypoint frame against the exercise's dual-threshold config
 * and emits `DeviationEvent`s for out-of-range joint angles.
 *
 * **Warning threshold** — angle outside acceptable form range:
 *   - Creates a `DeviationEvent` with `severity: 'warning'`
 *   - Logged ONCE at onset; subsequent frames while the joint stays in warning
 *     range do not generate additional events
 *
 * **Critical threshold** — angle indicating potential injury risk:
 *   - Creates a `DeviationEvent` with `severity: 'critical'`
 *   - Immediately dispatches the event via `onCriticalDeviation` callback (≤10 ms)
 *   - Dispatched on every frame where the joint remains critical (not deduplicated)
 *
 * Joints whose `available` flag is `false` are silently skipped.
 *
 * The full frame evaluation must complete within 10 ms; a console warning is
 * emitted if the budget is exceeded (Requirement 12.2).
 *
 * Requirements: 3.1, 3.2, 4.1, 4.2, 4.3, 4.4, 4.5, 12.2
 */
export class FormEvaluator {
  private readonly config: ExerciseFSMConfig;
  private readonly onCriticalDeviation: CriticalDeviationCallback;

  /** 1-based rep number supplied by the orchestrating component. */
  private currentRepNumber: number = 1;

  /**
   * Tracks joints currently in a warning state so that the onset DeviationEvent
   * is only emitted once per continuous warning episode.
   *
   * Cleared when the joint's angle returns to within `warningThreshold`.
   *
   * Requirement 4.3 — log warning once at onset.
   */
  private readonly activeWarnings: Set<string> = new Set();

  /**
   * @param config              Exercise configuration supplying threshold values.
   * @param onCriticalDeviation Callback invoked synchronously for every critical
   *                            deviation detected. Must complete in ≤10 ms combined
   *                            with the frame evaluation itself.
   */
  constructor(
    config: ExerciseFSMConfig,
    onCriticalDeviation: CriticalDeviationCallback,
  ) {
    this.config = config;
    this.onCriticalDeviation = onCriticalDeviation;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Evaluate a single keypoint frame against the exercise configuration.
   *
   * For every joint in `config.joints`:
   *   1. Compute the `JointAngle` via `calculateJointAngle`.
   *   2. If `available: false`, skip silently (Requirement 4.5 / 3.4).
   *   3. If outside `criticalThreshold`: create critical `DeviationEvent` and
   *      call `onCriticalDeviation` immediately (Requirement 4.4).
   *   4. Else if outside `warningThreshold` and not already tracked: create
   *      warning `DeviationEvent` and mark joint as active warning (Requirement 4.3).
   *   5. If within `warningThreshold`: clear joint from `activeWarnings`.
   *
   * A performance.now() guard ensures the method logs a console warning if
   * evaluation exceeds 10 ms (Requirement 12.2).
   *
   * @returns Array of all `DeviationEvent`s detected in this frame.
   *          Critical events appear before warning events, in joint order.
   *
   * Requirements: 3.1, 3.2, 4.1–4.5, 12.2
   */
  evaluateFrame(message: KeypointMessage): DeviationEvent[] {
    const t0 = performance.now();
    const deviationEvents: DeviationEvent[] = [];

    for (const jointName of this.config.joints) {
      const angle = this.computeAngle(jointName, message);

      // Requirement 4.5 — skip unavailable joints.
      if (!angle.available) {
        continue;
      }

      const { degrees } = angle;
      const { warningThreshold, criticalThreshold } = this.config;

      const isOutsideCritical =
        degrees < criticalThreshold.min || degrees > criticalThreshold.max;

      const isOutsideWarning =
        degrees < warningThreshold.min || degrees > warningThreshold.max;

      if (isOutsideCritical) {
        // Critical deviations are always dispatched (every frame), not deduplicated.
        // Requirement 4.4 — notify Safety_Monitor within ≤10 ms.
        const event: DeviationEvent = {
          jointName,
          angleValue: degrees,
          severity: 'critical',
          timestampMs: message.timestampMs,
          repNumber: this.currentRepNumber,
        };
        deviationEvents.push(event);
        this.onCriticalDeviation(event);
      } else if (isOutsideWarning) {
        // Warning: log ONCE at onset using activeWarnings deduplication.
        // Requirement 4.3 — do not repeat for the same joint in the same state.
        if (!this.activeWarnings.has(jointName)) {
          this.activeWarnings.add(jointName);
          const event: DeviationEvent = {
            jointName,
            angleValue: degrees,
            severity: 'warning',
            timestampMs: message.timestampMs,
            repNumber: this.currentRepNumber,
          };
          deviationEvents.push(event);
        }
        // If joint was already in warning, do nothing (onset already logged).
      } else {
        // Joint is within safe range (warningThreshold) — clear any active warning.
        this.clearWarning(jointName);
      }
    }

    // Requirement 12.2 — log if frame evaluation exceeds 10 ms budget.
    const elapsed = performance.now() - t0;
    if (elapsed > 10) {
      console.warn(`[FormEvaluator] evaluateFrame exceeded 10ms: ${elapsed.toFixed(2)}ms`);
    }

    return deviationEvents;
  }

  /**
   * Update the current rep number.  Call this when the Rep_Counter signals
   * that a new rep has started so that subsequent `DeviationEvent`s are tagged
   * with the correct rep number.
   *
   * @param repNumber 1-based rep index within the active set.
   */
  setRepNumber(repNumber: number): void {
    this.currentRepNumber = repNumber;
    // Clear warning state when transitioning to a new rep so onset deduplication
    // restarts for the fresh rep context.
    this.activeWarnings.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Computes a `JointAngle` for the named joint using the MediaPipe landmark
   * indices from `JOINT_KEYPOINT_MAP`.
   *
   * Returns an unavailable angle if:
   * - The joint name is not present in `JOINT_KEYPOINT_MAP`
   * - Any of the three required keypoints is missing from the message
   *
   * Requirement 3.1, 3.2
   */
  private computeAngle(jointName: string, message: KeypointMessage): JointAngle {
    const unavailable: JointAngle = {
      jointName,
      degrees: 0,
      available: false,
      frameId: message.frameId,
      timestampMs: message.timestampMs,
    };

    const indices = JOINT_KEYPOINT_MAP[jointName];
    if (indices === undefined) {
      return unavailable;
    }

    const [ai, bi, ci] = indices;
    const a = message.keypoints[ai];
    const b = message.keypoints[bi];
    const c = message.keypoints[ci];

    if (a === undefined || b === undefined || c === undefined) {
      return unavailable;
    }

    return calculateJointAngle(a, b, c, jointName, message.frameId, message.timestampMs);
  }

  /**
   * Removes a joint from the active warning set when its angle returns to
   * within the safe range (warningThreshold).
   */
  private clearWarning(jointName: string): void {
    this.activeWarnings.delete(jointName);
  }
}
