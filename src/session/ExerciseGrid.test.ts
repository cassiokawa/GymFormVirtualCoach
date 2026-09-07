/**
 * Unit tests for ExerciseGrid — the SETUP surface's filterable exercise picker
 * (R7.1–R7.4).
 *
 * These assert, against real DOM (jsdom):
 *  - the picker is a rendered GRID of cards, not a native <select> (R7.1)
 *  - facet dropdowns filter the visible cards (R7.2)
 *  - typing in the search box filters the visible cards over names/aliases (R7.3)
 *  - the recents row shows up to five most-recent distinct exercises (R7.4)
 *  - clicking a card fires onSelect with the exercise's opaque id
 *
 * All identity values (ids, names, aliases, facets) are DATA supplied here,
 * never literals inside implementation code (`tech.md` rule 1).
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { ExerciseGrid } from './ExerciseGrid.js';
import type { ExerciseSpecMeta } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures / builders
// ---------------------------------------------------------------------------

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
    aliases: ['RDL'],
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
// Harness
// ---------------------------------------------------------------------------

interface Mounted {
  host: HTMLElement;
  grid: ExerciseGrid;
}

function mountGrid(): Mounted {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const grid = new ExerciseGrid();
  grid.mount(host);
  grid.setExercises(CATALOGUE);
  return { host, grid };
}

/** The ids of the cards currently rendered in the main grid (not recents). */
function gridCardIds(host: HTMLElement): string[] {
  const cards = host.querySelectorAll<HTMLElement>('.exercise-grid__cards .exercise-grid__card');
  return Array.from(cards).map((c) => c.dataset['exerciseId'] ?? '');
}

/** The ids of the cards currently rendered in the recents row. */
function recentCardIds(host: HTMLElement): string[] {
  const cards = host.querySelectorAll<HTMLElement>('.exercise-grid__recents .exercise-grid__card');
  return Array.from(cards).map((c) => c.dataset['exerciseId'] ?? '');
}

function facetSelect(host: HTMLElement, key: string): HTMLSelectElement {
  const el = host.querySelector<HTMLSelectElement>(`select[data-facet="${key}"]`);
  expect(el, `expected a facet select for "${key}"`).not.toBeNull();
  return el!;
}

function searchBox(host: HTMLElement): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>('input[type="search"]');
  expect(el, 'expected a search input').not.toBeNull();
  return el!;
}

beforeEach(() => {
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------
// R7.1 — a rendered grid of cards, not a native <select>
// ---------------------------------------------------------------------------

describe('ExerciseGrid — rendering (R7.1)', () => {
  it('renders exercises as a grid of card buttons, one per exercise', () => {
    const { host } = mountGrid();
    const cards = host.querySelectorAll('.exercise-grid__cards .exercise-grid__card');
    expect(cards.length).toBe(CATALOGUE.length);
    // Cards are buttons (tappable), not <option>s.
    cards.forEach((c) => expect(c.tagName).toBe('BUTTON'));
  });

  it('does not present the exercise catalogue as a native <select>', () => {
    const { host } = mountGrid();
    // The only <select> elements are the three facet filter controls — none
    // enumerates the exercises themselves.
    const selects = host.querySelectorAll('select');
    selects.forEach((s) => {
      const optionTexts = Array.from(s.querySelectorAll('option')).map((o) => o.textContent);
      for (const meta of CATALOGUE) {
        expect(optionTexts).not.toContain(meta.displayName);
      }
    });
  });

  it('renders each card with its display name and facet chips from data', () => {
    const { host } = mountGrid();
    const first = host.querySelector<HTMLElement>(
      '.exercise-grid__cards .exercise-grid__card[data-exercise-id="ex-1"]',
    );
    expect(first).not.toBeNull();
    expect(first!.querySelector('.exercise-grid__card-name')?.textContent).toBe('Back Squat');
    const chips = Array.from(
      first!.querySelectorAll('.exercise-grid__facet-chip'),
    ).map((c) => c.textContent);
    expect(chips).toContain('barbell');
    expect(chips).toContain('quads');
  });
});

// ---------------------------------------------------------------------------
// R7.3 — free-text search over names + aliases
// ---------------------------------------------------------------------------

describe('ExerciseGrid — search (R7.3)', () => {
  it('typing in the search box filters the visible cards by name', () => {
    const { host } = mountGrid();
    const search = searchBox(host);
    search.value = 'squat';
    search.dispatchEvent(new Event('input'));
    expect(gridCardIds(host)).toEqual(['ex-1', 'ex-4']);
  });

  it('search matches aliases too', () => {
    const { host } = mountGrid();
    const search = searchBox(host);
    search.value = 'rdl';
    search.dispatchEvent(new Event('input'));
    expect(gridCardIds(host)).toEqual(['ex-2']);
  });

  it('clearing the search restores the full grid', () => {
    const { host } = mountGrid();
    const search = searchBox(host);
    search.value = 'squat';
    search.dispatchEvent(new Event('input'));
    search.value = '';
    search.dispatchEvent(new Event('input'));
    expect(gridCardIds(host)).toEqual(['ex-1', 'ex-2', 'ex-3', 'ex-4']);
  });

  it('shows an empty-state message when nothing matches', () => {
    const { host } = mountGrid();
    const search = searchBox(host);
    search.value = 'no-such-exercise';
    search.dispatchEvent(new Event('input'));
    expect(gridCardIds(host)).toEqual([]);
    expect(host.querySelector('.exercise-grid__empty')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R7.2 — facet filters
// ---------------------------------------------------------------------------

describe('ExerciseGrid — facet filters (R7.2)', () => {
  it('selecting an equipment facet filters the cards', () => {
    const { host } = mountGrid();
    const select = facetSelect(host, 'equipment');
    select.value = 'dumbbell';
    select.dispatchEvent(new Event('change'));
    expect(gridCardIds(host)).toEqual(['ex-3', 'ex-4']);
  });

  it('selecting a muscle-group facet filters by membership', () => {
    const { host } = mountGrid();
    const select = facetSelect(host, 'muscleGroup');
    select.value = 'glutes';
    select.dispatchEvent(new Event('change'));
    expect(gridCardIds(host)).toEqual(['ex-1', 'ex-2']);
  });

  it('facet + search compose as a conjunction', () => {
    const { host } = mountGrid();
    const equip = facetSelect(host, 'equipment');
    equip.value = 'dumbbell';
    equip.dispatchEvent(new Event('change'));
    const search = searchBox(host);
    search.value = 'squat';
    search.dispatchEvent(new Event('input'));
    expect(gridCardIds(host)).toEqual(['ex-4']);
  });

  it('populates facet options from data with an "Any" no-constraint choice', () => {
    const { host } = mountGrid();
    const equip = facetSelect(host, 'equipment');
    const values = Array.from(equip.querySelectorAll('option')).map((o) => o.value);
    expect(values).toContain(''); // the "Any" option
    expect(values).toContain('barbell');
    expect(values).toContain('dumbbell');
  });
});

// ---------------------------------------------------------------------------
// R7.4 — recents surfaced above the grid
// ---------------------------------------------------------------------------

describe('ExerciseGrid — recents (R7.4)', () => {
  it('shows up to five most-recent distinct exercises, most-recent first', () => {
    const { host, grid } = mountGrid();
    // history is most-recent-LAST.
    grid.setHistory(['ex-1', 'ex-2', 'ex-3', 'ex-1', 'ex-4', 'ex-2']);
    // distinct, most-recent-first: ex-2, ex-4, ex-1, ex-3
    expect(recentCardIds(host)).toEqual(['ex-2', 'ex-4', 'ex-1', 'ex-3']);
  });

  it('caps the recents row at five entries', () => {
    const { host, grid } = mountGrid();
    const extra = makeMeta({ id: 'ex-5', displayName: 'Overhead Press' });
    const extra2 = makeMeta({ id: 'ex-6', displayName: 'Row' });
    grid.setExercises([...CATALOGUE, extra, extra2]);
    grid.setHistory(['ex-1', 'ex-2', 'ex-3', 'ex-4', 'ex-5', 'ex-6']);
    const ids = recentCardIds(host);
    expect(ids.length).toBe(5);
    expect(ids).toEqual(['ex-6', 'ex-5', 'ex-4', 'ex-3', 'ex-2']);
  });

  it('hides the recents row when there is no history', () => {
    const { host } = mountGrid();
    expect(recentCardIds(host)).toEqual([]);
    const row = host.querySelector<HTMLElement>('.exercise-grid__recents');
    expect(row?.hidden).toBe(true);
  });

  it('skips recent ids that are not in the catalogue', () => {
    const { host, grid } = mountGrid();
    grid.setHistory(['ex-unknown', 'ex-1']);
    expect(recentCardIds(host)).toEqual(['ex-1']);
  });
});

// ---------------------------------------------------------------------------
// Selection callback
// ---------------------------------------------------------------------------

describe('ExerciseGrid — onSelect', () => {
  it('fires onSelect with the exercise id when a grid card is clicked', () => {
    const { host, grid } = mountGrid();
    const selected: string[] = [];
    grid.onSelect((id) => selected.push(id));
    const card = host.querySelector<HTMLButtonElement>(
      '.exercise-grid__cards .exercise-grid__card[data-exercise-id="ex-3"]',
    );
    expect(card).not.toBeNull();
    card!.click();
    expect(selected).toEqual(['ex-3']);
  });

  it('fires onSelect when a recents card is clicked', () => {
    const { host, grid } = mountGrid();
    grid.setHistory(['ex-2']);
    const selected: string[] = [];
    grid.onSelect((id) => selected.push(id));
    const card = host.querySelector<HTMLButtonElement>(
      '.exercise-grid__recents .exercise-grid__card[data-exercise-id="ex-2"]',
    );
    expect(card).not.toBeNull();
    card!.click();
    expect(selected).toEqual(['ex-2']);
  });

  it('unmount removes the grid from the host', () => {
    const { host, grid } = mountGrid();
    expect(host.querySelector('.exercise-grid')).not.toBeNull();
    grid.unmount();
    expect(host.querySelector('.exercise-grid')).toBeNull();
  });
});
