/**
 * Unit tests for SetupSurface — the SETUP-state surface (R1.3, R2.3, R4.1,
 * R4.5, R5.5, R7.5).
 *
 * These assert:
 *  - the surface mounts the camera preview, the exercise grid, and a SINGLE
 *    primary Start action (R1.3), with the camera composited under the overlay
 *    (R2.3);
 *  - Start is disabled while the verdict is not ok and enabled when ok (R1.3,
 *    R4.5);
 *  - the readiness tone fires EXACTLY ONCE on the not-ok → ok edge, not
 *    repeatedly while ok, and re-arms after dropping back to not-ok (R4.5);
 *  - selecting an exercise shows its required camera angle (R7.5), from data;
 *  - missing-landmark / angle / distance guidance text renders from the verdict
 *    (R4.2–R4.4) in camera terms, not model terms (R5.5);
 *  - onStart fires when Start is clicked while ok, and not while disabled.
 *
 * Requirements: 1.3, 2.3, 4.1, 4.5, 5.5, 7.5
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import type { ExerciseSpecMeta, FramingVerdict, SessionContext } from '../types.js';
import { SetupSurface, type ReadinessAudio } from './SetupSurface.js';

/** A SETUP-state context; the surface reads only lifecycle facts from it. */
const SETUP_CTX: SessionContext = {
  state: 'SETUP',
  exerciseId: null,
  framingValid: false,
  set: null,
};

/**
 * A data-only exercise fixture. Ids/names/aliases are literals confined to the
 * TEST fixture, never to `src` code under test.
 */
const EXERCISE_A: ExerciseSpecMeta = {
  id: 'fixture_movement_a',
  version: '1.0.0',
  displayName: 'Fixture Movement A',
  aliases: ['fixture-a'],
  facets: { equipment: 'none', primaryMuscles: ['quads'], position: 'standing' },
  mode: 'reps',
  bilateral: true,
  camera: { preferredAngleDeg: 90, toleranceDeg: 20, view: 'side' },
  requiredLandmarks: [23, 24, 25, 26, 27, 28],
};

/** Build a verdict with sensible ok defaults, overridable per test. */
function verdict(overrides: Partial<FramingVerdict> = {}): FramingVerdict {
  return {
    ok: true,
    missingLandmarks: [],
    angleCorrection: null,
    distance: 'ok',
    distanceHintMetres: null,
    ...overrides,
  };
}

interface Harness {
  host: HTMLElement;
  surface: SetupSurface;
  root: HTMLElement;
  audio: ReadinessAudio & { readinessTone: ReturnType<typeof vi.fn> };
  onStart: ReturnType<typeof vi.fn>;
}

function mountSurface(
  opts: Partial<
    Pick<ConstructorParameters<typeof SetupSurface>[0], 'exercises' | 'history'>
  > = {},
): Harness {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const audio = { readinessTone: vi.fn() };
  const onStart = vi.fn();
  const surface = new SetupSurface({
    audio,
    onStart,
    exercises: opts.exercises ?? [EXERCISE_A],
    ...(opts.history ? { history: opts.history } : {}),
  });
  surface.mount(host, SETUP_CTX);
  const root = host.querySelector('.setup-surface') as HTMLElement;
  return { host, surface, root, audio, onStart };
}

describe('SetupSurface composition (R1.3, R2.3)', () => {
  it('mounts a camera preview, an exercise grid, and a single Start action', () => {
    const { root } = mountSurface();

    expect(root.querySelectorAll('.setup-surface__camera')).toHaveLength(1);
    expect(root.querySelectorAll('.exercise-grid')).toHaveLength(1);

    // Exactly ONE primary action (R1.3): a single Start button.
    const buttons = Array.from(root.querySelectorAll('button.setup-surface__start'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe('Start');
  });

  it('composites the camera under the overlay (R2.3)', () => {
    const { root } = mountSurface();
    const camera = root.querySelector('.setup-surface__camera') as HTMLElement;
    const overlay = root.querySelector('.setup-surface__overlay') as HTMLElement;
    expect(Number(camera.style.zIndex)).toBeLessThan(Number(overlay.style.zIndex));
  });

  it('mounts and unmounts cleanly, removing the grid', () => {
    const { host, surface } = mountSurface();
    expect(host.querySelector('.setup-surface')).not.toBeNull();
    expect(host.querySelector('.exercise-grid')).not.toBeNull();
    surface.unmount();
    expect(host.querySelector('.setup-surface')).toBeNull();
    expect(host.querySelector('.exercise-grid')).toBeNull();
  });
});

describe('SetupSurface Start gating (R1.3, R4.5)', () => {
  it('starts disabled before any verdict arrives', () => {
    const { root } = mountSurface();
    const start = root.querySelector('.setup-surface__start') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
  });

  it('disables Start when the verdict is not ok', () => {
    const { root, surface } = mountSurface();
    const start = root.querySelector('.setup-surface__start') as HTMLButtonElement;
    surface.updateFraming(verdict({ ok: false, distance: 'too_far', distanceHintMetres: 1.2 }));
    expect(start.disabled).toBe(true);
    expect(surface.isStartEnabled()).toBe(false);
  });

  it('enables Start when the verdict is ok', () => {
    const { root, surface } = mountSurface();
    const start = root.querySelector('.setup-surface__start') as HTMLButtonElement;
    surface.updateFraming(verdict({ ok: true }));
    expect(start.disabled).toBe(false);
    expect(surface.isStartEnabled()).toBe(true);
  });
});

describe('SetupSurface readiness tone edge (R4.5)', () => {
  it('fires the readiness tone once on the not-ok → ok edge', () => {
    const { surface, audio } = mountSurface();
    surface.updateFraming(verdict({ ok: false, distance: 'too_far', distanceHintMetres: 1 }));
    expect(audio.readinessTone).not.toHaveBeenCalled();

    surface.updateFraming(verdict({ ok: true }));
    expect(audio.readinessTone).toHaveBeenCalledTimes(1);
  });

  it('does not re-fire the tone while framing stays ok', () => {
    const { surface, audio } = mountSurface();
    surface.updateFraming(verdict({ ok: true }));
    surface.updateFraming(verdict({ ok: true }));
    surface.updateFraming(verdict({ ok: true }));
    expect(audio.readinessTone).toHaveBeenCalledTimes(1);
  });

  it('re-arms and fires again after framing drops back to not-ok', () => {
    const { surface, audio } = mountSurface();
    surface.updateFraming(verdict({ ok: true }));
    expect(audio.readinessTone).toHaveBeenCalledTimes(1);

    surface.updateFraming(verdict({ ok: false, distance: 'too_close', distanceHintMetres: 0.4 }));
    surface.updateFraming(verdict({ ok: true }));
    expect(audio.readinessTone).toHaveBeenCalledTimes(2);
  });
});

describe('SetupSurface required camera angle on selection (R7.5)', () => {
  it('reveals the exercise required camera angle from data when selected', () => {
    const { root } = mountSurface();
    const angle = root.querySelector('.setup-surface__angle') as HTMLElement;
    // Hidden until a selection is made.
    expect(angle.hidden).toBe(true);

    // Click the exercise card in the grid.
    const card = root.querySelector('.exercise-grid__card') as HTMLButtonElement;
    card.click();

    expect(angle.hidden).toBe(false);
    const text = angle.textContent ?? '';
    expect(text).toContain('90');
    expect(text).toContain('20');
    expect(text).toContain('side');
  });

  it('records the selected opaque exercise id', () => {
    const { root, surface } = mountSurface();
    const card = root.querySelector('.exercise-grid__card') as HTMLButtonElement;
    card.click();
    expect(surface.getSelectedExerciseId()).toBe(EXERCISE_A.id);
  });
});

describe('SetupSurface framing guidance text (R4.2–R4.4, R5.5)', () => {
  it('names missing body parts in plain language (R4.2)', () => {
    const { root, surface } = mountSurface();
    const guidance = root.querySelector('.setup-surface__guidance') as HTMLElement;
    surface.updateFraming(
      verdict({ ok: false, missingLandmarks: ['left knee', 'right ankle'] }),
    );
    const text = guidance.textContent ?? '';
    expect(text).toContain('left knee');
    expect(text).toContain('right ankle');
  });

  it('states the angle-correction direction (R4.3)', () => {
    const { root, surface } = mountSurface();
    const guidance = root.querySelector('.setup-surface__guidance') as HTMLElement;
    surface.updateFraming(
      verdict({ ok: false, angleCorrection: { direction: 'left', degrees: 18 } }),
    );
    const text = (guidance.textContent ?? '').toLowerCase();
    expect(text).toContain('left');
  });

  it('instructs move closer / further in approximate metres (R4.4)', () => {
    const { root, surface } = mountSurface();
    const guidance = root.querySelector('.setup-surface__guidance') as HTMLElement;

    surface.updateFraming(verdict({ ok: false, distance: 'too_far', distanceHintMetres: 1.3 }));
    let text = (guidance.textContent ?? '').toLowerCase();
    expect(text).toContain('closer');
    expect(text).toContain('1.3');

    surface.updateFraming(verdict({ ok: false, distance: 'too_close', distanceHintMetres: 0.5 }));
    text = (guidance.textContent ?? '').toLowerCase();
    expect(text).toContain('further');
    expect(text).toContain('0.5');
  });

  it('communicates readiness in camera terms, never model terms (R5.5)', () => {
    const { root, surface } = mountSurface();
    const guidance = root.querySelector('.setup-surface__guidance') as HTMLElement;
    surface.updateFraming(verdict({ ok: true }));

    const text = (guidance.textContent ?? '').toLowerCase();
    expect(text).toContain('ready');
    for (const modelTerm of ['model', 'inference', 'tensor', 'onnx', 'mediapipe', 'movenet']) {
      expect(text).not.toContain(modelTerm);
    }
  });
});

describe('SetupSurface Start action (R1.3, R4.5)', () => {
  it('fires onStart when Start is clicked while framing is ok', () => {
    const { root, surface, onStart } = mountSurface();
    surface.updateFraming(verdict({ ok: true }));
    const start = root.querySelector('.setup-surface__start') as HTMLButtonElement;
    start.click();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('does not fire onStart while Start is disabled (framing not ok)', () => {
    const { root, surface, onStart } = mountSurface();
    surface.updateFraming(verdict({ ok: false, distance: 'too_far', distanceHintMetres: 1 }));
    const start = root.querySelector('.setup-surface__start') as HTMLButtonElement;
    start.click();
    expect(onStart).not.toHaveBeenCalled();
  });
});
