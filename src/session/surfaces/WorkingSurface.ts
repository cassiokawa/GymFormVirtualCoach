/**
 * WorkingSurface — the WORKING-state surface (R1.4, R2.3, R5.1, R5.3, R5.5).
 *
 * The user is 3 metres from the screen and cannot touch it mid-set, so the
 * WORKING surface collapses to the barest audio-first display: a full-bleed
 * camera underneath, and above it EXACTLY THREE children and nothing else —
 *
 *   1. the {@link RepCountDisplay} (the single largest thing on screen),
 *   2. the {@link PhaseArc} (movement phase as a continuous arc, no text label),
 *   3. one cue line (at most one spoken cue per rep is mirrored here as text).
 *
 * ## Three-child allowlist (R1.4, R5.3) — enforced structurally
 *
 * R1.4 says WORKING shows *only* the rep count, the phase indicator, and the
 * current cue line: "No other control, metric, panel, or accordion SHALL be
 * present." This surface makes that a STRUCTURAL guarantee rather than a
 * convention: it composes a fixed, private allowlist of three children and
 * exposes no slot, no `append`, no `addPanel`, no children array to push into.
 * There is nowhere to hang a panel, a metric readout, a telemetry strip, an
 * accordion, or a control that duplicates a top-level nav destination (R5.3).
 * The only way to change what is on screen is through the three typed setters.
 *
 * ## No developer telemetry (R5.1, R5.4)
 *
 * Nothing here renders frames-per-second, per-rep millisecond timings, inference
 * latency, landmark confidence, raw signal traces, or third-party library names.
 * Those belong on the Lab surface only (R5.2). The cue line renders only the
 * movement-focused cue text passed to {@link setCue} (already banned-word-checked
 * upstream in spec 02) or the camera-terms stall message from {@link onStalled}.
 *
 * ## Full-bleed composite (R2.3)
 *
 * The camera feed is full-bleed underneath; every child is absolutely positioned
 * and composites above it with `pointer-events: none`, so overlays never
 * intercept the (nonexistent) mid-set touches.
 *
 * ## Readiness in camera terms (R5.5)
 *
 * When the pipeline stalls, the surface says "not detecting movement" — phrased
 * about the camera and the movement, never about the model or the library.
 *
 * ## Dependency rule
 *
 * Session UX depends INWARD. This surface drives its children through plain
 * values (an integer, a normalised `[0,1]` signal, a cue string). It knows
 * nothing about Analysis internals — no signal math, no phase FSM, no fault
 * evaluation — and holds NO exercise identity literal (`tech.md` rule 1). The
 * event loop / machine translates `RepCompleted` / `FaultDetected` /
 * `AnalysisStalled` into these calls; the surface itself never subscribes to
 * domain events.
 *
 * Framework-free: plain DOM with a {@link Surface} `mount` / `unmount` lifecycle.
 *
 * Requirements: 1.4, 2.3, 5.1, 5.3, 5.5
 */

import type { Surface, SessionContext } from '../types.js';
import { PhaseArc } from '../PhaseArc.js';
import { RepCountDisplay } from '../RepCountDisplay.js';

/**
 * The plain-language message shown when the pose pipeline reports a stall
 * (`AnalysisStalled`). Phrased in CAMERA terms, not model terms (R5.5), and free
 * of any banned medical/aesthetic word (`coaching-safety.md`).
 */
export const STALL_MESSAGE = 'not detecting movement';

/**
 * Minimum cue-line height as a fraction of viewport height. The 3-metre
 * constraint forbids any text below 5% of viewport height on the WORKING
 * surface (R2.2); the cue line honours that floor.
 */
export const CUE_LINE_MIN_VH = 5;

/** Construction options for {@link WorkingSurface}. */
export interface WorkingSurfaceOptions {
  /** Start in mirrored-display mode (R2.6); passed through to both children. */
  readonly mirrored?: boolean;
  /**
   * Cue-line font size as a fraction of viewport height. Must be ≥
   * {@link CUE_LINE_MIN_VH} (R2.2); smaller values are raised to the minimum.
   * Defaults to {@link CUE_LINE_MIN_VH}.
   */
  readonly cueVh?: number;
}

/**
 * The WORKING surface: full-bleed camera underneath, exactly three children
 * above. Implements {@link Surface} so the machine can mount/unmount it as the
 * one surface bound to the WORKING state (R1.2).
 */
export class WorkingSurface implements Surface {
  private readonly root: HTMLDivElement;

  // --- The three-child allowlist. There is no fourth field, no array, and no
  // public accessor that would let a caller add a fourth child (R1.4, R5.3). ---
  private readonly repCount: RepCountDisplay;
  private readonly phaseArc: PhaseArc;
  private readonly cueLine: HTMLDivElement;

  private host: HTMLElement | null = null;
  private mirrored: boolean;

  constructor(options: WorkingSurfaceOptions = {}) {
    this.mirrored = options.mirrored ?? false;
    const cueVh = Math.max(CUE_LINE_MIN_VH, options.cueVh ?? CUE_LINE_MIN_VH);

    this.root = document.createElement('div');
    this.root.className = 'working-surface';
    // The camera feed is full-bleed underneath; this overlay layer fills it and
    // composites above it without intercepting touches (R2.3).
    this.root.style.position = 'absolute';
    this.root.style.inset = '0';
    this.root.style.pointerEvents = 'none';

    this.repCount = new RepCountDisplay({ mirrored: this.mirrored });
    this.phaseArc = new PhaseArc({ mirrored: this.mirrored });

    // The single cue line. Bottom-anchored so it never competes with the rep
    // count for the centre of the frame. Empty until a cue (or stall) is set.
    this.cueLine = document.createElement('div');
    this.cueLine.className = 'working-surface__cue';
    this.cueLine.style.position = 'absolute';
    this.cueLine.style.left = '0';
    this.cueLine.style.right = '0';
    this.cueLine.style.bottom = '6vh';
    this.cueLine.style.textAlign = 'center';
    // R2.2: no text below 5% of viewport height. `vh` keeps it legible in both
    // portrait and landscape (R2.5).
    this.cueLine.style.fontSize = `${cueVh}vh`;
    this.cueLine.style.lineHeight = '1.1';
    this.cueLine.style.fontWeight = '600';
    this.cueLine.style.color = '#ffffff';
    this.cueLine.setAttribute('role', 'status');
    this.cueLine.setAttribute('aria-live', 'polite');
    this.cueLine.setAttribute('aria-label', 'coaching cue');
    this.cueLine.textContent = '';

    this.applyMirror();
  }

  /**
   * Mount the surface into `host` (the full-bleed camera container). Attaches
   * the three children in order: phase arc (backmost), rep count (centre), cue
   * line (front). `ctx` carries the mirrored flag if the machine drives it.
   */
  mount(host: HTMLElement, _ctx: SessionContext): void {
    this.host = host;
    // The arc sits behind the rep count so the count stays the dominant element.
    this.phaseArc.mount(this.root);
    this.repCount.mount(this.root);
    this.root.appendChild(this.cueLine);
    host.appendChild(this.root);
  }

  /** Detach the surface and all three children; drop the host reference. */
  unmount(): void {
    this.phaseArc.unmount();
    this.repCount.unmount();
    if (this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    this.host = null;
  }

  /**
   * Update the rep count (R1.4). Delegates to {@link RepCountDisplay.setCount};
   * the surface adds no decoration — a counted rep is confirmed by a tone, not
   * a badge (`coaching-safety.md`).
   */
  setReps(n: number): void {
    this.repCount.setCount(n);
  }

  /**
   * Update the phase arc from a normalised signal position in `[0, 1]` (R2.4):
   * `0` = ROM floor (empty arc), `1` = ROM top (full sweep). Delegates to
   * {@link PhaseArc.render}, which clamps out-of-range / non-finite input.
   */
  setPhase(signalNorm: number): void {
    this.phaseArc.render(signalNorm);
  }

  /**
   * Set the single cue line (R1.4). Renders the movement-focused cue `text`
   * exactly as passed (banned-word-checked upstream), or CLEARS the line when
   * `text` is `null` — silence when there is nothing to say
   * (`coaching-safety.md`). At most one cue is shown at a time.
   */
  setCue(text: string | null): void {
    this.cueLine.textContent = text ?? '';
  }

  /**
   * Surface the stall message (R5.5) on `AnalysisStalled`. Shows "not detecting
   * movement" in the SAME cue line — a minimal overlay, never a panel (R5.3).
   * Phrased in camera/movement terms, not model terms.
   */
  onStalled(): void {
    this.cueLine.textContent = STALL_MESSAGE;
  }

  /** Toggle mirrored-display mode (R2.6); passed through to both children. */
  setMirrored(mirrored: boolean): void {
    this.mirrored = mirrored;
    this.repCount.setMirrored(mirrored);
    this.phaseArc.setMirrored(mirrored);
    this.applyMirror();
  }

  /** Whether mirrored-display mode is active. */
  isMirrored(): boolean {
    return this.mirrored;
  }

  private applyMirror(): void {
    // The cue line lives in this surface's own layer (the children mirror
    // themselves), so mirror the cue line here to keep it readable in a mirror.
    this.cueLine.style.transform = this.mirrored ? 'scaleX(-1)' : '';
  }
}
