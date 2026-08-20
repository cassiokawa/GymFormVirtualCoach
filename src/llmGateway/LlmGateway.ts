/**
 * LlmGateway — singleton that enforces phase-based access control for all LLM requests.
 *
 * Phase rules (Requirements 11.1–11.4):
 *   pre_workout    — only 'Routine_Generator' may call the LLM
 *   session_active — ALL LLM calls are rejected
 *   post_workout   — only 'Coaching_Advisor' may call the LLM
 *
 * Requirements covered: 11.1, 11.2, 11.3, 11.4
 */

import type { AppPhase } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface LlmPayload {
  prompt: string;
  context?: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// PolicyViolationError
// ---------------------------------------------------------------------------

export class PolicyViolationError extends Error {
  constructor(caller: string, reason: string) {
    super(`LLM policy violation [${caller}]: ${reason}`);
    this.name = 'PolicyViolationError';
  }
}

// ---------------------------------------------------------------------------
// LlmGateway
// ---------------------------------------------------------------------------

export class LlmGateway {
  private static instance: LlmGateway | undefined;
  private currentPhase: AppPhase = 'pre_workout';

  private constructor() {}

  // -------------------------------------------------------------------------
  // Singleton accessors
  // -------------------------------------------------------------------------

  static getInstance(): LlmGateway {
    if (LlmGateway.instance === undefined) {
      LlmGateway.instance = new LlmGateway();
    }
    return LlmGateway.instance;
  }

  /** Reset the singleton — intended for use in tests only. */
  static _resetInstance(): void {
    LlmGateway.instance = undefined;
  }

  // -------------------------------------------------------------------------
  // Phase management
  // -------------------------------------------------------------------------

  setPhase(phase: AppPhase): void {
    this.currentPhase = phase;
  }

  getPhase(): AppPhase {
    return this.currentPhase;
  }

  // -------------------------------------------------------------------------
  // Core request method — enforces phase-based access control
  // -------------------------------------------------------------------------

  async request(caller: string, payload: LlmPayload): Promise<LlmResponse> {
    // Requirement 11.3: reject ALL requests during session_active
    if (this.currentPhase === 'session_active') {
      const reason = 'attempted LLM call during active session';
      this.logPolicyViolation(caller, reason);
      throw new PolicyViolationError(caller, reason);
    }

    // Requirement 11.1: only Routine_Generator is permitted during pre_workout
    if (this.currentPhase === 'pre_workout' && caller !== 'Routine_Generator') {
      const reason = 'unauthorized pre-workout LLM call';
      this.logPolicyViolation(caller, reason);
      throw new PolicyViolationError(caller, reason);
    }

    // Requirement 11.2: only Coaching_Advisor is permitted during post_workout
    if (this.currentPhase === 'post_workout' && caller !== 'Coaching_Advisor') {
      const reason = 'unauthorized post-workout LLM call';
      this.logPolicyViolation(caller, reason);
      throw new PolicyViolationError(caller, reason);
    }

    return this.sendToLlm(payload);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private logPolicyViolation(caller: string, reason: string): void {
    console.warn(`[LlmGateway] Policy violation — caller: "${caller}", reason: "${reason}", phase: "${this.currentPhase}"`);
  }

  /**
   * Stub transport layer.  In production this would call an external LLM API.
   * The actual integration is out of scope for this task; the interface contract
   * is what matters here.
   */
  private async sendToLlm(_payload: LlmPayload): Promise<LlmResponse> {
    // Real LLM API call goes here
    return { text: 'LLM response stub', model: 'stub' };
  }
}
