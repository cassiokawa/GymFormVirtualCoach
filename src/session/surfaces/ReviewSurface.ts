/**
 * ReviewSurface — the post-set review (R1.6, R6).
 *
 * The state machine mounts this surface on entering REVIEW. It renders the
 * frozen {@link SetRecord} from {@link SessionContext.set} as:
 *  - a {@link SetSummary}: rep count, total time under tension, mean concentric
 *    RELATIVE velocity, flagged-rep count (R6.1);
 *  - a {@link VelocityChart}: per-rep RELATIVE velocity, the best rep marked,
 *    flagged reps marked with evidence-clip access in one interaction (R6.2,
 *    R6.3);
 *  - exactly two actions — repeat set, return to setup (R1.6) — wired to the
 *    `onRepeat` / `onReturnToSetup` callbacks the machine maps to `REPEAT_SET`
 *    and `RETURN_TO_SETUP`.
 *
 * ## Low-confidence suppression (R6.4)
 *
 * When {@link SetRecord.lowConfidence} is true, the surface states the set's
 * data is low confidence and suppresses ALL velocity figures: the SetSummary
 * omits its mean-velocity row and the VelocityChart is not rendered at all.
 *
 * ## No grade, score, percentage, star, or streak (R6.5, `coaching-safety.md`)
 *
 * Nothing on this surface is a grade, score, percentage, star rating, rank, or
 * streak. Figures are plain counts and unitless relative numbers; the best-rep
 * marker is a neutral pointer, not an award.
 *
 * ## No absolute velocity units (`tech.md` hard rule 2)
 *
 * All velocity is RELATIVE and unitless — no `m/s` anywhere. This is delegated
 * to SetSummary and VelocityChart, which never print a unit.
 *
 * ## Dependency rule / exercise identity
 *
 * Session UX depends INWARD. This surface reads a frozen `SetRecord` and holds
 * no exercise identity literal (`tech.md` rule 1); the `exerciseId` it carries
 * is an opaque data string it never prints.
 *
 * Framework-free: implements the {@link Surface} mount/unmount lifecycle.
 *
 * Requirements: 1.6, 6.1, 6.2, 6.3, 6.4, 6.5
 */

import type { SessionContext, SetRecord, Surface } from '../types';
import { SetSummary } from './SetSummary';
import { VelocityChart } from './VelocityChart';

/** Construction options for {@link ReviewSurface}. */
export interface ReviewSurfaceOptions {
  /** Wired to `REPEAT_SET` — run the same exercise again (R1.6). */
  readonly onRepeat: () => void;
  /** Wired to `RETURN_TO_SETUP` — pick a different exercise (R1.6). */
  readonly onReturnToSetup: () => void;
  /**
   * Invoked when a flagged rep's evidence is requested from the chart, with the
   * rep's `evidenceClipRef` (R6.3). The machine/host resolves the clip.
   */
  readonly onEvidence?: (clipRef: string) => void;
}

/** Plain-language note shown when the set was low confidence (R6.4). */
export const LOW_CONFIDENCE_NOTE =
  'This set was recorded at low confidence, so velocity figures are not shown.';

/**
 * The standing disclaimer every body/movement-data surface carries
 * (`coaching-safety.md`): a movement-tracking tool, not a medical device.
 */
export const REVIEW_DISCLAIMER =
  'This is a movement-tracking tool, not a medical device, and does not replace a qualified coach or clinician.';

/**
 * The post-set review surface. Framework-free; `mount` builds and attaches the
 * DOM from the session context, `unmount` disposes children and detaches.
 */
export class ReviewSurface implements Surface {
  private readonly onRepeat: () => void;
  private readonly onReturnToSetup: () => void;
  private readonly onEvidence: ((clipRef: string) => void) | undefined;

  private root: HTMLDivElement | null = null;
  private host: HTMLElement | null = null;
  private summary: SetSummary | null = null;
  private chart: VelocityChart | null = null;
  private readonly disposers: Array<() => void> = [];

  constructor(options: ReviewSurfaceOptions) {
    this.onRepeat = options.onRepeat;
    this.onReturnToSetup = options.onReturnToSetup;
    this.onEvidence = options.onEvidence;
  }

  /** Build and attach the review DOM, reading the frozen set from `ctx`. */
  mount(host: HTMLElement, ctx: SessionContext): void {
    this.host = host;

    const root = document.createElement('div');
    root.className = 'review-surface';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'set review');
    this.root = root;

    const set = ctx.set;
    if (set === null) {
      // No set to review — render only the actions so the user can move on.
      root.appendChild(this.buildActions());
      host.appendChild(root);
      return;
    }

    if (set.lowConfidence) {
      // R6.4: state low confidence and suppress ALL velocity figures.
      const note = document.createElement('p');
      note.className = 'review-surface__low-confidence';
      note.setAttribute('role', 'status');
      note.textContent = LOW_CONFIDENCE_NOTE;
      root.appendChild(note);
    }

    // SetSummary itself omits the mean-velocity row when lowConfidence (R6.4).
    this.summary = new SetSummary(set);
    this.summary.mount(root);

    // VelocityChart is only rendered when velocity figures may be shown (R6.4).
    if (!set.lowConfidence) {
      this.chart = this.buildChart(set);
      this.chart.mount(root);
    }

    // Standing disclaimer (coaching-safety.md).
    const disclaimer = document.createElement('p');
    disclaimer.className = 'review-surface__disclaimer';
    disclaimer.textContent = REVIEW_DISCLAIMER;
    root.appendChild(disclaimer);

    // Exactly two actions (R1.6).
    root.appendChild(this.buildActions());

    host.appendChild(root);
  }

  /** Dispose children, remove listeners, and detach. */
  unmount(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;

    if (this.summary) {
      this.summary.unmount();
      this.summary = null;
    }
    if (this.chart) {
      this.chart.unmount();
      this.chart = null;
    }
    if (this.root && this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    this.root = null;
    this.host = null;
  }

  private buildChart(set: SetRecord): VelocityChart {
    const opts = this.onEvidence
      ? { onEvidence: this.onEvidence }
      : {};
    return new VelocityChart(set, opts);
  }

  /** Build exactly two actions: repeat set, return to setup (R1.6). */
  private buildActions(): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'review-surface__actions';

    const repeat = document.createElement('button');
    repeat.type = 'button';
    repeat.className = 'review-surface__action review-surface__action--repeat';
    repeat.textContent = 'Repeat set';
    const onRepeatClick = (): void => this.onRepeat();
    repeat.addEventListener('click', onRepeatClick);
    this.disposers.push(() => repeat.removeEventListener('click', onRepeatClick));

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'review-surface__action review-surface__action--setup';
    back.textContent = 'Return to setup';
    const onBackClick = (): void => this.onReturnToSetup();
    back.addEventListener('click', onBackClick);
    this.disposers.push(() => back.removeEventListener('click', onBackClick));

    actions.appendChild(repeat);
    actions.appendChild(back);
    return actions;
  }
}
