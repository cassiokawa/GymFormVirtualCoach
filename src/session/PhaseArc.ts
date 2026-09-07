/**
 * PhaseArc — the WORKING surface's movement-phase indicator (R2.4).
 *
 * The user is 3 metres from the screen and cannot read text at that distance,
 * so movement phase is shown as a CONTINUOUS ARC rather than a text label
 * (R2.4). The arc sweep is a pure function of normalised signal position
 * between the ROM floor (0) and top (1): at the floor the arc is empty, at the
 * top it is fully swept. This reads at a glance from across a room.
 *
 * ## Dependency rule
 *
 * Session UX depends INWARD on domain contracts and never reaches into Analysis
 * internals. This component knows nothing about signal math, the phase FSM, or
 * fault evaluation — it is handed an already-normalised `signalNorm` in `[0, 1]`
 * and renders it. It holds NO exercise identity literal (`tech.md` rule 1): the
 * arc geometry is the same for every exercise; only the normalised position it
 * is fed differs.
 *
 * ## No text phase label (R2.4)
 *
 * The arc renders SVG geometry only — no "eccentric"/"concentric"/"top" text,
 * no numeric readout, no phase name. R2.4 forbids a text label; the sweep angle
 * carries the whole meaning.
 *
 * ## Full-bleed composite (R2.3), portrait/landscape (R2.5), mirror (R2.6)
 *
 * The arc composites ABOVE the full-bleed camera feed (transparent background,
 * `pointer-events: none`). It sizes itself with viewport-relative units so it
 * stays legible in both portrait and landscape (R2.5). A mirrored-display mode
 * (R2.6) flips it horizontally with `transform: scaleX(-1)` for use with the
 * device screen facing a mirror.
 *
 * Framework-free: plain DOM/SVG with a `mount(host)` / `unmount()` lifecycle,
 * matching the `Surface`-style contract used across this context.
 *
 * Requirements: 2.4, 2.5, 2.6
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The arc is drawn on a fixed 100×100 user-space viewBox and scaled by the
 * container's viewport-relative size, so all geometry below is in that space.
 */
const VIEWBOX = 100;

/** Centre of the arc in viewBox user units. */
const CX = VIEWBOX / 2;
const CY = VIEWBOX / 2;

/** Radius of the arc's centre-line in viewBox user units. */
const RADIUS = 42;

/** Stroke width of the arc track / progress in viewBox user units. */
const STROKE = 8;

/**
 * The arc spans a 270° gauge, opening downward. The sweep starts at the floor
 * end (`START_ANGLE_DEG`) and, as `signalNorm` goes 0 → 1, advances clockwise
 * through `SWEEP_DEG` to the top end. 270° (rather than a full 360°) leaves a
 * visible gap at the bottom so the floor/top ends are distinguishable at a
 * glance.
 */
const START_ANGLE_DEG = 135;
const SWEEP_DEG = 270;

/** Clamp a value into `[0, 1]`; maps NaN and non-finite input to 0 (silence when uncertain). */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Point on the arc circle for a given angle (degrees), measured clockwise from
 * the positive x-axis in SVG's y-down coordinate space.
 */
function polarPoint(angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: CX + RADIUS * Math.cos(rad),
    y: CY + RADIUS * Math.sin(rad),
  };
}

/**
 * Build the SVG path `d` for the progress arc from the floor end to the point
 * reached by `progress` in `[0, 1]`. A zero-length sweep produces an empty
 * string so nothing is drawn at the floor (R2.4: empty at floor).
 *
 * Exported for unit testing: the mapping of `0 / 0.5 / 1` to arc geometry must
 * be monotonic and land on the expected endpoints.
 */
export function arcPath(progress: number): string {
  const p = clamp01(progress);
  if (p <= 0) return '';
  const endAngle = START_ANGLE_DEG + SWEEP_DEG * p;
  const start = polarPoint(START_ANGLE_DEG);
  const end = polarPoint(endAngle);
  // largeArcFlag is 1 once the swept angle exceeds 180°.
  const largeArc = SWEEP_DEG * p > 180 ? 1 : 0;
  // sweepFlag 1 = clockwise (positive angle direction in SVG y-down space).
  return `M ${start.x} ${start.y} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

/**
 * The end-angle (degrees) the sweep reaches for a given normalised signal.
 * Exported so tests can assert the mapping is monotonic in `signalNorm`.
 */
export function sweepEndAngleDeg(signalNorm: number): number {
  return START_ANGLE_DEG + SWEEP_DEG * clamp01(signalNorm);
}

/** Construction options for {@link PhaseArc}. */
export interface PhaseArcOptions {
  /** Start in mirrored-display mode (R2.6). Defaults to `false`. */
  readonly mirrored?: boolean;
}

/**
 * Continuous-arc phase indicator. Framework-free; `mount` attaches an SVG into
 * the host, `render`/`setProgress` update the sweep, `unmount` detaches.
 */
export class PhaseArc {
  private readonly root: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly progressPath: SVGPathElement;
  private host: HTMLElement | null = null;
  private mirrored: boolean;
  private progress = 0;

  constructor(options: PhaseArcOptions = {}) {
    this.mirrored = options.mirrored ?? false;

    this.root = document.createElement('div');
    this.root.className = 'phase-arc';
    // Composite above the full-bleed camera; never intercept touches (R2.3).
    this.root.style.position = 'absolute';
    this.root.style.inset = '0';
    this.root.style.pointerEvents = 'none';
    this.root.style.display = 'flex';
    this.root.style.alignItems = 'center';
    this.root.style.justifyContent = 'center';

    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('viewBox', `0 0 ${VIEWBOX} ${VIEWBOX}`);
    this.svg.setAttribute('role', 'img');
    // Sized with viewport-relative units so it stays legible in portrait and
    // landscape (R2.5); vmin keeps the square arc square in both orientations.
    this.svg.style.width = '60vmin';
    this.svg.style.height = '60vmin';
    this.svg.style.overflow = 'visible';

    const track = document.createElementNS(SVG_NS, 'path');
    track.setAttribute('d', this.trackPath());
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', 'rgba(255,255,255,0.22)');
    track.setAttribute('stroke-width', String(STROKE));
    track.setAttribute('stroke-linecap', 'round');

    this.progressPath = document.createElementNS(SVG_NS, 'path');
    this.progressPath.setAttribute('fill', 'none');
    this.progressPath.setAttribute('stroke', '#ffffff');
    this.progressPath.setAttribute('stroke-width', String(STROKE));
    this.progressPath.setAttribute('stroke-linecap', 'round');

    this.svg.appendChild(track);
    this.svg.appendChild(this.progressPath);
    this.root.appendChild(this.svg);

    this.applyMirror();
    this.renderProgress();
  }

  /** The full 270° background track path (floor end to top end). */
  private trackPath(): string {
    return arcPath(1);
  }

  /**
   * Attach the arc into `host`. The host is expected to be positioned so the
   * absolutely-positioned arc fills it and composites over the camera.
   */
  mount(host: HTMLElement): void {
    this.host = host;
    host.appendChild(this.root);
  }

  /** Detach the arc and drop its host reference. */
  unmount(): void {
    if (this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    this.host = null;
  }

  /**
   * Render the arc for a normalised signal position in `[0, 1]` (R2.4):
   * `0` = ROM floor (empty arc), `1` = ROM top (full sweep). Out-of-range or
   * non-finite input is clamped to `[0, 1]` (0 for NaN — silence when
   * uncertain).
   */
  render(signalNorm: number): void {
    this.setProgress(signalNorm);
  }

  /** Alias of {@link render}; both accept a `[0, 1]` floor→top position. */
  setProgress(signalNorm: number): void {
    this.progress = clamp01(signalNorm);
    this.renderProgress();
  }

  /** The current clamped sweep progress in `[0, 1]`. */
  getProgress(): number {
    return this.progress;
  }

  /** Toggle mirrored-display mode (R2.6): horizontally flips the arc. */
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

  private renderProgress(): void {
    const d = arcPath(this.progress);
    if (d === '') {
      this.progressPath.removeAttribute('d');
    } else {
      this.progressPath.setAttribute('d', d);
    }
  }
}
