/**
 * ComparisonView — renders side-by-side pose skeleton overlays for up to four
 * pose models on the same source frame, a metric summary table, per-keypoint
 * divergence highlighting, and per-panel error indicators.
 *
 * The view is model-agnostic: callers push a {@link ComparisonFrame} carrying
 * each model's keypoints for a synchronized frame index, plus the shared source
 * image, and this component draws each model's skeleton into its own panel.
 *
 * Rendering follows the app's canvas style (dark theme, MediaPipe skeleton).
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import type { Keypoint } from '../../types/index.js';

/**
 * Per-frame comparison payload: the same source frame's keypoints as produced
 * by each model, keyed by model id.
 */
export interface ComparisonFrame {
  /** Synchronized frame index shared across all panels. */
  frameIndex: number;
  /** Keypoints per model id (33-keypoint MediaPipe schema expected). */
  perModel: Map<string, Keypoint[]>;
}

/** Latency/accuracy summary metrics per model for the metric table. */
interface PanelMetrics {
  fps: number;
  medianMs: number;
  oks: number | null;
}

/** Maximum number of comparison panels (Req 5.1). */
const MAX_MODELS = 4;

/**
 * Normalized-coordinate distance above which a keypoint is considered
 * divergent across models (Req 5.4).
 */
const DIVERGENCE_THRESHOLD = 0.05;

/** Confidence threshold below which a keypoint is treated as not drawable. */
const VISIBILITY_THRESHOLD = 0.5;

/**
 * MediaPipe Pose skeleton connections (index pairs). Copied from the live
 * demo renderer so overlays match the rest of the app.
 */
const CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26],
  [25, 27], [26, 28], [27, 29], [28, 30], [27, 31], [28, 32],
];

/** Skeleton connection stroke colour (matches demo teal). */
const SKELETON_COLOR = 'rgba(0, 184, 148, 0.7)';
/** Normal joint marker fill. */
const JOINT_COLOR = 'rgba(255, 255, 255, 0.9)';
/** Divergent keypoint marker fill (distinct amber, Req 5.4). */
const DIVERGENCE_COLOR = 'rgba(245, 158, 11, 0.95)';

/** Internal per-model panel handle. */
interface Panel {
  modelId: string;
  root: HTMLDivElement;
  label: HTMLDivElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  errorBanner: HTMLDivElement;
}

export class ComparisonView {
  private readonly container: HTMLElement;
  private readonly panelGrid: HTMLDivElement;
  private readonly metricTableHost: HTMLDivElement;
  private readonly panels = new Map<string, Panel>();
  private metrics = new Map<string, PanelMetrics>();

  constructor(container: HTMLElement) {
    this.container = container;

    this.panelGrid = document.createElement('div');
    this.panelGrid.style.display = 'grid';
    this.panelGrid.style.gap = '8px';
    this.panelGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';

    this.metricTableHost = document.createElement('div');
    this.metricTableHost.style.marginTop = '12px';
    this.metricTableHost.style.overflowX = 'auto';

    this.container.appendChild(this.panelGrid);
    this.container.appendChild(this.metricTableHost);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Configure the compared models, creating one panel (canvas + label) per
   * model. Up to {@link MAX_MODELS} models are accepted; any beyond that are
   * ignored (Req 5.1). Existing panels are cleared and rebuilt.
   */
  setModels(modelIds: string[]): void {
    // Reset existing DOM and state.
    this.panelGrid.replaceChildren();
    this.panels.clear();
    this.metrics = new Map();

    const capped = modelIds.slice(0, MAX_MODELS);
    for (const modelId of capped) {
      if (this.panels.has(modelId)) continue; // guard duplicate ids
      const panel = this.createPanel(modelId);
      this.panels.set(modelId, panel);
      this.panelGrid.appendChild(panel.root);
    }

    this.renderMetricTable();
  }

  /**
   * Draw the same source frame plus each model's skeleton overlay into its
   * panel, synchronizing the frame across all panels (Req 5.3). Keypoints that
   * diverge across models beyond {@link DIVERGENCE_THRESHOLD} are highlighted in
   * every panel (Req 5.4).
   */
  showFrame(
    frame: ComparisonFrame,
    source: ImageBitmap | HTMLCanvasElement | HTMLImageElement,
  ): void {
    const divergent = this.computeDivergentKeypoints(frame.perModel);

    for (const panel of this.panels.values()) {
      const keypoints = frame.perModel.get(panel.modelId) ?? [];
      this.drawPanel(panel, source, keypoints, divergent);
    }
  }

  /**
   * Render the metric summary table showing FPS, median latency, and accuracy
   * (OKS) per model. A null OKS is displayed as 'N/A' (Req 5.2).
   */
  setMetrics(metrics: Map<string, PanelMetrics>): void {
    this.metrics = new Map(metrics);
    this.renderMetricTable();
  }

  /**
   * Mark a panel as having failed to produce a pose for the current frame,
   * showing a per-panel error indicator (Req 5.5). No-op for unknown model ids.
   */
  markPanelError(modelId: string, message: string): void {
    const panel = this.panels.get(modelId);
    if (!panel) return;
    panel.errorBanner.textContent = `Error: ${message}`;
    panel.errorBanner.style.display = 'block';
  }

  // ---------------------------------------------------------------------------
  // Panel construction & rendering
  // ---------------------------------------------------------------------------

  /** Build a single model panel: a label, a canvas, and a hidden error banner. */
  private createPanel(modelId: string): Panel {
    const root = document.createElement('div');
    root.style.position = 'relative';
    root.style.background = '#111827';
    root.style.border = '1px solid #1f2937';
    root.style.borderRadius = '8px';
    root.style.overflow = 'hidden';

    const label = document.createElement('div');
    label.textContent = modelId;
    label.style.padding = '4px 8px';
    label.style.fontFamily = 'system-ui, sans-serif';
    label.style.fontSize = '12px';
    label.style.fontWeight = '600';
    label.style.color = '#e5e7eb';
    label.style.background = '#0b1220';

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.style.background = '#000';

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('ComparisonView: unable to obtain 2D canvas context');
    }

    const errorBanner = document.createElement('div');
    errorBanner.style.display = 'none';
    errorBanner.style.position = 'absolute';
    errorBanner.style.left = '0';
    errorBanner.style.right = '0';
    errorBanner.style.bottom = '0';
    errorBanner.style.padding = '4px 8px';
    errorBanner.style.fontFamily = 'system-ui, sans-serif';
    errorBanner.style.fontSize = '11px';
    errorBanner.style.color = '#fff';
    errorBanner.style.background = 'rgba(239, 68, 68, 0.85)';

    root.appendChild(label);
    root.appendChild(canvas);
    root.appendChild(errorBanner);

    return { modelId, root, label, canvas, ctx, errorBanner };
  }

  /**
   * Draw the source frame and skeleton overlay for a single panel. Clears any
   * stale error indicator since this frame produced keypoints.
   */
  private drawPanel(
    panel: Panel,
    source: ImageBitmap | HTMLCanvasElement | HTMLImageElement,
    keypoints: Keypoint[],
    divergent: ReadonlySet<number>,
  ): void {
    const { ctx, canvas } = panel;
    const w = canvas.width;
    const h = canvas.height;

    // Reset error indicator for a successful frame.
    panel.errorBanner.style.display = 'none';
    panel.errorBanner.textContent = '';

    ctx.clearRect(0, 0, w, h);
    try {
      ctx.drawImage(source, 0, 0, w, h);
    } catch {
      // Some sources (e.g. detached ImageBitmap) may throw; leave the black bg.
    }

    // Skeleton connections.
    ctx.strokeStyle = SKELETON_COLOR;
    ctx.lineWidth = 2;
    for (const [i, j] of CONNECTIONS) {
      const a = keypoints[i];
      const b = keypoints[j];
      if (!a || !b) continue;
      if (a.confidence < VISIBILITY_THRESHOLD || b.confidence < VISIBILITY_THRESHOLD) {
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(a.x * w, a.y * h);
      ctx.lineTo(b.x * w, b.y * h);
      ctx.stroke();
    }

    // Joint markers, highlighting divergent keypoints distinctly (Req 5.4).
    for (let index = 0; index < keypoints.length; index++) {
      const kp = keypoints[index];
      if (!kp) continue;
      if (kp.confidence < VISIBILITY_THRESHOLD) continue;

      const isDivergent = divergent.has(index);
      ctx.fillStyle = isDivergent ? DIVERGENCE_COLOR : JOINT_COLOR;
      ctx.beginPath();
      ctx.arc(kp.x * w, kp.y * h, isDivergent ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();

      if (isDivergent) {
        // Distinct marker: ring around the divergent joint.
        ctx.strokeStyle = DIVERGENCE_COLOR;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(kp.x * w, kp.y * h, 9, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Divergence computation
  // ---------------------------------------------------------------------------

  /**
   * Compute the set of keypoint indices whose maximum pairwise normalized
   * distance across all models exceeds {@link DIVERGENCE_THRESHOLD} (Req 5.4).
   *
   * Only keypoints present and visible in at least two models are considered.
   */
  private computeDivergentKeypoints(
    perModel: Map<string, Keypoint[]>,
  ): Set<number> {
    const divergent = new Set<number>();
    const modelKeypoints = Array.from(perModel.values());
    if (modelKeypoints.length < 2) return divergent;

    // MediaPipe schema is 33 keypoints; guard against varying lengths.
    let maxIndex = 0;
    for (const kps of modelKeypoints) {
      if (kps.length > maxIndex) maxIndex = kps.length;
    }

    for (let index = 0; index < maxIndex; index++) {
      const points: Array<{ x: number; y: number }> = [];
      for (const kps of modelKeypoints) {
        const kp = kps[index];
        if (!kp) continue;
        if (kp.confidence < VISIBILITY_THRESHOLD) continue;
        points.push({ x: kp.x, y: kp.y });
      }
      if (points.length < 2) continue;

      let maxDist = 0;
      for (let a = 0; a < points.length; a++) {
        for (let b = a + 1; b < points.length; b++) {
          const pa = points[a];
          const pb = points[b];
          if (!pa || !pb) continue;
          const dx = pa.x - pb.x;
          const dy = pa.y - pb.y;
          const dist = Math.hypot(dx, dy);
          if (dist > maxDist) maxDist = dist;
        }
      }

      if (maxDist > DIVERGENCE_THRESHOLD) divergent.add(index);
    }

    return divergent;
  }

  // ---------------------------------------------------------------------------
  // Metric table
  // ---------------------------------------------------------------------------

  /**
   * Render the metric summary table for the currently configured models.
   * OKS values that are null render as 'N/A' (Req 5.2).
   */
  private renderMetricTable(): void {
    this.metricTableHost.replaceChildren();

    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.fontFamily = 'system-ui, sans-serif';
    table.style.fontSize = '12px';
    table.style.color = '#e5e7eb';

    const headerRow = document.createElement('tr');
    for (const heading of ['Model', 'FPS', 'Median (ms)', 'OKS']) {
      const th = document.createElement('th');
      th.textContent = heading;
      th.style.textAlign = 'left';
      th.style.padding = '4px 8px';
      th.style.borderBottom = '1px solid #374151';
      th.style.color = '#9ca3af';
      headerRow.appendChild(th);
    }
    table.appendChild(headerRow);

    for (const modelId of this.panels.keys()) {
      const m = this.metrics.get(modelId);
      const row = document.createElement('tr');

      const oksText =
        m == null || m.oks == null ? 'N/A' : m.oks.toFixed(3);
      const cells = [
        modelId,
        m == null ? 'N/A' : m.fps.toFixed(1),
        m == null ? 'N/A' : m.medianMs.toFixed(1),
        oksText,
      ];

      for (const value of cells) {
        const td = document.createElement('td');
        td.textContent = value;
        td.style.padding = '4px 8px';
        td.style.borderBottom = '1px solid #1f2937';
        row.appendChild(td);
      }
      table.appendChild(row);
    }

    this.metricTableHost.appendChild(table);
  }
}
