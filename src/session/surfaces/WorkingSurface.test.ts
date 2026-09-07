/**
 * Unit tests for WorkingSurface — the WORKING-state three-child allowlist
 * (R1.4, R2.3, R5.1, R5.3, R5.5).
 *
 * These assert:
 *  - the surface mounts EXACTLY the three allowed children and nothing else
 *    (rep count, phase arc, one cue line) — R1.4, R5.3
 *  - setReps / setPhase / setCue update the right child, and setCue(null) clears
 *  - onStalled surfaces "not detecting movement" in the cue line, not a panel
 *    (R5.5)
 *  - no FPS / ms / latency / confidence / third-party library text appears
 *    anywhere on the surface (R5.1, R5.4)
 *  - the surface composites above the full-bleed camera without intercepting
 *    touches (R2.3)
 *  - mirrored mode passes through to both children (R2.6)
 *
 * Requirements: 1.4, 2.3, 5.1, 5.3, 5.5
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import type { SessionContext } from '../types.js';
import { WorkingSurface, STALL_MESSAGE, CUE_LINE_MIN_VH } from './WorkingSurface.js';

/** A WORKING-state context; the surface reads only the mirrored flag from it. */
const WORKING_CTX: SessionContext = {
  state: 'WORKING',
  exerciseId: 'opaque-id',
  framingValid: true,
  set: null,
};

function mountSurface(
  opts: ConstructorParameters<typeof WorkingSurface>[0] = {},
): { host: HTMLElement; surface: WorkingSurface; root: HTMLElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const surface = new WorkingSurface(opts);
  surface.mount(host, WORKING_CTX);
  const root = host.querySelector('.working-surface') as HTMLElement;
  return { host, surface, root };
}

describe('WorkingSurface three-child allowlist (R1.4, R5.3)', () => {
  it('mounts exactly the three allowed children — rep count, phase arc, cue line', () => {
    const { root } = mountSurface();

    expect(root.querySelectorAll('.rep-count-display')).toHaveLength(1);
    expect(root.querySelectorAll('.phase-arc')).toHaveLength(1);
    expect(root.querySelectorAll('.working-surface__cue')).toHaveLength(1);

    // Exactly three direct children of the surface root, nothing else.
    expect(root.children).toHaveLength(3);
  });

  it('exposes no panel, accordion, metric strip, or nav-duplicating control', () => {
    const { root } = mountSurface();
    const html = root.innerHTML.toLowerCase();

    for (const forbidden of [
      'panel',
      'accordion',
      'nav',
      'menu',
      'tablist',
      'metric',
      'settings',
      'history',
      'routine',
    ]) {
      expect(html, `unexpected "${forbidden}" on WORKING surface`).not.toContain(forbidden);
    }

    // No interactive controls belong on the WORKING surface (R1.4).
    expect(root.querySelectorAll('button, a, select, input')).toHaveLength(0);
  });

  it('offers no public slot to append a fourth child', () => {
    const surface = new WorkingSurface();
    const publicApi = surface as unknown as Record<string, unknown>;
    // The only mutators are the three typed setters + mirror; no append/add slot.
    expect(publicApi['append']).toBeUndefined();
    expect(publicApi['addPanel']).toBeUndefined();
    expect(publicApi['addChild']).toBeUndefined();
    expect(publicApi['children']).toBeUndefined();
  });
});

describe('WorkingSurface setters drive the right child', () => {
  it('setReps updates the rep-count child only', () => {
    const { root, surface } = mountSurface();
    const count = root.querySelector('.rep-count-display__count') as HTMLElement;

    expect(count.textContent).toBe('0');
    surface.setReps(9);
    expect(count.textContent).toBe('9');
  });

  it('setPhase drives the phase arc sweep (empty at floor, drawn above it)', () => {
    const { root, surface } = mountSurface();
    const progress = root.querySelectorAll('.phase-arc path')[1] as SVGPathElement;

    surface.setPhase(0);
    expect(progress.getAttribute('d')).toBeNull();

    surface.setPhase(0.5);
    expect(progress.getAttribute('d')).not.toBeNull();
  });

  it('setCue renders the cue text and setCue(null) clears the line', () => {
    const { root, surface } = mountSurface();
    const cue = root.querySelector('.working-surface__cue') as HTMLElement;

    expect(cue.textContent).toBe('');
    surface.setCue('knees out');
    expect(cue.textContent).toBe('knees out');
    surface.setCue(null);
    expect(cue.textContent).toBe('');
  });
});

describe('WorkingSurface stall message (R5.5)', () => {
  it('surfaces "not detecting movement" in the cue line, not a panel', () => {
    const { root, surface } = mountSurface();
    const cue = root.querySelector('.working-surface__cue') as HTMLElement;

    surface.onStalled();
    expect(cue.textContent).toBe(STALL_MESSAGE);
    expect(STALL_MESSAGE).toBe('not detecting movement');

    // Still exactly three children — the stall message reused the cue line.
    expect(root.children).toHaveLength(3);
  });

  it('phrases the stall in camera/movement terms, never model or library terms', () => {
    const { root, surface } = mountSurface();
    surface.onStalled();
    const text = (root.textContent ?? '').toLowerCase();
    for (const modelTerm of ['model', 'inference', 'tensor', 'onnx', 'mediapipe', 'movenet']) {
      expect(text).not.toContain(modelTerm);
    }
  });
});

describe('WorkingSurface has no developer telemetry (R5.1, R5.4)', () => {
  it('renders no FPS, ms timings, latency, confidence, or library names', () => {
    const { root, surface } = mountSurface();
    // Populate every surface with realistic values first.
    surface.setReps(12);
    surface.setPhase(0.7);
    surface.setCue('brace core');

    const text = (root.textContent ?? '').toLowerCase();
    const html = root.innerHTML.toLowerCase();

    // No developer telemetry vocabulary (R5.1).
    for (const term of ['fps', 'frames per second', 'latency', 'confidence', 'ms']) {
      expect(text, `telemetry term "${term}" leaked`).not.toContain(term);
    }
    // No unit-suffixed millisecond readouts like "120ms" (R5.1).
    expect(text).not.toMatch(/\d+\s*ms\b/);
    expect(text).not.toMatch(/\d+\s*fps\b/);

    // No third-party library names in user-facing copy (R5.4).
    for (const lib of ['mediapipe', 'movenet', 'onnx', 'tensorflow', 'tfjs', 'webgl']) {
      expect(text, `library name "${lib}" leaked`).not.toContain(lib);
      expect(html, `library name "${lib}" leaked in markup`).not.toContain(lib);
    }
  });
});

describe('WorkingSurface composite + mirror + lifecycle (R2.3, R2.6)', () => {
  it('composites above the full-bleed camera without intercepting touches (R2.3)', () => {
    const { root } = mountSurface();
    expect(root.style.position).toBe('absolute');
    expect(root.style.inset).toBe('0px');
    expect(root.style.pointerEvents).toBe('none');
  });

  it('the cue line honours the ≥5vh legibility floor (R2.2)', () => {
    const { root } = mountSurface({ cueVh: 1 });
    const cue = root.querySelector('.working-surface__cue') as HTMLElement;
    const match = /^([\d.]+)vh$/.exec(cue.style.fontSize);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(CUE_LINE_MIN_VH);
  });

  it('passes mirrored mode through to both children (R2.6)', () => {
    const { root, surface } = mountSurface({ mirrored: true });
    const repRoot = root.querySelector('.rep-count-display') as HTMLElement;
    const arcRoot = root.querySelector('.phase-arc') as HTMLElement;
    expect(repRoot.style.transform).toBe('scaleX(-1)');
    expect(arcRoot.style.transform).toBe('scaleX(-1)');
    expect(surface.isMirrored()).toBe(true);

    surface.setMirrored(false);
    expect(repRoot.style.transform).toBe('');
    expect(arcRoot.style.transform).toBe('');
  });

  it('mounts and unmounts cleanly, removing all three children', () => {
    const { host, surface } = mountSurface();
    expect(host.querySelector('.working-surface')).not.toBeNull();
    surface.unmount();
    expect(host.querySelector('.working-surface')).toBeNull();
    expect(host.querySelector('.rep-count-display')).toBeNull();
    expect(host.querySelector('.phase-arc')).toBeNull();
  });
});
