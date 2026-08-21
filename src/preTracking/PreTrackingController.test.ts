/**
 * @vitest-environment jsdom
 *
 * Unit tests for PreTrackingController.
 *
 * Validates the pre-tracking pipeline orchestration that gates Active_Tracking:
 * - Full state transition pipeline: framing → positioning → locking → active
 * - Regression from active → framing when pause condition triggers
 * - skipLock() immediately sets state to active and fires callback
 * - Position advisor feedback suppressed while in framing state (framingScore < 0.7)
 * - onLockAchieved callback fires exactly once on successful lock
 *
 * Requirements: 2.4, 3.2, 3.5, 4.4
 */

import { describe, it, expect, vi } from 'vitest';
import { PreTrackingController } from './PreTrackingController.js';
import type { Keypoint, KeypointMessage, ExerciseFSMConfig, LockConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arcTo: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    measureText: vi.fn(() => ({ width: 100 })),
    roundRect: vi.fn(),
    setLineDash: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
  };
  vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return canvas;
}

/** Create a keypoint at normalised (x, y) with specified confidence. */
function kp(index: number, x: number, y: number, confidence = 0.9): Keypoint {
  return { index, x, y, z: 0, confidence };
}

/**
 * Build a full 33-keypoint array spread evenly inside the target zone
 * (x: 0.1–0.9, y: 0.05–0.95) so the framing score is high.
 * All keypoints have high confidence by default.
 */
function makeHighFramingKeypoints(confidence = 0.9): Keypoint[] {
  const keypoints: Keypoint[] = [];
  for (let i = 0; i < 33; i++) {
    // Spread keypoints across the target zone for high overlap
    const x = 0.15 + (i / 33) * 0.7; // range [0.15, 0.85]
    const y = 0.1 + (i / 33) * 0.8;  // range [0.1, 0.9]
    keypoints.push(kp(i, x, y, confidence));
  }
  return keypoints;
}

/**
 * Build keypoints with low visibility / outside the target zone
 * to produce a low framing score (< 0.5).
 */
function makeLowFramingKeypoints(): Keypoint[] {
  const keypoints: Keypoint[] = [];
  for (let i = 0; i < 33; i++) {
    // Low confidence means few "visible" keypoints → low visibility ratio
    keypoints.push(kp(i, 0.5, 0.5, 0.2));
  }
  return keypoints;
}

/**
 * Build keypoints arranged to produce a ~170° angle at left_knee
 * (indices 23, 25, 27: hip → knee → ankle) — within startThreshold [160, 180].
 * Also keeps all 33 keypoints visible and inside the target zone.
 */
function makeGoodPositionKeypoints(): Keypoint[] {
  const keypoints = makeHighFramingKeypoints(0.9);

  // Place left_knee triplet to form ~170° angle:
  // proximal (hip, idx 23) above joint, distal (ankle, idx 27) nearly collinear
  keypoints[23] = kp(23, 0.5, 0.3, 0.9);  // hip above
  keypoints[25] = kp(25, 0.5, 0.5, 0.9);  // knee (joint centre)
  // ~170° = nearly straight, distal almost directly below
  const rad = (170 * Math.PI) / 180;
  const bcX = 0.2 * Math.sin(rad);
  const bcY = -0.2 * Math.cos(rad);
  keypoints[27] = kp(27, 0.5 + bcX, 0.5 + bcY, 0.9); // ankle

  return keypoints;
}

/**
 * Build keypoints that produce a ~90° angle at left_knee — outside [160, 180].
 * Keeps high framing score (all 33 visible, good overlap).
 */
function makeBadPositionKeypoints(): Keypoint[] {
  const keypoints = makeHighFramingKeypoints(0.9);

  // Place left_knee triplet to form ~90° angle:
  keypoints[23] = kp(23, 0.5, 0.3, 0.9);  // hip above
  keypoints[25] = kp(25, 0.5, 0.5, 0.9);  // knee (joint centre)
  const rad = (90 * Math.PI) / 180;
  const bcX = 0.2 * Math.sin(rad);
  const bcY = -0.2 * Math.cos(rad);
  keypoints[27] = kp(27, 0.5 + bcX, 0.5 + bcY, 0.9); // ankle

  return keypoints;
}

/** Helper to wrap keypoints in a KeypointMessage. */
function makeMessage(keypoints: Keypoint[], frameId = 1): KeypointMessage {
  return { type: 'keypoints', frameId, timestampMs: frameId * 33, keypoints };
}

/** Exercise config tracking left_knee with a startThreshold of [160, 180]. */
const testConfig: ExerciseFSMConfig = {
  exerciseName: 'test_squat',
  joints: ['left_knee'],
  startThreshold: { min: 160, max: 180 },
  inflectionThreshold: { min: 90, max: 130 },
  completeThreshold: { min: 60, max: 95 },
  warningThreshold: { min: 0, max: 55 },
  criticalThreshold: { min: 0, max: 160 },
};

/**
 * Lock config with short lockDuration for faster testing.
 * lockThreshold: 0.4 means keypoints with confidence >= 0.4 pass.
 */
const testLockConfig: LockConfig = {
  lockThreshold: 0.4,
  lockDuration: 3,       // only 3 frames to lock (fast for tests)
  pauseAfterFrames: 3,   // 3 consecutive bad frames to pause
  pauseThreshold: 0.3,
};

function createController(lockConfig?: LockConfig) {
  const canvas = createMockCanvas();
  return new PreTrackingController({
    canvas,
    config: testConfig,
    lockConfig: lockConfig ?? testLockConfig,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PreTrackingController', () => {
  describe('full state transition pipeline: framing → positioning → locking → active', () => {
    it('transitions through all states when conditions are met', () => {
      const controller = createController();

      // STATE 1: framing — starts in framing
      expect(controller.getState()).toBe('framing');

      // Process frame with high framing score (>= 0.5) to advance to positioning
      const highFramingMsg = makeMessage(makeHighFramingKeypoints());
      const status1 = controller.processFrame(highFramingMsg);
      expect(status1.state).toBe('positioning');

      // STATE 2: positioning — needs positionScore >= 0.6
      // Feed good position keypoints (left_knee at ~170°, within [160, 180])
      const goodPosMsg = makeMessage(makeGoodPositionKeypoints(), 2);
      const status2 = controller.processFrame(goodPosMsg);
      // Score should be 1.0 (single joint in range) which is >= 0.6
      expect(status2.state).toBe('locking');

      // STATE 3: locking — needs lockDuration consecutive good frames
      // With lockDuration=3, need 3 frames with required joint confidence >= lockThreshold
      const lockMsg = makeMessage(makeGoodPositionKeypoints(), 3);
      controller.processFrame(lockMsg); // frame 1
      controller.processFrame(makeMessage(makeGoodPositionKeypoints(), 4)); // frame 2
      const status3 = controller.processFrame(makeMessage(makeGoodPositionKeypoints(), 5)); // frame 3
      expect(status3.state).toBe('active');
      expect(status3.isLocked).toBe(true);
    });
  });

  describe('regression from active → framing when pause condition triggers', () => {
    it('reverts to framing when sustained low confidence is detected', () => {
      const controller = createController();

      // Drive to active state
      controller.processFrame(makeMessage(makeHighFramingKeypoints()));
      controller.processFrame(makeMessage(makeGoodPositionKeypoints(), 2));
      controller.processFrame(makeMessage(makeGoodPositionKeypoints(), 3));
      controller.processFrame(makeMessage(makeGoodPositionKeypoints(), 4));
      const activeStatus = controller.processFrame(makeMessage(makeGoodPositionKeypoints(), 5));
      expect(activeStatus.state).toBe('active');

      // Now feed frames with very low confidence on required joints to trigger pause.
      // PoseLock.shouldPause checks avg confidence of required joints < pauseThreshold (0.3)
      // for pauseAfterFrames (3) consecutive frames.
      const lowConfKeypoints = makeHighFramingKeypoints(0.1); // confidence 0.1 < 0.3
      controller.processFrame(makeMessage(lowConfKeypoints, 6));
      controller.processFrame(makeMessage(lowConfKeypoints, 7));
      const pausedStatus = controller.processFrame(makeMessage(lowConfKeypoints, 8));

      expect(pausedStatus.state).toBe('framing');
    });
  });

  describe('skipLock()', () => {
    it('immediately sets state to active and fires callback', () => {
      const controller = createController();
      const callback = vi.fn();
      controller.onLockAchieved(callback);

      // Still in framing state
      expect(controller.getState()).toBe('framing');

      // Skip the lock
      controller.skipLock();

      expect(controller.getState()).toBe('active');
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('works even without a registered callback', () => {
      const controller = createController();

      controller.skipLock();

      expect(controller.getState()).toBe('active');
    });
  });

  describe('position advisor feedback suppressed while in framing state', () => {
    it('returns no position cues when still in framing state (framingScore < 0.5)', () => {
      const controller = createController();

      // Feed low framing keypoints — stays in framing, framingScore < 0.5
      const lowFramingMsg = makeMessage(makeLowFramingKeypoints());
      const status = controller.processFrame(lowFramingMsg);

      expect(status.state).toBe('framing');
      expect(status.positionCues).toHaveLength(0);
    });

    it('position cues only appear once in positioning state', () => {
      const controller = createController();

      // First advance to positioning with high framing score
      controller.processFrame(makeMessage(makeHighFramingKeypoints()));
      expect(controller.getState()).toBe('positioning');

      // Now feed bad position keypoints — should get cues
      const badPosMsg = makeMessage(makeBadPositionKeypoints(), 2);
      const status = controller.processFrame(badPosMsg);

      expect(status.state).toBe('positioning');
      expect(status.positionCues.length).toBeGreaterThan(0);
    });
  });

  describe('onLockAchieved callback fires exactly once on successful lock', () => {
    it('fires callback exactly once when lock completes', () => {
      const controller = createController();
      const callback = vi.fn();
      controller.onLockAchieved(callback);

      // Drive to active state through normal pipeline
      controller.processFrame(makeMessage(makeHighFramingKeypoints()));
      controller.processFrame(makeMessage(makeGoodPositionKeypoints(), 2));
      // locking phase — 3 frames needed
      controller.processFrame(makeMessage(makeGoodPositionKeypoints(), 3));
      controller.processFrame(makeMessage(makeGoodPositionKeypoints(), 4));
      controller.processFrame(makeMessage(makeGoodPositionKeypoints(), 5));

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('does not fire callback again on subsequent frames in active state', () => {
      const controller = createController();
      const callback = vi.fn();
      controller.onLockAchieved(callback);

      // Drive to active state
      controller.processFrame(makeMessage(makeHighFramingKeypoints()));
      controller.processFrame(makeMessage(makeGoodPositionKeypoints(), 2));
      controller.processFrame(makeMessage(makeGoodPositionKeypoints(), 3));
      controller.processFrame(makeMessage(makeGoodPositionKeypoints(), 4));
      controller.processFrame(makeMessage(makeGoodPositionKeypoints(), 5));

      expect(callback).toHaveBeenCalledTimes(1);

      // Continue processing in active state
      controller.processFrame(makeMessage(makeGoodPositionKeypoints(), 6));
      controller.processFrame(makeMessage(makeGoodPositionKeypoints(), 7));

      // Still only fired once
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });
});
