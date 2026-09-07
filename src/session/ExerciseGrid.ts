/**
 * ExerciseGrid — the SETUP surface's exercise picker (R7.1–R7.4).
 *
 * The user is 3 metres from the screen, so the picker is a rendered GRID of
 * tappable cards, never a native `<select>` (R7.1). It composes the pure
 * selection logic in {@link exerciseSelection}: {@link filterExercises} drives
 * the facet controls (R7.2) and free-text search (R7.3), and {@link recentFive}
 * surfaces the five most-recently-performed exercises above the grid (R7.4).
 *
 * ## Framework-free DOM
 *
 * Plain DOM with a `mount(host)` / `unmount()` lifecycle, matching the other
 * Session UX surfaces (e.g. {@link RepCountDisplay}). No framework, no virtual
 * DOM: it holds its own element references and re-renders the grid subtree on
 * every filter/search/data change.
 *
 * ## Selection contract
 *
 * Choosing a card fires {@link ExerciseGrid.onSelect} with the exercise's
 * opaque `id`. The SetupSurface / session machine consumes that to set
 * `exerciseId` and reveal the required camera angle before start (R7.5); this
 * component owns none of that downstream behaviour.
 *
 * ## Exercise identity is data, never code
 *
 * HARD CONSTRAINT (`tech.md` rule 1): no exercise `id`, name, or alias appears
 * as a literal here. Card labels, facet chips, filter option values, and the
 * recents row are all derived from the {@link ExerciseSpecMeta} DATA passed in
 * via {@link setExercises}. The only string literals in this file are static
 * UI chrome (control labels, placeholders, CSS class names).
 *
 * ## Not a grade, score, or ranking (`coaching-safety.md`)
 *
 * The grid renders exercise names and descriptive facets only — no score,
 * grade, star, rank, streak, or comparison of any kind.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */

import { filterExercises, recentFive } from './exerciseSelection';
import type { ExerciseFilter, ExerciseSpecMeta } from './types';

/** Callback fired when the user chooses an exercise card. */
export type ExerciseSelectHandler = (exerciseId: string) => void;

/**
 * The three facet dimensions the grid exposes as filter controls (R7.2). Kept
 * as a typed tuple so the render loop and option-collection stay in lock-step
 * and adding a facet is a single-edit change.
 */
type FacetKey = 'equipment' | 'muscleGroup' | 'position';

/** A facet control's static chrome plus how to read its options from data. */
interface FacetControl {
  /** The {@link ExerciseFilter} field this control writes. */
  readonly key: FacetKey;
  /** Static, non-identity label shown to the user. */
  readonly label: string;
  /** Collect the distinct option values for this facet from the catalogue. */
  readonly options: (all: readonly ExerciseSpecMeta[]) => string[];
}

/**
 * Facet control definitions. `options` derives its values from the passed-in
 * DATA — never from literals — so the dropdowns reflect exactly the catalogue.
 */
const FACET_CONTROLS: readonly FacetControl[] = [
  {
    key: 'equipment',
    label: 'Equipment',
    options: (all) => distinct(all.map((e) => e.facets.equipment)),
  },
  {
    key: 'muscleGroup',
    label: 'Muscle group',
    options: (all) => distinct(all.flatMap((e) => e.facets.primaryMuscles)),
  },
  {
    key: 'position',
    label: 'Position',
    options: (all) => distinct(all.map((e) => e.facets.position)),
  },
];

/**
 * Framework-free, filterable exercise grid. `mount` attaches it into a host,
 * `setExercises` / `setHistory` feed it data, and `onSelect` registers the
 * selection callback.
 */
export class ExerciseGrid {
  private readonly root: HTMLDivElement;
  private readonly recentsRow: HTMLDivElement;
  private readonly searchInput: HTMLInputElement;
  private readonly facetSelects: ReadonlyMap<FacetKey, HTMLSelectElement>;
  private readonly gridEl: HTMLDivElement;

  private host: HTMLElement | null = null;
  private all: readonly ExerciseSpecMeta[] = [];
  private history: readonly string[] = [];
  private filter: ExerciseFilter = {};
  private selectHandler: ExerciseSelectHandler | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'exercise-grid';

    // --- Recents row (rendered ABOVE the grid, R7.4) ---------------------
    this.recentsRow = document.createElement('div');
    this.recentsRow.className = 'exercise-grid__recents';
    this.recentsRow.setAttribute('aria-label', 'recently performed exercises');

    // --- Filter controls -------------------------------------------------
    const controls = document.createElement('div');
    controls.className = 'exercise-grid__controls';

    // Free-text search over names + aliases (R7.3).
    const searchLabel = document.createElement('label');
    searchLabel.className = 'exercise-grid__search';
    const searchText = document.createElement('span');
    searchText.textContent = 'Search';
    this.searchInput = document.createElement('input');
    this.searchInput.type = 'search';
    this.searchInput.placeholder = 'Search exercises';
    this.searchInput.setAttribute('aria-label', 'search exercises');
    this.searchInput.addEventListener('input', () => {
      this.filter = withField(this.filter, 'query', this.searchInput.value);
      this.renderGrid();
    });
    searchLabel.append(searchText, this.searchInput);
    controls.appendChild(searchLabel);

    // Facet dropdowns for equipment / muscle group / position (R7.2).
    const facetSelects = new Map<FacetKey, HTMLSelectElement>();
    for (const control of FACET_CONTROLS) {
      const label = document.createElement('label');
      label.className = `exercise-grid__facet exercise-grid__facet--${control.key}`;
      const text = document.createElement('span');
      text.textContent = control.label;
      const select = document.createElement('select');
      select.setAttribute('aria-label', control.label);
      select.dataset['facet'] = control.key;
      select.addEventListener('change', () => {
        this.filter = withField(this.filter, control.key, select.value);
        this.renderGrid();
      });
      label.append(text, select);
      controls.appendChild(label);
      facetSelects.set(control.key, select);
    }
    this.facetSelects = facetSelects;

    // --- The card grid ---------------------------------------------------
    this.gridEl = document.createElement('div');
    this.gridEl.className = 'exercise-grid__cards';
    this.gridEl.setAttribute('role', 'list');

    this.root.append(this.recentsRow, controls, this.gridEl);
  }

  /** Attach the grid into `host`. */
  mount(host: HTMLElement): void {
    this.host = host;
    host.appendChild(this.root);
    this.renderAll();
  }

  /** Detach the grid and drop its host reference. */
  unmount(): void {
    if (this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    this.host = null;
  }

  /**
   * Register the selection callback. Choosing a card invokes it with the
   * exercise's opaque id (R7.5's upstream trigger). Replaces any prior handler.
   */
  onSelect(fn: ExerciseSelectHandler): void {
    this.selectHandler = fn;
  }

  /**
   * Replace the exercise catalogue (DATA projection). Re-derives the facet
   * option lists and re-renders. The active filter is preserved.
   */
  setExercises(meta: readonly ExerciseSpecMeta[]): void {
    this.all = meta.slice();
    this.renderAll();
  }

  /**
   * Replace the performance history — exercise ids in performance order,
   * most-recent last (see {@link recentFive}). Re-renders the recents row.
   */
  setHistory(ids: readonly string[]): void {
    this.history = ids.slice();
    this.renderRecents();
  }

  /** The active filter (defensive copy). */
  getFilter(): ExerciseFilter {
    return { ...this.filter };
  }

  /** Render everything: facet options, recents, and the card grid. */
  private renderAll(): void {
    this.renderFacetOptions();
    this.renderRecents();
    this.renderGrid();
  }

  /**
   * Populate each facet dropdown with a "no constraint" blank option plus the
   * distinct values present in the catalogue. Option values are DATA.
   */
  private renderFacetOptions(): void {
    for (const control of FACET_CONTROLS) {
      const select = this.facetSelects.get(control.key);
      if (!select) {
        continue;
      }
      const current = this.filter[control.key] ?? '';
      select.replaceChildren();

      // The empty option = "no constraint" (matches filterExercises semantics).
      const any = document.createElement('option');
      any.value = '';
      any.textContent = 'Any';
      select.appendChild(any);

      for (const value of control.options(this.all)) {
        const option = document.createElement('option');
        // value + label both come from data; never a literal here.
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
      }

      // Preserve the current selection if it still exists in the data.
      select.value = current;
    }
  }

  /**
   * Render the recents row: up to five most-recent DISTINCT exercises as cards,
   * above the grid (R7.4). Ids no longer present in the catalogue are skipped.
   */
  private renderRecents(): void {
    this.recentsRow.replaceChildren();
    const ids = recentFive(this.history);
    const cards: HTMLElement[] = [];
    for (const id of ids) {
      const meta = this.all.find((e) => e.id === id);
      if (meta) {
        cards.push(this.makeCard(meta, 'exercise-grid__card--recent'));
      }
    }
    // Hide the row entirely when there is nothing recent to show.
    this.recentsRow.hidden = cards.length === 0;
    if (cards.length > 0) {
      const heading = document.createElement('h3');
      heading.className = 'exercise-grid__recents-heading';
      heading.textContent = 'Recent';
      this.recentsRow.append(heading, ...cards);
    }
  }

  /**
   * Re-render the filtered card grid. Delegates the "which match" decision to
   * the pure {@link filterExercises} (R7.2, R7.3).
   */
  private renderGrid(): void {
    const matches = filterExercises(this.all, this.filter);
    this.gridEl.replaceChildren();
    if (matches.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'exercise-grid__empty';
      empty.textContent = 'No exercises match';
      this.gridEl.appendChild(empty);
      return;
    }
    for (const meta of matches) {
      this.gridEl.appendChild(this.makeCard(meta));
    }
  }

  /**
   * Build one exercise card: a button (keyboard- and pointer-accessible) whose
   * label and facet chips are read from data. Clicking fires `onSelect(id)`.
   */
  private makeCard(meta: ExerciseSpecMeta, extraClass?: string): HTMLButtonElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = extraClass
      ? `exercise-grid__card ${extraClass}`
      : 'exercise-grid__card';
    card.setAttribute('role', 'listitem');
    // Opaque id carried on the element as data, never rendered as a label.
    card.dataset['exerciseId'] = meta.id;

    const name = document.createElement('span');
    name.className = 'exercise-grid__card-name';
    name.textContent = meta.displayName;
    card.appendChild(name);

    const facets = document.createElement('span');
    facets.className = 'exercise-grid__card-facets';
    for (const value of cardFacetValues(meta)) {
      const chip = document.createElement('span');
      chip.className = 'exercise-grid__facet-chip';
      chip.textContent = value;
      facets.appendChild(chip);
    }
    card.appendChild(facets);

    card.addEventListener('click', () => {
      this.selectHandler?.(meta.id);
    });

    return card;
  }
}

/**
 * The descriptive facet values shown on a card (equipment, position, primary
 * muscles), all sourced from data. Order is stable and non-identity-literal.
 */
function cardFacetValues(meta: ExerciseSpecMeta): string[] {
  return [meta.facets.equipment, meta.facets.position, ...meta.facets.primaryMuscles];
}

/**
 * Return the distinct, non-empty values in `values`, preserving first-seen
 * order. Used to build facet dropdown options from the catalogue.
 */
function distinct(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Return a copy of `filter` with `field` set to `value`, or with the field
 * removed when `value` is blank. Keeping absent fields absent (rather than
 * empty strings) matches {@link ExerciseFilter}'s optional-field contract under
 * `exactOptionalPropertyTypes`.
 */
function withField(
  filter: ExerciseFilter,
  field: keyof ExerciseFilter,
  value: string,
): ExerciseFilter {
  // Build a mutable draft, then return it as the readonly ExerciseFilter.
  const next: Record<string, string> = {};
  for (const [key, existing] of Object.entries(filter)) {
    if (existing !== undefined) {
      next[key] = existing;
    }
  }
  if (value.trim().length === 0) {
    delete next[field];
  } else {
    next[field] = value;
  }
  return next as ExerciseFilter;
}
