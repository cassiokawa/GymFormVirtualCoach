/**
 * Ground-truth annotation tool (Req 7).
 *
 * {@link AnnotationTool} renders a video frame onto a canvas and lets the user
 * click to place each of the 33 MediaPipe pose landmarks, flag occluded
 * landmarks as "not visible", and persist the result as a {@link
 * GroundTruthFrame} via {@link ResultStore}. Placed markers carry their index
 * and MediaPipe landmark name label for disambiguation (Req 7.6).
 *
 * Coordinates are stored normalized to [0, 1] relative to the canvas so they
 * are resolution-independent and directly comparable with adapter output
 * (Req 7.1). Saving requires every landmark to be either placed or explicitly
 * flagged not-visible; otherwise it throws listing the missing indices (Req
 * 7.8). Previously saved annotations can be reloaded for adjustment (Req 7.5).
 *
 * Rendering is vanilla canvas 2D with a dark theme; no framework dependencies.
 *
 * Requirements covered: 7.1, 7.2, 7.3, 7.5, 7.6, 7.8
 */

import type { GroundTruthFrame } from '../types.js';
import type { ResultStore } from '../store/ResultStore.js';

/**
 * The 33 MediaPipe Pose (BlazePose) landmark names in canonical index order.
 * See the MediaPipe Pose landmark model documentation.
 */
export const MEDIAPIPE_LANDMARK_NAMES: readonly string[] = [
  'nose', // 0
  'left_eye_inner', // 1
  'left_eye', // 2
  'left_eye_outer', // 3
  'right_eye_inner', // 4
  'right_eye', // 5
  'right_eye_outer', // 6
  'left_ear', // 7
  'right_ear', // 8
  'mouth_left', // 9
  'mouth_right', // 10
  'left_shoulder', // 11
  'right_shoulder', // 12
  'left_elbow', // 13
  'right_elbow', // 14
  'left_wrist', // 15
  'right_wrist', // 16
  'left_pinky', // 17
  'right_pinky', // 18
  'left_index', // 19
  'right_index', // 20
  'left_thumb', // 21
  'right_thumb', // 22
  'left_hip', // 23
  'right_hip', // 24
  'left_knee', // 25
  'right_knee', // 26
  'left_ankle', // 27
  'right_ankle', // 28
  'left_heel', // 29
  'right_heel', // 30
  'left_foot_index', // 31
  'right_foot_index', // 32
] as const;

/** Total MediaPipe Pose landmark count. */
export const LANDMARK_COUNT = 33;

/** A placed keypoint in normalized [0, 1] canvas coordinates. */
interface PlacedPoint {
  x: number;
  y: number;
}

/**
 * Per-index annotation status. A landmark is "unassigned" until it is either
 * placed (`point` set) or explicitly flagged not-visible.
 */
interface KeypointState {
  /** Normalized position, or `null` when unplaced. */
  point: PlacedPoint | null;
  /** True when explicitly flagged occluded/not-visible. */
  notVisible: boolean;
}

/** Snapshot of the current annotation state, exposed for testing. */
export interface AnnotationState {
  sourceVideoId: string | null;
  frameIndex: number | null;
  selectedIndex: number;
  /** Length 33: normalized coords, or `null` where unplaced. */
  points: Array<PlacedPoint | null>;
  /** Length 33: not-visible flags. */
  notVisible: boolean[];
  /** Id when editing a previously saved annotation, else `null`. */
  editingId: string | null;
}

/** Constructor dependencies for {@link AnnotationTool}. */
export interface AnnotationToolDeps {
  canvas: HTMLCanvasElement;
  store: ResultStore;
}

const DARK_BG = '#0f172a';
const MARKER_PLACED = '#22c55e';
const MARKER_SELECTED = '#38bdf8';
const MARKER_NOT_VISIBLE = '#ef4444';
const LABEL_TEXT = '#e2e8f0';
const LABEL_BG = 'rgba(15, 23, 42, 0.75)';
const MARKER_RADIUS = 5;

export class AnnotationTool {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly store: ResultStore;

  /** Current frame image, retained so markers can be re-composited on redraw. */
  private image: ImageBitmap | HTMLImageElement | HTMLCanvasElement | null = null;

  private sourceVideoId: string | null = null;
  private frameIndex: number | null = null;
  private editingId: string | null = null;
  private selectedIndex = 0;

  /** Per-landmark annotation state, always length {@link LANDMARK_COUNT}. */
  private readonly keypoints: KeypointState[] = AnnotationTool.freshKeypoints();

  private readonly clickHandler = (event: MouseEvent): void => this.onClick(event);

  constructor(deps: AnnotationToolDeps) {
    this.canvas = deps.canvas;
    this.store = deps.store;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('AnnotationTool: unable to obtain 2D canvas context');
    }
    this.ctx = ctx;
    this.canvas.addEventListener('click', this.clickHandler);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Displays `image` as the frame to annotate and resets all placement state
   * (Req 7.1). Sizes the canvas backing store to the image's intrinsic
   * dimensions so normalized coordinates map cleanly.
   */
  loadFrame(
    sourceVideoId: string,
    frameIndex: number,
    image: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  ): void {
    this.sourceVideoId = sourceVideoId;
    this.frameIndex = frameIndex;
    this.editingId = null;
    this.image = image;
    this.selectedIndex = 0;
    this.resetKeypoints();
    this.render();
  }

  /**
   * Selects which of the 33 landmarks the next click will place (Req 7.1).
   * @throws {RangeError} If `index` is outside [0, 32].
   */
  selectKeypoint(index: number): void {
    this.assertIndex(index);
    this.selectedIndex = index;
    this.render();
  }

  /**
   * Flags a landmark as occluded/not-visible, clearing any placed position
   * (Req 7.2). Advances selection to the next unassigned landmark.
   * @throws {RangeError} If `index` is outside [0, 32].
   */
  markNotVisible(index: number): void {
    this.assertIndex(index);
    const kp = this.keypoints[index];
    if (!kp) return;
    kp.notVisible = true;
    kp.point = null;
    this.advanceSelection();
    this.render();
  }

  /**
   * Validates that all 33 landmarks are placed or flagged not-visible, then
   * persists a {@link GroundTruthFrame} via the store and returns it (Req 7.3,
   * 7.8). The frame image is captured from the current canvas as a Blob.
   *
   * @throws {Error} If no frame is loaded, or if any landmark is unassigned
   *   (message lists the missing indices).
   */
  async save(): Promise<GroundTruthFrame> {
    if (this.sourceVideoId === null || this.frameIndex === null) {
      throw new Error('AnnotationTool: no frame loaded; call loadFrame() before save()');
    }

    const missing = this.unassignedIndices();
    if (missing.length > 0) {
      throw new Error(
        `AnnotationTool: cannot save — ${missing.length} keypoint(s) unassigned: ` +
          `[${missing.join(', ')}]. Place a marker or mark them not-visible.`,
      );
    }

    const keypoints: Array<{ x: number; y: number }> = this.keypoints.map((kp) =>
      kp.point ? { x: kp.point.x, y: kp.point.y } : { x: 0, y: 0 },
    );
    const visibility: boolean[] = this.keypoints.map((kp) => !kp.notVisible);

    const imageRef = await this.captureCanvasBlob();

    const frame: GroundTruthFrame = {
      id: this.editingId ?? crypto.randomUUID(),
      sourceVideoId: this.sourceVideoId,
      frameIndex: this.frameIndex,
      imageRef,
      keypoints,
      visibility,
      createdMs: Date.now(),
    };

    await this.store.saveAnnotation(frame);
    // Retain the id so subsequent saves update the same record.
    this.editingId = frame.id;
    return frame;
  }

  /**
   * Loads a previously saved {@link GroundTruthFrame} for adjustment (Req 7.5).
   * Placed positions and visibility flags are restored; the stored image blob
   * is decoded and drawn as the background.
   *
   * @throws {Error} If no annotation with `id` exists.
   */
  async loadForEdit(id: string): Promise<void> {
    const frame = await this.store.getAnnotation(id);
    if (!frame) {
      throw new Error(`AnnotationTool: no saved annotation found for id "${id}"`);
    }

    this.editingId = frame.id;
    this.sourceVideoId = frame.sourceVideoId;
    this.frameIndex = frame.frameIndex;
    this.selectedIndex = 0;

    for (let i = 0; i < LANDMARK_COUNT; i += 1) {
      const kp = this.keypoints[i];
      if (!kp) continue;
      const visible = frame.visibility[i] ?? false;
      const coord = frame.keypoints[i];
      if (visible && coord) {
        kp.point = { x: coord.x, y: coord.y };
        kp.notVisible = false;
      } else {
        kp.point = null;
        kp.notVisible = true;
      }
    }

    this.image = await this.decodeBlob(frame.imageRef);
    this.render();
  }

  /** Returns a snapshot of placement + visibility state (for testing). */
  getState(): AnnotationState {
    return {
      sourceVideoId: this.sourceVideoId,
      frameIndex: this.frameIndex,
      selectedIndex: this.selectedIndex,
      points: this.keypoints.map((kp) => (kp.point ? { ...kp.point } : null)),
      notVisible: this.keypoints.map((kp) => kp.notVisible),
      editingId: this.editingId,
    };
  }

  /** Detaches the canvas click listener. Call when discarding the tool. */
  dispose(): void {
    this.canvas.removeEventListener('click', this.clickHandler);
  }

  // -------------------------------------------------------------------------
  // Event handling
  // -------------------------------------------------------------------------

  /**
   * Places the currently-selected landmark at the clicked location, converted
   * to normalized [0, 1] canvas coordinates, then auto-advances to the next
   * unplaced landmark (Req 7.1).
   */
  private onClick(event: MouseEvent): void {
    if (this.sourceVideoId === null) return;

    const rect = this.canvas.getBoundingClientRect();
    // Guard against a zero-sized rect (canvas not laid out yet).
    const width = rect.width || this.canvas.width || 1;
    const height = rect.height || this.canvas.height || 1;
    const nx = clamp01((event.clientX - rect.left) / width);
    const ny = clamp01((event.clientY - rect.top) / height);

    const kp = this.keypoints[this.selectedIndex];
    if (!kp) return;
    kp.point = { x: nx, y: ny };
    kp.notVisible = false;

    this.advanceSelection();
    this.render();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** Redraws the frame background and every placed / flagged marker. */
  private render(): void {
    const { width, height } = this.canvas;
    this.ctx.save();
    this.ctx.fillStyle = DARK_BG;
    this.ctx.fillRect(0, 0, width, height);

    if (this.image) {
      try {
        this.ctx.drawImage(this.image, 0, 0, width, height);
      } catch {
        // A detached/closed ImageBitmap can throw; keep the dark background.
      }
    }

    for (let i = 0; i < LANDMARK_COUNT; i += 1) {
      const kp = this.keypoints[i];
      if (!kp || !kp.point) continue;
      this.drawMarker(i, kp.point, i === this.selectedIndex);
    }

    this.ctx.restore();
  }

  /** Draws a single marker dot plus its "index name" label (Req 7.6). */
  private drawMarker(index: number, point: PlacedPoint, selected: boolean): void {
    const { width, height } = this.canvas;
    const px = point.x * width;
    const py = point.y * height;
    const name = MEDIAPIPE_LANDMARK_NAMES[index] ?? `kp_${index}`;
    const label = `${index} ${name}`;

    this.ctx.save();

    // Marker dot.
    this.ctx.beginPath();
    this.ctx.arc(px, py, MARKER_RADIUS, 0, Math.PI * 2);
    this.ctx.fillStyle = selected ? MARKER_SELECTED : MARKER_PLACED;
    this.ctx.fill();
    this.ctx.lineWidth = 1.5;
    this.ctx.strokeStyle = DARK_BG;
    this.ctx.stroke();

    // Label pill.
    this.ctx.font = '11px sans-serif';
    this.ctx.textBaseline = 'middle';
    const metrics = this.ctx.measureText(label);
    const padX = 4;
    const labelW = metrics.width + padX * 2;
    const labelH = 16;
    const labelX = px + MARKER_RADIUS + 2;
    const labelY = py - labelH / 2;

    this.ctx.fillStyle = LABEL_BG;
    this.ctx.fillRect(labelX, labelY, labelW, labelH);
    this.ctx.fillStyle = LABEL_TEXT;
    this.ctx.fillText(label, labelX + padX, py);

    this.ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Indices with neither a placed point nor a not-visible flag. */
  private unassignedIndices(): number[] {
    const missing: number[] = [];
    for (let i = 0; i < LANDMARK_COUNT; i += 1) {
      const kp = this.keypoints[i];
      if (!kp) {
        missing.push(i);
        continue;
      }
      if (kp.point === null && !kp.notVisible) missing.push(i);
    }
    return missing;
  }

  /**
   * Advances `selectedIndex` to the next landmark that is still unassigned,
   * scanning circularly. Leaves the selection unchanged when all are assigned.
   */
  private advanceSelection(): void {
    for (let step = 1; step <= LANDMARK_COUNT; step += 1) {
      const candidate = (this.selectedIndex + step) % LANDMARK_COUNT;
      const kp = this.keypoints[candidate];
      if (kp && kp.point === null && !kp.notVisible) {
        this.selectedIndex = candidate;
        return;
      }
    }
  }

  /** Resets every landmark to unassigned. */
  private resetKeypoints(): void {
    for (let i = 0; i < LANDMARK_COUNT; i += 1) {
      const kp = this.keypoints[i];
      if (!kp) continue;
      kp.point = null;
      kp.notVisible = false;
    }
  }

  private assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= LANDMARK_COUNT) {
      throw new RangeError(
        `AnnotationTool: keypoint index must be an integer in [0, ${LANDMARK_COUNT - 1}], got ${index}`,
      );
    }
  }

  /**
   * Captures the current canvas contents as a PNG Blob, using
   * `convertToBlob` when available (OffscreenCanvas) and falling back to
   * `toBlob` for a standard HTMLCanvasElement.
   */
  private captureCanvasBlob(): Promise<Blob> {
    const canvas = this.canvas as unknown as {
      convertToBlob?: (opts?: { type?: string }) => Promise<Blob>;
      toBlob?: (cb: (blob: Blob | null) => void, type?: string) => void;
    };

    if (typeof canvas.convertToBlob === 'function') {
      return canvas.convertToBlob({ type: 'image/png' });
    }

    if (typeof canvas.toBlob === 'function') {
      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob!((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('AnnotationTool: canvas.toBlob produced no data'));
        }, 'image/png');
      });
    }

    return Promise.reject(
      new Error('AnnotationTool: canvas does not support convertToBlob or toBlob'),
    );
  }

  /**
   * Decodes a stored image Blob into a drawable source. Prefers
   * `createImageBitmap`; returns `null` when no decoder is available so the
   * caller falls back to the dark background.
   */
  private async decodeBlob(
    blob: Blob,
  ): Promise<ImageBitmap | HTMLImageElement | HTMLCanvasElement | null> {
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(blob);
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Builds a fresh length-33 keypoint state array. */
  private static freshKeypoints(): KeypointState[] {
    return Array.from({ length: LANDMARK_COUNT }, () => ({ point: null, notVisible: false }));
  }
}

/** Clamps a value into the normalized [0, 1] range. */
function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
