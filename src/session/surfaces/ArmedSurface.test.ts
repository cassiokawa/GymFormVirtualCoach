/**
 * Unit tests for ArmedSurface — the ARMED-state 5-second audible countdown
 * (R2.3, R4.6).
 *
 * These assert:
 *  - mounting starts a 5-second countdown that ticks each second, calling
 *    AudioBus.countdownTick() exactly 5 times (R4.6)
 *  - after the fifth tick the countdown elapses and onElapsed fires once
 *  - the countdown digit renders 5 → 1 as it counts down (R2.3 legibility)
 *  - cancel() before elapse stops the timer, fires onCancel, and onElapsed
 *    never fires
 *  - unmount() before elapse clears the pending timer so onElapsed never fires
 *    after teardown, and does NOT fire onCancel
 *  - the surface is a transparent overlay that does not intercept pointer
 *    events (composited above the full-bleed camera, R2.3)
 *
 * Requirements: 2.3, 4.6
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  ArmedSurface,
  COUNTDOWN_SECONDS,
  COUNTDOWN_TICK_MS,
  COUNTDOWN_DIGIT_VH,
  type ArmedSurfaceOptions,
} from './ArmedSurface.js';
import type { SessionContext } from '../types';

const ARMED_CTX: SessionContext = {
  state: 'ARMED',
  exerciseId: 'opaque-id',
  framingValid: true,
  set: null,
};

interface Harness {
  host: HTMLElement;
  surface: ArmedSurface;
  ticks: () => number;
  elapsed: () => number;
  cancelled: () => number;
}

function mountSurface(
  overrides: Partial<ArmedSurfaceOptions> = {},
): Harness {
  const host = document.createElement('div');
  document.body.appendChild(host);

  let tickCount = 0;
  let elapsedCount = 0;
  let cancelledCount = 0;

  const surface = new ArmedSurface({
    audio: { countdownTick: () => void (tickCount += 1) },
    onElapsed: () => void (elapsedCount += 1),
    onCancel: () => void (cancelledCount += 1),
    ...overrides,
  });
  surface.mount(host, ARMED_CTX);

  return {
    host,
    surface,
    ticks: () => tickCount,
    elapsed: () => elapsedCount,
    cancelled: () => cancelledCount,
  };
}

describe('ArmedSurface', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('counts down for a default of 5 seconds', () => {
    expect(COUNTDOWN_SECONDS).toBe(5);
  });

  it('renders the starting digit on mount', () => {
    const { host } = mountSurface();
    const digit = host.querySelector('.armed-surface__count');
    expect(digit?.textContent).toBe('5');
  });

  it('ticks the audio once per second, 5 times total, then elapses once', () => {
    const h = mountSurface();

    // No tick before the first second elapses.
    expect(h.ticks()).toBe(0);
    expect(h.elapsed()).toBe(0);

    for (let i = 1; i <= COUNTDOWN_SECONDS; i += 1) {
      vi.advanceTimersByTime(COUNTDOWN_TICK_MS);
      expect(h.ticks()).toBe(i);
    }

    expect(h.ticks()).toBe(COUNTDOWN_SECONDS);
    expect(h.elapsed()).toBe(1);
    expect(h.surface.isRunning()).toBe(false);
    expect(h.surface.getRemaining()).toBe(0);
  });

  it('renders digits 5 -> 1 as it counts down', () => {
    const { host, surface } = mountSurface();
    const digit = host.querySelector('.armed-surface__count');

    const seen: string[] = [digit?.textContent ?? ''];
    for (let i = 0; i < COUNTDOWN_SECONDS - 1; i += 1) {
      vi.advanceTimersByTime(COUNTDOWN_TICK_MS);
      seen.push(digit?.textContent ?? '');
    }

    expect(seen).toEqual(['5', '4', '3', '2', '1']);
    expect(surface.getRemaining()).toBe(1);
  });

  it('does not fire onElapsed more than once even if timers over-advance', () => {
    const h = mountSurface();
    vi.advanceTimersByTime(COUNTDOWN_TICK_MS * (COUNTDOWN_SECONDS + 10));
    expect(h.elapsed()).toBe(1);
    expect(h.ticks()).toBe(COUNTDOWN_SECONDS);
  });

  it('cancel() before elapse fires onCancel and never fires onElapsed', () => {
    const h = mountSurface();

    vi.advanceTimersByTime(COUNTDOWN_TICK_MS * 2); // 2 ticks in
    expect(h.ticks()).toBe(2);

    h.surface.cancel();
    expect(h.cancelled()).toBe(1);
    expect(h.surface.isRunning()).toBe(false);

    // Let the clock run well past when the countdown would have elapsed.
    vi.advanceTimersByTime(COUNTDOWN_TICK_MS * COUNTDOWN_SECONDS);
    expect(h.elapsed()).toBe(0);
    expect(h.ticks()).toBe(2); // no further ticks after cancel
  });

  it('cancel() is idempotent and a no-op once stopped', () => {
    const h = mountSurface();
    h.surface.cancel();
    h.surface.cancel();
    expect(h.cancelled()).toBe(1);
  });

  it('unmount() before elapse clears timers so onElapsed never fires afterward', () => {
    const h = mountSurface();

    vi.advanceTimersByTime(COUNTDOWN_TICK_MS); // 1 tick in
    expect(h.ticks()).toBe(1);

    h.surface.unmount();
    expect(h.surface.isRunning()).toBe(false);

    vi.advanceTimersByTime(COUNTDOWN_TICK_MS * COUNTDOWN_SECONDS);
    expect(h.elapsed()).toBe(0);
    expect(h.ticks()).toBe(1); // no further ticks after unmount
  });

  it('unmount() does not fire onCancel', () => {
    const h = mountSurface();
    h.surface.unmount();
    expect(h.cancelled()).toBe(0);
  });

  it('unmount() detaches its DOM from the host', () => {
    const { host, surface } = mountSurface();
    expect(host.querySelector('.armed-surface')).not.toBeNull();
    surface.unmount();
    expect(host.querySelector('.armed-surface')).toBeNull();
  });

  it('is a transparent overlay that does not intercept pointer events (R2.3)', () => {
    const { host } = mountSurface();
    const root = host.querySelector<HTMLElement>('.armed-surface');
    expect(root).not.toBeNull();
    expect(root!.style.pointerEvents).toBe('none');
    expect(root!.style.background).toBe('transparent');
    expect(root!.style.position).toBe('absolute');
  });

  it('sizes the countdown digit in a viewport-relative unit for 3 m legibility (R2.3)', () => {
    const { host } = mountSurface();
    const digit = host.querySelector<HTMLElement>('.armed-surface__count');
    expect(digit!.style.fontSize).toBe(`${COUNTDOWN_DIGIT_VH}vh`);
  });

  it('honours a custom countdown length via the seconds option', () => {
    const h = mountSurface({ seconds: 3 });
    const digit = h.host.querySelector('.armed-surface__count');
    expect(digit?.textContent).toBe('3');

    vi.advanceTimersByTime(COUNTDOWN_TICK_MS * 3);
    expect(h.ticks()).toBe(3);
    expect(h.elapsed()).toBe(1);
  });

  it('supports an injected timer seam instead of the platform timer', () => {
    let scheduled: (() => void) | null = null;
    let cleared = 0;
    const timer = {
      set: (fn: () => void): unknown => {
        scheduled = fn;
        return Symbol('handle');
      },
      clear: (): void => void (cleared += 1),
    };

    let ticks = 0;
    let elapsed = 0;
    const surface = new ArmedSurface({
      audio: { countdownTick: () => void (ticks += 1) },
      onElapsed: () => void (elapsed += 1),
      seconds: 2,
      timer,
    });
    const host = document.createElement('div');
    surface.mount(host, ARMED_CTX);

    // Drive the injected timer manually.
    expect(scheduled).not.toBeNull();
    scheduled!(); // second 1
    expect(ticks).toBe(1);
    scheduled!(); // second 2 -> elapse
    expect(ticks).toBe(2);
    expect(elapsed).toBe(1);

    // Cancelling after elapse is a no-op (already stopped), clears nothing new.
    surface.unmount();
    expect(cleared).toBe(0);
  });
});
