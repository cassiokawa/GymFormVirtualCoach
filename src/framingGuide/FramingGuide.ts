/**
 * Framing Guide — renders a target silhouette zone on a canvas overlay and
 * computes a framing score based on keypoint visibility and bounding-box
 * overlap with the target zone.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
 */

import type { BoundingBox, Keypoint } from '../types/index.js';

/**
 * Minimum visible keypoints (confidence >= 0.5) before suppressing the
 * "Step back" prompt.
 */
const MIN_VISIBLE_KEYPOINTS = 25;

/** Total MediaPipe Pose keypoints. */
const TOTAL_KEYPOINTS = 33;

/** Confidence threshold to consider a keypoint "visible". */
const VISIBILITY_THRESHOLD = 0.5;

/**
 * Target zone expressed as normalised coordinates.
 * Centred rectangle with 10% horizontal inset and 5% vertical inset:
 *   x = 0.1, y = 0.05, width = 0.8, height = 0.9
 */
const TARGET_ZONE: BoundingBox = {
  x: 0.1,
  y: 0.05,
  width: 0.8,
  height: 0.9,
};

export class FramingGuide {
  private readonly targetZone: BoundingBox = TARGET_ZONE;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('FramingGuide: unable to obtain 2D canvas context');
    }
    this.ctx = ctx;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Process a keypoint frame and return the framing score [0, 1].
   * Also renders the target zone overlay and any guidance prompt on the canvas.
   */
  evaluate(keypoints: Keypoint[]): number {
    const visibleCount = keypoints.filter(
      (kp) => kp.confidence >= VISIBILITY_THRESHOLD,
    ).length;
    const visibilityRatio = visibleCount / TOTAL_KEYPOINTS;

    const userBox = this.computeBoundingBox(keypoints);
    const overlapRatio = userBox
      ? this.computeOverlap(userBox, this.targetZone)
      : 0;

    const framingScore = 0.6 * visibilityRatio + 0.4 * overlapRatio;

    // Render overlay
    this.clear();
    const color = this.getColor(framingScore);
    this.renderTargetZone(color);

    if (visibleCount < MIN_VISIBLE_KEYPOINTS) {
      this.renderPrompt('Step back so your full body is visible');
    } else if (userBox && overlapRatio < 0.5) {
      this.renderPrompt('Move to the centre of the frame');
    }

    return framingScore;
  }

  /** Clear the framing overlay from canvas. */
  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute a normalised bounding box from visible keypoints.
   * Returns null when no keypoints pass the visibility threshold.
   */
  computeBoundingBox(keypoints: Keypoint[]): BoundingBox | null {
    const visible = keypoints.filter(
      (kp) => kp.confidence >= VISIBILITY_THRESHOLD,
    );
    if (visible.length === 0) return null;

    let minX = 1;
    let maxX = 0;
    let minY = 1;
    let maxY = 0;

    for (const kp of visible) {
      if (kp.x < minX) minX = kp.x;
      if (kp.x > maxX) maxX = kp.x;
      if (kp.y < minY) minY = kp.y;
      if (kp.y > maxY) maxY = kp.y;
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  /**
   * Compute Intersection-over-Union (IoU) between the user bounding box and
   * the target zone. Both boxes are in normalised [0, 1] coordinates.
   */
  computeOverlap(userBox: BoundingBox, targetZone: BoundingBox): number {
    const x1 = Math.max(userBox.x, targetZone.x);
    const y1 = Math.max(userBox.y, targetZone.y);
    const x2 = Math.min(
      userBox.x + userBox.width,
      targetZone.x + targetZone.width,
    );
    const y2 = Math.min(
      userBox.y + userBox.height,
      targetZone.y + targetZone.height,
    );

    const intersectionWidth = Math.max(0, x2 - x1);
    const intersectionHeight = Math.max(0, y2 - y1);
    const intersectionArea = intersectionWidth * intersectionHeight;

    const userArea = userBox.width * userBox.height;
    const targetArea = targetZone.width * targetZone.height;
    const unionArea = userArea + targetArea - intersectionArea;

    if (unionArea <= 0) return 0;
    return intersectionArea / unionArea;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /**
   * Render the target zone as a dashed rounded rectangle with a simplified
   * body silhouette inside.
   */
  private renderTargetZone(color: string): void {
    const { width, height } = this.canvas;
    const x = this.targetZone.x * width;
    const y = this.targetZone.y * height;
    const w = this.targetZone.width * width;
    const h = this.targetZone.height * height;
    const radius = 16;

    this.ctx.save();
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 2;
    this.ctx.setLineDash([10, 6]);
    this.ctx.globalAlpha = 0.7;

    // Rounded rectangle
    this.ctx.beginPath();
    this.ctx.moveTo(x + radius, y);
    this.ctx.lineTo(x + w - radius, y);
    this.ctx.arcTo(x + w, y, x + w, y + radius, radius);
    this.ctx.lineTo(x + w, y + h - radius);
    this.ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
    this.ctx.lineTo(x + radius, y + h);
    this.ctx.arcTo(x, y + h, x, y + h - radius, radius);
    this.ctx.lineTo(x, y + radius);
    this.ctx.arcTo(x, y, x + radius, y, radius);
    this.ctx.closePath();
    this.ctx.stroke();

    // Simplified body silhouette (stick figure)
    this.ctx.globalAlpha = 0.3;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 3;
    this.ctx.setLineDash([]);

    const cx = x + w / 2;
    const headY = y + h * 0.12;
    const headRadius = h * 0.05;
    const shoulderY = headY + headRadius + h * 0.05;
    const hipY = shoulderY + h * 0.3;
    const footY = y + h * 0.88;
    const shoulderWidth = w * 0.15;
    const hipWidth = w * 0.08;

    // Head
    this.ctx.beginPath();
    this.ctx.arc(cx, headY, headRadius, 0, Math.PI * 2);
    this.ctx.stroke();

    // Spine
    this.ctx.beginPath();
    this.ctx.moveTo(cx, headY + headRadius);
    this.ctx.lineTo(cx, hipY);
    this.ctx.stroke();

    // Arms
    this.ctx.beginPath();
    this.ctx.moveTo(cx - shoulderWidth, shoulderY + h * 0.12);
    this.ctx.lineTo(cx, shoulderY);
    this.ctx.lineTo(cx + shoulderWidth, shoulderY + h * 0.12);
    this.ctx.stroke();

    // Legs
    this.ctx.beginPath();
    this.ctx.moveTo(cx - hipWidth, footY);
    this.ctx.lineTo(cx, hipY);
    this.ctx.lineTo(cx + hipWidth, footY);
    this.ctx.stroke();

    this.ctx.restore();
  }

  /** Render a text prompt as a white overlay in the lower portion of canvas. */
  private renderPrompt(message: string): void {
    const { width, height } = this.canvas;
    this.ctx.save();

    this.ctx.font = `bold ${Math.max(14, height * 0.03)}px sans-serif`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';

    // Background pill
    const textMetrics = this.ctx.measureText(message);
    const textWidth = textMetrics.width;
    const pillX = width / 2 - textWidth / 2 - 16;
    const pillY = height * 0.88;
    const pillW = textWidth + 32;
    const pillH = height * 0.05;

    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    this.ctx.beginPath();
    this.ctx.roundRect(pillX, pillY, pillW, pillH, 8);
    this.ctx.fill();

    // Text
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillText(message, width / 2, pillY + pillH / 2);

    this.ctx.restore();
  }

  /**
   * Determine overlay color based on framing score thresholds:
   * - < 0.5 → red
   * - 0.5–0.7 → yellow
   * - ≥ 0.7 → green
   */
  private getColor(score: number): string {
    if (score < 0.5) return '#ef4444'; // red
    if (score < 0.7) return '#eab308'; // yellow
    return '#22c55e'; // green
  }
}
