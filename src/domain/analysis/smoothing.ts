/**
 * Signal smoothing and windowed rate-of-change (`dSignal`).
 *
 * Phase-machine steps 2–3 of the design: after the raw signal is evaluated, it
 * is (2) pushed through a smoothing filter — One Euro by default — and (3) a
 * `dSignal` is computed from the smoothed series over a 3-frame window. This
 * module implements both, plus a small factory that maps a `SmoothingSpec.type`
 * string to a filter instance.
 *
 * ## Design notes
 *
 * - **Stateful across frames, allocation-conscious.** Each filter/tracker holds
 *   its previous values as plain number fields — no per-frame allocation, no
 *   I/O. `reset()` clears that state so a fresh set starts clean. This keeps the
 *   per-frame hot path within budget (`ingest` ≤ 3 ms p95).
 * - **Driven by frame timestamps.** Both the One Euro filter and the `dSignal`
 *   tracker take `t` in milliseconds. Cadence-independent behaviour matters
 *   because capture frame rate is not guaranteed constant.
 * - **No exercise identity.** Nothing here names an exercise; smoothing is a
 *   pure numeric concern.
 *
 * ## `dSignal` sign and scale convention
 *
 * `dSignal` is the **signed rate of change of the smoothed signal, in signal
 * units per millisecond** (Δsignal / Δt). This convention is fixed because the
 * fault grammar reads `dSignal < -velocityThreshold` (a downward-moving signal,
 * e.g. the descent of a squat, yields a *negative* `dSignal`). A rising signal
 * yields a positive `dSignal`; a falling signal a negative one; a flat signal
 * zero. On insufficient history (fewer than two samples since the last reset)
 * `dSignal` is `UNAVAILABLE` — silence when uncertain — and the caller decides
 * how to bind it into the {@link EvalContext}.
 *
 * Requirements: 3.2
 */

import { UNAVAILABLE, type Signal } from './types';
import type { SmoothingSpec } from './spec';

// ---------------------------------------------------------------------------
// Filter contract
// ---------------------------------------------------------------------------

/**
 * A stateful, per-frame smoothing filter. `filter` consumes one raw sample plus
 * its capture timestamp and returns the smoothed value; `reset` clears all
 * accumulated state so the next sample is treated as the first of a new run.
 */
export interface SmoothingFilter {
  /**
   * Smooth one sample.
   *
   * @param value raw signal value for this frame
   * @param t capture timestamp in milliseconds
   * @returns the smoothed value
   */
  filter(value: number, t: number): number;
  /** Clear all accumulated state. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// One Euro filter
// ---------------------------------------------------------------------------

/**
 * Low-pass smoothing factor for a first-order filter given a cutoff frequency
 * `cutoff` (Hz) and a sampling period `dt` (seconds).
 *
 * `alpha = 1 / (1 + tau/dt)` where `tau = 1 / (2π·cutoff)`.
 */
function smoothingAlpha(cutoff: number, dtSeconds: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dtSeconds);
}

/**
 * The One Euro filter (Casiez, Roussel & Vogel, 2012): a first-order low-pass
 * filter whose cutoff frequency adapts to the signal's velocity. At low speed
 * the cutoff is low (heavy smoothing removes jitter); as the signal moves faster
 * the cutoff rises (light smoothing keeps lag low). Adaptation is governed by
 * two parameters carried on {@link SmoothingSpec}:
 *
 * - `minCutoff` — the baseline cutoff frequency (Hz). Lower = smoother/more lag
 *   when still.
 * - `beta` — the speed coefficient. Higher = more aggressive cutoff increase
 *   with velocity = less lag when moving fast.
 *
 * The derivative cutoff (`dCutoff`) is fixed at 1 Hz, the paper's default.
 *
 * State is held as plain fields; a fresh instance (or `reset()`) has no
 * previous sample, so the first `filter` call returns the raw value unchanged.
 */
export class OneEuroFilter implements SmoothingFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;

  private hasPrev = false;
  private prevValue = 0;
  private prevDeriv = 0;
  private prevT = 0;

  /**
   * @param minCutoff baseline cutoff frequency in Hz; must be > 0
   * @param beta speed coefficient; must be >= 0
   * @param dCutoff derivative cutoff frequency in Hz (default 1)
   */
  constructor(minCutoff: number, beta: number, dCutoff = 1) {
    if (!(minCutoff > 0)) {
      throw new RangeError(`OneEuroFilter: minCutoff must be > 0, got ${minCutoff}`);
    }
    if (!(beta >= 0)) {
      throw new RangeError(`OneEuroFilter: beta must be >= 0, got ${beta}`);
    }
    if (!(dCutoff > 0)) {
      throw new RangeError(`OneEuroFilter: dCutoff must be > 0, got ${dCutoff}`);
    }
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  filter(value: number, t: number): number {
    if (!this.hasPrev) {
      this.hasPrev = true;
      this.prevValue = value;
      this.prevDeriv = 0;
      this.prevT = t;
      return value;
    }

    // Sampling period in seconds. Guard against non-increasing timestamps
    // (duplicate or out-of-order frames) by falling back to a tiny positive dt
    // so the filter never divides by zero and never produces NaN.
    let dt = (t - this.prevT) / 1000;
    if (!(dt > 0)) {
      dt = 1e-3;
    }

    // Filtered derivative of the signal.
    const rawDeriv = (value - this.prevValue) / dt;
    const dAlpha = smoothingAlpha(this.dCutoff, dt);
    const deriv = dAlpha * rawDeriv + (1 - dAlpha) * this.prevDeriv;

    // Adaptive cutoff rises with the magnitude of the (smoothed) speed.
    const cutoff = this.minCutoff + this.beta * Math.abs(deriv);
    const alpha = smoothingAlpha(cutoff, dt);
    const smoothed = alpha * value + (1 - alpha) * this.prevValue;

    this.prevValue = smoothed;
    this.prevDeriv = deriv;
    this.prevT = t;
    return smoothed;
  }

  reset(): void {
    this.hasPrev = false;
    this.prevValue = 0;
    this.prevDeriv = 0;
    this.prevT = 0;
  }
}

// ---------------------------------------------------------------------------
// dSignal — windowed rate of change
// ---------------------------------------------------------------------------

/** Number of smoothed samples retained for the `dSignal` window. */
const D_SIGNAL_WINDOW = 3;

/**
 * Computes `dSignal`, the signed rate of change of the smoothed signal over a
 * 3-frame window, in **signal units per millisecond**.
 *
 * Feed it successive *smoothed* values (the output of a {@link SmoothingFilter})
 * with their capture timestamps. It retains the last {@link D_SIGNAL_WINDOW}
 * samples in a fixed-size ring (no per-frame allocation) and returns the slope
 * across the window as `(newest − oldest) / (tNewest − tOldest)`.
 *
 * - With fewer than two samples since the last {@link reset}, there is
 *   insufficient history and the result is {@link UNAVAILABLE}.
 * - Once at least two samples exist, the rate is measured across the widest
 *   span currently held (up to 3 frames), which smooths single-frame jitter in
 *   the derivative while staying responsive.
 * - A non-increasing timestamp span (duplicate frames) also yields
 *   {@link UNAVAILABLE} rather than dividing by zero.
 *
 * Sign convention: a rising signal → positive; a falling signal → negative.
 * This matches the fault grammar's `dSignal < -velocityThreshold`.
 */
export class DSignalTracker {
  private readonly values = new Float64Array(D_SIGNAL_WINDOW);
  private readonly times = new Float64Array(D_SIGNAL_WINDOW);
  /** Count of samples currently held (saturates at the window size). */
  private count = 0;
  /** Index of the next write position in the ring. */
  private head = 0;

  /**
   * Push one smoothed sample and return the current `dSignal`.
   *
   * @param smoothedValue the smoothed signal value for this frame
   * @param t capture timestamp in milliseconds
   */
  push(smoothedValue: number, t: number): Signal {
    this.values[this.head] = smoothedValue;
    this.times[this.head] = t;
    this.head = (this.head + 1) % D_SIGNAL_WINDOW;
    if (this.count < D_SIGNAL_WINDOW) {
      this.count += 1;
    }
    return this.compute();
  }

  /**
   * Current `dSignal` without pushing a new sample. {@link UNAVAILABLE} until at
   * least two samples have been pushed since the last {@link reset}.
   */
  compute(): Signal {
    if (this.count < 2) {
      return UNAVAILABLE;
    }
    // Oldest retained sample: when saturated it sits at `head` (the next write
    // slot overwrites it); before saturation the oldest is index 0.
    const newestIdx = (this.head - 1 + D_SIGNAL_WINDOW) % D_SIGNAL_WINDOW;
    const oldestIdx =
      this.count < D_SIGNAL_WINDOW ? 0 : this.head;

    // Non-null assertions are safe: indices are within the fixed-size arrays.
    const newestValue = this.values[newestIdx]!;
    const oldestValue = this.values[oldestIdx]!;
    const newestT = this.times[newestIdx]!;
    const oldestT = this.times[oldestIdx]!;

    const span = newestT - oldestT;
    if (!(span > 0)) {
      return UNAVAILABLE;
    }
    return (newestValue - oldestValue) / span;
  }

  reset(): void {
    this.count = 0;
    this.head = 0;
    this.values.fill(0);
    this.times.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** The default smoothing filter type when a spec omits or defaults to it. */
export const DEFAULT_SMOOTHING_TYPE = 'oneEuro';

/**
 * Error surfaced when a {@link SmoothingSpec} names a filter the engine does not
 * know how to build. The build-time validator (task 11) also rejects unknown
 * filters, but the factory signals clearly at the point of construction so a
 * bad spec never silently produces an unsmoothed signal.
 */
export class UnknownSmoothingFilterError extends Error {
  constructor(public readonly filterType: string) {
    super(`Unknown smoothing filter: "${filterType}"`);
    this.name = 'UnknownSmoothingFilterError';
  }
}

/**
 * Build a stateful {@link SmoothingFilter} from a {@link SmoothingSpec}.
 *
 * The only filter currently implemented is `"oneEuro"` (the default),
 * parameterised by `minCutoff` and `beta`. An unknown `type` throws
 * {@link UnknownSmoothingFilterError}.
 */
export function createSmoothingFilter(spec: SmoothingSpec): SmoothingFilter {
  switch (spec.type) {
    case DEFAULT_SMOOTHING_TYPE:
      return new OneEuroFilter(spec.minCutoff, spec.beta);
    default:
      throw new UnknownSmoothingFilterError(spec.type);
  }
}
