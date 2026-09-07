/**
 * ArmedSurface — the ARMED-state surface: a 5-second audible countdown before
 * WORKING begins (R4.6).
 *
 * The user has taken the start action and is stepping into position 3 metres
 * from the screen. They cannot read desk-distance text and cannot touch the
 * screen mid-set, so the countdown is AUDIBLE first (a tick per second via the
 * AudioBus) and its visual is a single huge digit that is legible across the
 * room. After the fifth tick the countdown has elapsed and the surface fires
 * {@link ArmedSurfaceOptions.onElapsed}, which the machine maps to
 * `COUNTDOWN_ELAPSED` → WORKING.
 *
 * ## Full-bleed camera, transparent overlay (R2.3)
 *
 * The camera feed is rendered full-bleed and composited BELOW this surface; the
 * surface itself is a transparent overlay that never paints an opaque
 * background over the camera and never intercepts pointer events. It contributes
 * only the countdown number (plus an optional cancel affordance owned by the
 * caller), so the user can still see themselves getting into position.
 *
 * ## Cancel back to SETUP
 *
 * ARMED can be abandoned before the countdown ends. {@link cancel} stops the
 * countdown and fires {@link ArmedSurfaceOptions.onCancel}, which the machine
 * maps to `COUNTDOWN_CANCELLED` → SETUP.
 *
 * ## Timers never outlive the surface
 *
 * A late timer that fired `onElapsed` after the surface was torn down would
 * drive the machine ARMED → WORKING when the user had cancelled or navigated
 * away. So {@link unmount} (and {@link cancel}) clear every pending timer, and
 * the surface refuses to fire either callback once it is no longer running.
 * `onElapsed` can never fire after `unmount`.
 *
 * ## Injectable seams (testable without real timers / Web Audio)
 *
 * The audio channel is an {@link CountdownAudio} — structurally satisfied by
 * {@link AudioBus} — so tests pass a spy `{ countdownTick() }`. The timer is an
 * injectable {@link CountdownTimer} seam (defaulting to `setTimeout` /
 * `clearTimeout`) so tests can drive it with fake timers. No real
 * `AudioContext` or wall-clock delay is needed to unit-test the sequence.
 *
 * ## Framework-free DOM, exercise identity is data
 *
 * Plain DOM with a `mount(host, ctx)` / `unmount()` lifecycle (the
 * {@link Surface} contract). No exercise id, name, or alias appears as a
 * literal here (`tech.md` rule 1); the surface reads only the opaque
 * `ctx.exerciseId` it is handed and does not render it.
 *
 * Requirements: 2.3, 4.6
 */

import type { SessionContext, Surface } from '../types';

/**
 * The number of seconds the countdown runs before elapsing (R4.6). Exported as
 * a seam so tests assert the exact count without a magic number.
 */
export const COUNTDOWN_SECONDS = 5;

/** One second, in milliseconds — the interval between countdown ticks. */
export const COUNTDOWN_TICK_MS = 1000;

/**
 * Countdown-digit height as a fraction of viewport height. The single number is
 * the largest thing on the surface so it is legible at 3 metres, mirroring the
 * rep-count treatment on the WORKING surface. Viewport-relative so it holds in
 * portrait and landscape.
 */
export const COUNTDOWN_DIGIT_VH = 40;

/**
 * The slice of {@link AudioBus} this surface needs: one tick per countdown
 * second. Structurally satisfied by `AudioBus`, and trivially by a test spy —
 * this surface never touches Web Audio directly.
 */
export interface CountdownAudio {
  /** Emit one tick of the ARMED countdown. */
  countdownTick(): void;
}

/**
 * The timer seam. Mirrors `setTimeout` / `clearTimeout` so the default is a
 * one-line binding to the platform timers, while tests can inject fake ones (or
 * use `vi.useFakeTimers()` against the real global, which the default uses).
 */
export interface CountdownTimer {
  /** Schedule `fn` after `ms`; returns an opaque handle for {@link clear}. */
  set(fn: () => void, ms: number): unknown;
  /** Cancel a handle previously returned by {@link set}. */
  clear(handle: unknown): void;
}

/** The default timer seam: the platform's `setTimeout` / `clearTimeout`. */
const defaultTimer: CountdownTimer = {
  set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clear: (handle: unknown): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** Construction options for {@link ArmedSurface}. */
export interface ArmedSurfaceOptions {
  /**
   * Audio channel that ticks each countdown second (R4.6). Structurally an
   * {@link AudioBus}; a spy `{ countdownTick() }` satisfies it in tests.
   */
  readonly audio: CountdownAudio;
  /**
   * Called once when the countdown has fully elapsed. The machine maps this to
   * `COUNTDOWN_ELAPSED` → WORKING. Never called after {@link unmount} or
   * {@link cancel}.
   */
  readonly onElapsed: () => void;
  /**
   * Called when the countdown is cancelled before it elapses (via
   * {@link cancel}). The machine maps this to `COUNTDOWN_CANCELLED` → SETUP.
   */
  readonly onCancel?: () => void;
  /**
   * Number of seconds to count down. Defaults to {@link COUNTDOWN_SECONDS} (5,
   * R4.6). Values below 1 are raised to 1 so at least one tick always fires.
   */
  readonly seconds?: number;
  /** Timer seam; defaults to the platform `setTimeout` / `clearTimeout`. */
  readonly timer?: CountdownTimer;
}

/**
 * The ARMED surface. Framework-free; `mount` starts the countdown, `unmount`
 * tears it down (clearing any pending timer), `cancel` aborts it back to SETUP.
 */
export class ArmedSurface implements Surface {
  private readonly audio: CountdownAudio;
  private readonly onElapsed: () => void;
  private readonly onCancel: (() => void) | null;
  private readonly totalSeconds: number;
  private readonly timer: CountdownTimer;

  private readonly root: HTMLDivElement;
  private readonly digitEl: HTMLDivElement;

  private host: HTMLElement | null = null;
  /** Pending tick handle, or `null` when no tick is scheduled. */
  private handle: unknown = null;
  /** Seconds remaining; drives both the tick and the rendered digit. */
  private remaining = 0;
  /** True only between a `mount` that started the countdown and its teardown. */
  private running = false;

  constructor(options: ArmedSurfaceOptions) {
    this.audio = options.audio;
    this.onElapsed = options.onElapsed;
    this.onCancel = options.onCancel ?? null;
    this.totalSeconds = Math.max(1, Math.floor(options.seconds ?? COUNTDOWN_SECONDS));
    this.timer = options.timer ?? defaultTimer;

    // Transparent overlay above the full-bleed camera (R2.3): no opaque
    // background, no pointer interception. Only the countdown digit is painted.
    this.root = document.createElement('div');
    this.root.className = 'armed-surface';
    this.root.style.position = 'absolute';
    this.root.style.inset = '0';
    this.root.style.background = 'transparent';
    this.root.style.pointerEvents = 'none';
    this.root.style.display = 'flex';
    this.root.style.alignItems = 'center';
    this.root.style.justifyContent = 'center';

    this.digitEl = document.createElement('div');
    this.digitEl.className = 'armed-surface__count';
    // A single huge digit, legible at 3 m; viewport-relative so it holds in
    // portrait and landscape (R2.3, R2.5 sizing convention).
    this.digitEl.style.fontSize = `${COUNTDOWN_DIGIT_VH}vh`;
    this.digitEl.style.lineHeight = '1';
    this.digitEl.style.fontWeight = '700';
    this.digitEl.style.color = '#ffffff';
    this.digitEl.style.fontVariantNumeric = 'tabular-nums';
    this.digitEl.setAttribute('role', 'timer');
    this.digitEl.setAttribute('aria-label', 'countdown');

    this.root.appendChild(this.digitEl);
  }

  /**
   * Attach the surface into `host` and start the 5-second countdown (R4.6).
   * `ctx` is accepted per the {@link Surface} contract; the surface reads only
   * the opaque `ctx.exerciseId` and does not render it.
   */
  mount(host: HTMLElement, _ctx: SessionContext): void {
    this.host = host;
    host.appendChild(this.root);
    this.start();
  }

  /**
   * Detach the surface and clear any pending timer so a late countdown can never
   * fire `onElapsed` after teardown. Does NOT fire `onCancel` — unmount is the
   * machine tearing the surface down, not the user cancelling.
   */
  unmount(): void {
    this.stop();
    if (this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    this.host = null;
  }

  /**
   * Cancel the countdown before it elapses and fire `onCancel` (→ SETUP). Clears
   * the pending timer; after this the countdown can never fire `onElapsed`.
   * Idempotent: a second call after the surface has stopped does nothing.
   */
  cancel(): void {
    if (!this.running) return;
    this.stop();
    if (this.onCancel) this.onCancel();
  }

  /** Seconds currently remaining in the countdown (0 once elapsed/stopped). */
  getRemaining(): number {
    return this.remaining;
  }

  /** Whether the countdown is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  // --- Internals ------------------------------------------------------------

  /** Seed the countdown, render the first digit, and schedule the first tick. */
  private start(): void {
    this.running = true;
    this.remaining = this.totalSeconds;
    this.renderDigit();
    this.scheduleTick();
  }

  /** Stop the countdown and clear any pending timer. Safe to call repeatedly. */
  private stop(): void {
    this.running = false;
    if (this.handle !== null) {
      this.timer.clear(this.handle);
      this.handle = null;
    }
  }

  /** Schedule the next one-second tick. */
  private scheduleTick(): void {
    this.handle = this.timer.set(() => {
      this.handle = null;
      this.onTick();
    }, COUNTDOWN_TICK_MS);
  }

  /**
   * One countdown second elapsed: sound a tick (R4.6), decrement, and either
   * schedule the next tick or, when the last second is consumed, elapse.
   */
  private onTick(): void {
    // Guard against a stray timer that fired after teardown.
    if (!this.running) return;

    this.audio.countdownTick();
    this.remaining -= 1;

    if (this.remaining <= 0) {
      this.remaining = 0;
      this.renderDigit();
      this.running = false;
      this.onElapsed();
      return;
    }

    this.renderDigit();
    this.scheduleTick();
  }

  /** Render the current remaining-seconds digit. */
  private renderDigit(): void {
    this.digitEl.textContent = String(this.remaining);
  }
}
