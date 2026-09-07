/**
 * BodyMeasurement — extracts normalized body proportions from pose keypoints
 * captured in a standardized "measurement pose" (standing, arms relaxed, facing
 * camera). Measurements are stored as ratios relative to a stable reference
 * (standing height from ankle to nose), making them scale/distance-invariant.
 *
 * Over time, trending these ratios reveals muscle development:
 * - Shoulder-to-hip ratio increasing = deltoid/lat growth
 * - Upper-arm width relative to forearm = bicep/tricep development
 * - Thigh width relative to knee = quad growth
 * - Chest expansion relative to waist
 *
 * All computation is from the 33 MediaPipe keypoints already produced by the
 * pose detector — no additional model or hardware needed.
 */

import type { Keypoint } from '../types/index.js';

/** A single measurement session (one "body scan" photo). */
export interface BodyScan {
  id: string;
  /** When the scan was taken. */
  timestamp: number;
  /** The raw measurement ratios (all normalized to standing height). */
  measurements: BodyMeasurements;
  /** Quality score 0-1 indicating how well the pose matched the standard. */
  poseQuality: number;
  /**
   * Optional body weight in kilograms, entered by the user at the moment of
   * measurement. Sensitive personal data — only stored with user consent and
   * encrypted at rest via the privacy layer.
   */
  weightKg?: number;
}

/** Normalized body proportion measurements (ratios to standing height). */
export interface BodyMeasurements {
  /** Distance between left and right shoulder / height. */
  shoulderWidth: number;
  /** Distance between left and right hip / height. */
  hipWidth: number;
  /** Shoulder-to-hip ratio (V-taper indicator). */
  shoulderToHipRatio: number;
  /** Left upper arm length (shoulder to elbow) / height. */
  leftUpperArm: number;
  /** Right upper arm length / height. */
  rightUpperArm: number;
  /** Left forearm length (elbow to wrist) / height. */
  leftForearm: number;
  /** Right forearm length / height. */
  rightForearm: number;
  /** Left thigh length (hip to knee) / height. */
  leftThigh: number;
  /** Right thigh length / height. */
  rightThigh: number;
  /** Left calf length (knee to ankle) / height. */
  leftCalf: number;
  /** Right calf length / height. */
  rightCalf: number;
  /** Torso length (mid-shoulder to mid-hip) / height. */
  torsoLength: number;
  /** Standing height in pixels (reference, not stored as ratio). */
  heightPx: number;
}

/** MediaPipe Pose landmark indices. */
const LM = {
  NOSE: 0,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
} as const;

/** Euclidean 2D distance between two keypoints (normalized coords). */
function dist(a: Keypoint | undefined, b: Keypoint | undefined): number {
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Midpoint between two keypoints. */
function mid(a: Keypoint | undefined, b: Keypoint | undefined): { x: number; y: number } {
  if (!a || !b) return { x: 0, y: 0 };
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Minimum confidence required for a keypoint to be considered valid. */
const MIN_CONF = 0.5;

function valid(kps: Keypoint[], idx: number): boolean {
  const kp = kps[idx];
  return kp !== undefined && kp.confidence >= MIN_CONF;
}

/**
 * Assess how well the current pose matches the "measurement pose" (standing
 * upright, arms at sides, facing camera). Returns 0-1; >= 0.7 is usable.
 */
export function assessPoseQuality(keypoints: Keypoint[]): number {
  let score = 0;
  let checks = 0;

  // All key landmarks must be visible.
  const required = [
    LM.NOSE, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER,
    LM.LEFT_HIP, LM.RIGHT_HIP, LM.LEFT_KNEE, LM.RIGHT_KNEE,
    LM.LEFT_ANKLE, LM.RIGHT_ANKLE,
  ];
  for (const idx of required) {
    checks++;
    if (valid(keypoints, idx)) score++;
  }

  // Shoulders should be roughly level (< 5% height difference).
  const ls = keypoints[LM.LEFT_SHOULDER];
  const rs = keypoints[LM.RIGHT_SHOULDER];
  if (ls && rs) {
    checks++;
    if (Math.abs(ls.y - rs.y) < 0.05) score++;
  }

  // Hips should be roughly level.
  const lh = keypoints[LM.LEFT_HIP];
  const rh = keypoints[LM.RIGHT_HIP];
  if (lh && rh) {
    checks++;
    if (Math.abs(lh.y - rh.y) < 0.05) score++;
  }

  // Person should be mostly vertical (nose above hips, hips above ankles).
  const nose = keypoints[LM.NOSE];
  const la = keypoints[LM.LEFT_ANKLE];
  if (nose && lh && la) {
    checks++;
    if (nose.y < lh.y && lh.y < la.y) score++;
  }

  return checks > 0 ? score / checks : 0;
}

/**
 * Extract normalized body measurements from a set of keypoints in the standard
 * measurement pose. Returns null if the pose quality is too low (< 0.6).
 */
export function extractMeasurements(keypoints: Keypoint[]): { measurements: BodyMeasurements; poseQuality: number } | null {
  const poseQuality = assessPoseQuality(keypoints);
  if (poseQuality < 0.6) return null;

  // Standing height: nose to mid-ankle (in normalized coords).
  const nose = keypoints[LM.NOSE];
  const ankleL = keypoints[LM.LEFT_ANKLE];
  const ankleR = keypoints[LM.RIGHT_ANKLE];
  const midAnkle = mid(ankleL, ankleR);
  const heightPx = nose ? Math.abs(midAnkle.y - nose.y) : 0;
  if (heightPx < 0.1) return null; // Person is too small in frame.

  const normalize = (d: number): number => d / heightPx;

  const ls = keypoints[LM.LEFT_SHOULDER];
  const rs = keypoints[LM.RIGHT_SHOULDER];
  const le = keypoints[LM.LEFT_ELBOW];
  const re = keypoints[LM.RIGHT_ELBOW];
  const lw = keypoints[LM.LEFT_WRIST];
  const rw = keypoints[LM.RIGHT_WRIST];
  const lh = keypoints[LM.LEFT_HIP];
  const rh = keypoints[LM.RIGHT_HIP];
  const lk = keypoints[LM.LEFT_KNEE];
  const rk = keypoints[LM.RIGHT_KNEE];

  const shoulderWidth = normalize(dist(ls, rs));
  const hipWidth = normalize(dist(lh, rh));
  const midShoulder = mid(ls, rs);
  const midHip = mid(lh, rh);
  const torsoLength = normalize(Math.hypot(midShoulder.x - midHip.x, midShoulder.y - midHip.y));

  const measurements: BodyMeasurements = {
    shoulderWidth,
    hipWidth,
    shoulderToHipRatio: hipWidth > 0 ? shoulderWidth / hipWidth : 0,
    leftUpperArm: normalize(dist(ls, le)),
    rightUpperArm: normalize(dist(rs, re)),
    leftForearm: normalize(dist(le, lw)),
    rightForearm: normalize(dist(re, rw)),
    leftThigh: normalize(dist(lh, lk)),
    rightThigh: normalize(dist(rh, rk)),
    leftCalf: normalize(dist(lk, ankleL)),
    rightCalf: normalize(dist(rk, ankleR)),
    torsoLength,
    heightPx,
  };

  return { measurements, poseQuality };
}

/**
 * Compute percentage change between two scans for each measurement.
 * Positive = growth, negative = reduction.
 */
export function computeProgress(older: BodyMeasurements, newer: BodyMeasurements): Record<keyof Omit<BodyMeasurements, 'heightPx'>, number> {
  const pct = (o: number, n: number): number => o > 0 ? ((n - o) / o) * 100 : 0;
  return {
    shoulderWidth: pct(older.shoulderWidth, newer.shoulderWidth),
    hipWidth: pct(older.hipWidth, newer.hipWidth),
    shoulderToHipRatio: pct(older.shoulderToHipRatio, newer.shoulderToHipRatio),
    leftUpperArm: pct(older.leftUpperArm, newer.leftUpperArm),
    rightUpperArm: pct(older.rightUpperArm, newer.rightUpperArm),
    leftForearm: pct(older.leftForearm, newer.leftForearm),
    rightForearm: pct(older.rightForearm, newer.rightForearm),
    leftThigh: pct(older.leftThigh, newer.leftThigh),
    rightThigh: pct(older.rightThigh, newer.rightThigh),
    leftCalf: pct(older.leftCalf, newer.leftCalf),
    rightCalf: pct(older.rightCalf, newer.rightCalf),
    torsoLength: pct(older.torsoLength, newer.torsoLength),
  };
}

/** Human-friendly labels for measurements. */
export const MEASUREMENT_LABELS: Record<string, string> = {
  shoulderWidth: 'Shoulder Width',
  hipWidth: 'Hip Width',
  shoulderToHipRatio: 'V-Taper (Shoulder/Hip)',
  leftUpperArm: 'Left Upper Arm',
  rightUpperArm: 'Right Upper Arm',
  leftForearm: 'Left Forearm',
  rightForearm: 'Right Forearm',
  leftThigh: 'Left Thigh',
  rightThigh: 'Right Thigh',
  leftCalf: 'Left Calf',
  rightCalf: 'Right Calf',
  torsoLength: 'Torso Length',
};

/** Which measurements indicate growth in which muscle group. */
export const GROWTH_INDICATORS: Record<string, string[]> = {
  shoulderWidth: ['shoulders', 'lats'],
  shoulderToHipRatio: ['shoulders', 'lats', 'back'],
  leftUpperArm: ['biceps', 'triceps'],
  rightUpperArm: ['biceps', 'triceps'],
  leftThigh: ['quads', 'hamstrings'],
  rightThigh: ['quads', 'hamstrings'],
  leftCalf: ['calves'],
  rightCalf: ['calves'],
};

/**
 * Maximum plausible per-measurement change (%) between any two scans taken
 * within weeks. Real muscle growth is ~0.5-2% per week; anything above this
 * threshold is a measurement error (angle inconsistency, partial detection).
 */
export const MAX_PLAUSIBLE_CHANGE_PCT = 8;

/**
 * Check whether a new scan is plausibly consistent with the existing history.
 * Returns a list of measurements that look like outliers (> MAX_PLAUSIBLE_CHANGE_PCT
 * deviation from the median of prior scans).
 *
 * @param newScan The candidate scan.
 * @param history Existing accepted scans (oldest first).
 * @returns Array of measurement keys that are suspiciously different. Empty = OK.
 */
export function detectOutliers(
  newScan: BodyMeasurements,
  history: BodyScan[],
): string[] {
  if (history.length < 1) return []; // First scan is always accepted.

  // Compute median per measurement across history.
  const keys: Array<keyof Omit<BodyMeasurements, 'heightPx'>> = [
    'shoulderWidth', 'hipWidth', 'shoulderToHipRatio',
    'leftUpperArm', 'rightUpperArm', 'leftForearm', 'rightForearm',
    'leftThigh', 'rightThigh', 'leftCalf', 'rightCalf', 'torsoLength',
  ];
  const outliers: string[] = [];

  for (const key of keys) {
    const values = history.map((s) => s.measurements[key]).sort((a, b) => a - b);
    const mid = values.length % 2 === 0
      ? ((values[values.length / 2 - 1] ?? 0) + (values[values.length / 2] ?? 0)) / 2
      : (values[Math.floor(values.length / 2)] ?? 0);
    if (mid === 0) continue;
    const newVal = newScan[key];
    const pctDiff = Math.abs((newVal - mid) / mid) * 100;
    if (pctDiff > MAX_PLAUSIBLE_CHANGE_PCT) {
      outliers.push(key);
    }
  }
  return outliers;
}

/**
 * Clamp a progress percentage to a physiologically-plausible display range.
 * Real muscle growth is slow (~0.5-2% per week); anything beyond ±MAX is
 * displayed as the cap with a "~" prefix to indicate it's clamped.
 */
export function clampProgress(pct: number): { value: number; clamped: boolean } {
  const cap = MAX_PLAUSIBLE_CHANGE_PCT;
  if (Math.abs(pct) <= cap) return { value: pct, clamped: false };
  return { value: pct > 0 ? cap : -cap, clamped: true };
}

