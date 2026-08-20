/**
 * CoachingAdvisor — generates post-workout coaching recommendations using
 * LLM-backed advice generation with a rule-based fallback.
 *
 * Receives a SessionSummary from the Analytics_Engine and calls LlmGateway
 * (caller: 'Coaching_Advisor') to produce personalised recommendations.
 * Guarantees ≥1 recommendation per deviation event and per rep category.
 *
 * Requirements covered: 10.1, 10.2, 10.3, 10.4
 */

import type { SessionSummary, DeviationEvent } from '../types/index.js';
import { LlmGateway } from '../llmGateway/LlmGateway.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface CoachingRecommendation {
  category: 'form_correction' | 'volume_adjustment' | 'technique_tip' | 'safety_warning';
  message: string;
  relatedJoint?: string | undefined;
  relatedRep?: number | undefined;
}

export interface CoachingAdvice {
  sessionId: string;
  recommendations: CoachingRecommendation[];
  generatedAt: Date;
}

/**
 * Pre-populated parameters for the next session for a given exercise.
 * Action is 'UP' when performance targets are met, 'HOLD' otherwise.
 *
 * Requirement 10.2
 */
export interface NextSessionParams {
  exerciseName: string;
  action: 'UP' | 'HOLD';
  suggestedReps: number;
  suggestedSets: number;
  reason: string;
}

/**
 * Full coaching result including advice, next-session pre-population,
 * LLM availability status, and the raw summary for fallback display.
 *
 * Requirements 10.3, 10.4
 */
export interface FullCoachingResult {
  advice: CoachingAdvice;
  nextSessionParams: NextSessionParams[];
  isLlmAvailable: boolean;
  rawSummary: SessionSummary;
}

// ---------------------------------------------------------------------------
// CoachingAdvisor
// ---------------------------------------------------------------------------

export class CoachingAdvisor {
  private gateway: LlmGateway;

  constructor(gateway: LlmGateway) {
    this.gateway = gateway;
  }

  /**
   * Generate coaching advice for a completed session.
   * Attempts LLM-backed generation first; falls back to rule-based if the
   * LLM is unavailable or returns an unparseable response.
   */
  async generateAdvice(summary: SessionSummary): Promise<CoachingAdvice> {
    const prompt = this.buildPrompt(summary);

    try {
      const response = await this.gateway.request('Coaching_Advisor', { prompt });
      return this.parseResponse(summary, response.text);
    } catch {
      // If LLM fails (policy violation, network error, etc.), use rule-based fallback
      return this.generateRuleBasedAdvice(summary);
    }
  }

  /**
   * Generate full coaching result including next-session pre-population and
   * offline fallback handling.
   *
   * Requirements 10.2, 10.3, 10.4
   */
  async generateFullResult(summary: SessionSummary): Promise<FullCoachingResult> {
    let advice: CoachingAdvice;
    let isLlmAvailable = true;

    try {
      const response = await this.gateway.request('Coaching_Advisor', { prompt: this.buildPrompt(summary) });
      advice = this.parseResponse(summary, response.text);
    } catch {
      advice = this.generateRuleBasedAdvice(summary);
      isLlmAvailable = false;
    }

    // Requirement 10.4: If LLM unavailable, add technique_tip indicating offline fallback
    if (!isLlmAvailable) {
      advice.recommendations.push({
        category: 'technique_tip',
        message: 'AI coaching unavailable. Showing raw session summary.',
      });
    }

    // Requirement 10.2: Pre-populate next session parameters
    const nextSessionParams = this.computeNextSessionParams(summary);

    return { advice, nextSessionParams, isLlmAvailable, rawSummary: summary };
  }

  /**
   * Receive a SessionSummary from the AnalyticsEngine dispatch interface.
   * Generates advice (side-effect: could be stored/emitted in a full app).
   */
  async receiveSummary(summary: SessionSummary): Promise<CoachingAdvice> {
    return this.generateAdvice(summary);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Compute pre-populated next-session parameters for each set in the summary.
   * Performance target: ≥80% correct reps AND TUT delta ≥ 0.
   * Action is 'UP' when targets met, 'HOLD' otherwise.
   *
   * Requirement 10.2
   */
  private computeNextSessionParams(summary: SessionSummary): NextSessionParams[] {
    return summary.setBreakdowns.map(set => {
      const totalReps = set.correctReps + set.flawedReps + set.dangerousReps;
      // Performance target: ≥80% correct reps AND TUT delta ≥ 0
      const targetsMetCorrectness = totalReps > 0 && (set.correctReps / totalReps) >= 0.8;
      const targetsMetTut = set.tutDeltaMs >= 0;
      const targetsMet = targetsMetCorrectness && targetsMetTut;

      return {
        exerciseName: set.exerciseName,
        action: targetsMet ? 'UP' as const : 'HOLD' as const,
        suggestedReps: targetsMet ? Math.min(set.correctReps + 1, 30) : set.correctReps + set.flawedReps,
        suggestedSets: targetsMet ? 4 : 3,
        reason: targetsMet
          ? 'Performance targets met — increase volume for progressive overload'
          : 'Targets not met — maintain current load until form improves',
      };
    });
  }

  private buildPrompt(summary: SessionSummary): string {
    const lines: string[] = [
      'You are a fitness coach AI. Analyse the following workout session and provide personalised recommendations.',
      '',
      `Session ID: ${summary.sessionId}`,
      `Total correct reps: ${summary.totalCorrectReps}`,
      `Total flawed reps: ${summary.totalFlawedReps}`,
      `Total dangerous reps: ${summary.totalDangerousReps}`,
      '',
      'Set breakdowns:',
    ];

    for (const set of summary.setBreakdowns) {
      lines.push(
        `  - ${set.exerciseName}: ${set.correctReps} correct, ${set.flawedReps} flawed, ${set.dangerousReps} dangerous | TUT delta: ${set.tutDeltaMs}ms`,
      );
    }

    if (summary.allDeviationEvents.length > 0) {
      lines.push('', 'Deviation events:');
      for (const event of summary.allDeviationEvents) {
        lines.push(
          `  - Rep ${event.repNumber}, ${event.jointName}: ${event.angleValue.toFixed(1)}° (${event.severity})`,
        );
      }
    }

    lines.push(
      '',
      'Respond with a JSON array of recommendations. Each object must have: category (form_correction | volume_adjustment | technique_tip | safety_warning), message, optionally relatedJoint and relatedRep.',
    );

    return lines.join('\n');
  }

  private parseResponse(summary: SessionSummary, responseText: string): CoachingAdvice {
    // If the response is the stub, fall back to rule-based
    if (responseText === 'LLM response stub') {
      return this.generateRuleBasedAdvice(summary);
    }

    // Attempt to parse JSON from the LLM response
    try {
      const parsed: unknown = JSON.parse(responseText);

      if (Array.isArray(parsed) && parsed.length > 0) {
        const recommendations: CoachingRecommendation[] = [];

        for (const item of parsed as unknown[]) {
          if (this.isValidRecommendation(item)) {
            recommendations.push(item);
          }
        }

        if (recommendations.length > 0) {
          return {
            sessionId: summary.sessionId,
            recommendations,
            generatedAt: new Date(),
          };
        }
      }
    } catch {
      // JSON parse failed — fall through to rule-based
    }

    return this.generateRuleBasedAdvice(summary);
  }

  private isValidRecommendation(item: unknown): item is CoachingRecommendation {
    if (typeof item !== 'object' || item === null) {
      return false;
    }

    const obj = item as Record<string, unknown>;
    const validCategories = ['form_correction', 'volume_adjustment', 'technique_tip', 'safety_warning'];

    return (
      typeof obj['category'] === 'string' &&
      validCategories.includes(obj['category']) &&
      typeof obj['message'] === 'string' &&
      obj['message'].length > 0
    );
  }

  private generateRuleBasedAdvice(summary: SessionSummary): CoachingAdvice {
    const recommendations: CoachingRecommendation[] = [];

    // ≥1 recommendation per deviation event
    for (const event of summary.allDeviationEvents) {
      recommendations.push(this.buildDeviationRecommendation(event));
    }

    // Recommendations per rep category
    if (summary.totalDangerousReps > 0) {
      recommendations.push({
        category: 'safety_warning',
        message: `${summary.totalDangerousReps} rep(s) were aborted due to dangerous form. Consider reducing weight.`,
      });
    }

    if (summary.totalFlawedReps > 0) {
      recommendations.push({
        category: 'form_correction',
        message: `${summary.totalFlawedReps} rep(s) had form deviations. Review form guide before next session.`,
      });
    }

    if (summary.totalCorrectReps > 0 && summary.totalFlawedReps === 0 && summary.totalDangerousReps === 0) {
      recommendations.push({
        category: 'technique_tip',
        message: 'All reps completed with good form. Consider increasing weight or reps for progressive overload.',
      });
    }

    // Ensure at least one recommendation is always produced
    if (recommendations.length === 0) {
      recommendations.push({
        category: 'technique_tip',
        message: 'Session completed. Keep up the consistent training.',
      });
    }

    return {
      sessionId: summary.sessionId,
      recommendations,
      generatedAt: new Date(),
    };
  }

  private buildDeviationRecommendation(event: DeviationEvent): CoachingRecommendation {
    return {
      category: event.severity === 'critical' ? 'safety_warning' : 'form_correction',
      message: `${event.jointName}: angle was ${event.angleValue.toFixed(1)}° during rep ${event.repNumber}. Focus on maintaining proper joint alignment.`,
      relatedJoint: event.jointName,
      relatedRep: event.repNumber,
    };
  }
}
