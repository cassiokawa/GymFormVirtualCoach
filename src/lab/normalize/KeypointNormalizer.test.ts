/**
 * Unit and property-based tests for KeypointNormalizer.
 *
 * Verifies 33-kp pass-through, 17-kp COCO -> 33-kp MediaPipe zero-fill mapping,
 * value copying at mapped indices, zero-fill of unmapped indices, and the
 * unsupported-count error. Includes the Property 1 round-trip test from the
 * design document.
 *
 * Requirements: 1.4, 2.1, 2.5, 2.6, 2.7
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  KeypointNormalizer,
  UnsupportedKeypointCountError,
} from './KeypointNormalizer.js';
import { COCO_TO_MEDIAPIPE } from './keypointMap.js';
import type { Keypoint } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build an array of `count` keypoints with deterministic distinct values. */
function makeKeypoints(count: number): Keypoint[] {
  return Array.from({ length: count }, (_, index): Keypoint => ({
    index,
    x: (index + 1) * 0.01,
    y: (index + 1) * 0.02,
    z: (index + 1) * 0.03,
    confidence: Math.min(1, (index + 1) * 0.04),
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KeypointNormalizer', () => {
  const normalizer = new KeypointNormalizer();

  it('passes 33-keypoint input through unchanged', () => {
    const input = makeKeypoints(33);
    const output = normalizer.normalize(input);

    expect(output).toHaveLength(33);
    expect(output).toBe(input);
  });

  it('produces exactly 33 elements with correct index fields (0-32) from 17-kp input', () => {
    const input = makeKeypoints(17);
    const output = normalizer.normalize(input);

    expect(output).toHaveLength(33);
    output.forEach((kp, position) => {
      expect(kp.index).toBe(position);
    });
  });

  it('copies x/y/z/confidence to mapped indices (nose->0, left_hip->23, right_ankle->28)', () => {
    const input = makeKeypoints(17);
    const output = normalizer.normalize(input);

    // nose: COCO 0 -> MediaPipe 0
    expect(output[0]).toMatchObject({
      x: input[0].x,
      y: input[0].y,
      z: input[0].z,
      confidence: input[0].confidence,
    });

    // left_hip: COCO 11 -> MediaPipe 23
    expect(output[23]).toMatchObject({
      x: input[11].x,
      y: input[11].y,
      z: input[11].z,
      confidence: input[11].confidence,
    });

    // right_ankle: COCO 16 -> MediaPipe 28
    expect(output[28]).toMatchObject({
      x: input[16].x,
      y: input[16].y,
      z: input[16].z,
      confidence: input[16].confidence,
    });
  });

  it('zero-fills unmapped MediaPipe indices with confidence 0 and x/y/z 0', () => {
    const input = makeKeypoints(17);
    const output = normalizer.normalize(input);

    const mappedTargets = new Set(COCO_TO_MEDIAPIPE.map(([, mp]) => mp));
    const unmappedSamples = [1, 3, 4, 17, 18, 19, 20, 21, 22, 29, 30, 31, 32];

    for (const idx of unmappedSamples) {
      expect(mappedTargets.has(idx)).toBe(false); // sanity: truly unmapped
      expect(output[idx]).toEqual({ index: idx, x: 0, y: 0, z: 0, confidence: 0 });
    }
  });

  it('throws UnsupportedKeypointCountError for non-17/33 lengths', () => {
    expect(() => normalizer.normalize(makeKeypoints(0))).toThrow(
      UnsupportedKeypointCountError,
    );
    expect(() => normalizer.normalize(makeKeypoints(16))).toThrow(
      UnsupportedKeypointCountError,
    );
    expect(() => normalizer.normalize(makeKeypoints(25))).toThrow(
      UnsupportedKeypointCountError,
    );
    expect(() => normalizer.normalize(makeKeypoints(34))).toThrow(
      /Unsupported keypoint count: 34/,
    );
  });

  // Property 1 (design doc): round-trip identity for mapped indices.
  it('PROPERTY: normalizing then extracting mapped indices yields the original 17-kp values', () => {
    const coordinate = () => fc.double({ min: -10, max: 10, noNaN: true });
    const keypointArb = (index: number) =>
      fc.record({
        index: fc.constant(index),
        x: coordinate(),
        y: coordinate(),
        z: coordinate(),
        confidence: fc.double({ min: 0, max: 1, noNaN: true }),
      });
    const cocoArb = fc.tuple(...Array.from({ length: 17 }, (_, i) => keypointArb(i)));

    fc.assert(
      fc.property(cocoArb, (kpTuple) => {
        const input = kpTuple as Keypoint[];
        const normalized = normalizer.normalize(input);

        for (const [cocoIndex, mediapipeIndex] of COCO_TO_MEDIAPIPE) {
          const source = input[cocoIndex];
          const target = normalized[mediapipeIndex];
          expect(target.x).toBe(source.x);
          expect(target.y).toBe(source.y);
          expect(target.z).toBe(source.z);
          expect(target.confidence).toBe(source.confidence);
        }
      }),
    );
  });
});
