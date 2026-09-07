/**
 * Joint reference resolution.
 *
 * A {@link RefNode} in a signal / guard expression names a joint. This module
 * turns that name — together with a frame's landmark data and the spec's
 * `landmarkPairs` — into a concrete 3D point (or the {@link UNAVAILABLE}
 * sentinel). The rules (design.md, "Reference resolution"; Requirements 1.4,
 * 1.5):
 *
 * - An UNPREFIXED joint name (e.g. `hip`) resolves to the bilateral MIDPOINT of
 *   the left/right landmark indices declared for that name in `landmarkPairs`.
 * - A `left_` / `right_` PREFIXED name (e.g. `left_hip`, `right_ankle`)
 *   resolves to the single named side landmark from the same pair.
 *
 * Silence when uncertain: if any landmark required for the resolution has
 * visibility or presence below the confidence threshold — or the name cannot be
 * resolved at all — the result is {@link UNAVAILABLE}. A runtime coordinate is
 * never fabricated for a joint the pose model is not confident about.
 *
 * This is the resolution PRIMITIVE. Wiring it into the compiled closure tree is
 * task 5; here we provide the pure function and its own unit tests. It is
 * allocation-conscious: it writes into a caller-provided output buffer so the
 * per-frame hot path allocates nothing.
 *
 * HARD CONSTRAINT: no exercise `id`, name, or alias appears here. Joint names
 * (`hip`, `left_knee`, …) are anatomy, not exercise identity.
 *
 * Requirements: 1.4, 1.5
 */

import type { LandmarkPairs, LandmarkPair } from '../spec';
import type { LandmarkFrame } from '../types';
import { LANDMARK_COUNT, UNAVAILABLE } from '../types';

// ---------------------------------------------------------------------------
// Confidence threshold
// ---------------------------------------------------------------------------

/**
 * Default minimum visibility AND presence a landmark must have to be usable.
 * Below this, resolution yields {@link UNAVAILABLE} — the engine stays silent
 * rather than acting on a low-confidence coordinate.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Output buffer
// ---------------------------------------------------------------------------

/**
 * A mutable 3-slot buffer a resolved point is written into: `[x, y, z]`. Reused
 * across frames by the caller so resolution allocates nothing in the hot path.
 */
export type Point3 = Float32Array;

/** Allocate a fresh {@link Point3} buffer. Call this ONCE, outside the hot path. */
export function makePoint3(): Point3 {
  return new Float32Array(3);
}

// ---------------------------------------------------------------------------
// Side prefixes
// ---------------------------------------------------------------------------

const LEFT_PREFIX = 'left_';
const RIGHT_PREFIX = 'right_';

// ---------------------------------------------------------------------------
// Low-level landmark read
// ---------------------------------------------------------------------------

/**
 * True when `index` names a real landmark whose visibility and presence both
 * meet `threshold`. Out-of-range indices are never confident.
 */
export function isLandmarkConfident(
  frame: LandmarkFrame,
  index: number,
  threshold: number,
): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= LANDMARK_COUNT) {
    return false;
  }
  const visibility = frame.visibility[index];
  const presence = frame.presence[index];
  // `noUncheckedIndexedAccess`: a bounds-checked index can still be `undefined`
  // if the typed array is shorter than LANDMARK_COUNT. Treat that as not-confident.
  if (visibility === undefined || presence === undefined) {
    return false;
  }
  return visibility >= threshold && presence >= threshold;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a joint reference name to a 3D point, writing the result into `out`.
 *
 * @param name         The joint name exactly as written (e.g. `hip`, `left_hip`).
 * @param frame        The current landmark frame.
 * @param landmarkPairs The spec's unprefixed-name → left/right index mapping.
 * @param out          A 3-slot buffer the resolved `[x, y, z]` is written into.
 * @param threshold    Minimum visibility/presence; defaults to
 *                     {@link DEFAULT_CONFIDENCE_THRESHOLD}.
 * @returns `out` on success, or {@link UNAVAILABLE} when the name cannot be
 *          resolved or a required landmark is below the confidence threshold.
 *
 * The function is pure with respect to inputs other than `out`, performs no I/O,
 * and allocates nothing.
 */
export function resolveRef(
  name: string,
  frame: LandmarkFrame,
  landmarkPairs: LandmarkPairs,
  out: Point3,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): Point3 | typeof UNAVAILABLE {
  if (name.startsWith(LEFT_PREFIX)) {
    const base = name.slice(LEFT_PREFIX.length);
    const pair = lookupPair(landmarkPairs, base);
    if (pair === undefined) {
      return UNAVAILABLE;
    }
    return readLandmark(frame, pair.left, out, threshold);
  }

  if (name.startsWith(RIGHT_PREFIX)) {
    const base = name.slice(RIGHT_PREFIX.length);
    const pair = lookupPair(landmarkPairs, base);
    if (pair === undefined) {
      return UNAVAILABLE;
    }
    return readLandmark(frame, pair.right, out, threshold);
  }

  // Unprefixed: bilateral midpoint of the pair's left and right landmarks.
  const pair = lookupPair(landmarkPairs, name);
  if (pair === undefined) {
    return UNAVAILABLE;
  }
  return readMidpoint(frame, pair.left, pair.right, out, threshold);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Look up a landmark pair by unprefixed name. `landmarkPairs` is an index
 * signature, so a miss is `undefined` under `noUncheckedIndexedAccess`.
 */
function lookupPair(
  landmarkPairs: LandmarkPairs,
  name: string,
): LandmarkPair | undefined {
  return landmarkPairs[name];
}

/**
 * Read a single landmark's `[x, y, z]` into `out` from the flat `points` array
 * at `index * 3`, provided the landmark meets the confidence threshold.
 */
function readLandmark(
  frame: LandmarkFrame,
  index: number,
  out: Point3,
  threshold: number,
): Point3 | typeof UNAVAILABLE {
  if (!isLandmarkConfident(frame, index, threshold)) {
    return UNAVAILABLE;
  }
  const base = index * 3;
  const x = frame.points[base];
  const y = frame.points[base + 1];
  const z = frame.points[base + 2];
  if (x === undefined || y === undefined || z === undefined) {
    return UNAVAILABLE;
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

/**
 * Read the midpoint of two landmarks into `out`. BOTH landmarks must be
 * confident; otherwise the whole reference is {@link UNAVAILABLE}.
 */
function readMidpoint(
  frame: LandmarkFrame,
  leftIndex: number,
  rightIndex: number,
  out: Point3,
  threshold: number,
): Point3 | typeof UNAVAILABLE {
  if (
    !isLandmarkConfident(frame, leftIndex, threshold) ||
    !isLandmarkConfident(frame, rightIndex, threshold)
  ) {
    return UNAVAILABLE;
  }
  const lb = leftIndex * 3;
  const rb = rightIndex * 3;
  const lx = frame.points[lb];
  const ly = frame.points[lb + 1];
  const lz = frame.points[lb + 2];
  const rx = frame.points[rb];
  const ry = frame.points[rb + 1];
  const rz = frame.points[rb + 2];
  if (
    lx === undefined ||
    ly === undefined ||
    lz === undefined ||
    rx === undefined ||
    ry === undefined ||
    rz === undefined
  ) {
    return UNAVAILABLE;
  }
  out[0] = (lx + rx) * 0.5;
  out[1] = (ly + ry) * 0.5;
  out[2] = (lz + rz) * 0.5;
  return out;
}
