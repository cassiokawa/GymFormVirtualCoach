/**
 * Unit tests for PoseLock.
 *
 * Validates the confidence-based lock mechanism that gates transition
 * to active tracking by requiring sustained keypoint confidence.
 *
 * Requirements: 3.1, 3.3, 3.4, 3.5
 */

import { describe, it, expect } from 'vitest';
import { PoseLock } from './PoseLock.js';
import type { Keypoint, LockConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a keypoint with specified index and confidence. */
function kp(index: number, confidence: number): Keypoint {
  return { index, x: 0.5, y: 0.5, z: 0, confidence };
}

/** Build a 33-keypoint array with all keypoints at the given confidence. */
function makeKeypoints(confidence = 0.9): Keypoint[] {
  const keypoints: Keypoint[] = [];
  for (let i = 0; i < 33; i++) {
    keypoints.push(kp(i, confidence));
  }
  return keypoints;
}

/** Build keypoints with specific overrides for individual indices. */
function makeKeypointsWithOverrides(
  baseConfidence: number,
  overrides: Record<number, number>,
): Keypoint[] {
  const keypoints = makeKeypoints(baseConfidence);
  for (const [index, confidence] of Object.entries(overrides)) {
    keypoints[Number(index)] = kp(Number(index), confidence);
  }
  return keypoints;
}

/** Default lock configuration used in most tests. */
const defaultConfig: LockConfig = {
  lockThreshold: 0.7,
  lockDuration: 15,
  pauseAfterFrames: 10,
  pauseThreshold: 0.5,
};

/** Required joint indices used in tests (left hip, left knee, left ankle). */
const requiredJoints = [23, 25, 27];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PoseLock', () => {
  describe('evaluateFrame() — lock acquisition', () => {
    it('acquires lock after exactly lockDuration consecutive good frames', () => {
      const lock = new PoseLock(defaultConfig, requiredJoints);
      const goodFrame = makeKeypoints(0.9);

      // Feed lockDuration - 1 frames — not yet locked
      for (let i = 0; i < defaultConfig.lockDuration - 1; i++) {
        lock.evaluateFrame(goodFrame);
      }
      expect(lock.isLocked()).toBe(false);

      // The lockDuration-th frame triggers lock
      lock.evaluateFrame(goodFrame);
      expect(lock.isLocked()).toBe(true);
    });

    it('returns true when all required keypoints meet threshold', () => {
      const lock = new PoseLock(defaultConfig, requiredJoints);
      const goodFrame = makeKeypoints(0.9);

      const result = lock.evaluateFrame(goodFrame);

      expect(result).toBe(true);
    });

    it('returns false when any required keypoint is below threshold', () => {
      const lock = new PoseLock(defaultConfig, requiredJoints);
      const badFrame = makeKeypointsWithOverrides(0.9, { 25: 0.3 });

      const result = lock.evaluateFrame(badFrame);

      expect(result).toBe(false);
    });
  });

  describe('evaluateFrame() — counter reset', () => {
    it('resets consecutive counter to 0 when any required keypoint drops below threshold', () => {
      const lock = new PoseLock(defaultConfig, requiredJoints);
      const goodFrame = makeKeypoints(0.9);
      const badFrame = makeKeypointsWithOverrides(0.9, { 27: 0.5 });

      // Accumulate 10 good frames
      for (let i = 0; i < 10; i++) {
        lock.evaluateFrame(goodFrame);
      }
      expect(lock.getLockProgress()).toBeCloseTo(10 / 15);

      // One bad frame resets the counter
      lock.evaluateFrame(badFrame);
      expect(lock.getLockProgress()).toBe(0);

      // Need full lockDuration from scratch
      for (let i = 0; i < defaultConfig.lockDuration; i++) {
        lock.evaluateFrame(goodFrame);
      }
      expect(lock.isLocked()).toBe(true);
    });
  });

  describe('getLockProgress()', () => {
    it('returns correct fraction during countdown', () => {
      const lock = new PoseLock(defaultConfig, requiredJoints);
      const goodFrame = makeKeypoints(0.9);

      expect(lock.getLockProgress()).toBe(0);

      lock.evaluateFrame(goodFrame);
      expect(lock.getLockProgress()).toBeCloseTo(1 / 15);

      for (let i = 0; i < 4; i++) {
        lock.evaluateFrame(goodFrame);
      }
      expect(lock.getLockProgress()).toBeCloseTo(5 / 15);
    });

    it('clamps to 1 when consecutive frames exceed lockDuration', () => {
      const lock = new PoseLock(defaultConfig, requiredJoints);
      const goodFrame = makeKeypoints(0.9);

      // Feed more frames than lockDuration
      for (let i = 0; i < 20; i++) {
        lock.evaluateFrame(goodFrame);
      }

      expect(lock.getLockProgress()).toBe(1);
    });

    it('returns 0 after a bad frame resets progress', () => {
      const lock = new PoseLock(defaultConfig, requiredJoints);
      const goodFrame = makeKeypoints(0.9);
      const badFrame = makeKeypointsWithOverrides(0.9, { 23: 0.1 });

      for (let i = 0; i < 8; i++) {
        lock.evaluateFrame(goodFrame);
      }
      lock.evaluateFrame(badFrame);

      expect(lock.getLockProgress()).toBe(0);
    });
  });

  describe('shouldPause()', () => {
    it('detects pause after pauseAfterFrames consecutive low-confidence frames', () => {
      const lock = new PoseLock(defaultConfig, requiredJoints);
      const lowConfFrame = makeKeypoints(0.3); // avg below pauseThreshold (0.5)

      // Feed pauseAfterFrames - 1 bad frames — not yet paused
      for (let i = 0; i < defaultConfig.pauseAfterFrames - 1; i++) {
        expect(lock.shouldPause(lowConfFrame)).toBe(false);
      }

      // The pauseAfterFrames-th frame triggers pause
      expect(lock.shouldPause(lowConfFrame)).toBe(true);
    });

    it('resets bad frame counter when avg confidence meets threshold', () => {
      const lock = new PoseLock(defaultConfig, requiredJoints);
      const lowConfFrame = makeKeypoints(0.3);
      const goodConfFrame = makeKeypoints(0.8);

      // Accumulate 5 bad frames
      for (let i = 0; i < 5; i++) {
        lock.shouldPause(lowConfFrame);
      }

      // One good frame resets the counter
      lock.shouldPause(goodConfFrame);

      // Need full pauseAfterFrames from scratch
      for (let i = 0; i < defaultConfig.pauseAfterFrames - 1; i++) {
        expect(lock.shouldPause(lowConfFrame)).toBe(false);
      }
      expect(lock.shouldPause(lowConfFrame)).toBe(true);
    });

    it('does not trigger pause when avg confidence stays above threshold', () => {
      const lock = new PoseLock(defaultConfig, requiredJoints);
      const goodConfFrame = makeKeypoints(0.8);

      for (let i = 0; i < 20; i++) {
        expect(lock.shouldPause(goodConfFrame)).toBe(false);
      }
    });
  });

  describe('forceActive()', () => {
    it('immediately sets state to active', () => {
      const lock = new PoseLock(defaultConfig, requiredJoints);

      expect(lock.getState()).toBe('framing');

      lock.forceActive();

      expect(lock.getState()).toBe('active');
    });

    it('works regardless of current state', () => {
      const lock = new PoseLock(defaultConfig, requiredJoints);

      // Advance to positioning
      lock.advanceState(0.8, 0.5);
      expect(lock.getState()).toBe('positioning');

      lock.forceActive();
      expect(lock.getState()).toBe('active');
    });
  });

  describe('reset()', () => {
    it('zeroes all counters and returns to framing state', () => {
      const lock = new PoseLock(defaultConfig, requiredJoints);
      const goodFrame = makeKeypoints(0.9);
      const lowConfFrame = makeKeypoints(0.3);

      // Build up some state
      for (let i = 0; i < 10; i++) {
        lock.evaluateFrame(goodFrame);
      }
      for (let i = 0; i < 5; i++) {
        lock.shouldPause(lowConfFrame);
      }
      lock.forceActive();

      expect(lock.getState()).toBe('active');
      expect(lock.getLockProgress()).toBeGreaterThan(0);

      // Reset
      lock.reset();

      expect(lock.getState()).toBe('framing');
      expect(lock.getLockProgress()).toBe(0);
      expect(lock.isLocked()).toBe(false);
    });

    it('resets pause counter so shouldPause returns false', () => {
      const lock = new PoseLock(defaultConfig, requiredJoints);
      const lowConfFrame = makeKeypoints(0.3);

      // Accumulate bad frames nearly to pause threshold
      for (let i = 0; i < defaultConfig.pauseAfterFrames - 1; i++) {
        lock.shouldPause(lowConfFrame);
      }

      lock.reset();

      // After reset, need full pauseAfterFrames again
      expect(lock.shouldPause(lowConfFrame)).toBe(false);
    });
  });
});
