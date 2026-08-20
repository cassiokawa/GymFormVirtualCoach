import type { Keypoint, LockConfig, PreTrackingState } from '../types/index.js';

/**
 * Pose_Lock gates transition to active tracking by requiring sustained
 * confidence across required keypoints for a configurable duration.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */
export class PoseLock {
  private readonly config: LockConfig;
  private readonly requiredJointIndices: number[];
  private consecutiveGoodFrames: number = 0;
  private consecutiveBadFrames: number = 0;
  private state: PreTrackingState = 'framing';

  constructor(config: LockConfig, requiredJointIndices: number[]) {
    this.config = config;
    this.requiredJointIndices = requiredJointIndices;
  }

  /**
   * Evaluate a keypoint frame for lock conditions.
   * Returns true when ALL required keypoints meet the confidence threshold.
   */
  evaluateFrame(keypoints: Keypoint[]): boolean {
    const allGood = this.requiredJointIndices.every((i) => {
      const kp = keypoints[i];
      return kp != null && kp.confidence >= this.config.lockThreshold;
    });

    if (allGood) {
      this.consecutiveGoodFrames++;
    } else {
      this.consecutiveGoodFrames = 0;
    }

    return allGood;
  }

  /**
   * Get current progress toward lock as a fraction [0, 1].
   */
  getLockProgress(): number {
    return Math.min(1, this.consecutiveGoodFrames / this.config.lockDuration);
  }

  /**
   * Advance the internal state based on framing and position scores.
   * Transitions: framing → positioning → locking → active.
   */
  advanceState(framingScore: number, positionScore: number): PreTrackingState {
    switch (this.state) {
      case 'framing':
        if (framingScore >= 0.7) {
          this.state = 'positioning';
        }
        break;
      case 'positioning':
        if (positionScore >= 1.0) {
          this.state = 'locking';
        }
        break;
      case 'locking':
        if (this.consecutiveGoodFrames >= this.config.lockDuration) {
          this.state = 'active';
        }
        break;
      case 'active':
        // No automatic transition out of active via advanceState;
        // pause logic is handled via shouldPause().
        break;
    }
    return this.state;
  }

  /**
   * Check if active tracking should be paused due to sustained confidence drop.
   * Computes average confidence of required keypoints and tracks consecutive bad frames.
   */
  shouldPause(keypoints: Keypoint[]): boolean {
    let totalConfidence = 0;
    let count = 0;

    for (const i of this.requiredJointIndices) {
      const kp = keypoints[i];
      if (kp != null) {
        totalConfidence += kp.confidence;
        count++;
      }
    }

    const avgConfidence = count > 0 ? totalConfidence / count : 0;

    if (avgConfidence < this.config.pauseThreshold) {
      this.consecutiveBadFrames++;
    } else {
      this.consecutiveBadFrames = 0;
    }

    return this.consecutiveBadFrames >= this.config.pauseAfterFrames;
  }

  /**
   * Reset all counters and return to framing state.
   */
  reset(): void {
    this.consecutiveGoodFrames = 0;
    this.consecutiveBadFrames = 0;
    this.state = 'framing';
  }

  /**
   * Force transition to active state (skip lock).
   */
  forceActive(): void {
    this.state = 'active';
  }

  /**
   * Returns true when consecutive good frames meets or exceeds lockDuration.
   */
  isLocked(): boolean {
    return this.consecutiveGoodFrames >= this.config.lockDuration;
  }

  /**
   * Get the current pre-tracking state.
   */
  getState(): PreTrackingState {
    return this.state;
  }
}
