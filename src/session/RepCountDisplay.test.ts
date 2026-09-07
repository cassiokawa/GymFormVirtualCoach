/**
 * Unit tests for RepCountDisplay — the distance-legible rep counter
 * (R2.1, R2.2, R2.5, R2.6).
 *
 * These assert:
 *  - the rep count font size encodes the ≥25% viewport-height rule (R2.1)
 *  - the size is expressed in a viewport-relative unit (R2.5)
 *  - any secondary-text floor is ≥5% viewport height (R2.2)
 *  - setCount updates the rendered integer and coerces bad input
 *  - the count is a bare integer with no grade/score/streak (coaching-safety)
 *  - mirrored mode applies scaleX(-1) (R2.6)
 *
 * Requirements: 2.1, 2.2, 2.5, 2.6
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  RepCountDisplay,
  REP_COUNT_MIN_VH,
  MIN_TEXT_VH,
} from './RepCountDisplay.js';

function mountDisplay(
  opts: ConstructorParameters<typeof RepCountDisplay>[0] = {},
): { host: HTMLElement; display: RepCountDisplay } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const display = new RepCountDisplay(opts);
  display.mount(host);
  return { host, display };
}

/** Parse the numeric part of a `<n>vh` font size. */
function vhOf(fontSize: string): number {
  const match = /^([\d.]+)vh$/.exec(fontSize);
  expect(match, `expected a vh font size, got "${fontSize}"`).not.toBeNull();
  return Number(match![1]);
}

describe('RepCountDisplay legibility (R2.1, R2.2, R2.5)', () => {
  it('the ≥25% rule is encoded as the min-vh constant (R2.1/R2.2)', () => {
    expect(REP_COUNT_MIN_VH).toBeGreaterThanOrEqual(25);
    expect(MIN_TEXT_VH).toBeGreaterThanOrEqual(5);
  });

  it('renders the count at a viewport-relative font size ≥ 25vh (R2.1, R2.5)', () => {
    const { host } = mountDisplay();
    const count = host.querySelector('.rep-count-display__count') as HTMLElement;
    expect(count.style.fontSize.endsWith('vh')).toBe(true);
    expect(vhOf(count.style.fontSize)).toBeGreaterThanOrEqual(25);
  });

  it('raises a below-minimum requested size up to 25vh (R2.1)', () => {
    const { host, display } = mountDisplay({ countVh: 10 });
    const count = host.querySelector('.rep-count-display__count') as HTMLElement;
    expect(display.getCountVh()).toBe(REP_COUNT_MIN_VH);
    expect(vhOf(count.style.fontSize)).toBeGreaterThanOrEqual(25);
  });

  it('honours a larger requested size (still ≥ 25vh)', () => {
    const { display } = mountDisplay({ countVh: 40 });
    expect(display.getCountVh()).toBe(40);
  });
});

describe('RepCountDisplay setCount (R2.1, coaching-safety)', () => {
  it('renders the initial count as zero', () => {
    const { host } = mountDisplay();
    const count = host.querySelector('.rep-count-display__count') as HTMLElement;
    expect(count.textContent).toBe('0');
  });

  it('updates the rendered integer on setCount', () => {
    const { host, display } = mountDisplay();
    const count = host.querySelector('.rep-count-display__count') as HTMLElement;
    display.setCount(7);
    expect(count.textContent).toBe('7');
    expect(display.getCount()).toBe(7);
  });

  it('coerces negative, non-finite, and fractional input to a whole count', () => {
    const { host, display } = mountDisplay();
    const count = host.querySelector('.rep-count-display__count') as HTMLElement;

    display.setCount(-3);
    expect(count.textContent).toBe('0');

    display.setCount(Number.NaN);
    expect(count.textContent).toBe('0');

    display.setCount(5.9);
    expect(count.textContent).toBe('5');
  });

  it('renders a bare integer only — no percentage, star, or streak', () => {
    const { host, display } = mountDisplay();
    display.setCount(12);
    const text = host.textContent ?? '';
    expect(text).toBe('12');
    expect(text).not.toMatch(/[%★*]|streak|score|grade/i);
  });
});

describe('RepCountDisplay mirrored mode + lifecycle (R2.6, R2.3)', () => {
  it('applies scaleX(-1) when mirrored and clears it otherwise (R2.6)', () => {
    const { host, display } = mountDisplay({ mirrored: true });
    const root = host.querySelector('.rep-count-display') as HTMLElement;
    expect(root.style.transform).toBe('scaleX(-1)');
    expect(display.isMirrored()).toBe(true);

    display.setMirrored(false);
    expect(root.style.transform).toBe('');
    expect(display.isMirrored()).toBe(false);
  });

  it('composites above the camera without intercepting touches (R2.3)', () => {
    const { host } = mountDisplay();
    const root = host.querySelector('.rep-count-display') as HTMLElement;
    expect(root.style.position).toBe('absolute');
    expect(root.style.pointerEvents).toBe('none');
  });

  it('mounts and unmounts cleanly', () => {
    const { host, display } = mountDisplay();
    expect(host.querySelector('.rep-count-display')).not.toBeNull();
    display.unmount();
    expect(host.querySelector('.rep-count-display')).toBeNull();
  });
});
