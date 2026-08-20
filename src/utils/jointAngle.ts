/**
 * Joint angle calculation utility.
 *
 * Computes the interior angle at keypoint B (the joint centre) given three
 * keypoints A (proximal), B (joint), and C (distal) using dot-product vector
 * math on the 2D x/y plane.
 *
 * Requirements covered: 3.1, 3.3, 3.4
 */

import type { Keypoint, JointAngle } from '../types/index.js';

/** Minimum confidence score for a keypoint to be considered valid. */
const MIN_CONFIDENCE = 0.5;

/**
 * Returns `true` when the keypoint has sufficient confidence and normalised
 * coordinates within the unit square [0, 1] × [0, 1].
 */
function isValid(kp: Keypoint): boolean {
  return (
    kp.confidence >= MIN_CONFIDENCE &&
    kp.x >= 0 &&
    kp.x <= 1 &&
    kp.y >= 0 &&
    kp.y <= 1
  );
}

/**
 * Compute the interior angle at keypoint **B** formed by the triplet A–B–C.
 *
 * The angle is calculated using the dot-product formula:
 *   θ = arccos( (BA · BC) / (|BA| × |BC|) )
 *
 * where BA = A − B and BC = C − B are 2-D vectors (x, y only).
 *
 * Returns a `JointAngle` with `available: false` when:
 * - Fewer than 3 of the supplied keypoints are valid
 *   (confidence ≥ 0.5, x and y within [0, 1]).
 * - Either edge vector has zero magnitude (coincident keypoints).
 *
 * Otherwise the angle is clamped to [0°, 180°] and returned with
 * `available: true`.
 *
 * @param a         Proximal keypoint
 * @param b         Joint-centre keypoint
 * @param c         Distal keypoint
 * @param jointName Human-readable joint identifier (e.g. "left_knee")
 * @param frameId   Frame identifier from the originating KeypointMessage
 * @param timestampMs Wall-clock timestamp of the source frame in milliseconds
 */
export function calculateJointAngle(
  a: Keypoint,
  b: Keypoint,
  c: Keypoint,
  jointName: string,
  frameId: number,
  timestampMs: number,
): JointAngle {
  // Baseline unavailable result used for all early-return paths.
  const unavailable: JointAngle = {
    jointName,
    degrees: 0,
    available: false,
    frameId,
    timestampMs,
  };

  // Requirement 3.4 — fewer than 3 valid keypoints → unavailable.
  if (!isValid(a) || !isValid(b) || !isValid(c)) {
    return unavailable;
  }

  // 2-D vectors from the joint centre B to the proximal (A) and distal (C)
  // endpoints, using x/y coordinates only (Requirement 3.1).
  const bax = a.x - b.x;
  const bay = a.y - b.y;
  const bcx = c.x - b.x;
  const bcy = c.y - b.y;

  const magBA = Math.sqrt(bax * bax + bay * bay);
  const magBC = Math.sqrt(bcx * bcx + bcy * bcy);

  // Requirement 3.4 — zero-magnitude edge vector (coincident keypoints) → unavailable.
  if (magBA === 0 || magBC === 0) {
    return unavailable;
  }

  // Dot product and cosine of the angle.
  const dot = bax * bcx + bay * bcy;
  // Clamp the argument to [-1, 1] to guard against floating-point rounding
  // that could push it fractionally outside the arccos domain.
  const cosTheta = Math.max(-1, Math.min(1, dot / (magBA * magBC)));

  // Convert radians to degrees and clamp to [0°, 180°] (Requirement 3.3).
  const degrees = Math.max(0, Math.min(180, (Math.acos(cosTheta) * 180) / Math.PI));

  return {
    jointName,
    degrees,
    available: true,
    frameId,
    timestampMs,
  };
}
