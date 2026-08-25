/**
 * Unit tests for the OKS (Object Keypoint Similarity) helpers.
 *
 * Covers computeOks, computeRecall, perKeypointOks and the exported sigma
 * tables against the 33-keypoint MediaPipe ground-truth schema.
 *
 * Requirements validated: 3.3
 * Design: "Property 3: OKS bounds".
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import type { Keypoint } from '../../types/index.js';
import type { GroundTruthFrame } from '../types.js';
import {
  computeOks,
  computeRecall,
  perKeypointOks,
  MEDIAPIPE_SIGMAS,
  COCO_SIGMAS,
} from './oks.js';

const KEYPOINT_COUNT = 33;

/** Build a Keypoint with sensible defaults. */
function kp(index: number, x: number, y: number, confidence = 1): Keypoint {
  return { index, x, y, z: 0, confidence };
}

/**
 * Build a GroundTruthFrame fixture. `points` supplies 33 {x,y} positions and
 * `visibility` supplies 33 flags; both default to a spread pose fully visible.
 */
function makeGt(
  points: Array<{ x: number; y: number }>,
  visibility: boolean[],
): GroundTruthFrame {
  return {
    id: 'gt-1',
    sourceVideoId: 'vid-1',
    frameIndex: 0,
    imageRef: new Blob(['x']),
    keypoints: points,
    visibility,
    createdMs: 0,
  };
}

/** A deterministic spread of 33 points across the normalized frame. */
function spreadPoints(): Array<{ x: number; y: number }> {
  return Array.from({ length: KEYPOINT_COUNT }, (_, i) => ({
    x: 0.1 + (i / KEYPOINT_COUNT) * 0.8,
    y: 0.1 + ((i * 7) % KEYPOINT_COUNT) / KEYPOINT_COUNT * 0.8,
  }));
}

/** Predicted keypoints that exactly match the given GT points. */
function predictedFromGt(points: Array<{ x: number; y: number }>): Keypoint[] {
  return points.map((p, i) => kp(i, p.x, p.y));
}

describe('OKS sigma tables', () => {
  it('exposes 17 COCO sigmas and 33 MediaPipe sigmas', () => {
    expect(COCO_SIGMAS).toHaveLength(17);
    expect(MEDIAPIPE_SIGMAS).toHaveLength(33);
    for (const s of MEDIAPIPE_SIGMAS) {
      expect(s).toBeGreaterThan(0);
    }
  });
});

describe('computeOks', () => {
  it('returns 1.0 for identical predicted vs ground-truth poses (Property 3)', () => {
    const points = spreadPoints();
    const gt = makeGt(points, new Array(KEYPOINT_COUNT).fill(true));
    const predicted = predictedFromGt(points);

    expect(computeOks(predicted, gt)).toBeCloseTo(1.0, 10);
  });

  it('returns a lower value when predicted keypoints are offset', () => {
    const points = spreadPoints();
    const visibility = new Array(KEYPOINT_COUNT).fill(true);
    const gt = makeGt(points, visibility);

    const exact = predictedFromGt(points);
    const offset = points.map((p, i) => kp(i, p.x + 0.1, p.y + 0.1));

    const exactScore = computeOks(exact, gt);
    const offsetScore = computeOks(offset, gt);

    expect(offsetScore).toBeLessThan(exactScore);
    expect(offsetScore).toBeGreaterThanOrEqual(0);
  });

  it('stays within [0,1] for a spread of arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            gx: fc.double({ min: 0, max: 1, noNaN: true }),
            gy: fc.double({ min: 0, max: 1, noNaN: true }),
            px: fc.double({ min: 0, max: 1, noNaN: true }),
            py: fc.double({ min: 0, max: 1, noNaN: true }),
            vis: fc.boolean(),
          }),
          { minLength: KEYPOINT_COUNT, maxLength: KEYPOINT_COUNT },
        ),
        (rows) => {
          const points = rows.map((r) => ({ x: r.gx, y: r.gy }));
          const visibility = rows.map((r) => r.vis);
          const predicted = rows.map((r, i) => kp(i, r.px, r.py));
          const gt = makeGt(points, visibility);

          const oks = computeOks(predicted, gt);
          expect(oks).toBeGreaterThanOrEqual(0);
          expect(oks).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('returns 0 when no ground-truth keypoints are visible', () => {
    const points = spreadPoints();
    const gt = makeGt(points, new Array(KEYPOINT_COUNT).fill(false));
    const predicted = predictedFromGt(points);

    expect(computeOks(predicted, gt)).toBe(0);
  });

  it('matches the hand-computed exp(-d^2/(2 s^2 k^2)) for a single-visible-keypoint case', () => {
    // GT bbox: two visible keypoints define an axis-aligned box.
    // Corner A at (0.2, 0.2) is the scored keypoint (index 5, left_shoulder).
    // Corner B at (0.6, 0.5) sets the bbox so scale s = sqrt(width*height).
    const points: Array<{ x: number; y: number }> = Array.from(
      { length: KEYPOINT_COUNT },
      () => ({ x: 0, y: 0 }),
    );
    points[5] = { x: 0.2, y: 0.2 };
    points[6] = { x: 0.6, y: 0.5 };

    const visibility = new Array(KEYPOINT_COUNT).fill(false);
    visibility[5] = true;
    visibility[6] = true;

    const gt = makeGt(points, visibility);

    // Predict index 5 offset by a known distance; index 6 exact (term = 1).
    const dx = 0.03;
    const dy = 0.04; // distance d = 0.05
    const predicted: Keypoint[] = points.map((p, i) => kp(i, p.x, p.y));
    predicted[5] = kp(5, 0.2 + dx, 0.2 + dy);

    // Hand-compute scale and the index-5 term.
    const width = 0.6 - 0.2;
    const height = 0.5 - 0.2;
    const scale = Math.sqrt(width * height);
    const sigma5 = MEDIAPIPE_SIGMAS[5]!;
    const dSq = dx * dx + dy * dy;
    const term5 = Math.exp(-dSq / (2 * scale * scale * sigma5 * sigma5));

    // Two visible keypoints: index 6 term is 1 (exact), index 5 is term5.
    const expectedOks = (term5 + 1) / 2;

    expect(computeOks(predicted, gt)).toBeCloseTo(expectedOks, 12);

    // And the per-keypoint value for index 5 matches the hand-computed term.
    const terms = perKeypointOks(predicted, gt);
    expect(terms[5]).toBeCloseTo(term5, 12);
  });
});

describe('perKeypointOks', () => {
  it('returns an array whose length matches gt.keypoints', () => {
    const points = spreadPoints();
    const gt = makeGt(points, new Array(KEYPOINT_COUNT).fill(true));
    const terms = perKeypointOks(predictedFromGt(points), gt);
    expect(terms).toHaveLength(KEYPOINT_COUNT);
  });

  it('yields 0 for not-visible entries', () => {
    const points = spreadPoints();
    const visibility = new Array(KEYPOINT_COUNT).fill(true);
    visibility[3] = false;
    visibility[10] = false;
    const gt = makeGt(points, visibility);

    const terms = perKeypointOks(predictedFromGt(points), gt);
    expect(terms[3]).toBe(0);
    expect(terms[10]).toBe(0);
    // A visible, exact keypoint still scores 1.
    expect(terms[0]).toBeCloseTo(1, 10);
  });
});

describe('computeRecall', () => {
  it('counts keypoints above the threshold correctly', () => {
    // Three visible GT keypoints; two predicted exactly (term 1 >= 0.5),
    // one predicted far away (term below 0.5).
    const points: Array<{ x: number; y: number }> = Array.from(
      { length: KEYPOINT_COUNT },
      () => ({ x: 0, y: 0 }),
    );
    points[5] = { x: 0.2, y: 0.2 };
    points[6] = { x: 0.8, y: 0.8 }; // widens bbox so scale is nonzero
    points[11] = { x: 0.5, y: 0.5 };

    const visibility = new Array(KEYPOINT_COUNT).fill(false);
    visibility[5] = true;
    visibility[6] = true;
    visibility[11] = true;

    const gt = makeGt(points, visibility);

    const predicted: Keypoint[] = points.map((p, i) => kp(i, p.x, p.y));
    // Push index 11 far off so its OKS term drops below 0.5.
    predicted[11] = kp(11, 0.5 + 0.5, 0.5 + 0.5);

    const recall = computeRecall(predicted, gt, 0.5);
    // 2 of 3 visible keypoints recalled.
    expect(recall).toBeCloseTo(2 / 3, 10);
  });

  it('returns 1 when all visible keypoints match exactly', () => {
    const points = spreadPoints();
    const gt = makeGt(points, new Array(KEYPOINT_COUNT).fill(true));
    expect(computeRecall(predictedFromGt(points), gt, 0.5)).toBe(1);
  });

  it('returns 0 when no keypoints are visible', () => {
    const points = spreadPoints();
    const gt = makeGt(points, new Array(KEYPOINT_COUNT).fill(false));
    expect(computeRecall(predictedFromGt(points), gt, 0.5)).toBe(0);
  });
});
