/**
 * Tests for the pure exercise-selection logic (task 6.1).
 *
 * Covers `filterExercises` facet + free-text matching (R7.2, R7.3) and
 * `recentFive` distinct-most-recent-first behaviour (R7.4), with both
 * example-based unit tests and property-based tests.
 *
 * Feature: 01-coach-session-ux
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import type { ExerciseFilter, ExerciseSpecMeta } from './types';
import { filterExercises, recentFive } from './exerciseSelection';

// ---------------------------------------------------------------------------
// Fixtures / builders — all identity values are DATA supplied here, never
// literals inside src/**/*.ts implementation code.
// ---------------------------------------------------------------------------

/** Build an ExerciseSpecMeta with sensible defaults; override any field. */
function makeMeta(overrides: Partial<ExerciseSpecMeta> = {}): ExerciseSpecMeta {
  return {
    id: 'ex-0',
    version: '1',
    displayName: 'Movement',
    aliases: [],
    facets: { equipment: 'barbell', primaryMuscles: ['quads'], position: 'standing' },
    mode: 'reps',
    bilateral: true,
    camera: { preferredAngleDeg: 90, toleranceDeg: 15, view: 'side' },
    requiredLandmarks: [],
    ...overrides,
  } as ExerciseSpecMeta;
}

const CATALOGUE: readonly ExerciseSpecMeta[] = [
  makeMeta({
    id: 'ex-1',
    displayName: 'Back Squat',
    aliases: ['high-bar squat'],
    facets: { equipment: 'barbell', primaryMuscles: ['quads', 'glutes'], position: 'standing' },
  }),
  makeMeta({
    id: 'ex-2',
    displayName: 'Romanian Deadlift',
    aliases: ['RDL', 'stiff-leg deadlift'],
    facets: { equipment: 'barbell', primaryMuscles: ['hamstrings', 'glutes'], position: 'standing' },
  }),
  makeMeta({
    id: 'ex-3',
    displayName: 'Dumbbell Bench Press',
    aliases: ['db bench'],
    facets: { equipment: 'dumbbell', primaryMuscles: ['chest'], position: 'lying' },
  }),
  makeMeta({
    id: 'ex-4',
    displayName: 'Goblet Squat',
    aliases: [],
    facets: { equipment: 'dumbbell', primaryMuscles: ['quads'], position: 'standing' },
  }),
];

// ---------------------------------------------------------------------------
// filterExercises — unit tests
// ---------------------------------------------------------------------------

describe('filterExercises', () => {
  it('returns every exercise for an empty filter', () => {
    expect(filterExercises(CATALOGUE, {})).toEqual(CATALOGUE);
  });

  it('treats empty-string fields as no constraint', () => {
    const filter: ExerciseFilter = { equipment: '', muscleGroup: '', position: '', query: '' };
    expect(filterExercises(CATALOGUE, filter)).toEqual(CATALOGUE);
  });

  it('filters by equipment facet', () => {
    const result = filterExercises(CATALOGUE, { equipment: 'dumbbell' });
    expect(result.map((e) => e.id)).toEqual(['ex-3', 'ex-4']);
  });

  it('filters by primary muscle group membership', () => {
    const result = filterExercises(CATALOGUE, { muscleGroup: 'glutes' });
    expect(result.map((e) => e.id)).toEqual(['ex-1', 'ex-2']);
  });

  it('filters by body position', () => {
    const result = filterExercises(CATALOGUE, { position: 'lying' });
    expect(result.map((e) => e.id)).toEqual(['ex-3']);
  });

  it('matches the free-text query against displayName (case-insensitive)', () => {
    const result = filterExercises(CATALOGUE, { query: 'squat' });
    expect(result.map((e) => e.id)).toEqual(['ex-1', 'ex-4']);
  });

  it('matches the free-text query against an alias', () => {
    const result = filterExercises(CATALOGUE, { query: 'rdl' });
    expect(result.map((e) => e.id)).toEqual(['ex-2']);
  });

  it('applies all active constraints as a conjunction', () => {
    const result = filterExercises(CATALOGUE, {
      equipment: 'dumbbell',
      muscleGroup: 'quads',
      position: 'standing',
      query: 'squat',
    });
    expect(result.map((e) => e.id)).toEqual(['ex-4']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterExercises(CATALOGUE, { equipment: 'kettlebell' })).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const copy = [...CATALOGUE];
    filterExercises(CATALOGUE, { equipment: 'barbell' });
    expect(CATALOGUE).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// filterExercises — property tests
// ---------------------------------------------------------------------------

/** Generator for a single ExerciseSpecMeta with constrained facet/name spaces. */
const metaArb: fc.Arbitrary<ExerciseSpecMeta> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  displayName: fc.string({ minLength: 1, maxLength: 12 }),
  aliases: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 3 }),
  equipment: fc.constantFrom('barbell', 'dumbbell', 'kettlebell', 'bodyweight'),
  primaryMuscles: fc.array(
    fc.constantFrom('quads', 'glutes', 'hamstrings', 'chest', 'back'),
    { minLength: 1, maxLength: 3 },
  ),
  position: fc.constantFrom('standing', 'lying', 'seated'),
}).map(({ id, displayName, aliases, equipment, primaryMuscles, position }) =>
  makeMeta({ id, displayName, aliases, facets: { equipment, primaryMuscles, position } }),
);

const catalogueArb = fc.array(metaArb, { maxLength: 12 });

const filterArb: fc.Arbitrary<ExerciseFilter> = fc.record(
  {
    equipment: fc.constantFrom('barbell', 'dumbbell', 'kettlebell', 'bodyweight'),
    muscleGroup: fc.constantFrom('quads', 'glutes', 'hamstrings', 'chest', 'back'),
    position: fc.constantFrom('standing', 'lying', 'seated'),
    query: fc.string({ maxLength: 4 }),
  },
  { requiredKeys: [] },
);

describe('filterExercises — properties', () => {
  // Property 7: every result of filterExercises matches all active filter facets.
  // Validates: Requirements 7.2, 7.3
  it('Property 7: every result matches all active facets and the query', () => {
    fc.assert(
      fc.property(catalogueArb, filterArb, (all, filter) => {
        const results = filterExercises(all, filter);
        const q = filter.query?.trim().toLowerCase() ?? '';
        for (const e of results) {
          if (filter.equipment !== undefined && filter.equipment.trim() !== '') {
            expect(e.facets.equipment.toLowerCase()).toBe(filter.equipment.toLowerCase());
          }
          if (filter.muscleGroup !== undefined && filter.muscleGroup.trim() !== '') {
            expect(
              e.facets.primaryMuscles.map((m) => m.toLowerCase()),
            ).toContain(filter.muscleGroup.toLowerCase());
          }
          if (filter.position !== undefined && filter.position.trim() !== '') {
            expect(e.facets.position.toLowerCase()).toBe(filter.position.toLowerCase());
          }
          if (q !== '') {
            const hay = [e.displayName, ...e.aliases].map((s) => s.toLowerCase());
            expect(hay.some((s) => s.includes(q))).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('Property: results are a subset of the input in input order', () => {
    fc.assert(
      fc.property(catalogueArb, filterArb, (all, filter) => {
        const results = filterExercises(all, filter);
        // results is a subsequence of `all`
        let cursor = 0;
        for (const r of results) {
          const idx = all.indexOf(r, cursor);
          expect(idx).toBeGreaterThanOrEqual(cursor);
          cursor = idx + 1;
        }
      }),
      { numRuns: 200 },
    );
  });

  it('Property: an empty filter returns all', () => {
    fc.assert(
      fc.property(catalogueArb, (all) => {
        expect(filterExercises(all, {})).toEqual(all);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// recentFive — unit tests
// ---------------------------------------------------------------------------

describe('recentFive', () => {
  it('returns an empty array for empty history', () => {
    expect(recentFive([])).toEqual([]);
  });

  it('returns ids most-recent-first', () => {
    expect(recentFive(['a', 'b', 'c'])).toEqual(['c', 'b', 'a']);
  });

  it('de-duplicates by most-recent occurrence', () => {
    expect(recentFive(['a', 'b', 'a', 'c'])).toEqual(['c', 'a', 'b']);
  });

  it('returns at most five distinct ids', () => {
    expect(recentFive(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual([
      'g',
      'f',
      'e',
      'd',
      'c',
    ]);
  });

  it('collapses a repeated exercise to a single recent entry', () => {
    expect(recentFive(['a', 'a', 'a'])).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// recentFive — property tests
// ---------------------------------------------------------------------------

describe('recentFive — properties', () => {
  const historyArb = fc.array(
    fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'),
    { maxLength: 40 },
  );

  // Property 8: recentFive returns at most five distinct ids, most-recent-first.
  // Validates: Requirements 7.4
  it('Property 8: at most five distinct ids, most-recent-first', () => {
    fc.assert(
      fc.property(historyArb, (history) => {
        const result = recentFive(history);

        // at most five
        expect(result.length).toBeLessThanOrEqual(5);

        // distinct
        expect(new Set(result).size).toBe(result.length);

        // every result id is present in history
        for (const id of result) {
          expect(history).toContain(id);
        }

        // most-recent-first: for consecutive results, the earlier one's
        // last occurrence in history is later than the next one's.
        const lastIndex = (id: string): number => history.lastIndexOf(id);
        for (let i = 0; i + 1 < result.length; i += 1) {
          expect(lastIndex(result[i] as string)).toBeGreaterThan(
            lastIndex(result[i + 1] as string),
          );
        }

        // completeness: if fewer than 5 distinct ids exist, all are returned.
        const distinctCount = new Set(history).size;
        expect(result.length).toBe(Math.min(distinctCount, 5));
      }),
      { numRuns: 200 },
    );
  });

  it('Property: does not mutate the input', () => {
    fc.assert(
      fc.property(historyArb, (history) => {
        const copy = [...history];
        recentFive(history);
        expect(history).toEqual(copy);
      }),
      { numRuns: 100 },
    );
  });
});
