/**
 * Pure exercise-selection logic for the SETUP surface's exercise grid.
 *
 * This module is the DOM-free core the `ExerciseGrid` component (task 6.4)
 * renders on top of: it decides *which* exercises match the active filter
 * (R7.2, R7.3) and *which* were performed most recently (R7.4). Keeping this
 * logic pure means it is unit- and property-testable in isolation, and the
 * grid component stays a thin rendering shell.
 *
 * ## Purity
 *
 * Both functions are pure: no I/O, no DOM, no mutation of their inputs, and no
 * hidden state. `filterExercises` returns a new array; `recentFive` returns a
 * new array. Given the same inputs they always return the same output.
 *
 * ## Exercise identity is data, never code
 *
 * HARD CONSTRAINT (`tech.md` rule 1): no exercise `id`, name, or alias appears
 * as a literal here. Every value compared — facet strings, the free-text query,
 * ids — is supplied at runtime as {@link ExerciseSpecMeta} DATA or caller input.
 *
 * Requirements: 7.2, 7.3, 7.4
 */

import type { ExerciseFilter, ExerciseSpecMeta } from './types';

/**
 * The number of recent exercises surfaced above the grid (R7.4).
 */
const RECENTS_LIMIT = 5;

/**
 * Filter the exercise catalogue down to the entries matching every active
 * facet and the free-text query (R7.2, R7.3).
 *
 * Matching rules:
 * - Every field of {@link ExerciseFilter} is optional. An absent (or
 *   empty-string) field imposes NO constraint.
 * - `equipment` matches when it equals `facets.equipment` (case-insensitive).
 * - `muscleGroup` matches when `facets.primaryMuscles` contains it
 *   (case-insensitive).
 * - `position` matches when it equals `facets.position` (case-insensitive).
 * - `query` matches when it is a case-insensitive substring of `displayName`
 *   OR of any entry in `aliases` (R7.3).
 * - A result must satisfy ALL active constraints (logical AND). An empty
 *   filter therefore returns every exercise.
 *
 * Comparisons are case-insensitive so the grid's controls and search box need
 * not know the exact casing of the underlying data values.
 *
 * @param all The full exercise catalogue (DATA projection).
 * @param filter The active filter; any subset of fields may be present.
 * @returns A new array of the matching exercises, in the input order.
 */
export function filterExercises(
  all: readonly ExerciseSpecMeta[],
  filter: ExerciseFilter,
): ExerciseSpecMeta[] {
  const equipment = normalize(filter.equipment);
  const muscleGroup = normalize(filter.muscleGroup);
  const position = normalize(filter.position);
  const query = normalize(filter.query);

  return all.filter((exercise) => {
    if (equipment !== null && normalize(exercise.facets.equipment) !== equipment) {
      return false;
    }

    if (
      muscleGroup !== null &&
      !exercise.facets.primaryMuscles.some((muscle) => normalize(muscle) === muscleGroup)
    ) {
      return false;
    }

    if (position !== null && normalize(exercise.facets.position) !== position) {
      return false;
    }

    if (query !== null && !matchesQuery(exercise, query)) {
      return false;
    }

    return true;
  });
}

/**
 * Return the five most recently performed DISTINCT exercise ids, most-recent
 * first (R7.4).
 *
 * `history` is an append-only log of the ids of exercises as they were
 * performed, ordered **most-recent-LAST** (the newest performed exercise is the
 * final element). This matches how a session naturally pushes each completed
 * set's exercise id onto the end of a list.
 *
 * The result:
 * - contains only DISTINCT ids (an exercise repeated across sets appears once);
 * - is ordered most-recent-FIRST (the newest distinct id leads);
 * - has at most {@link RECENTS_LIMIT} entries.
 *
 * When an id recurs, its most-recent occurrence determines its position.
 *
 * @param history Exercise ids in performance order, most-recent last.
 * @returns Up to five distinct ids, most-recent first.
 */
export function recentFive(history: readonly string[]): string[] {
  const recents: string[] = [];
  const seen = new Set<string>();

  // Walk from the newest (end) toward the oldest (start), taking each id the
  // first time we see it, until we have five.
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const id = history[i];
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    recents.push(id);
    if (recents.length >= RECENTS_LIMIT) {
      break;
    }
  }

  return recents;
}

/**
 * Normalise a filter/facet value for comparison: trim, l-case, and treat an
 * empty or absent value as "no constraint" by returning `null`.
 */
function normalize(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Whether the exercise's display name or any alias contains `query` as a
 * case-insensitive substring (R7.3). `query` is already normalised.
 */
function matchesQuery(exercise: ExerciseSpecMeta, query: string): boolean {
  if (exercise.displayName.toLowerCase().includes(query)) {
    return true;
  }
  return exercise.aliases.some((alias) => alias.toLowerCase().includes(query));
}
