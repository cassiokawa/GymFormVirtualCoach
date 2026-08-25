/**
 * Unit tests for FormQualityModel.
 *
 * Exercises the deterministic stub assessment path (no ONNX weights required):
 * empty-window handling, high score on steady input, deviation emission on
 * noisy input with the 0.6 confidence/severity threshold, availability state,
 * and architecture selection.
 *
 * Requirements: 11.3
 */

import { describe, it, expect } from 'vitest';
import { FormQualityModel } from './FormQualityModel.js';
import type { Keypoint } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Joint vertices the stub measures angle variance over (from STUB_ANGLE_TRIPLES). */
const JOINT_INDICES = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

/**
 * Build a 33-keypoint frame. Optional per-index position overrides let a
 * noisy-window helper inject large jitter on the joints the stub inspects.
 */
function makeFrame(overrides: Record<number, { x: number; y: number }> = {}): Keypoint[] {
  const frame: Keypoint[] = [];
  for (let i = 0; i < 33; i += 1) {
    const o = overrides[i];
    frame.push({
      index: i,
      x: o?.x ?? 0.5,
      y: o?.y ?? 0.5,
      z: 0,
      confidence: 0.9,
    });
  }
  return frame;
}

/**
 * A "steady" window: near-identical frames. Joint angles barely change, so the
 * stub reports low variance → high quality and no deviations.
 */
function makeSteadyWindow(count: number): Keypoint[][] {
  const window: Keypoint[][] = [];
  // Give the tracked joints a stable, well-defined bent geometry so angles are
  // computable but identical across frames.
  const base: Record<number, { x: number; y: number }> = {
    11: { x: 0.4, y: 0.3 },
    13: { x: 0.35, y: 0.45 },
    15: { x: 0.4, y: 0.6 },
    12: { x: 0.6, y: 0.3 },
    14: { x: 0.65, y: 0.45 },
    16: { x: 0.6, y: 0.6 },
    23: { x: 0.42, y: 0.55 },
    25: { x: 0.4, y: 0.75 },
    27: { x: 0.42, y: 0.95 },
    24: { x: 0.58, y: 0.55 },
    26: { x: 0.6, y: 0.75 },
    28: { x: 0.58, y: 0.95 },
  };
  for (let i = 0; i < count; i += 1) {
    window.push(makeFrame(base));
  }
  return window;
}

/**
 * A "noisy" window: large per-frame jitter on the tracked joints so the interior
 * angles swing widely, producing high angular variance → lower quality and at
 * least one emitted deviation above the 0.6 threshold.
 */
function makeNoisyWindow(count: number): Keypoint[][] {
  const window: Keypoint[][] = [];
  for (let i = 0; i < count; i += 1) {
    const overrides: Record<number, { x: number; y: number }> = {};
    // Vertices swing hard between two extremes so the interior angle alternates
    // between nearly straight (~180) and fully folded (~0). Endpoints of each
    // triple are placed so that one extreme is collinear (straight) and the
    // other doubles the vertex back on itself (folded).
    const flip = i % 2 === 0;

    // Left elbow triple [11, 13, 15]: keep 11 above and 15 below the vertex.
    overrides[11] = { x: 0.4, y: 0.2 };
    overrides[15] = { x: 0.4, y: 0.8 };
    overrides[13] = flip ? { x: 0.4, y: 0.5 } : { x: 0.9, y: 0.5 };

    // Right elbow triple [12, 14, 16].
    overrides[12] = { x: 0.6, y: 0.2 };
    overrides[16] = { x: 0.6, y: 0.8 };
    overrides[14] = flip ? { x: 0.6, y: 0.5 } : { x: 0.1, y: 0.5 };

    // Left knee triple [23, 25, 27].
    overrides[23] = { x: 0.42, y: 0.2 };
    overrides[27] = { x: 0.42, y: 0.8 };
    overrides[25] = flip ? { x: 0.42, y: 0.5 } : { x: 0.95, y: 0.5 };

    // Right knee triple [24, 26, 28].
    overrides[24] = { x: 0.58, y: 0.2 };
    overrides[28] = { x: 0.58, y: 0.8 };
    overrides[26] = flip ? { x: 0.58, y: 0.5 } : { x: 0.05, y: 0.5 };

    // Left hip triple [11, 23, 25]: vertex 23 swings; 11 and 25 already set.
    // (11 above at y=0.2, 25 set above.) Nudge 23 handled by knee triple, but
    // its role as a hip vertex still contributes via the shared position.

    // Right hip triple [12, 24, 26]: vertex 24 shared with right-knee endpoint.
    window.push(makeFrame(overrides));
  }
  // Reference the joint list so lint stays happy and the intent is documented.
  void JOINT_INDICES;
  return window;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FormQualityModel', () => {
  describe('assess()', () => {
    it('returns the empty assessment when fewer than windowSize frames are supplied', async () => {
      const model = new FormQualityModel({ architecture: 'stgcn', windowSize: 30 });
      const window = makeSteadyWindow(29);
      const result = await model.assess(window);
      expect(result.qualityScore).toBe(1);
      expect(result.deviations).toEqual([]);
    });

    it('yields a high quality score with few/no deviations for a steady window', async () => {
      const model = new FormQualityModel({ architecture: 'stgcn', windowSize: 30 });
      const window = makeSteadyWindow(30);
      const result = await model.assess(window);

      expect(result.qualityScore).toBeGreaterThan(0.9);
      expect(result.deviations.length).toBe(0);
    });

    it('yields a lower quality score and at least one deviation for a noisy window', async () => {
      const model = new FormQualityModel({ architecture: 'stgcn', windowSize: 30 });
      const window = makeNoisyWindow(30);
      const result = await model.assess(window);

      // Noisy input should degrade the score relative to a steady window.
      expect(result.qualityScore).toBeLessThan(0.9);
      expect(result.deviations.length).toBeGreaterThanOrEqual(1);

      for (const deviation of result.deviations) {
        // Severity in [0, 1] and above the 0.6 emission threshold (Req 11.3).
        expect(deviation.severity).toBeGreaterThanOrEqual(0);
        expect(deviation.severity).toBeLessThanOrEqual(1);
        expect(deviation.severity).toBeGreaterThan(0.6);
        // Affected joints must be identified.
        expect(deviation.affectedJoints.length).toBeGreaterThan(0);
      }
    });

    it('keeps qualityScore within [0, 1] for a noisy window', async () => {
      const model = new FormQualityModel({ architecture: 'stgcn', windowSize: 30 });
      const result = await model.assess(makeNoisyWindow(30));
      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
      expect(result.qualityScore).toBeLessThanOrEqual(1);
    });
  });

  describe('isAvailable()', () => {
    it('is false before load() (no real model)', () => {
      const model = new FormQualityModel({ architecture: 'stgcn', windowSize: 30 });
      expect(model.isAvailable()).toBe(false);
    });

    it('remains false in a test env where the ONNX runtime load is not performed', async () => {
      const model = new FormQualityModel({ architecture: 'transformer', windowSize: 30 });
      // load() should fail in the bare test environment (no real weights /
      // runtime), leaving the model unavailable.
      await expect(model.load('models/does-not-exist.onnx')).rejects.toThrow();
      expect(model.isAvailable()).toBe(false);
    });
  });

  describe('constructor', () => {
    it("accepts architecture 'stgcn'", () => {
      const model = new FormQualityModel({ architecture: 'stgcn' });
      expect(model).toBeInstanceOf(FormQualityModel);
    });

    it("accepts architecture 'transformer'", () => {
      const model = new FormQualityModel({ architecture: 'transformer' });
      expect(model).toBeInstanceOf(FormQualityModel);
    });
  });
});
