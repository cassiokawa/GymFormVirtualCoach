/**
 * Unit tests for PhaseArc — the continuous-arc phase indicator (R2.4, R2.5, R2.6).
 *
 * The arc sweep is a pure function of normalised signal position between the
 * ROM floor (0) and top (1). These assert:
 *  - the 0 / 0.5 / 1 mapping is monotonic and lands on the expected geometry
 *  - the floor renders an empty arc; the top renders a swept arc (R2.4)
 *  - there is NO text phase label (R2.4)
 *  - the arc is sized with viewport-relative units (R2.5)
 *  - mirrored mode applies scaleX(-1) (R2.6)
 *
 * Requirements: 2.4, 2.5, 2.6
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { PhaseArc, arcPath, sweepEndAngleDeg } from './PhaseArc.js';

describe('PhaseArc sweep geometry (R2.4)', () => {
  it('maps floor (0) to an empty arc and top (1) to a drawn arc', () => {
    expect(arcPath(0)).toBe('');
    expect(arcPath(1)).not.toBe('');
    expect(arcPath(1).startsWith('M')).toBe(true);
  });

  it('end angle is monotonically increasing in signalNorm', () => {
    const a0 = sweepEndAngleDeg(0);
    const aHalf = sweepEndAngleDeg(0.5);
    const a1 = sweepEndAngleDeg(1);
    expect(aHalf).toBeGreaterThan(a0);
    expect(a1).toBeGreaterThan(aHalf);
  });

  it('half sweep is exactly the midpoint angle between floor and top', () => {
    const a0 = sweepEndAngleDeg(0);
    const aHalf = sweepEndAngleDeg(0.5);
    const a1 = sweepEndAngleDeg(1);
    expect(aHalf).toBeCloseTo((a0 + a1) / 2, 6);
  });

  it('uses the small-arc flag below 180° sweep and the large-arc flag above it', () => {
    // 0.5 of a 270° gauge = 135° (< 180) -> largeArc 0.
    expect(arcPath(0.5)).toContain(' 0 1 ');
    // 1.0 of a 270° gauge = 270° (> 180) -> largeArc 1.
    expect(arcPath(1)).toContain(' 1 1 ');
  });

  it('clamps out-of-range and non-finite input (silence when uncertain)', () => {
    expect(arcPath(-1)).toBe('');
    expect(arcPath(Number.NaN)).toBe('');
    expect(sweepEndAngleDeg(5)).toBe(sweepEndAngleDeg(1));
    expect(sweepEndAngleDeg(Number.NaN)).toBe(sweepEndAngleDeg(0));
  });
});

describe('PhaseArc rendering (R2.4, R2.5, R2.6)', () => {
  function mountArc(mirrored = false): { host: HTMLElement; arc: PhaseArc } {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const arc = new PhaseArc({ mirrored });
    arc.mount(host);
    return { host, arc };
  }

  it('mounts an SVG and unmounts cleanly', () => {
    const { host, arc } = mountArc();
    expect(host.querySelector('svg')).not.toBeNull();
    arc.unmount();
    expect(host.querySelector('svg')).toBeNull();
  });

  it('renders NO text phase label (R2.4 forbids a text label)', () => {
    const { host, arc } = mountArc();
    arc.render(0.5);
    expect(host.textContent?.trim()).toBe('');
  });

  it('render/setProgress update the drawn arc and clamp to [0,1]', () => {
    const { host, arc } = mountArc();
    const path = host.querySelector('path:nth-of-type(2)') as SVGPathElement;

    arc.render(0);
    expect(path.getAttribute('d')).toBeNull(); // empty at floor
    expect(arc.getProgress()).toBe(0);

    arc.setProgress(0.5);
    expect(path.getAttribute('d')).not.toBeNull();

    arc.setProgress(2);
    expect(arc.getProgress()).toBe(1);
  });

  it('sizes the arc with viewport-relative units (R2.5)', () => {
    const { host } = mountArc();
    const svg = host.querySelector('svg') as SVGSVGElement;
    expect(svg.style.width).toContain('vmin');
    expect(svg.style.height).toContain('vmin');
  });

  it('applies scaleX(-1) in mirrored mode and clears it otherwise (R2.6)', () => {
    const { host, arc } = mountArc(true);
    const root = host.querySelector('.phase-arc') as HTMLElement;
    expect(root.style.transform).toBe('scaleX(-1)');
    expect(arc.isMirrored()).toBe(true);

    arc.setMirrored(false);
    expect(root.style.transform).toBe('');
    expect(arc.isMirrored()).toBe(false);
  });

  it('composites above the camera without intercepting touches (R2.3)', () => {
    const { host } = mountArc();
    const root = host.querySelector('.phase-arc') as HTMLElement;
    expect(root.style.position).toBe('absolute');
    expect(root.style.pointerEvents).toBe('none');
  });
});
