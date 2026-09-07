/**
 * RepCountDisplay — the WORKING surface's rep counter (R2.1, R2.2, R2.5, R2.6).
 *
 * The user is 3 metres from the screen. Text sized for desk distance is
 * invisible at 3 m, so the rep count is the single largest thing on the WORKING
 * surface: it renders at a MINIMUM of 25% of viewport height (R2.1). No text on
 * the surface falls below 5% of viewport height (R2.2). Sizes are expressed in
 * viewport-relative units so legibility is preserved in both portrait and
 * landscape (R2.5), and a mirrored-display mode (R2.6) flips it for use with the
 * device facing a mirror.
 *
 * ## Not a grade, score, streak, or progress bar (`coaching-safety.md`)
 *
 * This renders a plain integer count and nothing else — no percentage, no star,
 * no streak, no goal gap, no progress bar, no praise. A counted rep is confirmed
 * by a tone (owned by the AudioBus); this component is purely the visual count.
 *
 * ## Dependency rule
 *
 * Session UX depends INWARD. This component is handed a plain integer via
 * {@link setCount}; it knows nothing about Analysis internals and holds no
 * exercise identity literal (`tech.md` rule 1).
 *
 * Framework-free: plain DOM with a `mount(host)` / `unmount()` lifecycle.
 *
 * Requirements: 2.1, 2.2, 2.5, 2.6
 */

/**
 * Minimum rep-count height as a fraction of the viewport's smaller-safe axis
 * (R2.1: "a minimum of 25% of viewport height"). Encoded as the numeric part of
 * the `vh` font size so tests can assert the ≥25% rule directly from the style.
 */
export const REP_COUNT_MIN_VH = 25;

/**
 * Minimum size for any text on the surface as a fraction of viewport height
 * (R2.2: "no text below 5% of viewport height"). Any secondary label this
 * component renders uses at least this size.
 */
export const MIN_TEXT_VH = 5;

/** Construction options for {@link RepCountDisplay}. */
export interface RepCountDisplayOptions {
  /** Start in mirrored-display mode (R2.6). Defaults to `false`. */
  readonly mirrored?: boolean;
  /**
   * Rep-count font size as a fraction of viewport height. Must be ≥
   * {@link REP_COUNT_MIN_VH} (R2.1); values below it are raised to the minimum.
   * Defaults to {@link REP_COUNT_MIN_VH}.
   */
  readonly countVh?: number;
}

/**
 * Distance-legible rep counter. Framework-free; `mount` attaches into the host,
 * `setCount` updates the number, `unmount` detaches.
 */
export class RepCountDisplay {
  private readonly root: HTMLDivElement;
  private readonly countEl: HTMLDivElement;
  private host: HTMLElement | null = null;
  private mirrored: boolean;
  private readonly countVh: number;
  private count = 0;

  constructor(options: RepCountDisplayOptions = {}) {
    this.mirrored = options.mirrored ?? false;
    // Enforce the ≥25% rule regardless of caller input (R2.1).
    this.countVh = Math.max(REP_COUNT_MIN_VH, options.countVh ?? REP_COUNT_MIN_VH);

    this.root = document.createElement('div');
    this.root.className = 'rep-count-display';
    // Composite above the full-bleed camera; never intercept touches (R2.3).
    this.root.style.position = 'absolute';
    this.root.style.inset = '0';
    this.root.style.pointerEvents = 'none';
    this.root.style.display = 'flex';
    this.root.style.alignItems = 'center';
    this.root.style.justifyContent = 'center';

    this.countEl = document.createElement('div');
    this.countEl.className = 'rep-count-display__count';
    // R2.1: at least 25% of viewport height. `vh` is the viewport-relative unit
    // that keeps this legible in portrait and landscape (R2.5).
    this.countEl.style.fontSize = `${this.countVh}vh`;
    this.countEl.style.lineHeight = '1';
    this.countEl.style.fontWeight = '700';
    this.countEl.style.color = '#ffffff';
    // A single tabular integer; no units, no suffix, no decoration.
    this.countEl.style.fontVariantNumeric = 'tabular-nums';
    this.countEl.setAttribute('aria-label', 'rep count');
    this.countEl.setAttribute('role', 'status');

    this.root.appendChild(this.countEl);

    this.applyMirror();
    this.renderCount();
  }

  /** Attach the counter into `host` (expected to be a positioned container). */
  mount(host: HTMLElement): void {
    this.host = host;
    host.appendChild(this.root);
  }

  /** Detach the counter and drop its host reference. */
  unmount(): void {
    if (this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    this.host = null;
  }

  /**
   * Set the rep count. Non-finite or negative input is coerced to 0; the value
   * is floored to a whole rep. Renders the bare integer only — no score, star,
   * streak, or progress (`coaching-safety.md`).
   */
  setCount(n: number): void {
    this.count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    this.renderCount();
  }

  /** The current rep count. */
  getCount(): number {
    return this.count;
  }

  /** The rep-count font size as a fraction of viewport height (≥ 25, R2.1). */
  getCountVh(): number {
    return this.countVh;
  }

  /** Toggle mirrored-display mode (R2.6): horizontally flips the counter. */
  setMirrored(mirrored: boolean): void {
    this.mirrored = mirrored;
    this.applyMirror();
  }

  /** Whether mirrored-display mode is active. */
  isMirrored(): boolean {
    return this.mirrored;
  }

  private applyMirror(): void {
    this.root.style.transform = this.mirrored ? 'scaleX(-1)' : '';
  }

  private renderCount(): void {
    this.countEl.textContent = String(this.count);
  }
}
