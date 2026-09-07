import { describe, it, expect } from 'vitest';
import { LANDMARK_COUNT } from '../domain/analysis/types';
import type { LandmarkFrame } from '../domain/analysis/types';
import type { ExerciseSpecMeta } from './types';
import {
  computeAngleCorrection,
  createFramingValidator,
  estimateViewAngleDeg,
  evaluateFraming,
  frameHeightOccupancy,
  landmarkName,
} from './FramingValidator';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * A side-view, reps-mode spec meta. Required landmarks are the lower body
 * (hips/knees/ankles) plus shoulders. Identity fields are data-only literals
 * confined to this fixture, never referenced by the code under test.
 */
function makeSpec(overrides: Partial<ExerciseSpecMeta> = {}): ExerciseSpecMeta {
  const spec: ExerciseSpecMeta = {
    id: 'fixture_movement',
    version: '1.0.0',
    displayName: 'Fixture Movement',
    aliases: ['fixture'],
    facets: { equipment: 'none', primaryMuscles: ['quads'], position: 'standing' },
    mode: 'reps',
    bilateral: true,
    camera: { preferredAngleDeg: 90, toleranceDeg: 15, view: 'side' },
    requiredLandmarks: [11, 12, 23, 24, 25, 26, 27, 28],
  };
  return { ...spec, ...overrides };
}

interface Placement {
  x?: number;
  y?: number;
  visibility?: number;
}

/**
 * Build a frame where every landmark index in `place` is positioned; all other
 * landmarks are invisible (visibility 0). Defaults: x=0.5, visibility=1.
 */
function makeFrame(place: Record<number, Placement>): LandmarkFrame {
  const points = new Float32Array(LANDMARK_COUNT * 3);
  const visibility = new Float32Array(LANDMARK_COUNT);
  const presence = new Float32Array(LANDMARK_COUNT);
  for (const [k, p] of Object.entries(place)) {
    const i = Number(k);
    points[i * 3] = p.x ?? 0.5;
    points[i * 3 + 1] = p.y ?? 0.5;
    points[i * 3 + 2] = 0;
    const v = p.visibility ?? 1;
    visibility[i] = v;
    presence[i] = v;
  }
  return { t: 0, points, visibility, presence };
}

/**
 * A fully-framed subject: all required landmarks present, front-on shoulders
 * (wide separation), and a vertical span of ~65% (occupancy ok). Extra
 * landmarks are added so occupancy reflects a plausible silhouette.
 */
function wellFramed(): Record<number, Placement> {
  return {
    // Shoulders wide apart at 0.28 → ~front-on (angle ≈ 0°).
    11: { x: 0.64, y: 0.2 },
    12: { x: 0.36, y: 0.2 },
    23: { x: 0.55, y: 0.5 },
    24: { x: 0.45, y: 0.5 },
    25: { x: 0.55, y: 0.65 },
    26: { x: 0.45, y: 0.65 },
    27: { x: 0.55, y: 0.85 },
    28: { x: 0.45, y: 0.85 },
  };
}

// ---------------------------------------------------------------------------
// landmarkName
// ---------------------------------------------------------------------------

describe('landmarkName', () => {
  it('maps standard indices to plain-language body parts', () => {
    expect(landmarkName(25)).toBe('left knee');
    expect(landmarkName(26)).toBe('right knee');
    expect(landmarkName(0)).toBe('nose');
  });

  it('falls back for out-of-range indices', () => {
    expect(landmarkName(99)).toBe('body point 99');
  });
});

// ---------------------------------------------------------------------------
// Missing landmarks (R4.2)
// ---------------------------------------------------------------------------

describe('missing landmarks (R4.2)', () => {
  it('names a required landmark that is below confidence', () => {
    const place = wellFramed();
    place[25] = { x: 0.55, y: 0.65, visibility: 0.1 }; // left knee not confident
    const verdict = evaluateFraming(makeFrame(place), makeSpec());
    expect(verdict.missingLandmarks).toContain('left knee');
    expect(verdict.ok).toBe(false);
  });

  it('names a required landmark that is outside the frame', () => {
    const place = wellFramed();
    place[28] = { x: 1.4, y: 0.85 }; // right ankle off-frame (x > 1)
    const verdict = evaluateFraming(makeFrame(place), makeSpec());
    expect(verdict.missingLandmarks).toContain('right ankle');
    expect(verdict.ok).toBe(false);
  });

  it('reports no missing landmarks when all required are present', () => {
    const verdict = evaluateFraming(makeFrame(wellFramed()), makeSpec());
    expect(verdict.missingLandmarks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Distance (R4.4)
// ---------------------------------------------------------------------------

describe('distance (R4.4)', () => {
  it('classifies <40% occupancy as too_far (move closer)', () => {
    // Compress everything into a narrow vertical band (~10% span).
    const place: Record<number, Placement> = {
      11: { x: 0.64, y: 0.45 },
      12: { x: 0.36, y: 0.45 },
      23: { x: 0.55, y: 0.48 },
      24: { x: 0.45, y: 0.48 },
      25: { x: 0.55, y: 0.5 },
      26: { x: 0.45, y: 0.5 },
      27: { x: 0.55, y: 0.53 },
      28: { x: 0.45, y: 0.55 },
    };
    const occupancy = frameHeightOccupancy(makeFrame(place));
    expect(occupancy).toBeLessThan(0.4);
    const verdict = evaluateFraming(makeFrame(place), makeSpec());
    expect(verdict.distance).toBe('too_far');
    expect(verdict.distanceHintMetres).not.toBeNull();
    expect(verdict.ok).toBe(false);
  });

  it('classifies >90% occupancy as too_close (move further)', () => {
    const place: Record<number, Placement> = {
      11: { x: 0.64, y: 0.02 },
      12: { x: 0.36, y: 0.02 },
      23: { x: 0.55, y: 0.4 },
      24: { x: 0.45, y: 0.4 },
      25: { x: 0.55, y: 0.6 },
      26: { x: 0.45, y: 0.6 },
      27: { x: 0.55, y: 0.98 },
      28: { x: 0.45, y: 0.98 },
    };
    const occupancy = frameHeightOccupancy(makeFrame(place));
    expect(occupancy).toBeGreaterThan(0.9);
    const verdict = evaluateFraming(makeFrame(place), makeSpec());
    expect(verdict.distance).toBe('too_close');
    expect(verdict.distanceHintMetres).not.toBeNull();
    expect(verdict.ok).toBe(false);
  });

  it('classifies in-band occupancy as ok with no hint', () => {
    const verdict = evaluateFraming(makeFrame(wellFramed()), makeSpec());
    expect(verdict.distance).toBe('ok');
    expect(verdict.distanceHintMetres).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Angle correction (R4.3)
// ---------------------------------------------------------------------------

describe('angle correction (R4.3)', () => {
  it('returns null when within tolerance', () => {
    expect(computeAngleCorrection(90, 15, 88)).toBeNull();
    expect(computeAngleCorrection(90, 15, 90)).toBeNull();
  });

  it('directs left when estimated angle exceeds preferred beyond tolerance', () => {
    const c = computeAngleCorrection(45, 10, 70);
    expect(c).not.toBeNull();
    expect(c?.direction).toBe('left');
    expect(c?.degrees).toBe(25);
  });

  it('directs right when estimated angle is below preferred beyond tolerance', () => {
    const c = computeAngleCorrection(80, 10, 40);
    expect(c).not.toBeNull();
    expect(c?.direction).toBe('right');
    expect(c?.degrees).toBe(40);
  });

  it('returns null when the angle cannot be estimated (shoulders missing)', () => {
    expect(computeAngleCorrection(90, 15, null)).toBeNull();
  });

  it('estimates ~0° for front-on shoulders and ~90° for overlapping shoulders', () => {
    const frontOn = estimateViewAngleDeg(makeFrame({ 11: { x: 0.64 }, 12: { x: 0.36 } }));
    expect(frontOn).not.toBeNull();
    expect(frontOn as number).toBeLessThan(10);

    const sideOn = estimateViewAngleDeg(makeFrame({ 11: { x: 0.5 }, 12: { x: 0.5 } }));
    expect(sideOn as number).toBeGreaterThan(80);
  });

  it('surfaces an angle correction in the verdict for a side-view spec seen front-on', () => {
    // Spec prefers 90° (side); subject is front-on (~0°) → deviation 90° > 15°.
    const verdict = evaluateFraming(makeFrame(wellFramed()), makeSpec());
    expect(verdict.angleCorrection).not.toBeNull();
    expect(verdict.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ok conjunction (R4.5)
// ---------------------------------------------------------------------------

describe('verdict.ok conjunction (R4.5)', () => {
  it('is true only when all sub-checks pass', () => {
    // Front-on-preferred spec so the well-framed (front-on) frame passes angle.
    const spec = makeSpec({ camera: { preferredAngleDeg: 0, toleranceDeg: 15, view: 'front' } });
    const verdict = evaluateFraming(makeFrame(wellFramed()), spec);
    expect(verdict.missingLandmarks).toEqual([]);
    expect(verdict.angleCorrection).toBeNull();
    expect(verdict.distance).toBe('ok');
    expect(verdict.ok).toBe(true);
  });

  it('is false when only the angle check fails', () => {
    // Same well-framed frame but a side-view spec → angle correction present.
    const verdict = evaluateFraming(makeFrame(wellFramed()), makeSpec());
    expect(verdict.missingLandmarks).toEqual([]);
    expect(verdict.distance).toBe('ok');
    expect(verdict.angleCorrection).not.toBeNull();
    expect(verdict.ok).toBe(false);
  });

  it('is total on an all-zero frame (no landmarks visible)', () => {
    const empty = makeFrame({});
    const verdict = evaluateFraming(empty, makeSpec());
    expect(verdict.ok).toBe(false);
    expect(verdict.missingLandmarks.length).toBeGreaterThan(0);
    expect(verdict.distance).toBe('too_far');
  });
});

// ---------------------------------------------------------------------------
// createFramingValidator wrapper
// ---------------------------------------------------------------------------

describe('createFramingValidator', () => {
  it('evaluate matches evaluateFraming with a derived angle', () => {
    const spec = makeSpec({ camera: { preferredAngleDeg: 0, toleranceDeg: 15, view: 'front' } });
    const frame = makeFrame(wellFramed());
    const validator = createFramingValidator();
    expect(validator.evaluate(frame, spec)).toEqual(evaluateFraming(frame, spec));
  });
});
