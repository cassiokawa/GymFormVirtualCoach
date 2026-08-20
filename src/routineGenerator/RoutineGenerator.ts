/**
 * RoutineGenerator — pre-workout phase component.
 *
 * Queries Storage for recent session history, analyses form errors, builds an
 * LLM prompt, and returns a structured Routine within the 5 s latency budget.
 *
 * Requirements covered: 6.1, 6.2, 6.3, 6.4
 */

import type { Session } from '../types/index.js';
import { Storage } from '../storage/Storage.js';
import { LlmGateway } from '../llmGateway/LlmGateway.js';
import type { LlmPayload } from '../llmGateway/LlmGateway.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExerciseConfig {
  name: string;
  sequence: number;
  /** Target repetitions per set — constrained to [1, 30] */
  targetReps: number;
  /** Expected time-under-tension in milliseconds — constrained to [10_000, 120_000] */
  expectedTutMs: number;
  primaryMuscles: string[];
  secondaryMuscles: string[];
}

export interface Routine {
  id: string;
  exercises: ExerciseConfig[];
  generatedAt: Date;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LLM_TIMEOUT_MS = 5_000;
const HISTORY_LIMIT = 10;
const ERROR_SESSION_THRESHOLD = 2; // errors in ≥2 sessions → volume reduction
const VOLUME_REDUCTION_MIN = 0.20; // 20 %
const VOLUME_REDUCTION_MAX = 0.30; // 30 %
const TARGET_REPS_MIN = 1;
const TARGET_REPS_MAX = 30;
const EXPECTED_TUT_MIN_MS = 10_000;
const EXPECTED_TUT_MAX_MS = 120_000;

// Default routine returned when there is no session history or when the LLM
// returns the stub "LLM response stub" (Requirement 6.5)
export const DEFAULT_EXERCISES: ExerciseConfig[] = [
  {
    name: 'barbell_squat',
    sequence: 1,
    targetReps: 8,
    expectedTutMs: 40_000,
    primaryMuscles: ['quads', 'glutes'],
    secondaryMuscles: ['hamstrings'],
  },
  {
    name: 'bench_press',
    sequence: 2,
    targetReps: 8,
    expectedTutMs: 35_000,
    primaryMuscles: ['chest'],
    secondaryMuscles: ['triceps', 'shoulders'],
  },
  {
    name: 'bent_over_row',
    sequence: 3,
    targetReps: 8,
    expectedTutMs: 35_000,
    primaryMuscles: ['back'],
    secondaryMuscles: ['biceps'],
  },
];

// Kept for backwards-compatibility — used only when no session history exists
// and no LLM call is made (first-session baseline variant).
const BASELINE_EXERCISES = DEFAULT_EXERCISES;

// ---------------------------------------------------------------------------
// RoutineGenerator
// ---------------------------------------------------------------------------

export class RoutineGenerator {
  private storage: Storage;
  private gateway: LlmGateway;

  constructor(storage: Storage, gateway: LlmGateway) {
    this.storage = storage;
    this.gateway = gateway;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Generate a personalised workout routine.
   *
   * Steps:
   * 1. Query the 10 most recent sessions from Storage.
   * 2. Analyse form errors per muscle group.
   * 3. Build an LLM prompt summarising history and error analysis.
   * 4. Call LlmGateway with a hard 5 s timeout.
   * 5. Parse the LLM response into a Routine, applying volume reductions.
   * 6. Return the Routine.
   *
   * Requirements: 6.1, 6.2, 6.3, 6.4
   */
  async generate(dateRange?: { from: Date; to: Date }): Promise<Routine> {
    // 1. Query recent sessions
    const sessions = await this.queryRecentSessions(dateRange);

    // 2. If no history, return baseline routine (Requirement 6.5 handled in 11.2,
    //    but we also gracefully handle it here to avoid empty prompts)
    if (sessions.length === 0) {
      return this.buildBaselineRoutine();
    }

    // 3. Analyse form errors per muscle group
    const errorsByMuscle = this.analyzeFormErrors(sessions);

    // 4. Build the LLM prompt
    const prompt = this.buildPrompt(sessions, errorsByMuscle);
    const payload: LlmPayload = { prompt };

    // 5. Call gateway with 5 s timeout (Requirement 6.4)
    const llmResponse = await this.callWithTimeout(payload);

    // 6. Parse LLM response and apply volume reductions
    return this.parseLlmResponse(llmResponse.text, errorsByMuscle);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Query the Storage for the 10 most recent Sessions.
   *
   * When no explicit date range is provided we use a wide window (past year)
   * and take only the last HISTORY_LIMIT entries, since Storage always returns
   * results in ascending chronological order.
   *
   * Requirement 6.1
   */
  private async queryRecentSessions(dateRange?: { from: Date; to: Date }): Promise<Session[]> {
    const to = dateRange?.to ?? new Date();
    const from = dateRange?.from ?? new Date(to.getTime() - 365 * 24 * 60 * 60 * 1_000);

    const all = await this.storage.query({ from, to });

    // Return the last HISTORY_LIMIT sessions (most recent)
    return all.slice(-HISTORY_LIMIT);
  }

  /**
   * Count how many sessions contain at least one form error (warning or
   * critical deviation) for each named muscle group, across all sets in those
   * sessions.
   *
   * A "muscle group" here is derived from the exercise name because the raw
   * `DeviationEvent` records joint names (e.g. "left_knee") rather than muscle
   * groups.  We map exercise names to primary muscle groups using a simple
   * heuristic so the volume-reduction logic can act on them.
   *
   * Requirement 6.1, 6.3
   */
  private analyzeFormErrors(sessions: Session[]): Map<string, number> {
    // Per session: collect the set of muscle groups that had ≥1 deviation
    const muscleErrorCounts = new Map<string, number>();

    for (const session of sessions) {
      // Track which muscles already had an error in this session (count once per session)
      const musclesWithErrorsInThisSession = new Set<string>();

      for (const setRecord of session.sets) {
        const muscles = exerciseNameToMuscles(setRecord.exerciseName);
        const hasDeviation = setRecord.reps.some((rep) => rep.deviationEvents.length > 0);

        if (hasDeviation) {
          for (const muscle of muscles) {
            musclesWithErrorsInThisSession.add(muscle);
          }
        }
      }

      // Increment the session-level counter for each affected muscle
      for (const muscle of musclesWithErrorsInThisSession) {
        muscleErrorCounts.set(muscle, (muscleErrorCounts.get(muscle) ?? 0) + 1);
      }
    }

    return muscleErrorCounts;
  }

  /**
   * Build the LLM prompt from session history and error analysis.
   *
   * Requirement 6.1
   */
  private buildPrompt(sessions: Session[], errorsByMuscle: Map<string, number>): string {
    const sessionCount = sessions.length;
    const totalSets = sessions.reduce((sum, s) => sum + s.sets.length, 0);

    // Summarise form errors for the prompt
    const errorLines: string[] = [];
    for (const [muscle, count] of errorsByMuscle.entries()) {
      errorLines.push(`  - ${muscle}: form errors in ${count}/${sessionCount} sessions`);
    }
    const errorsSection =
      errorLines.length > 0
        ? `Form error summary:\n${errorLines.join('\n')}`
        : 'No form errors detected in recent sessions.';

    // Summarise fatigue indicators (TUT delta)
    const avgTutDeltaMs = computeAvgTutDelta(sessions);
    const fatigueNote =
      avgTutDeltaMs < -5_000
        ? 'User appears fatigued: actual TUT consistently below target.'
        : avgTutDeltaMs > 5_000
          ? 'User appears fresh: actual TUT consistently above target.'
          : 'TUT performance is within expected range.';

    // Collect unique exercise names across recent sessions
    const exercisesPerformed = [
      ...new Set(sessions.flatMap((s) => s.sets.map((set) => set.exerciseName))),
    ];

    // Muscles that need volume reduction
    const reductionTargets = [...errorsByMuscle.entries()]
      .filter(([, count]) => count >= ERROR_SESSION_THRESHOLD)
      .map(([muscle]) => muscle);

    const reductionSection =
      reductionTargets.length > 0
        ? `Reduce volume 20–30% for: ${reductionTargets.join(', ')}.`
        : 'No volume reductions required.';

    return [
      'You are a certified strength & conditioning coach AI.',
      '',
      `Session history: ${sessionCount} session(s), ${totalSets} total sets.`,
      `Exercises performed: ${exercisesPerformed.join(', ') || 'none'}.`,
      '',
      errorsSection,
      '',
      `Fatigue indicator: ${fatigueNote}`,
      '',
      reductionSection,
      '',
      'Generate a structured workout routine as JSON with the following schema:',
      '{',
      '  "exercises": [',
      '    {',
      '      "name": string,',
      '      "sequence": number,',
      '      "targetReps": number (1–30),',
      '      "expectedTutMs": number (10000–120000),',
      '      "primaryMuscles": string[],',
      '      "secondaryMuscles": string[]',
      '    }',
      '  ]',
      '}',
      '',
      'Include at least 3 exercises covering chest, back, and legs.',
      'Respect the volume reductions noted above.',
    ].join('\n');
  }

  /**
   * Parse the LLM response text into a Routine, then apply volume reductions
   * for any muscle group that had errors in ≥2 sessions.
   *
   * When the response is the gateway stub "LLM response stub", or when the
   * response cannot be parsed, fall back to the default routine.
   *
   * Requirement 6.2, 6.3
   */
  private parseLlmResponse(responseText: string, errorsByMuscle: Map<string, number>): Routine {
    let exercises: ExerciseConfig[] = [];

    // Explicit check for the gateway stub text (Requirement 6.2 — stub handling)
    if (responseText === 'LLM response stub') {
      exercises = DEFAULT_EXERCISES.map((ex) => ({ ...ex }));
    } else {
      // Attempt to extract JSON from the response
      try {
        // Find JSON block in the response (LLMs often wrap it in markdown)
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch !== null && jsonMatch[0] !== undefined) {
          const parsed = JSON.parse(jsonMatch[0]) as unknown;
          if (isRoutinePayload(parsed)) {
            exercises = parsed.exercises.map((ex, index) => ({
              name: String(ex.name),
              sequence: typeof ex.sequence === 'number' ? ex.sequence : index + 1,
              targetReps: clamp(Number(ex.targetReps), TARGET_REPS_MIN, TARGET_REPS_MAX),
              expectedTutMs: clamp(Number(ex.expectedTutMs), EXPECTED_TUT_MIN_MS, EXPECTED_TUT_MAX_MS),
              primaryMuscles: Array.isArray(ex.primaryMuscles)
                ? (ex.primaryMuscles as string[]).map(String)
                : [],
              secondaryMuscles: Array.isArray(ex.secondaryMuscles)
                ? (ex.secondaryMuscles as string[]).map(String)
                : [],
            }));
          }
        }
      } catch {
        // JSON parse failed — fall through to default
      }

      // If parsing failed or produced no exercises, use the default routine
      if (exercises.length === 0) {
        exercises = DEFAULT_EXERCISES.map((ex) => ({ ...ex }));
      }
    }

    // Apply volume reductions for problem muscle groups (Requirement 6.3)
    exercises = exercises.map((ex) => applyVolumeReduction(ex, errorsByMuscle));

    return {
      id: generateId(),
      exercises,
      generatedAt: new Date(),
    };
  }

  /**
   * Wrap the LlmGateway call in a Promise.race against a 5 s timeout.
   *
   * Requirement 6.4
   */
  private callWithTimeout(payload: LlmPayload): Promise<{ text: string }> {
    const llmCall = this.gateway.request('Routine_Generator', payload);

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error(`Routine_Generator: LLM call exceeded ${LLM_TIMEOUT_MS} ms timeout`));
      }, LLM_TIMEOUT_MS);
    });

    return Promise.race([llmCall, timeoutPromise]);
  }

  /**
   * Build and return the default routine for first-time sessions.
   *
   * Requirement 6.5 (baseline; fully handled in task 11.2, but defensively
   * covered here too).
   */
  private buildBaselineRoutine(): Routine {
    return {
      id: generateId(),
      exercises: DEFAULT_EXERCISES.map((ex) => ({ ...ex })),
      generatedAt: new Date(),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Apply a 20–30 % reduction to `targetReps` for exercises whose primary
 * muscles intersect muscles with ≥2 session-level form errors.
 *
 * The reduction factor is fixed at the midpoint of the allowed range (25 %)
 * so that the outcome is deterministic and testable.  It stays within the
 * 20–30 % band specified in the requirements.
 *
 * Requirement 6.3
 */
function applyVolumeReduction(
  ex: ExerciseConfig,
  errorsByMuscle: Map<string, number>,
): ExerciseConfig {
  const needsReduction = ex.primaryMuscles.some(
    (muscle) => (errorsByMuscle.get(muscle) ?? 0) >= ERROR_SESSION_THRESHOLD,
  );

  if (!needsReduction) return ex;

  // Use the midpoint of [20 %, 30 %] for a deterministic, spec-compliant reduction
  const reductionFactor =
    VOLUME_REDUCTION_MIN + (VOLUME_REDUCTION_MAX - VOLUME_REDUCTION_MIN) / 2;

  const reducedReps = Math.max(
    TARGET_REPS_MIN,
    Math.round(ex.targetReps * (1 - reductionFactor)),
  );

  return { ...ex, targetReps: reducedReps };
}

/**
 * Map an exercise name to a list of primary muscle group strings.
 *
 * This is a best-effort heuristic used by `analyzeFormErrors` to associate
 * form errors (recorded per exercise) with muscle groups.
 */
function exerciseNameToMuscles(exerciseName: string): string[] {
  const name = exerciseName.toLowerCase();

  if (name.includes('squat') || name.includes('leg_press') || name.includes('lunge')) {
    return ['quadriceps', 'glutes', 'hamstrings'];
  }
  if (name.includes('deadlift') || name.includes('rdl')) {
    return ['hamstrings', 'glutes', 'back'];
  }
  if (name.includes('bench') || name.includes('push') || name.includes('fly')) {
    return ['chest', 'triceps'];
  }
  if (name.includes('row') || name.includes('pull') || name.includes('lat')) {
    return ['back', 'biceps'];
  }
  if (name.includes('shoulder') || name.includes('press') || name.includes('ohp')) {
    return ['shoulders', 'triceps'];
  }
  if (name.includes('curl')) {
    return ['biceps'];
  }
  if (name.includes('plank') || name.includes('core') || name.includes('crunch')) {
    return ['core'];
  }

  // Generic fallback
  return [exerciseName];
}

/**
 * Compute average TUT delta in milliseconds across all sets in all sessions.
 * Returns 0 when there are no sets.
 */
function computeAvgTutDelta(sessions: Session[]): number {
  const allSets = sessions.flatMap((s) => s.sets);
  if (allSets.length === 0) return 0;
  const total = allSets.reduce((sum, s) => sum + s.tutDeltaMs, 0);
  return total / allSets.length;
}

/** Clamp a numeric value to [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Generate a simple UUID-like identifier (crypto.randomUUID where available, otherwise fallback). */
function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return `routine-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Type guard for the LLM response payload
// ---------------------------------------------------------------------------

interface RawExercise {
  name: unknown;
  sequence: unknown;
  targetReps: unknown;
  expectedTutMs: unknown;
  primaryMuscles: unknown;
  secondaryMuscles: unknown;
}

interface RoutinePayload {
  exercises: RawExercise[];
}

function isRoutinePayload(value: unknown): value is RoutinePayload {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj['exercises']);
}
