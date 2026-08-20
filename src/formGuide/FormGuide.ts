/**
 * FormGuide — data/logic layer for the Form_Guide component.
 *
 * Provides static biomechanical step-by-step instructions and reference
 * media for each configured exercise. Satisfies the pre-workout display
 * requirements before a Set begins.
 *
 * Requirements covered: 7.1, 7.2, 7.3
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single numbered step in the biomechanical instructions for an exercise.
 *
 * Requirement 7.1
 */
export interface FormStep {
  stepNumber: number;
  instruction: string;
}

/**
 * A reference visual media item attached to an exercise guide.
 *
 * Requirement 7.2 — at least one item with category 'correct_form'.
 * Requirement 7.3 — at least one item with category 'common_mistake'.
 */
export interface MediaReference {
  type: 'gif' | 'video';
  url: string;
  alt: string;
  category: 'correct_form' | 'common_mistake';
}

/**
 * The complete guidance record for a single exercise.
 *
 * Requirements 7.1, 7.2, 7.3
 */
export interface ExerciseGuide {
  exerciseName: string;
  /** Ordered list of biomechanical steps (≥1). */
  steps: FormStep[];
  /**
   * Reference media items.
   * MUST contain ≥1 item with category 'correct_form' (Requirement 7.2).
   * MUST contain ≥1 item with category 'common_mistake' (Requirement 7.3).
   */
  media: MediaReference[];
}

// ---------------------------------------------------------------------------
// Static guide data
// ---------------------------------------------------------------------------

/**
 * Static guide catalogue for all configured exercises.
 * Keys are exercise identifiers matching `ExerciseFSMConfig.exerciseName`.
 *
 * Each entry satisfies:
 *   - ≥1 FormStep                      (Requirement 7.1)
 *   - ≥1 MediaReference (correct_form) (Requirement 7.2)
 *   - ≥1 MediaReference (common_mistake)(Requirement 7.3)
 */
const EXERCISE_GUIDES: Record<string, ExerciseGuide> = {
  barbell_squat: {
    exerciseName: 'barbell_squat',
    steps: [
      {
        stepNumber: 1,
        instruction:
          'Stand with feet shoulder-width apart, toes angled out 15–30°. Rest the bar across your upper traps (high-bar) or rear delts (low-bar).',
      },
      {
        stepNumber: 2,
        instruction:
          'Brace your core by taking a deep breath into your belly (360° brace). Pull your shoulder blades together and down, then unrack the bar with control.',
      },
      {
        stepNumber: 3,
        instruction:
          'Hinge at the hips and bend the knees simultaneously, keeping your chest tall and your knees tracking over your toes throughout the descent.',
      },
      {
        stepNumber: 4,
        instruction:
          'Lower until your thighs are parallel to the floor or slightly below — your hip crease should be at or below your knee. Maintain a neutral spine; avoid rounding the lower back.',
      },
      {
        stepNumber: 5,
        instruction:
          'Drive through your full foot (heel and mid-foot) to return to the standing position. Extend hips and knees at the same rate to avoid good-morning lean. Exhale at the top.',
      },
    ],
    media: [
      {
        type: 'gif',
        url: '/media/squat-correct.gif',
        alt: 'Side-view of a correctly performed barbell squat showing full depth and neutral spine',
        category: 'correct_form',
      },
      {
        type: 'gif',
        url: '/media/squat-valgus.gif',
        alt: 'Front-view highlighting knee valgus (inward knee collapse) — a common squat mistake',
        category: 'common_mistake',
      },
    ],
  },

  conventional_deadlift: {
    exerciseName: 'conventional_deadlift',
    steps: [
      {
        stepNumber: 1,
        instruction:
          'Stand with feet hip-width apart and the bar directly over your mid-foot (approximately 1 inch from shins). Your toes can angle out slightly.',
      },
      {
        stepNumber: 2,
        instruction:
          'Hinge at the hips and push them back until your hands reach the bar. Grip just outside your legs — double overhand or mixed grip.',
      },
      {
        stepNumber: 3,
        instruction:
          'Pull your shoulder blades down and back ("put your shoulders in your back pockets"). Brace your core hard (Valsalva manoeuvre) before the bar leaves the floor.',
      },
      {
        stepNumber: 4,
        instruction:
          'Push the floor away while simultaneously extending your hips. Keep the bar dragging against your legs throughout — this minimises the moment arm on your lower back.',
      },
      {
        stepNumber: 5,
        instruction:
          'Lock out by fully extending your hips and knees at the top. Squeeze glutes, stand tall. Do not hyperextend the lumbar spine. Lower under control by reversing the movement.',
      },
    ],
    media: [
      {
        type: 'gif',
        url: '/media/deadlift-correct.gif',
        alt: 'Side-view of a correctly performed conventional deadlift showing bar path and neutral spine',
        category: 'correct_form',
      },
      {
        type: 'gif',
        url: '/media/deadlift-rounded-back.gif',
        alt: 'Side-view showing excessive lower back rounding during the deadlift — a common and risky mistake',
        category: 'common_mistake',
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// FormGuide class
// ---------------------------------------------------------------------------

/**
 * FormGuide provides read-only access to the static exercise guide catalogue.
 *
 * Requirements 7.1, 7.2, 7.3
 */
export class FormGuide {
  /**
   * Returns the complete `ExerciseGuide` for the given exercise name, or
   * `null` when no guide is registered for that exercise.
   *
   * Requirement 7.1
   */
  getGuide(exerciseName: string): ExerciseGuide | null {
    return EXERCISE_GUIDES[exerciseName] ?? null;
  }

  /**
   * Returns the ordered `FormStep` array for the given exercise, or an
   * empty array when no guide is registered.
   *
   * Requirement 7.1
   */
  getSteps(exerciseName: string): FormStep[] {
    return EXERCISE_GUIDES[exerciseName]?.steps ?? [];
  }

  /**
   * Returns the `MediaReference` items for the given exercise, optionally
   * filtered to a specific category.
   *
   * - Passing no `category` returns all media for the exercise.
   * - Passing `'correct_form'` returns the range-of-motion visuals (Req 7.2).
   * - Passing `'common_mistake'` returns the mistake-highlight visuals (Req 7.3).
   *
   * Returns an empty array when no guide is registered.
   */
  getMedia(
    exerciseName: string,
    category?: 'correct_form' | 'common_mistake',
  ): MediaReference[] {
    const guide = EXERCISE_GUIDES[exerciseName];
    if (guide === undefined) return [];
    if (category === undefined) return guide.media;
    return guide.media.filter((m) => m.category === category);
  }

  /**
   * Returns the list of exercise names that have registered guides.
   */
  getSupportedExercises(): string[] {
    return Object.keys(EXERCISE_GUIDES);
  }
}
