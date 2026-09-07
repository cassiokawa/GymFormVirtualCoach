/**
 * SetSummary — the headline figures for a completed set on the REVIEW surface
 * (R6.1).
 *
 * Renders four plain figures from a {@link SetRecord}:
 *  - rep count
 *  - total time under tension (summed per-rep TUT, shown in seconds)
 *  - mean concentric velocity per rep — RELATIVE and UNITLESS (`tech.md` rule 2)
 *  - the count of flagged reps (reps with one or more fault cue ids)
 *
 * ## No absolute velocity units, ever (`tech.md` hard rule 2)
 *
 * `concentricVelocityRel` is a unitless RELATIVE value. This component prints it
 * as a bare number with no `m/s`, no `mps`, no unit suffix of any kind. The
 * scale factor `k` cancels only in relative loss; exposing an absolute figure
 * would invite comparison to published load-velocity tables where the number is
 * meaningless.
 *
 * ## Low-confidence suppression (R6.4)
 *
 * When {@link SetRecord.lowConfidence} is true, the mean-velocity figure is
 * suppressed entirely — not shown as zero, not shown as "n/a velocity" — the
 * row is omitted. The ReviewSurface renders the low-confidence note; this
 * component simply does not emit a velocity figure in that case.
 *
 * ## Not a grade, score, streak, or percentage (`coaching-safety.md`)
 *
 * Every figure here is a plain count or a plain relative number. No percentage,
 * no star, no streak, no goal gap, no progress bar, no rank, no praise.
 *
 * Framework-free: plain DOM with a `mount(host)` / `unmount()` lifecycle.
 *
 * Requirements: 6.1, 6.4, 6.5
 */

import type { SetRecord } from '../types';

/**
 * Compute the total time under tension for a set, in milliseconds: the sum of
 * every rep's `tUnderTensionMs`. Non-finite per-rep values contribute nothing.
 */
export function totalTimeUnderTensionMs(set: SetRecord): number {
  let total = 0;
  for (const rep of set.reps) {
    if (Number.isFinite(rep.tUnderTensionMs) && rep.tUnderTensionMs > 0) {
      total += rep.tUnderTensionMs;
    }
  }
  return total;
}

/**
 * Mean concentric RELATIVE velocity across the reps that have a computed value.
 * Reps whose `concentricVelocityRel` is `null` (low-confidence, R6.4) are
 * excluded from the mean. Returns `null` when no rep has a value. UNITLESS.
 */
export function meanConcentricVelocityRel(set: SetRecord): number | null {
  let sum = 0;
  let n = 0;
  for (const rep of set.reps) {
    const v = rep.concentricVelocityRel;
    if (v !== null && Number.isFinite(v)) {
      sum += v;
      n += 1;
    }
  }
  return n > 0 ? sum / n : null;
}

/** Count of reps carrying one or more fault cue ids (flagged reps, R6.1/R6.3). */
export function flaggedRepCount(set: SetRecord): number {
  let count = 0;
  for (const rep of set.reps) {
    if (rep.faultCueIds.length > 0) count += 1;
  }
  return count;
}

/** Round a relative velocity to two decimals for display. UNITLESS. */
function formatRelVelocity(v: number): string {
  return (Math.round(v * 100) / 100).toFixed(2);
}

/** Format a millisecond duration as seconds with one decimal, suffixed `s`. */
function formatSeconds(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
}

/**
 * The headline set figures. Framework-free; `mount` attaches into the host and
 * renders from the given {@link SetRecord}, `unmount` detaches.
 */
export class SetSummary {
  private readonly root: HTMLDivElement;
  private host: HTMLElement | null = null;

  constructor(set: SetRecord) {
    this.root = document.createElement('div');
    this.root.className = 'set-summary';

    // Rep count (R6.1).
    this.root.appendChild(
      figure('set-summary__reps', 'reps', String(set.reps.length)),
    );

    // Total time under tension (R6.1).
    this.root.appendChild(
      figure(
        'set-summary__tut',
        'time under tension',
        formatSeconds(totalTimeUnderTensionMs(set)),
      ),
    );

    // Mean concentric RELATIVE velocity (R6.1) — suppressed on low confidence
    // (R6.4), and omitted when no rep had a computable value.
    if (!set.lowConfidence) {
      const mean = meanConcentricVelocityRel(set);
      if (mean !== null) {
        this.root.appendChild(
          figure(
            'set-summary__velocity',
            'mean relative velocity',
            formatRelVelocity(mean),
          ),
        );
      }
    }

    // Flagged-rep count (R6.1).
    this.root.appendChild(
      figure(
        'set-summary__flagged',
        'flagged reps',
        String(flaggedRepCount(set)),
      ),
    );
  }

  /** Attach the summary into `host`. */
  mount(host: HTMLElement): void {
    this.host = host;
    host.appendChild(this.root);
  }

  /** Detach the summary and drop its host reference. */
  unmount(): void {
    if (this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    this.host = null;
  }

  /** The summary root element (for composition by ReviewSurface). */
  get element(): HTMLElement {
    return this.root;
  }
}

/** Build a labelled figure: a value paired with its plain-language label. */
function figure(className: string, label: string, value: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = className;

  const valueEl = document.createElement('div');
  valueEl.className = `${className}__value`;
  valueEl.textContent = value;

  const labelEl = document.createElement('div');
  labelEl.className = `${className}__label`;
  labelEl.textContent = label;

  wrap.appendChild(valueEl);
  wrap.appendChild(labelEl);
  return wrap;
}
