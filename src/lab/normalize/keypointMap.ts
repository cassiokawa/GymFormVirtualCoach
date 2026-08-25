/**
 * Static COCO-17 → MediaPipe-33 keypoint index mapping.
 *
 * The Algorithm Lab normalizes every 17-keypoint COCO model output (MoveNet,
 * YOLOv8-Pose, RTMPose) up to the internal 33-keypoint MediaPipe landmark
 * schema so downstream form evaluation and rep counting work identically
 * regardless of the source model.
 *
 * Requirements covered: 2.1, 2.3
 */

/**
 * Ordered pairs of `[cocoIndex, mediapipeIndex]`.
 *
 * Each entry maps a COCO-17 landmark index to its equivalent MediaPipe-33
 * landmark index. MediaPipe indices absent from this table (e.g. mouth,
 * inner/outer eye, finger, foot landmarks) have no COCO source and are
 * zero-filled with `confidence: 0` by the normalizer.
 */
export const COCO_TO_MEDIAPIPE: ReadonlyArray<[number, number]> = [
  [0, 0], // nose
  [1, 2], // left_eye
  [2, 5], // right_eye
  [3, 7], // left_ear
  [4, 8], // right_ear
  [5, 11], // left_shoulder
  [6, 12], // right_shoulder
  [7, 13], // left_elbow
  [8, 14], // right_elbow
  [9, 15], // left_wrist
  [10, 16], // right_wrist
  [11, 23], // left_hip
  [12, 24], // right_hip
  [13, 25], // left_knee
  [14, 26], // right_knee
  [15, 27], // left_ankle
  [16, 28], // right_ankle
];
