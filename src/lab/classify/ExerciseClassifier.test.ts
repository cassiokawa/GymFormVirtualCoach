/**
 * Unit tests for ExerciseClassifier.
 *
 * Exercises the sliding-window buffering/stride cadence, confidence thresholding
 * ("unknown" below threshold), label management, and reset behaviour of the
 * deterministic stub classifier (no trained weights required).
 *
 * Requirements: 6.1, 6.3, 6.5
 * Validates: Property 6 (Classifier windowing)
 */

import { describe, it, expect } from 'vitest';
import { ExerciseClassifier } from './ExerciseClassifier.js';
import type { Keypoint } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a 33-keypoint frame. `hipY` drives the hip landmarks (23/24) so a
 * sequence of frames with varied hipY produces vertical motion that feeds the
 * stub's motion heuristic. Other keypoints get a mid-frame position.
 */
function makeFrame(hipY = 0.5, confidence = 0.9): Keypoint[] {
  const frame: Keypoint[] = [];
  for (let i = 0; i < 33; i += 1) {
    const y = i === 23 || i === 24 ? hipY : 0.5;
    frame.push({ index: i, x: 0.5, y, z: 0, confidence });
  }
  return frame;
}

/**
 * Build `count` frames whose hip Y oscillates across [0.2, 0.8] to give the
 * stub a non-trivial motion signal. The exact values are deterministic so
 * tests are reproducible.
 */
function makeVariedFrames(count: number): Keypoint[][] {
  const frames: Keypoint[][] = [];
  for (let i = 0; i < count; i += 1) {
    // Triangular oscillation between 0.2 and 0.8.
    const phase = (i % 10) / 10;
    const hipY = 0.2 + 0.6 * Math.abs(0.5 - phase) * 2;
    frames.push(makeFrame(hipY));
  }
  return frames;
}

const DEFAULT_LABELS = ['squat', 'push_up', 'shoulder_press', 'bicep_curl'];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExerciseClassifier', () => {
  describe('windowing / buffering (Property 6)', () => {
    it('returns null until windowSize frames are buffered', () => {
      const windowSize = 5;
      const clf = new ExerciseClassifier({ windowSize, stride: 2, threshold: 0 });
      const frames = makeVariedFrames(windowSize);

      // First windowSize-1 frames: all null.
      for (let i = 0; i < windowSize - 1; i += 1) {
        expect(clf.pushFrame(frames[i]!)).toBeNull();
      }

      // The windowSize-th frame yields a result.
      const result = clf.pushFrame(frames[windowSize - 1]!);
      expect(result).not.toBeNull();
    });

    it('emits results every `stride` frames after the first full window', () => {
      const windowSize = 5;
      const stride = 2;
      const clf = new ExerciseClassifier({ windowSize, stride, threshold: 0 });
      const frames = makeVariedFrames(windowSize + 4 * stride);

      let idx = 0;
      // Fill the first window; only the last push emits.
      for (; idx < windowSize - 1; idx += 1) {
        expect(clf.pushFrame(frames[idx]!)).toBeNull();
      }
      expect(clf.pushFrame(frames[idx]!)).not.toBeNull();
      idx += 1;

      // Now, over the next frames: null on intermediate, non-null every stride.
      for (let step = 0; step < 4; step += 1) {
        for (let k = 0; k < stride - 1; k += 1) {
          expect(clf.pushFrame(frames[idx]!)).toBeNull();
          idx += 1;
        }
        // The stride-th frame emits.
        expect(clf.pushFrame(frames[idx]!)).not.toBeNull();
        idx += 1;
      }
    });

    it('every emitted result has confidence in [0, 1]', () => {
      const windowSize = 5;
      const clf = new ExerciseClassifier({ windowSize, stride: 2, threshold: 0 });
      const frames = makeVariedFrames(windowSize + 10);

      for (const frame of frames) {
        const result = clf.pushFrame(frame);
        if (result !== null) {
          expect(result.confidence).toBeGreaterThanOrEqual(0);
          expect(result.confidence).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  describe('confidence thresholding', () => {
    it("reports 'unknown' with the actual confidence when below a very high threshold", () => {
      const windowSize = 5;
      const clf = new ExerciseClassifier({ windowSize, stride: 2, threshold: 0.999 });
      const frames = makeVariedFrames(windowSize);

      let result = null;
      for (const frame of frames) {
        result = clf.pushFrame(frame) ?? result;
      }
      expect(result).not.toBeNull();
      expect(result!.label).toBe('unknown');
      // Confidence is the actual softmax value, still a valid probability.
      expect(result!.confidence).toBeGreaterThanOrEqual(0);
      expect(result!.confidence).toBeLessThan(0.999);
    });

    it('returns a concrete label from the default set when threshold is very low', () => {
      const windowSize = 5;
      const clf = new ExerciseClassifier({ windowSize, stride: 2, threshold: 0 });
      const frames = makeVariedFrames(windowSize);

      let result = null;
      for (const frame of frames) {
        result = clf.pushFrame(frame) ?? result;
      }
      expect(result).not.toBeNull();
      expect(result!.label).not.toBe('unknown');
      expect(DEFAULT_LABELS).toContain(result!.label);
    });
  });

  describe('reset()', () => {
    it('clears the buffer so it returns null until refilled', () => {
      const windowSize = 5;
      const clf = new ExerciseClassifier({ windowSize, stride: 2, threshold: 0 });
      const frames = makeVariedFrames(windowSize * 2);

      // Fill to first full window.
      for (let i = 0; i < windowSize; i += 1) {
        clf.pushFrame(frames[i]!);
      }

      clf.reset();

      // After reset, buffering restarts: null until windowSize frames again.
      for (let i = 0; i < windowSize - 1; i += 1) {
        expect(clf.pushFrame(frames[i]!)).toBeNull();
      }
      expect(clf.pushFrame(frames[windowSize - 1]!)).not.toBeNull();
    });
  });

  describe('setLabels()', () => {
    it('changes the reported labels', () => {
      const windowSize = 5;
      const clf = new ExerciseClassifier({ windowSize, stride: 2, threshold: 0 });
      const customLabels = ['deadlift', 'lunge', 'plank'];
      clf.setLabels(customLabels);

      const frames = makeVariedFrames(windowSize);
      let result = null;
      for (const frame of frames) {
        result = clf.pushFrame(frame) ?? result;
      }
      expect(result).not.toBeNull();
      expect(customLabels).toContain(result!.label);
    });

    it('throws when given an empty label set', () => {
      const clf = new ExerciseClassifier({ windowSize: 5, stride: 2 });
      expect(() => clf.setLabels([])).toThrow();
    });
  });
});
