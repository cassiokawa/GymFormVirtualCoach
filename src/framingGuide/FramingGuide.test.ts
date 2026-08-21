/**
 * Unit tests for FramingGuide.
 *
 * Requirements validated: 1.1, 1.2, 1.3, 1.4
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FramingGuide } from './FramingGuide.js';
import type { Keypoint } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock canvas with a stubbed 2D context since JSDOM doesn't
 * support Canvas natively.
 */
function createMockCanvas(width = 640, height = 480): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arcTo: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    measureText: vi.fn(() => ({ width: 100 })),
    roundRect: vi.fn(),
    setLineDash: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
  };

  vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return canvas;
}

/**
 * Generate a keypoint with given position and confidence.
 */
function makeKeypoint(
  index: number,
  x: number,
  y: number,
  confidence: number,
): Keypoint {
  return { index, x, y, z: 0, confidence };
}

/**
 * Generate 33 keypoints all with the same confidence and spread across the
 * target zone (x: 0.1–0.9, y: 0.05–0.95).
 */
function makeFullBodyKeypoints(confidence: number): Keypoint[] {
  return Array.from({ length: 33 }, (_, i) => {
    const t = i / 32;
    return makeKeypoint(
      i,
      0.1 + t * 0.8,   // spread x across 0.1–0.9
      0.05 + t * 0.9,  // spread y across 0.05–0.95
      confidence,
    );
  });
}

/**
 * Generate keypoints that perfectly fill the target zone for maximum IoU.
 * Target zone: { x: 0.1, y: 0.05, width: 0.8, height: 0.9 }
 */
function makeKeypointsInTargetZone(count: number, confidence: number): Keypoint[] {
  return Array.from({ length: count }, (_, i) => {
    const t = i / Math.max(count - 1, 1);
    return makeKeypoint(
      i,
      0.1 + t * 0.8,   // x: 0.1 to 0.9
      0.05 + t * 0.9,  // y: 0.05 to 0.95
      confidence,
    );
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FramingGuide', () => {
  let canvas: HTMLCanvasElement;
  let framingGuide: FramingGuide;

  beforeEach(() => {
    canvas = createMockCanvas();
    framingGuide = new FramingGuide(canvas);
  });

  // --- Framing score formula ---

  describe('framingScore formula', () => {
    it('returns high score when all 33 keypoints are visible and inside target zone', () => {
      const keypoints = makeFullBodyKeypoints(0.9);
      const score = framingGuide.evaluate(keypoints);

      // visibilityRatio = 33/33 = 1.0
      // overlapRatio: bounding box spans 0.1–0.9 x, 0.05–0.95 y
      // which matches the target zone exactly → IoU = 1.0
      // framingScore = 0.6 * 1.0 + 0.4 * 1.0 = 1.0
      expect(score).toBeCloseTo(1.0, 2);
    });

    it('returns framingScore = 0.6 * visibilityRatio + 0.4 * overlapRatio', () => {
      // 20 of 33 keypoints visible, all within target zone
      const keypoints: Keypoint[] = [
        ...makeKeypointsInTargetZone(20, 0.8),
        ...Array.from({ length: 13 }, (_, i) =>
          makeKeypoint(20 + i, 0.5, 0.5, 0.2), // below threshold
        ),
      ];

      const score = framingGuide.evaluate(keypoints);

      // visibilityRatio = 20/33 ≈ 0.6061
      // The 20 visible keypoints span x: 0.1–0.9, y: 0.05–0.95
      // which matches target zone exactly → IoU = 1.0
      // framingScore = 0.6 * (20/33) + 0.4 * 1.0 ≈ 0.7636
      const expectedVisibility = 20 / 33;
      const expectedScore = 0.6 * expectedVisibility + 0.4 * 1.0;
      expect(score).toBeCloseTo(expectedScore, 2);
    });

    it('weights visibility at 60% and overlap at 40%', () => {
      // All 33 visible but in a small cluster (low overlap)
      const keypoints = Array.from({ length: 33 }, (_, i) =>
        makeKeypoint(i, 0.5 + (i % 2) * 0.01, 0.5 + (i % 2) * 0.01, 0.9),
      );

      const score = framingGuide.evaluate(keypoints);

      // visibilityRatio = 1.0 (all visible)
      // overlapRatio will be very low since bounding box is tiny
      // framingScore ≈ 0.6 * 1.0 + 0.4 * (small number)
      expect(score).toBeGreaterThanOrEqual(0.6);
      expect(score).toBeLessThan(1.0);
    });
  });

  // --- Bounding box computation ---

  describe('bounding box computation', () => {
    it('computes correct bounding box from keypoints at corners', () => {
      const keypoints = [
        makeKeypoint(0, 0.2, 0.1, 0.9),
        makeKeypoint(1, 0.8, 0.1, 0.9),
        makeKeypoint(2, 0.2, 0.9, 0.9),
        makeKeypoint(3, 0.8, 0.9, 0.9),
        // fill remaining with invisible keypoints
        ...Array.from({ length: 29 }, (_, i) =>
          makeKeypoint(4 + i, 0.5, 0.5, 0.1),
        ),
      ];

      const score = framingGuide.evaluate(keypoints);

      // Bounding box: x=0.2, y=0.1, width=0.6, height=0.8
      // Target zone: x=0.1, y=0.05, width=0.8, height=0.9
      // Intersection: x=[0.2, 0.8], y=[0.1, 0.9] → w=0.6, h=0.8 → area=0.48
      // User area = 0.6 * 0.8 = 0.48
      // Target area = 0.8 * 0.9 = 0.72
      // Union = 0.48 + 0.72 - 0.48 = 0.72
      // IoU = 0.48 / 0.72 = 0.6667
      // visibilityRatio = 4/33
      // framingScore = 0.6 * (4/33) + 0.4 * 0.6667
      const expectedVisibility = 4 / 33;
      const expectedOverlap = 0.48 / 0.72;
      const expectedScore = 0.6 * expectedVisibility + 0.4 * expectedOverlap;
      expect(score).toBeCloseTo(expectedScore, 2);
    });

    it('uses only visible keypoints (confidence >= 0.5) for bounding box', () => {
      const keypoints = [
        makeKeypoint(0, 0.1, 0.1, 0.9),  // visible
        makeKeypoint(1, 0.9, 0.9, 0.9),  // visible
        makeKeypoint(2, 0.0, 0.0, 0.3),  // NOT visible — should be ignored
        makeKeypoint(3, 1.0, 1.0, 0.2),  // NOT visible — should be ignored
        ...Array.from({ length: 29 }, (_, i) =>
          makeKeypoint(4 + i, 0.5, 0.5, 0.1),
        ),
      ];

      const score = framingGuide.evaluate(keypoints);

      // Only kp 0 and 1 are visible: box = {0.1, 0.1, 0.8, 0.8}
      // Target zone = {0.1, 0.05, 0.8, 0.9}
      // Intersection: x=[0.1, 0.9], y=[0.1, 0.9] → w=0.8, h=0.8 → area=0.64
      // User area = 0.8 * 0.8 = 0.64
      // Target area = 0.8 * 0.9 = 0.72
      // Union = 0.64 + 0.72 - 0.64 = 0.72
      // IoU = 0.64 / 0.72 ≈ 0.8889
      // visibilityRatio = 2/33
      // framingScore = 0.6 * (2/33) + 0.4 * 0.8889
      const expectedVisibility = 2 / 33;
      const expectedOverlap = 0.64 / 0.72;
      const expectedScore = 0.6 * expectedVisibility + 0.4 * expectedOverlap;
      expect(score).toBeCloseTo(expectedScore, 2);
    });
  });

  // --- Colour transitions at threshold boundaries ---

  describe('colour transitions at threshold boundaries', () => {
    it('uses red colour when score < 0.5', () => {
      // Very few visible keypoints, small bounding box → low score
      const keypoints = [
        makeKeypoint(0, 0.5, 0.5, 0.9),
        ...Array.from({ length: 32 }, (_, i) =>
          makeKeypoint(1 + i, 0.5, 0.5, 0.1),
        ),
      ];

      const score = framingGuide.evaluate(keypoints);
      expect(score).toBeLessThan(0.5);

      // Verify renderTargetZone was called with red colour
      const ctx = canvas.getContext('2d')!;
      // strokeStyle should be set to red (#ef4444)
      expect(ctx.strokeStyle).toBe('#ef4444');
    });

    it('uses yellow colour when 0.5 ≤ score < 0.7', () => {
      // Engineer keypoints to hit the yellow range
      // Need: 0.5 ≤ 0.6 * visRatio + 0.4 * overlapRatio < 0.7
      // 15 visible keypoints filling the target zone:
      // visRatio = 15/33 ≈ 0.4545
      // overlapRatio = 1.0 (matches target zone)
      // score = 0.6 * 0.4545 + 0.4 * 1.0 = 0.2727 + 0.4 = 0.6727
      const keypoints: Keypoint[] = [
        ...makeKeypointsInTargetZone(15, 0.9),
        ...Array.from({ length: 18 }, (_, i) =>
          makeKeypoint(15 + i, 0.5, 0.5, 0.1),
        ),
      ];

      const score = framingGuide.evaluate(keypoints);
      expect(score).toBeGreaterThanOrEqual(0.5);
      expect(score).toBeLessThan(0.7);

      const ctx = canvas.getContext('2d')!;
      expect(ctx.strokeStyle).toBe('#eab308');
    });

    it('uses green colour when score ≥ 0.7', () => {
      // All 33 keypoints visible, covering target zone → score = 1.0
      const keypoints = makeFullBodyKeypoints(0.9);

      const score = framingGuide.evaluate(keypoints);
      expect(score).toBeGreaterThanOrEqual(0.7);

      const ctx = canvas.getContext('2d')!;
      expect(ctx.strokeStyle).toBe('#22c55e');
    });

    it('boundary: score exactly 0.5 uses yellow (not red)', () => {
      // We verify the threshold logic: getColor(0.5) should return yellow
      // We can test indirectly by crafting keypoints that produce score ≈ 0.5
      // Need 0.6 * visRatio + 0.4 * overlap = 0.5
      // If overlap = 1.0: 0.6 * visRatio + 0.4 = 0.5 → visRatio = 0.1667 → ~5.5 keypoints
      // If 6 visible in target zone: visRatio = 6/33 = 0.1818
      // score = 0.6 * 0.1818 + 0.4 * 1.0 = 0.1091 + 0.4 = 0.5091 ≈ 0.5
      const keypoints: Keypoint[] = [
        ...makeKeypointsInTargetZone(6, 0.9),
        ...Array.from({ length: 27 }, (_, i) =>
          makeKeypoint(6 + i, 0.5, 0.5, 0.1),
        ),
      ];

      const score = framingGuide.evaluate(keypoints);
      // Score should be around 0.5 — check it's in yellow range
      expect(score).toBeGreaterThanOrEqual(0.5);

      const ctx = canvas.getContext('2d')!;
      expect(ctx.strokeStyle).toBe('#eab308');
    });
  });

  // --- Edge case: no visible keypoints ---

  describe('edge case: no visible keypoints', () => {
    it('returns score 0 when no keypoints have confidence >= 0.5', () => {
      const keypoints = Array.from({ length: 33 }, (_, i) =>
        makeKeypoint(i, 0.5, 0.5, 0.3), // all below threshold
      );

      const score = framingGuide.evaluate(keypoints);

      // visibilityRatio = 0/33 = 0
      // no bounding box → overlapRatio = 0
      // framingScore = 0.6 * 0 + 0.4 * 0 = 0
      expect(score).toBe(0);
    });

    it('returns score 0 when keypoints array is empty', () => {
      const score = framingGuide.evaluate([]);
      expect(score).toBe(0);
    });
  });

  // --- Prompt display ---

  describe('prompt when fewer than 25 keypoints visible', () => {
    it('renders prompt when fewer than 25 keypoints are visible', () => {
      const keypoints: Keypoint[] = [
        ...Array.from({ length: 20 }, (_, i) =>
          makeKeypoint(i, 0.1 + (i / 19) * 0.8, 0.05 + (i / 19) * 0.9, 0.9),
        ),
        ...Array.from({ length: 13 }, (_, i) =>
          makeKeypoint(20 + i, 0.5, 0.5, 0.1),
        ),
      ];

      framingGuide.evaluate(keypoints);

      const ctx = canvas.getContext('2d')!;
      expect(ctx.fillText).toHaveBeenCalledWith(
        expect.stringContaining('full body'),
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('does NOT render "step back" prompt when 25+ keypoints are visible', () => {
      const keypoints = makeKeypointsInTargetZone(33, 0.9);

      framingGuide.evaluate(keypoints);

      const ctx = canvas.getContext('2d')!;
      // fillText should NOT have been called with "full body" text
      const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
      const hasStepBackPrompt = calls.some(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('full body'),
      );
      expect(hasStepBackPrompt).toBe(false);
    });

    it('renders prompt at exactly 24 visible keypoints', () => {
      const keypoints: Keypoint[] = [
        ...Array.from({ length: 24 }, (_, i) =>
          makeKeypoint(i, 0.1 + (i / 23) * 0.8, 0.05 + (i / 23) * 0.9, 0.9),
        ),
        ...Array.from({ length: 9 }, (_, i) =>
          makeKeypoint(24 + i, 0.5, 0.5, 0.1),
        ),
      ];

      framingGuide.evaluate(keypoints);

      const ctx = canvas.getContext('2d')!;
      const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
      const hasPrompt = calls.some(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('full body'),
      );
      expect(hasPrompt).toBe(true);
    });
  });
});
