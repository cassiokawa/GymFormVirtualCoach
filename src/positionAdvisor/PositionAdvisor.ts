/**
 * Position_Advisor for the User Framing & Lock pre-tracking pipeline.
 *
 * Evaluates the user's current joint angles against the exercise start threshold
 * to determine if they are in the correct starting position. Generates directional
 * cues for joints that are out of range.
 *
 * Requirements covered: 2.1, 2.2, 2.3, 2.4
 */

import type { Keypoint, ExerciseFSMConfig, PositionCue, AngleThreshold } from '../types/index.js';
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
// PositionAdvisor class
// ---------------------------------------------------------------------------

/**
 * Evaluates the user's pose against the exercise starting position and
 * provides directional correction cues for joints that are out of range.
 *
 * The score represents the fraction of tracked joints whose angle falls
 * within the configured `startThreshold` range. When score = 1.0, all joints
 * are in the correct starting position and the pipeline can advance to locking.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4
 */
export class PositionAdvisor {
  private readonly config: ExerciseFSMConfig;

  constructor(config: ExerciseFSMConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Evaluate current keypoints against the exercise start threshold.
   *
   * For each joint in config.joints:
   * - Computes the angle via `calculateJointAngle`
   * - If the angle is unavailable (low confidence / missing keypoints), skips it
   * - Otherwise compares against `config.startThreshold`
   *
   * Returns:
   * - score: jointsInRange / totalTrackedJoints (0 if no joints are trackable)
   * - cues: directional correction messages for out-of-range joints
   *
   * @param keypoints    Array of keypoints from the current frame
   * @param frameId      Frame identifier
   * @param timestampMs  Wall-clock timestamp of the source frame in milliseconds
   */
  evaluate(
    keypoints: Keypoint[],
    frameId: number,
    timestampMs: number,
  ): { score: number; cues: PositionCue[] } {
    const threshold = this.config.startThreshold;
    const cues: PositionCue[] = [];
    let totalTrackedJoints = 0;
    let jointsInRange = 0;

    for (const jointName of this.config.joints) {
      const indices = JOINT_KEYPOINT_MAP[jointName];
      if (indices === undefined) {
        // Unknown joint — skip.
        continue;
      }

      const [ai, bi, ci] = indices;
      const a = keypoints[ai];
      const b = keypoints[bi];
      const c = keypoints[ci];

      if (a === undefined || b === undefined || c === undefined) {
        // Required keypoints not present in the array — skip.
        continue;
      }

      const angle = calculateJointAngle(a, b, c, jointName, frameId, timestampMs);

      if (!angle.available) {
        // Angle unavailable (low confidence or coincident keypoints) — skip.
        continue;
      }

      // This joint is trackable.
      totalTrackedJoints += 1;

      if (angle.degrees >= threshold.min && angle.degrees <= threshold.max) {
        jointsInRange += 1;
      } else {
        // Joint is out of range — generate a directional cue.
        cues.push(this.generateCue(jointName, angle.degrees, threshold));
      }
    }

    const score = totalTrackedJoints === 0 ? 0 : jointsInRange / totalTrackedJoints;

    return { score, cues };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Generate a human-readable cue for a joint that is out of range.
   *
   * - If currentAngle < threshold.min: the joint is too flexed → "Extend {joint} more"
   * - If currentAngle > threshold.max: the joint is too extended → "Bend {joint} more"
   */
  private generateCue(
    jointName: string,
    currentAngle: number,
    threshold: AngleThreshold,
  ): PositionCue {
    const displayName = jointName.replace(/_/g, ' ');

    let message: string;
    if (currentAngle < threshold.min) {
      message = `Extend ${displayName} more`;
    } else {
      message = `Bend ${displayName} more`;
    }

    return {
      jointName,
      message,
      currentAngle,
      targetMin: threshold.min,
      targetMax: threshold.max,
    };
  }
}
