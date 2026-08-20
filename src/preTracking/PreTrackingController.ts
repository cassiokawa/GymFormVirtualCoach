/**
 * Pre-Tracking Controller — orchestrates the Framing Guide, Position Advisor,
 * and Pose Lock into a sequential pipeline that gates Active_Tracking.
 *
 * State machine: framing → positioning → locking → active
 *
 * Requirements: 1.1, 2.1, 2.4, 3.1, 3.2, 4.1, 4.4
 */

import { FramingGuide } from '../framingGuide/FramingGuide.js';
import { PositionAdvisor } from '../positionAdvisor/PositionAdvisor.js';
import { PoseLock } from '../poseLock/PoseLock.js';
import { DEFAULT_LOCK_CONFIG } from '../config/lockConfig.js';
import type {
  KeypointMessage,
  ExerciseFSMConfig,
  LockConfig,
  PreTrackingState,
  PreTrackingStatus,
  PositionCue,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Joint name → MediaPipe landmark index mapping
// ---------------------------------------------------------------------------

const JOINT_INDEX_MAP: Record<string, number> = {
  left_knee: 25,
  right_knee: 26,
  left_hip: 23,
  right_hip: 24,
  left_elbow: 13,
  right_elbow: 14,
  left_shoulder: 11,
  right_shoulder: 12,
};

// ---------------------------------------------------------------------------
// PreTrackingController
// ---------------------------------------------------------------------------

export class PreTrackingController {
  private state: PreTrackingState = 'framing';
  private readonly framingGuide: FramingGuide;
  private readonly positionAdvisor: PositionAdvisor;
  private readonly poseLock: PoseLock;
  private onLockedCallback: (() => void) | null = null;
  private lastFramingScore = 0;
  private lastPositionScore = 0;

  constructor(options: {
    canvas: HTMLCanvasElement;
    config: ExerciseFSMConfig;
    lockConfig?: LockConfig;
  }) {
    const lockConfig = options.lockConfig ?? DEFAULT_LOCK_CONFIG;

    this.framingGuide = new FramingGuide(options.canvas);
    this.positionAdvisor = new PositionAdvisor(options.config);

    // Derive requiredJointIndices from config.joints using the index map
    const requiredIndices = options.config.joints
      .map((j) => JOINT_INDEX_MAP[j])
      .filter((i): i is number => i !== undefined);

    this.poseLock = new PoseLock(lockConfig, requiredIndices);
  }

  /**
   * Process a single keypoint frame through the pre-tracking pipeline.
   * Returns a status snapshot for UI rendering.
   */
  processFrame(message: KeypointMessage): PreTrackingStatus {
    const keypoints = message.keypoints;
    let positionCues: PositionCue[] = [];

    // Always compute framing score (overlay feedback in all states)
    this.lastFramingScore = this.framingGuide.evaluate(keypoints);

    // State machine transitions
    switch (this.state) {
      case 'framing':
        if (this.lastFramingScore >= 0.5) {
          this.state = 'positioning';
        }
        break;

      case 'positioning': {
        const { score, cues } = this.positionAdvisor.evaluate(
          keypoints,
          message.frameId,
          message.timestampMs,
        );
        this.lastPositionScore = score;
        positionCues = cues;
        if (score >= 0.6) {
          this.state = 'locking';
        }
        break;
      }

      case 'locking':
        this.poseLock.evaluateFrame(keypoints);
        if (this.poseLock.getLockProgress() >= 1.0) {
          this.state = 'active';
          this.framingGuide.clear();
          this.onLockedCallback?.();
        }
        break;

      case 'active':
        if (this.poseLock.shouldPause(keypoints)) {
          this.state = 'framing';
          this.poseLock.reset();
        }
        break;
    }

    return {
      state: this.state,
      framingScore: this.lastFramingScore,
      startingPositionScore: this.lastPositionScore,
      lockProgress: this.poseLock.getLockProgress(),
      positionCues,
      isLocked: this.state === 'active',
    };
  }

  /** Register a callback that fires when the lock is achieved. */
  onLockAchieved(callback: () => void): void {
    this.onLockedCallback = callback;
  }

  /** Skip the lock countdown and immediately enter active tracking. */
  skipLock(): void {
    this.state = 'active';
    this.framingGuide.clear();
    this.onLockedCallback?.();
  }

  /** Reset the pipeline to the initial framing state. */
  resetToFraming(): void {
    this.state = 'framing';
    this.poseLock.reset();
    this.lastFramingScore = 0;
    this.lastPositionScore = 0;
  }

  /** Get the current pipeline state. */
  getState(): PreTrackingState {
    return this.state;
  }
}
