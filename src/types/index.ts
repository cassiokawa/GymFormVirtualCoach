/**
 * Shared TypeScript interfaces and types for the CV Fitness & Form Assistant.
 *
 * All components import their shared types from this barrel file.
 *
 * Requirements covered: 1.1, 2.6, 3.1, 3.3, 4.2, 4.3, 8.1–8.4
 */

// ---------------------------------------------------------------------------
// Pose Detection
// ---------------------------------------------------------------------------

/**
 * A single body landmark extracted by the Pose_Detector.
 * Index corresponds to a MediaPipe Holistic / Pose landmark index (0–32).
 * x and y are normalised to [0, 1]; z is depth (normalised).
 * A keypoint is "valid" when confidence >= 0.5 AND x/y are within [0, 1].
 *
 * Requirement 1.1 — 33 keypoints per frame with x, y, z coordinates.
 */
export interface Keypoint {
  /** MediaPipe landmark index, 0–32 */
  index: number;
  /** Normalised horizontal position [0, 1] */
  x: number;
  /** Normalised vertical position [0, 1] */
  y: number;
  /** Normalised depth */
  z: number;
  /** Visibility / confidence score [0, 1] */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Joint Angle
// ---------------------------------------------------------------------------

/**
 * The interior angle at a named joint, derived from three Keypoints using
 * dot-product vector math.  Always expressed in degrees within [0, 180].
 *
 * Requirements 3.1, 3.3, 3.4
 */
export interface JointAngle {
  /** Human-readable joint identifier, e.g. "left_knee" */
  jointName: string;
  /**
   * Angle in degrees, clamped to [0, 180].
   * Meaningful only when `available` is true.
   */
  degrees: number;
  /**
   * false when fewer than 3 valid keypoints exist for this joint, or when
   * one of the edge vectors has zero magnitude.
   */
  available: boolean;
  /** Frame identifier matching the originating KeypointMessage */
  frameId: number;
  /** Wall-clock timestamp of the source frame in milliseconds */
  timestampMs: number;
}

// ---------------------------------------------------------------------------
// Workout Telemetry
// ---------------------------------------------------------------------------

/**
 * A single form-deviation event detected during frame evaluation.
 *
 * Requirements 4.2, 4.3
 */
export interface DeviationEvent {
  /** Joint where the deviation occurred, e.g. "left_knee" */
  jointName: string;
  /** Measured angle at the time of the deviation */
  angleValue: number;
  /**
   * warning  — outside acceptable range but not immediately dangerous.
   * critical — indicates potential injury risk; Safety_Monitor must be notified.
   */
  severity: 'warning' | 'critical';
  /** Wall-clock timestamp when the deviation was detected (ms) */
  timestampMs: number;
  /** Rep number during which this deviation occurred */
  repNumber: number;
}

/**
 * A single completed repetition, as recorded by the Session_Logger.
 *
 * Requirements 2.6, 8.1
 */
export interface Rep {
  /** 1-based index within the current set */
  repNumber: number;
  /** Time-Under-Tension for this rep in milliseconds */
  tutMs: number;
  /**
   * correct           — completed without form deviations.
   * flawed            — completed with warning-level deviations.
   * dangerous_aborted — aborted because Safety_Monitor detected a critical deviation.
   */
  category: 'correct' | 'flawed' | 'dangerous_aborted';
  /** All deviation events that occurred during this rep */
  deviationEvents: DeviationEvent[];
}

/**
 * The telemetry record for a single set of an exercise.
 *
 * Requirements 8.2, 8.3
 */
export interface SetRecord {
  /** 1-based index within the current session */
  setNumber: number;
  /** Identifier for the exercise, e.g. "barbell_squat" */
  exerciseName: string;
  /** Ordered list of reps performed in this set */
  reps: Rep[];
  /** Actual TUT in ms — sum of all rep TUTs in this set */
  actualTutMs: number;
  /** Expected TUT in ms from the pre-workout routine */
  expectedTutMs: number;
  /** TUT delta in ms (actualTutMs − expectedTutMs) */
  tutDeltaMs: number;
}

/**
 * A complete workout session.
 *
 * Requirement 9.1
 */
export interface Session {
  /** UUID v4 identifying this session */
  id: string;
  /** When the session started */
  startedAt: Date;
  /** When the session ended */
  endedAt: Date;
  /** Total session duration in milliseconds */
  durationMs: number;
  /** Reference to the pre-workout routine that seeded this session */
  routineId: string;
  /** All sets performed, in order */
  sets: SetRecord[];
}

/**
 * Aggregate performance summary produced by the Analytics_Engine after a
 * session ends and consumed by the Coaching_Advisor and Storage.
 *
 * Requirements 8.4, 8.5
 */
export interface SessionSummary {
  /** UUID of the originating Session */
  sessionId: string;
  /** Total number of reps categorised as correct across all sets */
  totalCorrectReps: number;
  /** Total number of reps categorised as flawed across all sets */
  totalFlawedReps: number;
  /** Total number of reps aborted due to critical deviations */
  totalDangerousReps: number;
  /** Per-set breakdown of performance metrics */
  setBreakdowns: Array<{
    exerciseName: string;
    actualTutMs: number;
    expectedTutMs: number;
    tutDeltaMs: number;
    correctReps: number;
    flawedReps: number;
    dangerousReps: number;
  }>;
  /** Flat list of every deviation event recorded across all sets */
  allDeviationEvents: DeviationEvent[];
}

// ---------------------------------------------------------------------------
// Worker Message Contract
// ---------------------------------------------------------------------------

/**
 * Message sent from the Pose_Detector Web Worker to the main thread when a
 * frame has been processed successfully.
 *
 * Requirement 1.1
 */
export interface KeypointMessage {
  type: 'keypoints';
  /** Monotonically increasing frame counter */
  frameId: number;
  /** Wall-clock timestamp of the captured frame in milliseconds */
  timestampMs: number;
  /** Exactly 33 keypoints, one per MediaPipe landmark */
  keypoints: Keypoint[];
}

/**
 * Message sent from the Pose_Detector Web Worker to the main thread when an
 * error occurs during initialisation or runtime.
 *
 * Requirement 1.4
 */
export interface ErrorMessage {
  type: 'error';
  /**
   * INIT_FAILED      — MediaPipe WASM failed to initialise.
   * CAMERA_LOST      — Camera access was revoked or the stream ended.
   * DETECTION_FAILED — A runtime error occurred during keypoint extraction.
   */
  code: 'INIT_FAILED' | 'CAMERA_LOST' | 'DETECTION_FAILED';
  /** Human-readable description of the error */
  message: string;
}

// ---------------------------------------------------------------------------
// Exercise Configuration
// ---------------------------------------------------------------------------

/**
 * An inclusive angle range [min, max] in degrees used as a state-transition
 * or safety threshold.
 *
 * Requirement 2.1
 */
export interface AngleThreshold {
  /** Lower bound in degrees (inclusive) */
  min: number;
  /** Upper bound in degrees (inclusive) */
  max: number;
}

/**
 * Full configuration object for the Rep_Counter FSM and Form_Evaluator for a
 * single exercise.  Every exercise must define all five thresholds.
 *
 * Requirements 2.1, 2.2, 4.1
 */
export interface ExerciseFSMConfig {
  /** Identifier for the exercise, e.g. "barbell_squat" */
  exerciseName: string;
  /** Names of the joints tracked for FSM state transitions */
  joints: string[];
  /**
   * Angle range representing the standing / resting position.
   * FSM enters START when all tracked joints are within this range.
   */
  startThreshold: AngleThreshold;
  /**
   * Angle range representing the midpoint of the movement.
   * FSM transitions START → INFLECTION when all joints enter this range.
   */
  inflectionThreshold: AngleThreshold;
  /**
   * Angle range representing the bottom / peak contraction position.
   * FSM transitions INFLECTION → COMPLETE when all joints enter this range.
   */
  completeThreshold: AngleThreshold;
  /**
   * Form warning range — outside acceptable form but not immediately dangerous.
   * Form_Evaluator logs a DeviationEvent(severity: 'warning') once at onset.
   */
  warningThreshold: AngleThreshold;
  /**
   * Safety critical range — indicates potential injury risk.
   * Form_Evaluator notifies Safety_Monitor immediately (≤10 ms).
   */
  criticalThreshold: AngleThreshold;
}

// ---------------------------------------------------------------------------
// Application Phase
// ---------------------------------------------------------------------------

/**
 * The current phase of the application.  The LlmGateway enforces which
 * components are allowed to make LLM requests in each phase.
 *
 * pre_workout    — Routine_Generator may call LLM; no session is active.
 * session_active — No LLM calls permitted; real-time execution path is live.
 * post_workout   — Coaching_Advisor may call LLM; session has ended.
 *
 * Requirements 11.1–11.4
 */
export type AppPhase = 'pre_workout' | 'session_active' | 'post_workout';
