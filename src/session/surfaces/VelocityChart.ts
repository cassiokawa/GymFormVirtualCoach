/**
 * VelocityChart — the per-rep RELATIVE velocity chart on the REVIEW surface
 * (R6.2, R6.3).
 *
 * Plots one bar per rep whose height maps to that rep's RELATIVE concentric
 * velocity (unitless). The set's best rep ({@link SetRecord.bestRepIndex}) is
 * marked, and any rep carrying one or more fault cue ids is marked as flagged
 * (R6.3). A flagged rep's evidence clip is reachable in ONE interaction: a click
 * on the marked bar invokes {@link VelocityChartOptions.onEvidence} with the
 * rep's `evidenceClipRef`.
 *
 * ## No absolute velocity units, ever (`tech.md` hard rule 2)
 *
 * The bars encode a unitless RELATIVE value only. No axis label, tooltip, or
 * caption prints `m/s` or any velocity unit. Bar heights are a proportion of
 * the tallest bar in the set — a relative-to-relative rendering that never
 * surfaces an absolute figure.
 *
 * ## Low-confidence suppression (R6.4)
 *
 * When {@link SetRecord.lowConfidence} is true the chart is not rendered at all
 * — the ReviewSurface omits it. This component assumes it is only constructed
 * for a set whose velocity figures may be shown.
 *
 * ## Not a grade, score, streak, or percentage (`coaching-safety.md`)
 *
 * "Best rep" is a neutral marker on the highest relative-velocity bar, not a
 * grade, star, rank, or score. Reps with no computed velocity render as an empty
 * slot rather than as zero, so a missing value is not mistaken for a poor one.
 *
 * Framework-free: plain DOM (SVG) with a `mount(host)` / `unmount()` lifecycle.
 *
 * Requirements: 6.2, 6.3, 6.4, 6.5
 */

import type { RepRecord, SetRecord } from '../types';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Construction options for {@link VelocityChart}. */
export interface VelocityChartOptions {
  /**
   * Invoked when a flagged rep's bar is clicked, with that rep's
   * `evidenceClipRef` (R6.3). Only wired for reps that both are flagged AND
   * carry a non-null clip ref.
   */
  readonly onEvidence?: (clipRef: string) => void;
}

/** A rep bar the chart renders, with its display-relevant flags resolved. */
interface RepBar {
  readonly rep: RepRecord;
  readonly isBest: boolean;
  readonly isFlagged: boolean;
}

/**
 * The per-rep relative-velocity chart. Framework-free SVG; `mount` attaches into
 * the host, `unmount` detaches and drops listeners.
 */
export class VelocityChart {
  private readonly root: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private host: HTMLElement | null = null;
  private readonly onEvidence: ((clipRef: string) => void) | undefined;
  private readonly disposers: Array<() => void> = [];

  constructor(set: SetRecord, options: VelocityChartOptions = {}) {
    this.onEvidence = options.onEvidence;

    this.root = document.createElement('div');
    this.root.className = 'velocity-chart';
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'per-rep relative velocity');

    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('velocity-chart__svg');
    this.root.appendChild(this.svg);

    this.render(set);
  }

  /** Attach the chart into `host`. */
  mount(host: HTMLElement): void {
    this.host = host;
    host.appendChild(this.root);
  }

  /** Detach the chart, remove listeners, and drop its host reference. */
  unmount(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    if (this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    this.host = null;
  }

  /** The chart root element (for composition by ReviewSurface). */
  get element(): HTMLElement {
    return this.root;
  }

  private render(set: SetRecord): void {
    const bars = this.buildBars(set);
    const count = bars.length;

    const width = 100;
    const height = 40;
    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this.svg.style.width = '100%';

    if (count === 0) return;

    // Bar heights are a proportion of the tallest RELATIVE value in the set —
    // relative-to-relative, so no absolute figure is ever surfaced (rule 2).
    let maxVel = 0;
    for (const bar of bars) {
      const v = bar.rep.concentricVelocityRel;
      if (v !== null && Number.isFinite(v) && v > maxVel) maxVel = v;
    }

    const slot = width / count;
    const barWidth = slot * 0.6;
    const gap = (slot - barWidth) / 2;

    bars.forEach((bar, i) => {
      const v = bar.rep.concentricVelocityRel;
      const x = i * slot + gap;

      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('width', String(barWidth));
      rect.classList.add('velocity-chart__bar');
      rect.dataset['repIndex'] = String(bar.rep.index);

      if (v !== null && Number.isFinite(v) && maxVel > 0) {
        const barH = (v / maxVel) * height;
        rect.setAttribute('y', String(height - barH));
        rect.setAttribute('height', String(barH));
      } else {
        // No computable velocity: render an empty slot, not a zero bar, so a
        // missing value is not read as a poor one.
        rect.setAttribute('y', String(height));
        rect.setAttribute('height', '0');
        rect.classList.add('velocity-chart__bar--empty');
      }

      if (bar.isBest) {
        rect.classList.add('velocity-chart__bar--best');
        rect.dataset['best'] = 'true';
      }

      if (bar.isFlagged) {
        rect.classList.add('velocity-chart__bar--flagged');
        rect.dataset['flagged'] = 'true';

        const clipRef = bar.rep.evidenceClipRef;
        if (clipRef !== null && this.onEvidence) {
          const handler = this.onEvidence;
          rect.style.cursor = 'pointer';
          rect.setAttribute('role', 'button');
          rect.setAttribute('tabindex', '0');
          rect.setAttribute('aria-label', `flagged rep ${bar.rep.index}, view evidence`);

          const onClick = (): void => handler(clipRef);
          const onKey = (ev: KeyboardEvent): void => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              handler(clipRef);
            }
          };
          rect.addEventListener('click', onClick);
          rect.addEventListener('keydown', onKey);
          this.disposers.push(() => {
            rect.removeEventListener('click', onClick);
            rect.removeEventListener('keydown', onKey);
          });
        }
      }

      this.svg.appendChild(rect);
    });
  }

  private buildBars(set: SetRecord): readonly RepBar[] {
    return set.reps.map((rep, i) => ({
      rep,
      isBest: set.bestRepIndex !== null && set.bestRepIndex === i,
      isFlagged: rep.faultCueIds.length > 0,
    }));
  }
}
