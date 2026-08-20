/**
 * WorkoutSession — orchestrates the real-time workout execution pipeline.
 *
 * Subscribes to `KeypointMessage` from the Pose_Detector Web Worker and
 * forwards keypoints to `FormEvaluator.evaluateFrame()` and `RepCounter.update()`.
 * Forwards `ErrorMessage` events to the UI error boundary callback.
 *
 * Requirements covered: 1.3, 1.5, 4.1, 4.2, 4.3, 4.4
 *   - 1.3: Pose_Detector executes within a Web Worker; this class subscribes
 *           to its messages on the main thread.
 *   - 1.5: Keypoint data is delivered to Form_Evaluator and Rep_Counter
 *           within 50 ms of frame capture.
 *   - 4.1: Pre-tracking phase gates frames before forwarding to RepCounter/FormEvaluator.
 *   - 4.2: Lock transition enables frame forwarding to RepCounter/FormEvaluator.
 *   - 4.3: Pre-tracking consumes same KeypointMessage format without worker changes.
 *   - 4.4: Skip lock bypasses the countdown and enters Active_Tracking immediately.
 */

import type { KeypointMessage, ErrorMessage, ExerciseFSMConfig, PreTrackingStatus } from '../types/index.js';
import { RepCounter } from '../repCounter/RepCounter.js';
import { FormEvaluator } from '../formEvaluator/FormEvaluator.js';
import type { CriticalDeviationCallback } from '../formEvaluator/FormEvaluator.js';
import { SafetyMonitor } from '../safetyMonitor/SafetyMonitor.js';
import { AlertSystem } from '../alertSystem/AlertSystem.js';
import { SessionLogger } from '../sessionLogger/SessionLogger.js';
import { PreTrackingController } from '../preTracking/PreTrackingController.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Callback invoked when the Web Worker emits an ErrorMessage. */
export type ErrorCallback = (error: ErrorMessage) => void;

// ---------------------------------------------------------------------------
// WorkoutSession class
// ---------------------------------------------------------------------------

/**
 * Orchestrates the real-time workout execution pipeline by wiring the
 * Pose_Detector Web Worker to Form_Evaluator, Rep_Counter, Safety_Monitor,
 * Alert_System, and Session_Logger.
 *
 * Lifecycle:
 *   1. Construct with exercise config, session metadata, and UI hooks.
 *   2. Call `start()` to spawn the Web Worker and begin processing frames.
 *   3. Call `sendFrame()` to push camera frames to the worker.
 *   4. Call `stop()` to terminate the worker and dismiss alerts.
 *
 * Requirements: 1.3, 1.5
 */
export class WorkoutSession {
  private worker: Worker | null = null;
  private readonly repCounter: RepCounter;
  private readonly formEvaluator: FormEvaluator;
  private readonly safetyMonitor: SafetyMonitor;
  private readonly alertSystem: AlertSystem;
  private readonly sessionLogger: SessionLogger;
  private readonly onError: ErrorCallback;
  private readonly preTrackingController: PreTrackingController | undefined;
  private readonly onPreTrackingStatus: ((status: PreTrackingStatus) => void) | undefined;
  private trackingState: 'pre_tracking' | 'active' = 'pre_tracking';
  private isActive = false;

  constructor(options: {
    config: ExerciseFSMConfig;
    sessionId: string;
    routineId: string;
    expectedTutMs: number;
    canvasContainer: HTMLElement;
    onError: ErrorCallback;
    canvas?: HTMLCanvasElement;
    onPreTrackingStatus?: (status: PreTrackingStatus) => void;
  }) {
    this.onError = options.onError;
    this.onPreTrackingStatus = options.onPreTrackingStatus;

    // Set up alert system (visual overlay + audio on canvas container)
    this.alertSystem = new AlertSystem(options.canvasContainer);

    // Set up safety monitor (classifies critical deviations → triggers alert system)
    this.safetyMonitor = new SafetyMonitor(options.config, (event, alertType) => {
      this.alertSystem.trigger(event, alertType);
    });

    // Set up form evaluator (notifies safety monitor on critical deviation)
    this.formEvaluator = new FormEvaluator(options.config, (event) => {
      this.safetyMonitor.onCriticalDeviation(event);
      // Mark the current rep as dangerous in the session log
      const currentRep = this.repCounter.getRepCount() || 1;
      this.sessionLogger.markRepDangerous(currentRep, event);
    });

    // Set up rep counter (FSM-based repetition tracking)
    this.repCounter = new RepCounter(options.config);

    // Set up session logger (accumulates rep telemetry)
    this.sessionLogger = new SessionLogger(options.sessionId, options.routineId);
    this.sessionLogger.startSet(options.config.exerciseName, options.expectedTutMs);

    // Set up pre-tracking controller when canvas is provided
    if (options.canvas) {
      this.preTrackingController = new PreTrackingController({
        canvas: options.canvas,
        config: options.config,
      });
      this.preTrackingController.onLockAchieved(() => {
        this.trackingState = 'active';
      });
    } else {
      // No canvas provided — skip pre-tracking entirely (backward compatible)
      this.trackingState = 'active';
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Spawn the Pose_Detector Web Worker and begin listening for keypoint
   * and error messages.
   *
   * Requirement 1.3 — Worker executes off main thread.
   */
  start(): void {
    this.worker = new Worker(
      new URL('../workers/poseDetector.worker.ts', import.meta.url),
      { type: 'module' },
    );

    this.worker.onmessage = (event: MessageEvent) => {
      const data = event.data as KeypointMessage | ErrorMessage;

      if (data.type === 'keypoints') {
        this.handleKeypoints(data);
      } else if (data.type === 'error') {
        this.onError(data);
      }
    };

    this.isActive = true;
  }

  /**
   * Terminate the Web Worker and dismiss any active alerts.
   */
  stop(): void {
    this.isActive = false;
    this.worker?.terminate();
    this.worker = null;
    this.alertSystem.dismiss();
  }

  /**
   * Push a camera frame to the Pose_Detector worker for processing.
   * The bitmap is transferred (zero-copy) to the worker thread.
   */
  sendFrame(bitmap: ImageBitmap, timestampMs: number): void {
    this.worker?.postMessage({ type: 'frame', bitmap, timestampMs }, [bitmap]);
  }

  /** Returns the current rep count for this set. */
  getRepCount(): number {
    return this.repCounter.getRepCount();
  }

  /** Returns the SessionLogger instance for session lifecycle management. */
  getSessionLogger(): SessionLogger {
    return this.sessionLogger;
  }

  /** Returns the RepCounter instance for external state inspection. */
  getRepCounter(): RepCounter {
    return this.repCounter;
  }

  /** Whether the session is currently active and processing frames. */
  isSessionActive(): boolean {
    return this.isActive;
  }

  /**
   * Skip the pre-tracking lock countdown and immediately enter Active_Tracking.
   * Delegates to PreTrackingController.skipLock().
   *
   * Requirement 4.4 — Manual skip bypasses lock countdown.
   */
  skipLock(): void {
    this.preTrackingController?.skipLock();
  }

  // -------------------------------------------------------------------------
  // Private — frame handling
  // -------------------------------------------------------------------------

  /**
   * Process a single KeypointMessage from the Pose_Detector worker.
   *
   * During pre-tracking: routes frames through PreTrackingController and
   * emits status via callback. Does NOT forward to RepCounter/FormEvaluator.
   *
   * During active tracking: forwards keypoints to RepCounter.update() and
   * FormEvaluator.evaluateFrame() as before.
   *
   * Requirements: 1.5, 4.1, 4.2
   */
  private handleKeypoints(message: KeypointMessage): void {
    if (!this.isActive) return;

    // Pre-tracking gate: route through PreTrackingController
    if (this.trackingState === 'pre_tracking' && this.preTrackingController) {
      const status = this.preTrackingController.processFrame(message);
      this.onPreTrackingStatus?.(status);
      return; // Do NOT forward to RepCounter/FormEvaluator yet
    }

    // Active tracking — existing logic (unchanged)
    const prevRepCount = this.repCounter.getRepCount();

    // Forward to rep counter (FSM transitions)
    this.repCounter.update(message);

    // Check if a rep was just completed
    const newRepCount = this.repCounter.getRepCount();
    if (newRepCount > prevRepCount) {
      const completedReps = this.repCounter.getCompletedReps();
      const lastRep = completedReps[completedReps.length - 1];
      if (lastRep) {
        this.sessionLogger.recordRep(lastRep);
      }
      // Advance form evaluator to the next rep number
      this.formEvaluator.setRepNumber(newRepCount + 1);
      // Dismiss alert if angles have returned to safe range
      this.alertSystem.dismiss();
    }

    // Forward to form evaluator (deviation detection)
    this.formEvaluator.evaluateFrame(message);
  }
}
