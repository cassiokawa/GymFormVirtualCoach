/**
 * Analytics_Engine — post-workout categorization and TUT computation.
 *
 * Categorizes every Rep into exactly one of: correct, flawed, dangerous_aborted.
 * Computes actual TUT per Set (sum of rep TUTs) and TUT delta (actual − expected).
 * Assembles SessionSummary and dispatches to Coaching_Advisor and Storage.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
 */

import type { Rep, SetRecord, Session, SessionSummary, DeviationEvent } from '../types/index.js';

export class AnalyticsEngine {
  /**
   * Categorize a single rep based on its deviation events.
   * - critical deviation → dangerous_aborted
   * - warning deviation (no critical) → flawed
   * - no deviations → correct
   */
  categorizeRep(rep: Rep): Rep {
    if (rep.deviationEvents.some(e => e.severity === 'critical')) {
      return { ...rep, category: 'dangerous_aborted' };
    }
    if (rep.deviationEvents.some(e => e.severity === 'warning')) {
      return { ...rep, category: 'flawed' };
    }
    return { ...rep, category: 'correct' };
  }

  /**
   * Categorize all reps in an array.
   */
  categorizeReps(reps: Rep[]): Rep[] {
    return reps.map(rep => this.categorizeRep(rep));
  }

  /**
   * Sum all rep TUTs to produce the actual TUT for a set (in ms).
   * Requirement 8.2
   */
  computeActualTutMs(reps: Rep[]): number {
    return reps.reduce((sum, rep) => sum + rep.tutMs, 0);
  }

  /**
   * Compute the TUT delta: actual − expected (in ms).
   * Requirement 8.3
   */
  computeTutDelta(actualTutMs: number, expectedTutMs: number): number {
    return actualTutMs - expectedTutMs;
  }

  /**
   * Process a single set: categorize its reps, compute actualTutMs and tutDeltaMs.
   */
  processSet(set: SetRecord): SetRecord {
    const categorizedReps = this.categorizeReps(set.reps);
    const actualTutMs = this.computeActualTutMs(categorizedReps);
    const tutDeltaMs = this.computeTutDelta(actualTutMs, set.expectedTutMs);
    return { ...set, reps: categorizedReps, actualTutMs, tutDeltaMs };
  }

  /**
   * Process an entire session: apply processSet to every set.
   */
  processSession(session: Session): Session {
    const processedSets = session.sets.map(set => this.processSet(set));
    return { ...session, sets: processedSets };
  }

  /**
   * Assemble a SessionSummary from a Session.
   * Processes all sets (categorizing reps, computing TUT) and aggregates
   * totals and breakdowns.
   *
   * Requirements 8.4, 8.5
   */
  assembleSessionSummary(session: Session): SessionSummary {
    const processedSession = this.processSession(session);
    const setBreakdowns = processedSession.sets.map(set => ({
      exerciseName: set.exerciseName,
      actualTutMs: set.actualTutMs,
      expectedTutMs: set.expectedTutMs,
      tutDeltaMs: set.tutDeltaMs,
      correctReps: set.reps.filter(r => r.category === 'correct').length,
      flawedReps: set.reps.filter(r => r.category === 'flawed').length,
      dangerousReps: set.reps.filter(r => r.category === 'dangerous_aborted').length,
    }));

    return {
      sessionId: session.id,
      totalCorrectReps: setBreakdowns.reduce((s, b) => s + b.correctReps, 0),
      totalFlawedReps: setBreakdowns.reduce((s, b) => s + b.flawedReps, 0),
      totalDangerousReps: setBreakdowns.reduce((s, b) => s + b.dangerousReps, 0),
      setBreakdowns,
      allDeviationEvents: processedSession.sets.flatMap(s => s.reps.flatMap(r => r.deviationEvents)),
    };
  }

  /**
   * Dispatch a SessionSummary to downstream consumers: Coaching_Advisor and Storage.
   * Accepts handler interfaces so the AnalyticsEngine remains decoupled from
   * concrete implementations.
   *
   * Requirements 8.5
   */
  async dispatchSummary(
    summary: SessionSummary,
    coachingAdvisor: { receiveSummary(summary: SessionSummary): Promise<void> | void },
    storage: { persistSummary(summary: SessionSummary): Promise<void> | void },
  ): Promise<void> {
    await Promise.all([
      coachingAdvisor.receiveSummary(summary),
      storage.persistSummary(summary),
    ]);
  }
}
