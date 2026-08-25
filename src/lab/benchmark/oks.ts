/**
 * Object Keypoint Similarity (OKS) — the standard COCO metric for scoring
 * predicted keypoints against hand-annotated ground truth.
 *
 * OKS measures how close predicted keypoints are to ground-truth positions,
 * normalized by object scale and per-keypoint anatomical tolerance:
 *
 *   OKS = Σ_i [ exp( -d_i² / (2·s²·k_i²) ) · δ(v_i > 0) ] / Σ_i δ(v_i > 0)
 *
 *   d_i = euclidean distance between predicted and GT keypoint i (normalized coords)
 *   s   = object scale = sqrt(bbox_area) of the GT pose (from visible GT keypoints)
 *   k_i = per-keypoint constant (sigma); larger = looser tolerance
 *   v_i = GT visibility flag for keypoint i
 *   δ   = indicator function (1 when visible, 0 otherwise)
 *
 * Ground truth is expressed in the 33-keypoint MediaPipe schema (see
 * {@link GroundTruthFrame}). The COCO standard defines sigmas for its 17 body
 * keypoints; MediaPipe-only indices (face detail, hands, feet) reuse the
 * nearest anatomical sigma or a conservative default.
 *
 * Requirements covered: 3.3
 * Design: "3. BenchmarkRunner + OKS", "Property 3: OKS bounds".
 */

import type { Keypoint } from '../../types/index.js';
import type { GroundTruthFrame } from '../types.js';
import { COCO_TO_MEDIAPIPE } from '../normalize/keypointMap.js';

/** Number of landmarks in the MediaPipe-33 skeleton. */
const MEDIAPIPE_KEYPOINT_COUNT = 33;

/**
 * Standard COCO per-keypoint sigmas in COCO-17 index order.
 *
 * These are the falloff constants published with the COCO keypoint evaluation:
 * smaller sigmas (eyes, nose) demand tighter localization; larger sigmas (hips)
 * tolerate more error. Values are the canonical COCO `sigmas` divided by their
 * historical 10x packing — i.e. the raw sigma used directly as `k_i`.
 */
export const COCO_SIGMAS: readonly number[] = [
  0.026, // 0  nose
  0.025, // 1  left_eye
  0.025, // 2  right_eye
  0.035, // 3  left_ear
  0.035, // 4  right_ear
  0.079, // 5  left_shoulder
  0.079, // 6  right_shoulder
  0.072, // 7  left_elbow
  0.072, // 8  right_elbow
  0.062, // 9  left_wrist
  0.062, // 10 right_wrist
  0.107, // 11 left_hip
  0.107, // 12 right_hip
  0.087, // 13 left_knee
  0.087, // 14 right_knee
  0.089, // 15 left_ankle
  0.089, // 16 right_ankle
];

/**
 * Default sigma for MediaPipe indices with no COCO equivalent and no obvious
 * nearest anatomical neighbor. Chosen as a mid-range body tolerance so
 * unmapped landmarks neither dominate nor vanish from the score.
 */
const DEFAULT_SIGMA = 0.079;

/**
 * Nearest-anatomical sigma overrides for MediaPipe-only indices.
 *
 * MediaPipe adds face detail (eyes inner/outer, mouth), hand landmarks, and
 * foot landmarks that COCO lacks. Each is assigned the sigma of its closest
 * COCO counterpart so its localization tolerance is anatomically sensible.
 * Any index not listed here (and not mapped from COCO) falls back to
 * {@link DEFAULT_SIGMA}.
 */
const MEDIAPIPE_ONLY_SIGMAS: Readonly<Record<number, number>> = {
  1: 0.025, // left_eye_inner   -> eye
  3: 0.025, // left_eye_outer   -> eye
  4: 0.025, // right_eye_inner  -> eye
  6: 0.025, // right_eye_outer  -> eye
  9: 0.026, // mouth_left       -> nose (nearest face landmark)
  10: 0.026, // mouth_right     -> nose
  17: 0.062, // left_pinky      -> wrist
  18: 0.062, // right_pinky     -> wrist
  19: 0.062, // left_index      -> wrist
  20: 0.062, // right_index     -> wrist
  21: 0.062, // left_thumb      -> wrist
  22: 0.062, // right_thumb     -> wrist
  29: 0.089, // left_heel       -> ankle
  30: 0.089, // right_heel      -> ankle
  31: 0.089, // left_foot_index -> ankle
  32: 0.089, // right_foot_index-> ankle
};

/**
 * Per-keypoint sigma constants (k_i) for the 33-keypoint MediaPipe schema.
 *
 * Built by assigning each COCO sigma to its mapped MediaPipe index, then
 * filling the remaining MediaPipe-only indices from
 * {@link MEDIAPIPE_ONLY_SIGMAS} (nearest anatomical) or {@link DEFAULT_SIGMA}.
 */
export const MEDIAPIPE_SIGMAS: readonly number[] = buildMediapipeSigmas();

function buildMediapipeSigmas(): number[] {
  const sigmas: number[] = Array.from(
    { length: MEDIAPIPE_KEYPOINT_COUNT },
    (_, index): number => MEDIAPIPE_ONLY_SIGMAS[index] ?? DEFAULT_SIGMA,
  );

  for (const [cocoIndex, mediapipeIndex] of COCO_TO_MEDIAPIPE) {
    const cocoSigma = COCO_SIGMAS[cocoIndex];
    if (cocoSigma !== undefined && mediapipeIndex < sigmas.length) {
      sigmas[mediapipeIndex] = cocoSigma;
    }
  }

  return sigmas;
}

/** Options for {@link computeOks} and related helpers. */
export interface OksOptions {
  /**
   * Per-keypoint sigma constants (k_i), one per ground-truth keypoint.
   * Defaults to {@link MEDIAPIPE_SIGMAS} (33-keypoint schema).
   */
  sigmas?: readonly number[];
}

/** Clamp a value into the inclusive [0, 1] range. */
function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Compute the object scale `s = sqrt(bbox_area)` from the visible ground-truth
 * keypoints.
 *
 * The bounding box is the axis-aligned extent of all visible GT keypoints in
 * normalized coordinates. Returns 0 when fewer than one keypoint is visible or
 * when the visible keypoints are coincident (degenerate box).
 */
function computeGtScale(gt: GroundTruthFrame): number {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let visibleCount = 0;

  for (let i = 0; i < gt.keypoints.length; i++) {
    if (gt.visibility[i] !== true) continue;
    const point = gt.keypoints[i];
    if (point === undefined) continue;
    visibleCount++;
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }

  if (visibleCount === 0) return 0;

  const width = maxX - minX;
  const height = maxY - minY;
  const area = width * height;
  return area > 0 ? Math.sqrt(area) : 0;
}

/**
 * Compute the per-keypoint OKS term for a single keypoint.
 *
 * Returns `exp( -d² / (2·s²·k²) )` in [0, 1], or 0 when the keypoint is not
 * visible. When scale `s` is degenerate (0), a nonzero distance yields 0 and a
 * zero distance yields 1 (identical points still match).
 */
function keypointOksTerm(
  predicted: Keypoint | undefined,
  gtX: number,
  gtY: number,
  scale: number,
  sigma: number,
): number {
  const px = predicted?.x ?? 0;
  const py = predicted?.y ?? 0;
  const dx = px - gtX;
  const dy = py - gtY;
  const distanceSq = dx * dx + dy * dy;

  if (distanceSq === 0) return 1;

  const denom = 2 * scale * scale * sigma * sigma;
  if (denom === 0) return 0;

  return Math.exp(-distanceSq / denom);
}

/**
 * Compute the per-keypoint OKS term array for a prediction/ground-truth pair.
 *
 * The returned array has the same length as `gt.keypoints`. Each entry is the
 * OKS falloff term for that keypoint, or 0 for keypoints flagged not-visible in
 * the ground truth. This is the raw per-keypoint contribution before the
 * visibility-weighted mean is taken in {@link computeOks}.
 *
 * @param predicted - Predicted keypoints (expected length 33 after normalization).
 * @param gt - Ground-truth frame in the 33-keypoint MediaPipe schema.
 * @param opts - Optional sigma overrides.
 * @returns Per-keypoint OKS terms, length `gt.keypoints.length`.
 */
export function perKeypointOks(
  predicted: Keypoint[],
  gt: GroundTruthFrame,
  opts?: OksOptions,
): number[] {
  const sigmas = opts?.sigmas ?? MEDIAPIPE_SIGMAS;
  const scale = computeGtScale(gt);
  const terms: number[] = [];

  for (let i = 0; i < gt.keypoints.length; i++) {
    const gtPoint = gt.keypoints[i];
    if (gt.visibility[i] !== true || gtPoint === undefined) {
      terms.push(0);
      continue;
    }
    const sigma = sigmas[i] ?? DEFAULT_SIGMA;
    terms.push(
      keypointOksTerm(predicted[i], gtPoint.x, gtPoint.y, scale, sigma),
    );
  }

  return terms;
}

/**
 * Compute the Object Keypoint Similarity between a predicted pose and a
 * ground-truth frame.
 *
 * The result is the visibility-weighted mean of the per-keypoint OKS terms,
 * clamped to [0, 1]. Identical poses (all visible predicted keypoints coincide
 * with ground truth) yield exactly 1.0.
 *
 * When the ground truth has no visible keypoints, there is nothing to score;
 * this returns 0 as a documented sentinel (an undefined OKS is treated as the
 * worst score so it never inflates aggregate accuracy).
 *
 * @param predicted - Predicted keypoints (expected length 33 after normalization).
 * @param gt - Ground-truth frame in the 33-keypoint MediaPipe schema.
 * @param opts - Optional sigma overrides.
 * @returns OKS score in [0, 1]; 0 when no ground-truth keypoints are visible.
 */
export function computeOks(
  predicted: Keypoint[],
  gt: GroundTruthFrame,
  opts?: OksOptions,
): number {
  const terms = perKeypointOks(predicted, gt, opts);

  let sum = 0;
  let visibleCount = 0;
  for (let i = 0; i < terms.length; i++) {
    if (gt.visibility[i] !== true) continue;
    sum += terms[i] ?? 0;
    visibleCount++;
  }

  if (visibleCount === 0) return 0;

  return clamp01(sum / visibleCount);
}

/**
 * Compute recall as the fraction of visible ground-truth keypoints whose
 * individual per-keypoint OKS term meets or exceeds `threshold`.
 *
 * This is a per-keypoint recall (how many keypoints were localized well
 * enough), distinct from the aggregate {@link computeOks} score.
 *
 * @param predicted - Predicted keypoints (expected length 33 after normalization).
 * @param gt - Ground-truth frame in the 33-keypoint MediaPipe schema.
 * @param threshold - Minimum per-keypoint OKS term to count as recalled. Defaults to 0.5.
 * @param opts - Optional sigma overrides.
 * @returns Recall in [0, 1]; 0 when no ground-truth keypoints are visible.
 */
export function computeRecall(
  predicted: Keypoint[],
  gt: GroundTruthFrame,
  threshold = 0.5,
  opts?: OksOptions,
): number {
  const terms = perKeypointOks(predicted, gt, opts);

  let recalled = 0;
  let visibleCount = 0;
  for (let i = 0; i < terms.length; i++) {
    if (gt.visibility[i] !== true) continue;
    visibleCount++;
    if ((terms[i] ?? 0) >= threshold) recalled++;
  }

  if (visibleCount === 0) return 0;

  return recalled / visibleCount;
}
