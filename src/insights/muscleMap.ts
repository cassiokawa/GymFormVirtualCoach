/**
 * Canonical muscle regions and the mapping from the exercise catalog's freeform
 * `muscleGroups` strings onto them.
 *
 * The catalog uses descriptive labels ("shoulders (lateral deltoid)",
 * "calves (gastrocnemius)"); this module normalizes them to a fixed set of
 * regions that the anatomy SVG can highlight and the analytics can aggregate.
 */

/** Canonical muscle regions used by the anatomy visualization + analytics. */
export type MuscleRegion =
  | 'chest'
  | 'shoulders'
  | 'biceps'
  | 'triceps'
  | 'forearms'
  | 'abs'
  | 'obliques'
  | 'quads'
  | 'hamstrings'
  | 'glutes'
  | 'calves'
  | 'back'
  | 'hipFlexors';

/** Human-readable label per region (for legends / tooltips). */
export const REGION_LABELS: Record<MuscleRegion, string> = {
  chest: 'Chest',
  shoulders: 'Shoulders',
  biceps: 'Biceps',
  triceps: 'Triceps',
  forearms: 'Forearms',
  abs: 'Abs',
  obliques: 'Obliques',
  quads: 'Quads',
  hamstrings: 'Hamstrings',
  glutes: 'Glutes',
  calves: 'Calves',
  back: 'Back',
  hipFlexors: 'Hip Flexors',
};

/** Which anatomical view each region is drawn on. */
export const REGION_VIEW: Record<MuscleRegion, 'front' | 'back'> = {
  chest: 'front',
  shoulders: 'front',
  biceps: 'front',
  triceps: 'back',
  forearms: 'front',
  abs: 'front',
  obliques: 'front',
  quads: 'front',
  hamstrings: 'back',
  glutes: 'back',
  calves: 'back',
  back: 'back',
  hipFlexors: 'front',
};

/**
 * Normalize a freeform catalog muscle-group string to canonical regions.
 * A single label may map to more than one region; unknown/cardio labels map to
 * none (returned as an empty array).
 */
export function normalizeMuscle(raw: string): MuscleRegion[] {
  const s = raw.toLowerCase();
  if (s.includes('quad')) return ['quads'];
  if (s.includes('hamstring')) return ['hamstrings'];
  if (s.includes('glute')) return ['glutes'];
  if (s.includes('calf') || s.includes('calves') || s.includes('soleus')) return ['calves'];
  if (s.includes('hip flexor')) return ['hipFlexors'];
  if (s.includes('chest')) return ['chest'];
  if (s.includes('shoulder') || s.includes('deltoid')) return ['shoulders'];
  if (s.includes('tricep')) return ['triceps'];
  if (s.includes('bicep')) return ['biceps'];
  if (s.includes('forearm')) return ['forearms'];
  if (s.includes('oblique')) return ['obliques'];
  if (s.includes('abs') || s === 'core') return ['abs'];
  if (s.includes('back') || s.includes('lat')) return ['back'];
  // "cardio" and anything unrecognized contribute to no specific muscle.
  return [];
}

/**
 * The relative emphasis weight of each muscle group within an exercise. The
 * catalog lists muscles in rough priority order, so earlier entries get a
 * higher weight. Returns a map of region -> weight in (0, 1].
 */
export function exerciseMuscleWeights(muscleGroups: string[]): Map<MuscleRegion, number> {
  const weights = new Map<MuscleRegion, number>();
  muscleGroups.forEach((raw, index) => {
    // Primary mover ~1.0, secondary ~0.6, tertiary ~0.4, then 0.3 floor.
    const weight = [1.0, 0.6, 0.4][index] ?? 0.3;
    for (const region of normalizeMuscle(raw)) {
      weights.set(region, Math.max(weights.get(region) ?? 0, weight));
    }
  });
  return weights;
}
