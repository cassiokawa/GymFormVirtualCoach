/**
 * Unit tests for the post-set review surface and its components — ReviewSurface,
 * SetSummary, VelocityChart (R1.6, R6.1–R6.5).
 *
 * These assert:
 *  - SetSummary shows rep count, total TUT, mean RELATIVE velocity, flagged count (R6.1)
 *  - VelocityChart marks the best rep and flagged reps (R6.2, R6.3)
 *  - clicking a flagged rep reaches its evidence in ONE interaction (R6.3)
 *  - lowConfidence hides all velocity figures and shows the low-confidence note (R6.4)
 *  - no `m/s` (absolute velocity units) anywhere (tech.md rule 2)
 *  - no grade/score/percentage/star/streak anywhere (R6.5)
 *  - exactly two actions, wired to onRepeat / onReturnToSetup (R1.6)
 *
 * Requirements: 1.6, 6.1, 6.2, 6.3, 6.4, 6.5
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { ReviewSurface, LOW_CONFIDENCE_NOTE } from './ReviewSurface.js';
import {
  SetSummary,
  totalTimeUnderTensionMs,
  meanConcentricVelocityRel,
  flaggedRepCount,
} from './SetSummary.js';
import { VelocityChart } from './VelocityChart.js';
import type {
  RepRecord,
  SetRecord,
  SessionContext,
} from '../types.js';

function rep(over: Partial<RepRecord>): RepRecord {
  return {
    index: 0,
    tUnderTensionMs: 1000,
    concentricVelocityRel: 1,
    faultCueIds: [],
    evidenceClipRef: null,
    ...over,
  };
}

function makeSet(over: Partial<SetRecord> = {}): SetRecord {
  return {
    exerciseId: 'opaque-id',
    startedAt: 0,
    lowConfidence: false,
    bestRepIndex: null,
    reps: [],
    ...over,
  };
}

/** A three-rep set: rep 2 is flagged with an evidence clip; rep 1 is best. */
function threeRepSet(): SetRecord {
  return makeSet({
    bestRepIndex: 0,
    reps: [
      rep({ index: 1, tUnderTensionMs: 1200, concentricVelocityRel: 1.2 }),
      rep({
        index: 2,
        tUnderTensionMs: 900,
        concentricVelocityRel: 0.7,
        faultCueIds: ['cue-a'],
        evidenceClipRef: 'clip-2',
      }),
      rep({ index: 3, tUnderTensionMs: 800, concentricVelocityRel: 0.6 }),
    ],
  });
}

function mountReview(
  set: SetRecord | null,
  handlers: {
    onRepeat?: () => void;
    onReturnToSetup?: () => void;
    onEvidence?: (ref: string) => void;
  } = {},
): { host: HTMLElement; surface: ReviewSurface } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const surface = new ReviewSurface({
    onRepeat: handlers.onRepeat ?? ((): void => {}),
    onReturnToSetup: handlers.onReturnToSetup ?? ((): void => {}),
    ...(handlers.onEvidence ? { onEvidence: handlers.onEvidence } : {}),
  });
  const ctx: SessionContext = {
    state: 'REVIEW',
    exerciseId: set?.exerciseId ?? null,
    framingValid: false,
    set,
  };
  surface.mount(host, ctx);
  return { host, surface };
}

// Words that must never appear in review output.
const BANNED = ['m/s', 'mps', 'grade', 'score', 'percentage', 'star', 'streak'];

function assertNoBannedText(el: HTMLElement): void {
  const text = (el.textContent ?? '').toLowerCase();
  for (const word of BANNED) {
    expect(text, `banned token "${word}" appeared`).not.toContain(word);
  }
  // No literal "%" character either (percentage, R6.5).
  expect(text).not.toContain('%');
}

describe('SetSummary aggregation (R6.1)', () => {
  it('sums time under tension across reps', () => {
    expect(totalTimeUnderTensionMs(threeRepSet())).toBe(1200 + 900 + 800);
  });

  it('means only reps with a computed relative velocity', () => {
    const set = makeSet({
      reps: [
        rep({ concentricVelocityRel: 1 }),
        rep({ concentricVelocityRel: null }),
        rep({ concentricVelocityRel: 2 }),
      ],
    });
    expect(meanConcentricVelocityRel(set)).toBeCloseTo(1.5);
  });

  it('returns null mean when no rep has a value', () => {
    const set = makeSet({ reps: [rep({ concentricVelocityRel: null })] });
    expect(meanConcentricVelocityRel(set)).toBeNull();
  });

  it('counts flagged reps by non-empty fault cue ids', () => {
    expect(flaggedRepCount(threeRepSet())).toBe(1);
  });
});

describe('SetSummary rendering (R6.1)', () => {
  it('shows rep count, TUT, relative mean velocity, and flagged count', () => {
    const host = document.createElement('div');
    const summary = new SetSummary(threeRepSet());
    summary.mount(host);

    expect(host.querySelector('.set-summary__reps__value')?.textContent).toBe('3');
    expect(host.querySelector('.set-summary__tut__value')?.textContent).toBe('2.9s');
    // mean of 1.2, 0.7, 0.6 = 0.8333 -> "0.83", UNITLESS (no m/s).
    expect(host.querySelector('.set-summary__velocity__value')?.textContent).toBe('0.83');
    expect(host.querySelector('.set-summary__flagged__value')?.textContent).toBe('1');
    assertNoBannedText(host);
  });
});

describe('VelocityChart marks (R6.2, R6.3)', () => {
  it('marks the best rep and the flagged rep', () => {
    const host = document.createElement('div');
    const chart = new VelocityChart(threeRepSet());
    chart.mount(host);

    const best = host.querySelectorAll('.velocity-chart__bar--best');
    expect(best.length).toBe(1);
    expect((best[0] as SVGElement).dataset['repIndex']).toBe('1');

    const flagged = host.querySelectorAll('.velocity-chart__bar--flagged');
    expect(flagged.length).toBe(1);
    expect((flagged[0] as SVGElement).dataset['repIndex']).toBe('2');
  });

  it('reaches evidence in ONE interaction: click on flagged bar fires callback', () => {
    const onEvidence = vi.fn();
    const host = document.createElement('div');
    const chart = new VelocityChart(threeRepSet(), { onEvidence });
    chart.mount(host);

    const flagged = host.querySelector(
      '.velocity-chart__bar--flagged',
    ) as SVGElement;
    flagged.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onEvidence).toHaveBeenCalledTimes(1);
    expect(onEvidence).toHaveBeenCalledWith('clip-2');
  });

  it('renders an empty slot (not a zero bar) for reps without velocity', () => {
    const set = makeSet({
      reps: [rep({ index: 1, concentricVelocityRel: null })],
    });
    const host = document.createElement('div');
    new VelocityChart(set).mount(host);
    const empty = host.querySelectorAll('.velocity-chart__bar--empty');
    expect(empty.length).toBe(1);
  });
});

describe('ReviewSurface low confidence (R6.4)', () => {
  it('shows the low-confidence note and suppresses all velocity figures', () => {
    const set = threeRepSet();
    const { host } = mountReview(makeSet({ ...set, lowConfidence: true }));

    expect(host.textContent).toContain(LOW_CONFIDENCE_NOTE);
    // No velocity summary row.
    expect(host.querySelector('.set-summary__velocity')).toBeNull();
    // No chart at all.
    expect(host.querySelector('.velocity-chart')).toBeNull();
    // But rep count / TUT / flagged still present.
    expect(host.querySelector('.set-summary__reps__value')?.textContent).toBe('3');
  });

  it('shows velocity figures when confidence is fine', () => {
    const { host } = mountReview(threeRepSet());
    expect(host.querySelector('.set-summary__velocity')).not.toBeNull();
    expect(host.querySelector('.velocity-chart')).not.toBeNull();
  });
});

describe('ReviewSurface actions (R1.6)', () => {
  it('exposes exactly two actions wired to the callbacks', () => {
    const onRepeat = vi.fn();
    const onReturnToSetup = vi.fn();
    const { host } = mountReview(threeRepSet(), { onRepeat, onReturnToSetup });

    const actions = host.querySelectorAll('.review-surface__action');
    expect(actions.length).toBe(2);

    (host.querySelector('.review-surface__action--repeat') as HTMLButtonElement).click();
    (host.querySelector('.review-surface__action--setup') as HTMLButtonElement).click();

    expect(onRepeat).toHaveBeenCalledTimes(1);
    expect(onReturnToSetup).toHaveBeenCalledTimes(1);
  });
});

describe('ReviewSurface safety (R6.5, tech.md rule 2)', () => {
  it('contains no m/s units and no grade/score/percentage/star/streak', () => {
    const { host } = mountReview(threeRepSet());
    assertNoBannedText(host);
  });

  it('contains no banned text even on the low-confidence path', () => {
    const { host } = mountReview(makeSet({ ...threeRepSet(), lowConfidence: true }));
    assertNoBannedText(host);
  });

  it('unmount removes the surface DOM', () => {
    const { host, surface } = mountReview(threeRepSet());
    expect(host.querySelector('.review-surface')).not.toBeNull();
    surface.unmount();
    expect(host.querySelector('.review-surface')).toBeNull();
  });
});
