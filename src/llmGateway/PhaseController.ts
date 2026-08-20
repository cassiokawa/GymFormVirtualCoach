/**
 * PhaseController — thin orchestrator that wraps LlmGateway.setPhase() and
 * provides named methods for each valid phase transition.
 *
 * Transition wiring (Requirements 11.1–11.3):
 *   pre_workout → session_active  : onSessionStart()        (first Set begins)
 *   session_active → post_workout : onSessionEnd()          (Session ends)
 *   post_workout → pre_workout    : onNewSessionInitiated() (user starts again)
 *
 * Requirements covered: 11.1, 11.2, 11.3
 */

import { LlmGateway } from './LlmGateway.js';
import type { AppPhase } from '../types/index.js';

export class PhaseController {
  private static instance: PhaseController | undefined;
  private readonly gateway: LlmGateway;

  private constructor() {
    this.gateway = LlmGateway.getInstance();
  }

  // -------------------------------------------------------------------------
  // Singleton accessors
  // -------------------------------------------------------------------------

  static getInstance(): PhaseController {
    if (PhaseController.instance === undefined) {
      PhaseController.instance = new PhaseController();
    }
    return PhaseController.instance;
  }

  /** Reset the singleton — intended for use in tests only. */
  static _resetInstance(): void {
    PhaseController.instance = undefined;
  }

  // -------------------------------------------------------------------------
  // Phase transition methods
  // -------------------------------------------------------------------------

  /**
   * Called when the user starts the first Set of a session.
   * Transitions: pre_workout → session_active (Requirement 11.1)
   */
  onSessionStart(): void {
    this.gateway.setPhase('session_active');
  }

  /**
   * Called when the user ends a Session.
   * Transitions: session_active → post_workout (Requirement 11.2)
   */
  onSessionEnd(): void {
    this.gateway.setPhase('post_workout');
  }

  /**
   * Called when the user initiates a new session from post-workout.
   * Transitions: post_workout → pre_workout (Requirement 11.3)
   */
  onNewSessionInitiated(): void {
    this.gateway.setPhase('pre_workout');
  }

  // -------------------------------------------------------------------------
  // Phase query
  // -------------------------------------------------------------------------

  getCurrentPhase(): AppPhase {
    return this.gateway.getPhase();
  }
}
