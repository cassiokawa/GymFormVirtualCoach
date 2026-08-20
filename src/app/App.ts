/**
 * App — top-level application orchestrator.
 *
 * Wires all components together into a coherent lifecycle spanning:
 *   - Pre-workout:  RoutineGenerator + FormGuideController (16.5)
 *   - Execution:    WorkoutSession (FormEvaluator → SafetyMonitor → AlertSystem → SessionLogger) (16.2)
 *   - Post-workout: SessionPersister (SessionLogger → AnalyticsEngine → Storage) (16.3),
 *                   PhaseController transitions (16.4),
 *                   AnalyticsEngine + CoachingAdvisor dispatch (16.6)
 *
 * Requirements covered: 16.2, 16.3, 16.4, 16.5, 16.6
 */

import { Storage } from '../storage/Storage.js';
import { LlmGateway } from '../llmGateway/LlmGateway.js';
import { PhaseController } from '../llmGateway/PhaseController.js';
import { RoutineGenerator } from '../routineGenerator/RoutineGenerator.js';
import type { Routine } from '../routineGenerator/RoutineGenerator.js';
import { FormGuide } from '../formGuide/FormGuide.js';
import { FormGuideController } from '../formGuide/FormGuideController.js';
import { WorkoutSession } from './WorkoutSession.js';
import { SessionPersister } from '../sessionLogger/SessionPersister.js';
import { AnalyticsEngine } from '../analyticsEngine/AnalyticsEngine.js';
import { CoachingAdvisor } from '../coachingAdvisor/CoachingAdvisor.js';
import type { FullCoachingResult } from '../coachingAdvisor/CoachingAdvisor.js';
import type { ExerciseFSMConfig, ErrorMessage } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface AppDependencies {
  canvasContainer: HTMLElement;
  guideContainer: HTMLElement;
  onError: (error: ErrorMessage) => void;
  onSessionComplete: (result: FullCoachingResult) => void;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export class App {
  private readonly storage: Storage;
  private readonly gateway: LlmGateway;
  private readonly phaseController: PhaseController;
  private readonly routineGenerator: RoutineGenerator;
  private readonly formGuide: FormGuide;
  private readonly formGuideController: FormGuideController;
  private readonly analyticsEngine: AnalyticsEngine;
  private readonly coachingAdvisor: CoachingAdvisor;
  private readonly sessionPersister: SessionPersister;
  private workoutSession: WorkoutSession | null = null;
  private readonly deps: AppDependencies;

  constructor(deps: AppDependencies) {
    this.deps = deps;
    this.storage = Storage.getInstance();
    this.gateway = LlmGateway.getInstance();
    this.phaseController = PhaseController.getInstance();
    this.routineGenerator = new RoutineGenerator(this.storage, this.gateway);
    this.formGuide = new FormGuide();
    this.formGuideController = new FormGuideController(
      deps.guideContainer,
      this.formGuide,
      this.phaseController,
    );
    this.analyticsEngine = new AnalyticsEngine();
    this.coachingAdvisor = new CoachingAdvisor(this.gateway);
    this.sessionPersister = new SessionPersister(this.storage, this.analyticsEngine);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Open storage — must be called before any session operations. */
  async init(): Promise<void> {
    await this.storage.open();
  }

  // -------------------------------------------------------------------------
  // 16.5: Pre-workout phase (Routine_Generator + Form_Guide)
  // -------------------------------------------------------------------------

  /** Generate a personalised routine via LLM-backed RoutineGenerator. */
  async requestRoutine(): Promise<Routine> {
    return this.routineGenerator.generate();
  }

  /** Display the form guide overlay for a given exercise. */
  showFormGuide(exerciseName: string): void {
    this.formGuideController.showExercise(exerciseName);
  }

  /** Register a callback invoked when the user confirms readiness and the workout begins. */
  onWorkoutStart(callback: () => void): void {
    this.formGuideController.onWorkoutStart(callback);
  }

  // -------------------------------------------------------------------------
  // 16.2, 16.4: Start workout execution
  // -------------------------------------------------------------------------

  /**
   * Start a workout set. Transitions the phase to session_active and spawns
   * the real-time execution pipeline (WorkoutSession).
   */
  startSet(
    config: ExerciseFSMConfig,
    sessionId: string,
    routineId: string,
    expectedTutMs: number,
  ): void {
    // 16.4: Phase transition — pre_workout → session_active
    this.phaseController.onSessionStart();

    this.workoutSession = new WorkoutSession({
      config,
      sessionId,
      routineId,
      expectedTutMs,
      canvasContainer: this.deps.canvasContainer,
      onError: this.deps.onError,
    });
    this.workoutSession.start();
  }

  /** Forward a camera frame to the active WorkoutSession's Pose_Detector worker. */
  sendFrame(bitmap: ImageBitmap, timestampMs: number): void {
    this.workoutSession?.sendFrame(bitmap, timestampMs);
  }

  // -------------------------------------------------------------------------
  // 16.3, 16.4, 16.6: End session — persist, analyze, coach
  // -------------------------------------------------------------------------

  /**
   * End the active session and produce a full coaching result.
   *
   * Pipeline:
   *   1. Stop the WorkoutSession and finalize telemetry via SessionLogger.
   *   2. Phase transition — session_active → post_workout (16.4).
   *   3. Persist session and assemble SessionSummary (16.3).
   *   4. Dispatch summary to CoachingAdvisor for LLM-backed advice (16.6).
   *   5. Invoke the onSessionComplete callback with the result.
   */
  async endSession(): Promise<FullCoachingResult | null> {
    if (this.workoutSession === null) return null;

    // 1. Stop the real-time pipeline and finalize telemetry
    this.workoutSession.stop();
    const session = this.workoutSession.getSessionLogger().endSession();

    // 2. 16.4: Phase transition — session_active → post_workout
    this.phaseController.onSessionEnd();

    // 3. 16.3: Persist session to Storage and assemble SessionSummary
    const { summary } = await this.sessionPersister.persistAndAnalyze(session);

    // 4. 16.6: Dispatch to CoachingAdvisor for full coaching result
    const result = await this.coachingAdvisor.generateFullResult(summary);

    // 5. Notify consumer
    this.deps.onSessionComplete(result);

    this.workoutSession = null;
    return result;
  }

  // -------------------------------------------------------------------------
  // 16.4: New session — reset to pre_workout
  // -------------------------------------------------------------------------

  /** Transition back to pre_workout phase for a new session cycle. */
  startNewSession(): void {
    this.phaseController.onNewSessionInitiated();
  }
}
