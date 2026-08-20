/**
 * Unit tests for PositionAdvisor.
 *
 * Validates that the position evaluation correctly scores joints against the
 * exercise start threshold and generates appropriate directional cues.
 */

import { describe, it, expect } from 'vitest';
import { PositionAdvisor } from './PositionAdvisor.js';
import type { Keypoint, ExerciseFSMConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a valid keypoint at (x, y) with full confidence. */
function kp(index: number, x: number, y: number, confidence = 0.9): Keypoint {
  return { index, x, y, z: 0, confidence };
}

/** Build a full 33-keypoint array with all points at a known position. */
function makeKeypoints(overrides: Partial<Record<number, Keypoint>> = {}): Keypoint[] {
  const keypoints: Keypoint[] = [];
  for (let i = 0; i < 33; i++) {
    keypoints.push(overrides[i] ?? kp(i, 0.5, 0.5));
  }
  return keypoints;
}

/**
 * Places keypoints to form a specific angle at the knee joint (indices 23, 25, 27).
 * For a straight leg (~180°), proximal and distal are collinear through joint.
 * For a bent knee (~90°), proximal is directly above joint, distal is to the right.
 */
function kneeAngleKeypoints(angleDeg: number): Partial<Record<number, Keypoint>> {
  // Joint centre at (0.5, 0.5)
  const joint = kp(25, 0.5, 0.5);
  // Place proximal (hip, index 23) directly above the knee
  const proximal = kp(23, 0.5, 0.3);
  // Place distal (ankle, index 27) at the target angle from the proximal ray
  const rad = (angleDeg * Math.PI) / 180;
  // BA vector points up (0, -0.2). We place C such that angle between BA and BC = angleDeg.
  // Rotate BA by angleDeg to get BC direction.
  const bcX = 0.2 * Math.sin(rad);
  const bcY = -0.2 * Math.cos(rad);
  const distal = kp(27, 0.5 + bcX, 0.5 + bcY);

  return { 23: proximal, 25: joint, 27: distal };
}

/** A config that tracks only left_knee with startThreshold [160, 180]. */
const singleJointConfig: ExerciseFSMConfig = {
  exerciseName: 'test_exercise',
  joints: ['left_knee'],
  startThreshold: { min: 160, max: 180 },
  inflectionThreshold: { min: 90, max: 130 },
  completeThreshold: { min: 60, max: 95 },
  warningThreshold: { min: 0, max: 55 },
  criticalThreshold: { min: 0, max: 160 },
};

/** A config that tracks both knees. */
const dualJointConfig: ExerciseFSMConfig = {
  exerciseName: 'test_dual',
  joints: ['left_knee', 'right_knee'],
  startThreshold: { min: 160, max: 180 },
  inflectionThreshold: { min: 90, max: 130 },
  completeThreshold: { min: 60, max: 95 },
  warningThreshold: { min: 0, max: 55 },
  criticalThreshold: { min: 0, max: 160 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PositionAdvisor', () => {
  describe('evaluate()', () => {
    it('returns score = 1 when all joints are within startThreshold', () => {
      const advisor = new PositionAdvisor(singleJointConfig);
      // ~170° angle — within [160, 180]
      const overrides = kneeAngleKeypoints(170);
      const keypoints = makeKeypoints(overrides);

      const result = advisor.evaluate(keypoints, 1, 1000);

      expect(result.score).toBeCloseTo(1.0, 1);
      expect(result.cues).toHaveLength(0);
    });

    it('returns score = 0 when all joints are outside startThreshold', () => {
      const advisor = new PositionAdvisor(singleJointConfig);
      // ~90° angle — well outside [160, 180]
      const overrides = kneeAngleKeypoints(90);
      const keypoints = makeKeypoints(overrides);

      const result = advisor.evaluate(keypoints, 1, 1000);

      expect(result.score).toBeCloseTo(0, 1);
      expect(result.cues).toHaveLength(1);
    });

    it('returns score = 0.5 when half of joints are in range', () => {
      const advisor = new PositionAdvisor(dualJointConfig);
      // Left knee at ~170° (in range), right knee at ~90° (out of range)
      const leftOverrides = kneeAngleKeypoints(170);
      // For right knee: indices 24 (hip), 26 (knee), 28 (ankle)
      const rightJoint = kp(26, 0.7, 0.5);
      const rightProximal = kp(24, 0.7, 0.3);
      // ~90° angle for the right knee
      const rightDistal = kp(28, 0.9, 0.5);

      const keypoints = makeKeypoints({
        ...leftOverrides,
        24: rightProximal,
        26: rightJoint,
        28: rightDistal,
      });

      const result = advisor.evaluate(keypoints, 1, 1000);

      expect(result.score).toBeCloseTo(0.5, 1);
      expect(result.cues).toHaveLength(1);
      expect(result.cues[0]?.jointName).toBe('right_knee');
    });

    it('skips joints with unavailable angles (low confidence)', () => {
      const advisor = new PositionAdvisor(dualJointConfig);
      // Left knee has good keypoints at ~170°
      const leftOverrides = kneeAngleKeypoints(170);
      // Right knee has low-confidence keypoints
      const rightJoint = kp(26, 0.7, 0.5, 0.1); // confidence below 0.5
      const rightProximal = kp(24, 0.7, 0.3, 0.1);
      const rightDistal = kp(28, 0.9, 0.5, 0.1);

      const keypoints = makeKeypoints({
        ...leftOverrides,
        24: rightProximal,
        26: rightJoint,
        28: rightDistal,
      });

      const result = advisor.evaluate(keypoints, 1, 1000);

      // Only left_knee is trackable, and it's in range → score = 1
      expect(result.score).toBeCloseTo(1.0, 1);
      expect(result.cues).toHaveLength(0);
    });

    it('returns score = 0 when no joints are trackable', () => {
      const advisor = new PositionAdvisor(singleJointConfig);
      // All keypoints have zero confidence
      const keypoints: Keypoint[] = [];
      for (let i = 0; i < 33; i++) {
        keypoints.push(kp(i, 0.5, 0.5, 0.0));
      }

      const result = advisor.evaluate(keypoints, 1, 1000);

      expect(result.score).toBe(0);
      expect(result.cues).toHaveLength(0);
    });

    it('skips unknown joints not in JOINT_KEYPOINT_MAP', () => {
      const configWithUnknown: ExerciseFSMConfig = {
        ...singleJointConfig,
        joints: ['left_knee', 'unknown_joint'],
      };
      const advisor = new PositionAdvisor(configWithUnknown);
      const overrides = kneeAngleKeypoints(170);
      const keypoints = makeKeypoints(overrides);

      const result = advisor.evaluate(keypoints, 1, 1000);

      // Only left_knee is trackable (unknown_joint is skipped)
      expect(result.score).toBeCloseTo(1.0, 1);
      expect(result.cues).toHaveLength(0);
    });
  });

  describe('generateCue (via evaluate)', () => {
    it('generates "Extend" cue when angle is below threshold.min', () => {
      const advisor = new PositionAdvisor(singleJointConfig);
      // ~90° is below min of 160
      const overrides = kneeAngleKeypoints(90);
      const keypoints = makeKeypoints(overrides);

      const result = advisor.evaluate(keypoints, 1, 1000);

      expect(result.cues).toHaveLength(1);
      const cue = result.cues[0]!;
      expect(cue.jointName).toBe('left_knee');
      expect(cue.message).toContain('Extend');
      expect(cue.targetMin).toBe(160);
      expect(cue.targetMax).toBe(180);
    });

    it('generates "Bend" cue when angle is above threshold.max', () => {
      // Use a config where the max is lower so we can exceed it
      const lowThresholdConfig: ExerciseFSMConfig = {
        ...singleJointConfig,
        startThreshold: { min: 60, max: 95 },
      };
      const advisor = new PositionAdvisor(lowThresholdConfig);
      // ~170° is above max of 95
      const overrides = kneeAngleKeypoints(170);
      const keypoints = makeKeypoints(overrides);

      const result = advisor.evaluate(keypoints, 1, 1000);

      expect(result.cues).toHaveLength(1);
      const cue = result.cues[0]!;
      expect(cue.jointName).toBe('left_knee');
      expect(cue.message).toContain('Bend');
      expect(cue.targetMin).toBe(60);
      expect(cue.targetMax).toBe(95);
    });

    it('cue message uses display-friendly joint name (underscores to spaces)', () => {
      const advisor = new PositionAdvisor(singleJointConfig);
      const overrides = kneeAngleKeypoints(90);
      const keypoints = makeKeypoints(overrides);

      const result = advisor.evaluate(keypoints, 1, 1000);

      const cue = result.cues[0]!;
      expect(cue.message).toContain('left knee');
      expect(cue.message).not.toContain('left_knee');
    });
  });
});
