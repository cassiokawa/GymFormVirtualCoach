/**
 * SetupSurface — the SETUP-state surface (R1.3, R2.3, R4, R5.5, R7.5).
 *
 * SETUP is where the user, 3 metres from the screen, picks an exercise and gets
 * the camera framed before lifting. R1.3 says SETUP shows the live camera
 * preview, the exercise selector, framing guidance, and a SINGLE primary
 * action. This surface composes existing pieces rather than reimplementing
 * them:
 *
 *   - a full-bleed camera preview underneath, with every overlay composited
 *     ABOVE it (R2.3);
 *   - the {@link ExerciseGrid} (R7.1) for exercise selection — on select it sets
 *     the chosen `exerciseId` and DISPLAYS that exercise's required camera angle
 *     before start (R7.5);
 *   - continuous framing guidance (R4.1): a silhouette-style guide plus, read
 *     from each {@link FramingVerdict}, the missing body parts (R4.2), the
 *     angle-correction direction (R4.3), and a move-closer/further hint in
 *     approximate metres (R4.4);
 *   - a single Start button whose `disabled` binds to `!verdict.ok` (R1.3, R4.5).
 *
 * ## Framing is DRIVEN, not polled (testability)
 *
 * The frame loop owns pose inference and framing; this surface does not. The
 * loop feeds verdicts in via {@link updateFraming}, which is the single seam for
 * all framing state. Keeping the surface driven by `updateFraming(verdict)`
 * (rather than owning a validator + frame stream) makes the false→true readiness
 * edge, the Start `disabled` binding, and the guidance text unit-testable with
 * plain verdict objects and no camera.
 *
 * ## Readiness tone fires ONCE on the not-ok → ok edge (R4.5)
 *
 * When framing transitions from not-ok to ok, the surface fires
 * {@link ReadinessAudio.readinessTone} EXACTLY ONCE on that edge and enables
 * Start. It does not re-fire while framing stays ok, and it re-arms only after
 * framing drops back to not-ok. The audio channel is an injectable
 * {@link ReadinessAudio} seam (structurally satisfied by `AudioBus`) so tests
 * pass a spy `{ readinessTone() }` with no real Web Audio.
 *
 * ## Readiness in camera terms, not model terms (R5.5)
 *
 * The guidance line talks about the camera and the body ("all set — ready to
 * start", "move closer", "left knee outside the frame"), never about the pose
 * model, inference, or a third-party library.
 *
 * ## Exercise identity is data, never code (`tech.md` rule 1)
 *
 * No exercise id, name, or alias appears as a literal here. The required-angle
 * readout is derived from the selected {@link ExerciseSpecMeta}'s `camera` data;
 * the opaque `exerciseId` is carried, never rendered as a label.
 *
 * Framework-free: plain DOM with a {@link Surface} `mount` / `unmount`
 * lifecycle.
 *
 * Requirements: 1.3, 2.3, 4.1, 4.5, 5.5, 7.5
 */

import type { ExerciseSpecMeta, FramingVerdict, SessionContext, Surface } from '../types.js';
import { ExerciseGrid } from '../ExerciseGrid.js';

/**
 * The slice of `AudioBus` this surface needs: a single readiness tone fired on
 * the framing false→true edge (R4.5). Structurally satisfied by `AudioBus`, and
 * trivially by a test spy — this surface never touches Web Audio directly.
 */
export interface ReadinessAudio {
  /** Confirm framing readiness with a tone (R4.5). */
  readinessTone(): void;
}

/** Callback fired when the user takes the single primary Start action (R1.3). */
export type StartHandler = () => void;

/** Construction options for {@link SetupSurface}. */
export interface SetupSurfaceOptions {
  /**
   * Audio channel for the readiness tone (R4.5). Structurally an `AudioBus`; a
   * spy `{ readinessTone() }` satisfies it in tests.
   */
  readonly audio: ReadinessAudio;
  /**
   * Called when Start is taken while framing is valid. The machine maps this to
   * `START_REQUESTED` → ARMED (accepted only when framing is valid, R4.5).
   */
  readonly onStart: StartHandler;
  /**
   * The exercise catalogue (DATA projection) fed to the mounted grid. Optional;
   * can also be supplied later via {@link setExercises}.
   */
  readonly exercises?: readonly ExerciseSpecMeta[];
  /**
   * Performance history (opaque exercise ids, most-recent last) for the grid's
   * recents row (R7.4). Optional; also settable via {@link setHistory}.
   */
  readonly history?: readonly string[];
}

/**
 * The SETUP surface. Framework-free; `mount` attaches the camera preview,
 * mounts the grid, and paints the initial (blocked) framing guidance;
 * `updateFraming` drives all framing state; `unmount` tears everything down.
 */
export class SetupSurface implements Surface {
  private readonly audio: ReadinessAudio;
  private readonly onStartCb: StartHandler;

  private readonly root: HTMLDivElement;
  /** Full-bleed camera preview, painted UNDER every overlay (R2.3). */
  private readonly cameraLayer: HTMLDivElement;
  /** Overlay layer composited ABOVE the camera (R2.3); holds all UI. */
  private readonly overlay: HTMLDivElement;
  /** Silhouette-style framing guide (R4.1). */
  private readonly silhouette: HTMLDivElement;
  /** The plain-language framing guidance line (R4.2–R4.4, R5.5). */
  private readonly guidanceLine: HTMLDivElement;
  /** The required-camera-angle readout, shown on selection (R7.5). */
  private readonly angleReadout: HTMLDivElement;
  /** The single primary action (R1.3). */
  private readonly startButton: HTMLButtonElement;

  private readonly grid: ExerciseGrid;

  private host: HTMLElement | null = null;

  private exercises: readonly ExerciseSpecMeta[] = [];
  private selectedId: string | null = null;
  /** The most recent verdict; drives Start `disabled` and the guidance text. */
  private lastOk = false;
  /** Pending history to apply once the grid is mounted. */
  private pendingHistory: readonly string[] = [];

  constructor(options: SetupSurfaceOptions) {
    this.audio = options.audio;
    this.onStartCb = options.onStart;

    this.root = document.createElement('div');
    this.root.className = 'setup-surface';
    this.root.style.position = 'absolute';
    this.root.style.inset = '0';

    // --- Full-bleed camera preview, UNDER every overlay (R2.3) -------------
    this.cameraLayer = document.createElement('div');
    this.cameraLayer.className = 'setup-surface__camera';
    this.cameraLayer.setAttribute('aria-label', 'camera preview');
    this.cameraLayer.style.position = 'absolute';
    this.cameraLayer.style.inset = '0';
    this.cameraLayer.style.zIndex = '0';

    // --- Overlay layer, ABOVE the camera (R2.3) ---------------------------
    this.overlay = document.createElement('div');
    this.overlay.className = 'setup-surface__overlay';
    this.overlay.style.position = 'absolute';
    this.overlay.style.inset = '0';
    this.overlay.style.zIndex = '1';
    this.overlay.style.display = 'flex';
    this.overlay.style.flexDirection = 'column';

    // Silhouette-style guide (R4.1): a centred outline the user aligns to.
    this.silhouette = document.createElement('div');
    this.silhouette.className = 'setup-surface__silhouette';
    this.silhouette.setAttribute('aria-hidden', 'true');

    // Plain-language framing guidance (R4.2–R4.4, R5.5).
    this.guidanceLine = document.createElement('div');
    this.guidanceLine.className = 'setup-surface__guidance';
    this.guidanceLine.setAttribute('role', 'status');
    this.guidanceLine.setAttribute('aria-live', 'polite');
    this.guidanceLine.setAttribute('aria-label', 'framing guidance');

    // Required-camera-angle readout, revealed on selection (R7.5).
    this.angleReadout = document.createElement('div');
    this.angleReadout.className = 'setup-surface__angle';
    this.angleReadout.setAttribute('role', 'note');
    this.angleReadout.setAttribute('aria-label', 'required camera angle');
    this.angleReadout.hidden = true;

    // The mounted exercise grid (R7.1).
    this.grid = new ExerciseGrid();
    this.grid.onSelect((id) => this.handleSelect(id));

    // The single primary action (R1.3). Disabled until framing is valid (R4.5).
    this.startButton = document.createElement('button');
    this.startButton.type = 'button';
    this.startButton.className = 'setup-surface__start';
    this.startButton.textContent = 'Start';
    this.startButton.disabled = true;
    this.startButton.setAttribute('aria-label', 'start');
    this.startButton.addEventListener('click', () => this.handleStart());

    // Overlay children are assembled in mount() (the grid must be mounted into
    // it there), so nothing is appended to the overlay in the constructor.

    if (options.exercises) {
      this.exercises = options.exercises.slice();
    }
    if (options.history) {
      this.pendingHistory = options.history.slice();
    }
  }

  /**
   * Attach the surface into `host`: camera preview underneath, overlay above
   * with the silhouette, angle readout, guidance line, mounted grid, and Start
   * button. Paints the initial blocked guidance (framing not yet valid).
   */
  mount(host: HTMLElement, _ctx: SessionContext): void {
    this.host = host;

    // Rebuild the overlay children cleanly (the constructor placeholder aside).
    this.overlay.replaceChildren();
    this.overlay.append(this.silhouette, this.angleReadout, this.guidanceLine);

    // Mount the grid into the overlay so its cards composite above the camera.
    this.grid.mount(this.overlay);
    if (this.exercises.length > 0) {
      this.grid.setExercises(this.exercises);
    }
    if (this.pendingHistory.length > 0) {
      this.grid.setHistory(this.pendingHistory);
    }

    this.overlay.appendChild(this.startButton);

    this.root.append(this.cameraLayer, this.overlay);
    host.appendChild(this.root);

    // Initial state: framing not yet satisfied → Start disabled, guidance shown.
    this.renderGuidance(null);
    this.startButton.disabled = true;
  }

  /** Detach the surface and the mounted grid; drop the host reference. */
  unmount(): void {
    this.grid.unmount();
    if (this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    this.host = null;
  }

  /**
   * Replace the exercise catalogue fed to the grid (DATA projection). Safe to
   * call before or after {@link mount}.
   */
  setExercises(meta: readonly ExerciseSpecMeta[]): void {
    this.exercises = meta.slice();
    if (this.host) {
      this.grid.setExercises(this.exercises);
    }
  }

  /**
   * Replace the performance history feeding the grid's recents row (R7.4). Safe
   * to call before or after {@link mount}.
   */
  setHistory(ids: readonly string[]): void {
    this.pendingHistory = ids.slice();
    if (this.host) {
      this.grid.setHistory(this.pendingHistory);
    }
  }

  /**
   * Feed the surface a fresh {@link FramingVerdict} from the frame loop (R4.1).
   * This is the single seam for framing state: it repaints the guidance
   * (R4.2–R4.4), binds Start's `disabled` to `!verdict.ok` (R1.3, R4.5), and
   * fires {@link ReadinessAudio.readinessTone} EXACTLY ONCE on the not-ok → ok
   * edge (R4.5). Re-arms only after framing drops back to not-ok.
   */
  updateFraming(verdict: FramingVerdict): void {
    const wasOk = this.lastOk;
    this.lastOk = verdict.ok;

    this.renderGuidance(verdict);
    // Start is enabled iff framing is valid (R4.5); disabled binds to !ok.
    this.startButton.disabled = !verdict.ok;

    // Fire the readiness tone once, only on the rising (false → true) edge.
    if (verdict.ok && !wasOk) {
      this.audio.readinessTone();
    }
  }

  /** The currently-selected exercise id (opaque), or `null` if none. */
  getSelectedExerciseId(): string | null {
    return this.selectedId;
  }

  /** Whether Start is currently enabled (mirrors framing validity). */
  isStartEnabled(): boolean {
    return !this.startButton.disabled;
  }

  // --- Internals ------------------------------------------------------------

  /**
   * Handle a grid selection (R7.5): record the opaque id and reveal the
   * exercise's required camera angle before start. The id is data, never
   * rendered as a label.
   */
  private handleSelect(id: string): void {
    this.selectedId = id;
    const meta = this.exercises.find((e) => e.id === id) ?? null;
    this.renderAngleReadout(meta);
  }

  /** Fire `onStart` only when framing is valid (Start would be disabled otherwise). */
  private handleStart(): void {
    if (this.startButton.disabled) return;
    this.onStartCb();
  }

  /**
   * Render the required-camera-angle readout for the selected exercise (R7.5),
   * derived entirely from `meta.camera` DATA. Hidden when nothing is selected.
   */
  private renderAngleReadout(meta: ExerciseSpecMeta | null): void {
    if (!meta) {
      this.angleReadout.hidden = true;
      this.angleReadout.textContent = '';
      return;
    }
    const { preferredAngleDeg, toleranceDeg, view } = meta.camera;
    // `view` is a data-defined descriptor (e.g. "side" / "front"); angle values
    // are numeric data. No exercise identity appears here.
    this.angleReadout.hidden = false;
    this.angleReadout.textContent =
      `Camera angle: ${view} view, about ${preferredAngleDeg}° (±${toleranceDeg}°)`;
  }

  /**
   * Paint the plain-language framing guidance from a verdict (R4.2–R4.4), or the
   * initial "getting the camera ready" prompt when no verdict has arrived yet.
   * Phrased in camera/body terms, never model terms (R5.5).
   *
   * Priority mirrors the sub-checks so the user is told the single most useful
   * next correction: missing landmarks → angle → distance → ready.
   */
  private renderGuidance(verdict: FramingVerdict | null): void {
    if (verdict === null) {
      this.guidanceLine.textContent = 'Getting the camera ready';
      return;
    }

    if (verdict.ok) {
      // Readiness in camera terms, not model terms (R5.5).
      this.guidanceLine.textContent = 'All set — ready to start';
      return;
    }

    // Missing body parts (R4.2): name them in plain language.
    if (verdict.missingLandmarks.length > 0) {
      const parts = verdict.missingLandmarks.join(', ');
      this.guidanceLine.textContent = `Bring into frame: ${parts}`;
      return;
    }

    // Angle correction (R4.3): state the required direction.
    if (verdict.angleCorrection) {
      const { direction, degrees } = verdict.angleCorrection;
      this.guidanceLine.textContent =
        `Turn the camera ${direction} about ${Math.round(degrees)}°`;
      return;
    }

    // Distance (R4.4): move closer / further, in approximate metres.
    if (verdict.distance !== 'ok') {
      const dir = verdict.distance === 'too_far' ? 'closer' : 'further away';
      const metres = verdict.distanceHintMetres;
      this.guidanceLine.textContent =
        metres !== null
          ? `Move ${dir} about ${metres} m`
          : `Move ${dir}`;
      return;
    }

    // Fallback: not ok but no specific sub-check flagged — keep a neutral prompt.
    this.guidanceLine.textContent = 'Adjust your framing';
  }
}
