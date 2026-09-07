/**
 * FramingValidator — turns a single {@link LandmarkFrame} plus the selected
 * exercise's {@link ExerciseSpecMeta} into a structured {@link FramingVerdict}
 * (R4.1–R4.5). It runs continuously in SETUP; the SetupSurface maps
 * `verdict.ok` directly onto {@link SessionContext.framingValid}.
 *
 * ## Dependency rule
 *
 * Session UX depends INWARD on domain contracts. This module reads the
 * Analysis-context {@link LandmarkFrame} and the {@link ExerciseSpecMeta}
 * projection as data. It never reaches into analysis internals (no signal math,
 * no phase FSM) and it holds NO exercise identity literal — the missing-landmark
 * names are derived from landmark INDICES, not from any exercise id/name/alias
 * (`tech.md` rule 1).
 *
 * ## Purity
 *
 * {@link evaluate} is a pure, total function of its two inputs. It performs no
 * I/O and never throws: every landmark index, every empty frame, and every
 * degenerate geometry maps to a defined verdict. The heuristics below are
 * documented and deterministic.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import { LANDMARK_COUNT } from '../domain/analysis/types';
import type { LandmarkFrame } from '../domain/analysis/types';
import type { ExerciseSpecMeta } from './types';
import type { AngleCorrection, FramingDistance, FramingVerdict } from './types';

// ---------------------------------------------------------------------------
// Tunables (documented heuristics)
// ---------------------------------------------------------------------------

/**
 * Landmark-confidence threshold. A required landmark whose `visibility` is at or
 * above this AND whose (x, y) fall inside the normalised frame `[0, 1]` counts
 * as present; anything else is "missing" and named in plain language (R4.2).
 * Matches the existing FramingGuide visibility threshold for consistency.
 */
export const LANDMARK_CONFIDENCE_THRESHOLD = 0.5;

/** Below this frame-height occupancy the subject is too far (R4.4). */
export const OCCUPANCY_TOO_FAR = 0.4;

/** Above this frame-height occupancy the subject is too close (R4.4). */
export const OCCUPANCY_TOO_CLOSE = 0.9;

/**
 * Approximate real-world subject height (metres) used only to turn an occupancy
 * error into a rough "move ~X m" hint. Anthropometric average standing height;
 * the hint is deliberately coarse and never surfaced as a precise measurement.
 */
const ASSUMED_SUBJECT_HEIGHT_M = 1.7;

/**
 * Target occupancy the distance hint aims for (midpoint of the 40–90% band).
 * The hint estimates how far to move so the subject would fill this fraction.
 */
const TARGET_OCCUPANCY = 0.65;

// ---------------------------------------------------------------------------
// Landmark index → plain-language body-part name (R4.2)
// ---------------------------------------------------------------------------

/**
 * MediaPipe Pose landmark indices (0–32) mapped to plain-language body-part
 * names. This is a rendering concern (naming a body part for the user), NOT
 * exercise identity — indices are anatomical, not exercise-specific, so this
 * respects `tech.md` rule 1. Any required index absent from this map falls back
 * to a generic "body point N" label so the function stays total.
 */
const LANDMARK_NAMES: Readonly<Record<number, string>> = {
  0: 'nose',
  1: 'left eye',
  2: 'left eye',
  3: 'left eye',
  4: 'right eye',
  5: 'right eye',
  6: 'right eye',
  7: 'left ear',
  8: 'right ear',
  9: 'mouth',
  10: 'mouth',
  11: 'left shoulder',
  12: 'right shoulder',
  13: 'left elbow',
  14: 'right elbow',
  15: 'left wrist',
  16: 'right wrist',
  17: 'left hand',
  18: 'right hand',
  19: 'left hand',
  20: 'right hand',
  21: 'left hand',
  22: 'right hand',
  23: 'left hip',
  24: 'right hip',
  25: 'left knee',
  26: 'right knee',
  27: 'left ankle',
  28: 'right ankle',
  29: 'left heel',
  30: 'right heel',
  31: 'left foot',
  32: 'right foot',
};

/**
 * Plain-language name for a landmark index (R4.2). Falls back to a generic
 * label for any index outside the standard 33-point set so the caller never
 * sees `undefined`.
 */
export function landmarkName(index: number): string {
  return LANDMARK_NAMES[index] ?? `body point ${index}`;
}

// ---------------------------------------------------------------------------
// Frame accessors (pure, bounds-checked)
// ---------------------------------------------------------------------------

/** Whether a landmark index is in range and confidently visible in-frame. */
function isLandmarkPresent(frame: LandmarkFrame, index: number): boolean {
  if (index < 0 || index >= LANDMARK_COUNT) return false;
  const base = index * 3;
  const x = frame.points[base];
  const y = frame.points[base + 1];
  const v = frame.visibility[index];
  if (x === undefined || y === undefined || v === undefined) return false;
  if (v < LANDMARK_CONFIDENCE_THRESHOLD) return false;
  // Outside the normalised frame → not usable (R4.2 "outside the frame").
  return x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

// ---------------------------------------------------------------------------
// Missing-landmark check (R4.2)
// ---------------------------------------------------------------------------

/**
 * Plain-language names of every required landmark that is outside the frame or
 * below confidence (R4.2). Order follows `requiredLandmarks`; duplicate names
 * (e.g. two "left hand" indices) are de-duplicated so the user sees each body
 * part once.
 */
function missingLandmarkNames(
  frame: LandmarkFrame,
  required: readonly number[],
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const index of required) {
    if (isLandmarkPresent(frame, index)) continue;
    const name = landmarkName(index);
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Angle estimation + correction (R4.3)
// ---------------------------------------------------------------------------

/**
 * Estimate the camera view angle (degrees) from 2D shoulder foreshortening.
 *
 * HEURISTIC — approximate by construction. Estimating a true 3D camera angle
 * from a single 2D frame is under-determined; this uses shoulder separation as
 * a proxy:
 *
 * - Facing the camera front-on, the left/right shoulders are maximally
 *   separated horizontally (`|x11 − x12|` near the natural shoulder width).
 * - Rotating toward a side view foreshortens that separation toward 0.
 *
 * We map the observed horizontal shoulder separation to a view angle in
 * `[0°, 90°]` where 0° ≈ front-on and 90° ≈ full side. A reference front-on
 * shoulder width of 0.28 (normalised) is assumed; the mapping is
 * `angle = acos(clamp(sep / refWidth, 0, 1))`. Returns `null` when either
 * shoulder is missing (angle unknown → not gated on, per "silence when
 * uncertain").
 *
 * `spec.camera.preferredAngleDeg` is interpreted on the same 0°(front)–90°(side)
 * scale.
 */
export function estimateViewAngleDeg(frame: LandmarkFrame): number | null {
  const LEFT_SHOULDER = 11;
  const RIGHT_SHOULDER = 12;
  if (
    !isLandmarkPresent(frame, LEFT_SHOULDER) ||
    !isLandmarkPresent(frame, RIGHT_SHOULDER)
  ) {
    return null;
  }
  const lx = frame.points[LEFT_SHOULDER * 3] as number;
  const rx = frame.points[RIGHT_SHOULDER * 3] as number;
  const separation = Math.abs(lx - rx);
  const REFERENCE_FRONT_WIDTH = 0.28;
  const ratio = Math.min(1, Math.max(0, separation / REFERENCE_FRONT_WIDTH));
  const radians = Math.acos(ratio);
  return (radians * 180) / Math.PI;
}

/**
 * Compute the angle correction, or `null` when within tolerance / unknown.
 *
 * `estimatedAngleDeg` is injected so this is directly testable; when omitted it
 * is derived from the frame via {@link estimateViewAngleDeg}. If the angle can
 * not be estimated (shoulders missing) we return `null` — the missing-landmark
 * check already gates start, and we do not fabricate a correction from an
 * unknown angle (silence when uncertain).
 *
 * Direction convention: when the estimated angle exceeds the preferred angle
 * (subject rotated too far toward a side view) the user should rotate the
 * camera `'left'`; when below, `'right'`. `degrees` is the absolute deviation.
 */
export function computeAngleCorrection(
  preferredAngleDeg: number,
  toleranceDeg: number,
  estimatedAngleDeg: number | null,
): AngleCorrection | null {
  if (estimatedAngleDeg === null) return null;
  const deviation = estimatedAngleDeg - preferredAngleDeg;
  if (Math.abs(deviation) <= toleranceDeg) return null;
  return {
    direction: deviation > 0 ? 'left' : 'right',
    degrees: Math.abs(deviation),
  };
}

// ---------------------------------------------------------------------------
// Distance check (R4.4)
// ---------------------------------------------------------------------------

/**
 * Vertical span of visible landmarks as a fraction of frame height (0–1).
 * Uses every confidently-visible, in-frame landmark (not just required ones) so
 * the occupancy reflects the whole subject silhouette. Returns 0 when fewer
 * than two landmarks are visible (span undefined → treated as "too far").
 */
export function frameHeightOccupancy(frame: LandmarkFrame): number {
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    if (!isLandmarkPresent(frame, i)) continue;
    const y = frame.points[i * 3 + 1] as number;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    count += 1;
  }
  if (count < 2) return 0;
  return Math.min(1, Math.max(0, maxY - minY));
}

/** Classify occupancy into the 40–90% band (R4.4). */
function classifyDistance(occupancy: number): FramingDistance {
  if (occupancy < OCCUPANCY_TOO_FAR) return 'too_far';
  if (occupancy > OCCUPANCY_TOO_CLOSE) return 'too_close';
  return 'ok';
}

/**
 * Approximate metres to move (R4.4), or `null` when distance is `ok`.
 *
 * HEURISTIC — coarse. Under a pinhole model, apparent height is inversely
 * proportional to distance. From the current occupancy we estimate current
 * distance relative to the {@link TARGET_OCCUPANCY} distance and return the
 * signed-magnitude change, rounded to one decimetre. Positive means "move
 * further" (too close), positive-metres for "move closer" (too far) — the sign
 * is conveyed by the `distance` field, so this returns a positive magnitude.
 */
function distanceHintMetres(
  occupancy: number,
  distance: FramingDistance,
): number | null {
  if (distance === 'ok' || occupancy <= 0) return null;
  // Distance scales as height / occupancy for a fixed real subject height.
  const currentDistance = (ASSUMED_SUBJECT_HEIGHT_M / occupancy);
  const targetDistance = (ASSUMED_SUBJECT_HEIGHT_M / TARGET_OCCUPANCY);
  const delta = Math.abs(currentDistance - targetDistance);
  return Math.round(delta * 10) / 10;
}

// ---------------------------------------------------------------------------
// Verdict (R4.5 conjunction)
// ---------------------------------------------------------------------------

/**
 * Produce the framing verdict for a frame + selected exercise (R4.1–R4.5).
 *
 * `ok` is the conjunction (R4.5): no missing required landmarks AND angle
 * within tolerance (or unknown) AND distance in the 40–90% band. Pure and
 * total.
 *
 * @param frame the latest pose frame from Capture.
 * @param spec  the selected exercise metadata (data projection).
 * @param estimatedAngleDeg optional override for the estimated view angle,
 *        provided for testability; when omitted it is derived from `frame`.
 */
export function evaluateFraming(
  frame: LandmarkFrame,
  spec: ExerciseSpecMeta,
  estimatedAngleDeg?: number | null,
): FramingVerdict {
  const missingLandmarks = missingLandmarkNames(frame, spec.requiredLandmarks);

  const angle =
    estimatedAngleDeg === undefined
      ? estimateViewAngleDeg(frame)
      : estimatedAngleDeg;
  const angleCorrection = computeAngleCorrection(
    spec.camera.preferredAngleDeg,
    spec.camera.toleranceDeg,
    angle,
  );

  const occupancy = frameHeightOccupancy(frame);
  const distance = classifyDistance(occupancy);
  const hint = distanceHintMetres(occupancy, distance);

  const ok =
    missingLandmarks.length === 0 &&
    angleCorrection === null &&
    distance === 'ok';

  return {
    ok,
    missingLandmarks,
    angleCorrection,
    distance,
    distanceHintMetres: hint,
  };
}

/**
 * Stateful wrapper matching the `FramingValidator` interface in `design.md`.
 * Holds no state today (verdicts are pure); it exists so the SetupSurface can
 * depend on an interface rather than a bare function, and so an angle-estimate
 * strategy can be injected later without changing call sites.
 */
export interface FramingValidator {
  evaluate(frame: LandmarkFrame, spec: ExerciseSpecMeta): FramingVerdict;
}

/** Create the default {@link FramingValidator}. */
export function createFramingValidator(): FramingValidator {
  return {
    evaluate: (frame, spec) => evaluateFraming(frame, spec),
  };
}
