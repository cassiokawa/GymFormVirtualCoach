/**
 * KeypointNormalizer — maps pose keypoints from any supported model format to
 * the internal 33-keypoint MediaPipe landmark schema.
 *
 * - 17-keypoint COCO input (MoveNet, YOLOv8-Pose, RTMPose) is mapped up to a
 *   33-element array; unmapped target indices are zero-filled.
 * - 33-keypoint MediaPipe input is passed through unchanged.
 * - Any other length is rejected with {@link UnsupportedKeypointCountError}.
 *
 * Requirements covered: 2.1, 2.2, 2.3, 2.4, 2.7
 */

import type { Keypoint } from '../../types/index.js';
import { COCO_TO_MEDIAPIPE } from './keypointMap.js';

/** Number of landmarks in the COCO-17 skeleton. */
const COCO_KEYPOINT_COUNT = 17;
/** Number of landmarks in the MediaPipe-33 skeleton. */
const MEDIAPIPE_KEYPOINT_COUNT = 33;

/**
 * Thrown when {@link KeypointNormalizer.normalize} receives a keypoint array
 * whose length is neither 17 (COCO) nor 33 (MediaPipe). The actual count is
 * included in the message for diagnostics.
 *
 * Requirement 2.7.
 */
export class UnsupportedKeypointCountError extends Error {
  constructor(actualCount: number) {
    super(
      `Unsupported keypoint count: ${actualCount}. Expected 17 (COCO) or 33 (MediaPipe).`,
    );
    this.name = 'UnsupportedKeypointCountError';
  }
}

/**
 * Maps keypoints to the internal 33-keypoint MediaPipe schema.
 */
export class KeypointNormalizer {
  /**
   * Normalize a keypoint array to the 33-keypoint MediaPipe schema.
   *
   * @param keypoints - 17-keypoint COCO or 33-keypoint MediaPipe input.
   * @returns A 33-element array whose `index` fields equal their position.
   * @throws {UnsupportedKeypointCountError} for any length other than 17 or 33.
   */
  normalize(keypoints: Keypoint[]): Keypoint[] {
    if (keypoints.length === MEDIAPIPE_KEYPOINT_COUNT) {
      return keypoints;
    }

    if (keypoints.length !== COCO_KEYPOINT_COUNT) {
      throw new UnsupportedKeypointCountError(keypoints.length);
    }

    // 17-kp COCO → 33-kp MediaPipe. Start with a fully zero-filled skeleton so
    // any unmapped target index reports x/y/z = 0 and confidence = 0.
    const target: Keypoint[] = Array.from(
      { length: MEDIAPIPE_KEYPOINT_COUNT },
      (_, index): Keypoint => ({ index, x: 0, y: 0, z: 0, confidence: 0 }),
    );

    for (const [cocoIndex, mediapipeIndex] of COCO_TO_MEDIAPIPE) {
      const source = keypoints[cocoIndex];
      if (source === undefined) {
        // Guarded for noUncheckedIndexedAccess; unreachable for a 17-kp input
        // since every COCO index in the map is < 17.
        continue;
      }
      target[mediapipeIndex] = {
        index: mediapipeIndex,
        x: source.x,
        y: source.y,
        z: source.z,
        confidence: source.confidence,
      };
    }

    return target;
  }
}
