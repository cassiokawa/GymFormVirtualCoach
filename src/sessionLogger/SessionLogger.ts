/**
 * Session_Logger for the CV Fitness & Form Assistant.
 *
 * Records rep-level telemetry (repNumber, tutMs, category, deviationEvents),
 * assembles SetRecords with TUT delta calculations, and produces a complete
 * Session object at the end of a workout.
 *
 * Requirements covered: 5.7, 8.1, 8.2
 */

import type { Rep, SetRecord, Session, DeviationEvent } from '../types/index.js';

// ---------------------------------------------------------------------------
// SessionLogger class
// ---------------------------------------------------------------------------

/**
 * Accumulates per-rep telemetry during a workout session and assembles
 * structured `SetRecord` and `Session` objects for downstream persistence
 * and analytics.
 *
 * Lifecycle:
 *   1. Construct with a unique sessionId and routineId.
 *   2. Call `startSet()` before each set.
 *   3. Call `recordRep()` for each completed rep (from RepCounter).
 *   4. Optionally call `markRepDangerous()` or `addDeviationToRep()` when
 *      Safety_Monitor detects critical deviations.
 *   5. Call `endSet()` after each set (or let `startSet()` finalize the previous).
 *   6. Call `endSession()` to finalize and retrieve the complete Session.
 *
 * Requirements: 5.7, 8.1, 8.2
 */
export class SessionLogger {
  private sessionId: string;
  private routineId: string;
  private startedAt: Date;
  private sets: SetRecord[] = [];
  private currentSetReps: Rep[] = [];
  private currentSetNumber = 0;
  private currentExerciseName = '';
  private currentExpectedTutMs = 0;

  constructor(sessionId: string, routineId: string) {
    this.sessionId = sessionId;
    this.routineId = routineId;
    this.startedAt = new Date();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start a new set. If a previous set has unfinalized reps, it will be
   * automatically finalized before starting the new one.
   */
  startSet(exerciseName: string, expectedTutMs: number): void {
    if (this.currentSetReps.length > 0) {
      this.finalizeCurrentSet();
    }
    this.currentSetNumber++;
    this.currentExerciseName = exerciseName;
    this.currentExpectedTutMs = expectedTutMs;
    this.currentSetReps = [];
  }

  /**
   * Record a completed rep from RepCounter.
   * The rep is appended to the current set's rep list.
   */
  recordRep(rep: Rep): void {
    this.currentSetReps.push(rep);
  }

  /**
   * Mark a specific rep as `dangerous_aborted` and attach the deviation event
   * that triggered the Safety_Monitor notification.
   *
   * Requirement 5.7 — Rep marked dangerous_aborted when Safety_Monitor
   * notifies of a critical deviation during that rep.
   */
  markRepDangerous(repNumber: number, deviationEvent: DeviationEvent): void {
    const rep = this.currentSetReps.find((r) => r.repNumber === repNumber);
    if (rep) {
      rep.category = 'dangerous_aborted';
      rep.deviationEvents.push(deviationEvent);
    }
  }

  /**
   * Add a deviation event to a specific rep. Automatically updates the rep
   * category based on severity:
   *   - critical → dangerous_aborted
   *   - warning  → flawed (only if currently 'correct')
   */
  addDeviationToRep(repNumber: number, event: DeviationEvent): void {
    const rep = this.currentSetReps.find((r) => r.repNumber === repNumber);
    if (rep) {
      rep.deviationEvents.push(event);
      if (event.severity === 'critical') {
        rep.category = 'dangerous_aborted';
      } else if (rep.category === 'correct') {
        rep.category = 'flawed';
      }
    }
  }

  /**
   * End the current set. Finalizes rep data and assembles a SetRecord.
   */
  endSet(): void {
    this.finalizeCurrentSet();
  }

  /**
   * End the session and assemble the complete Session object.
   * Any unfinalized set is automatically finalized before assembly.
   */
  endSession(): Session {
    if (this.currentSetReps.length > 0) {
      this.finalizeCurrentSet();
    }
    const endedAt = new Date();
    return {
      id: this.sessionId,
      startedAt: this.startedAt,
      endedAt,
      durationMs: endedAt.getTime() - this.startedAt.getTime(),
      routineId: this.routineId,
      sets: this.sets,
    };
  }

  /** Returns a copy of all finalized sets. */
  getSets(): SetRecord[] {
    return [...this.sets];
  }

  /** Returns a copy of the current (in-progress) set's reps. */
  getCurrentSetReps(): Rep[] {
    return [...this.currentSetReps];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Finalize the current set by computing actualTutMs (sum of rep TUTs)
   * and tutDeltaMs (actual − expected), then push the SetRecord.
   */
  private finalizeCurrentSet(): void {
    const actualTutMs = this.currentSetReps.reduce((sum, r) => sum + r.tutMs, 0);
    const set: SetRecord = {
      setNumber: this.currentSetNumber,
      exerciseName: this.currentExerciseName,
      reps: [...this.currentSetReps],
      actualTutMs,
      expectedTutMs: this.currentExpectedTutMs,
      tutDeltaMs: actualTutMs - this.currentExpectedTutMs,
    };
    this.sets.push(set);
    this.currentSetReps = [];
  }
}
