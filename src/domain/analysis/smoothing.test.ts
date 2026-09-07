import { describe, it, expect } from 'vitest';
import {
  OneEuroFilter,
  DSignalTracker,
  createSmoothingFilter,
  UnknownSmoothingFilterError,
  DEFAULT_SMOOTHING_TYPE,
} from './smoothing';
import { UNAVAILABLE } from './types';

// ---------------------------------------------------------------------------
// One Euro filter
// ---------------------------------------------------------------------------

describe('OneEuroFilter', () => {
  it('returns the first sample unchanged (no previous state)', () => {
    const f = new OneEuroFilter(1, 0.1);
    expect(f.filter(5, 0)).toBe(5);
  });

  it('smooths a noisy step toward the true level and converges', () => {
    const f = new OneEuroFilter(1, 0.05);
    const trueLevel = 100;
    // Deterministic pseudo-noise around the step so the test is stable.
    const noise = [3, -4, 5, -2, 4, -3, 2, -5, 3, -1, 4, -2, 1, -3, 2, -1, 3, -2, 1, -1];
    let t = 0;
    let last = 0;
    const errors: number[] = [];
    for (const n of noise) {
      last = f.filter(trueLevel + n, t);
      errors.push(Math.abs(last - trueLevel));
      t += 33; // ~30 fps
    }
    // The filtered output is far closer to the true level than the raw noise
    // amplitude near the end, and the very last errors are small.
    const tailError = errors.slice(-4).reduce((a, b) => a + b, 0) / 4;
    expect(tailError).toBeLessThan(3);
    // Filtered output stays within the noise band (never overshoots wildly).
    expect(Math.abs(last - trueLevel)).toBeLessThan(5);
  });

  it('output variance is lower than the raw input variance for a noisy constant', () => {
    const f = new OneEuroFilter(1, 0.01);
    const base = 50;
    const raw = [2, -3, 4, -2, 3, -4, 2, -1, 3, -2, 1, -3, 2, -1, 2, -2].map((n) => base + n);
    const out: number[] = [];
    let t = 0;
    for (const v of raw) {
      out.push(f.filter(v, t));
      t += 33;
    }
    const variance = (xs: number[]): number => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
    };
    // Compare the settled tail (skip the first sample which is passed through).
    expect(variance(out.slice(4))).toBeLessThan(variance(raw.slice(4)));
  });

  it('tracks a fast ramp with bounded lag (adaptive cutoff opens up)', () => {
    const f = new OneEuroFilter(1, 0.7);
    let t = 0;
    let out = 0;
    for (let i = 0; i <= 20; i++) {
      out = f.filter(i * 10, t); // steep ramp
      t += 33;
    }
    // With a high beta the filter keeps up with the ramp; final output is close
    // to the final true value (200).
    expect(out).toBeGreaterThan(180);
    expect(out).toBeLessThanOrEqual(200);
  });

  it('never produces NaN on duplicate / out-of-order timestamps', () => {
    const f = new OneEuroFilter(1, 0.1);
    expect(f.filter(10, 100)).toBe(10);
    const a = f.filter(12, 100); // duplicate timestamp
    const b = f.filter(11, 90); // out-of-order timestamp
    expect(Number.isNaN(a)).toBe(false);
    expect(Number.isNaN(b)).toBe(false);
  });

  it('reset clears state so the next sample is treated as the first', () => {
    const f = new OneEuroFilter(1, 0.1);
    f.filter(5, 0);
    f.filter(9, 33);
    f.reset();
    expect(f.filter(42, 66)).toBe(42);
  });

  it('rejects invalid parameters', () => {
    expect(() => new OneEuroFilter(0, 0.1)).toThrow(RangeError);
    expect(() => new OneEuroFilter(-1, 0.1)).toThrow(RangeError);
    expect(() => new OneEuroFilter(1, -0.1)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// dSignal tracker
// ---------------------------------------------------------------------------

describe('DSignalTracker', () => {
  it('is UNAVAILABLE with fewer than two samples', () => {
    const d = new DSignalTracker();
    expect(d.compute()).toBe(UNAVAILABLE);
    expect(d.push(10, 0)).toBe(UNAVAILABLE);
  });

  it('is positive on a rising ramp', () => {
    const d = new DSignalTracker();
    d.push(0, 0);
    const r = d.push(10, 100); // +10 over 100 ms => +0.1 /ms
    expect(r).not.toBe(UNAVAILABLE);
    expect(r as number).toBeCloseTo(0.1, 6);
  });

  it('is negative on a falling ramp (matches dSignal < -velocityThreshold)', () => {
    const d = new DSignalTracker();
    d.push(100, 0);
    d.push(80, 100);
    const r = d.push(60, 200); // -40 over 200 ms => -0.2 /ms across the 3-frame window
    expect(r).not.toBe(UNAVAILABLE);
    expect(r as number).toBeCloseTo(-0.2, 6);
  });

  it('is zero on a flat signal', () => {
    const d = new DSignalTracker();
    d.push(50, 0);
    d.push(50, 100);
    const r = d.push(50, 200);
    expect(r).toBe(0);
  });

  it('measures the rate across the widest span held (3-frame window)', () => {
    const d = new DSignalTracker();
    d.push(0, 0);
    d.push(5, 100);
    d.push(20, 200); // window spans 0..200 ms, 0..20 => 0.1 /ms
    const r = d.push(30, 300); // window now 100..300 ms, 5..30 => 25/200 = 0.125 /ms
    expect(r as number).toBeCloseTo(0.125, 6);
  });

  it('is UNAVAILABLE when the timestamp span is non-increasing', () => {
    const d = new DSignalTracker();
    d.push(10, 100);
    expect(d.push(20, 100)).toBe(UNAVAILABLE); // duplicate timestamp
  });

  it('reset clears history back to UNAVAILABLE', () => {
    const d = new DSignalTracker();
    d.push(0, 0);
    d.push(10, 100);
    expect(d.compute()).not.toBe(UNAVAILABLE);
    d.reset();
    expect(d.compute()).toBe(UNAVAILABLE);
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe('createSmoothingFilter', () => {
  it('builds a One Euro filter for the default type', () => {
    const f = createSmoothingFilter({ type: DEFAULT_SMOOTHING_TYPE, minCutoff: 1, beta: 0.1 });
    expect(f).toBeInstanceOf(OneEuroFilter);
    expect(f.filter(7, 0)).toBe(7);
  });

  it('throws a clear error for an unknown filter type', () => {
    expect(() => createSmoothingFilter({ type: 'kalman', minCutoff: 1, beta: 0.1 })).toThrow(
      UnknownSmoothingFilterError,
    );
    try {
      createSmoothingFilter({ type: 'kalman', minCutoff: 1, beta: 0.1 });
    } catch (e) {
      expect((e as UnknownSmoothingFilterError).filterType).toBe('kalman');
    }
  });
});
