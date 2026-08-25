/**
 * Unit tests for Recommender.
 *
 * Uses minimal inline BenchmarkResult fixtures to exercise composite scoring,
 * determinism (with lexicographic tie-breaking), use-case categorization, the
 * summary constraints, and edge cases.
 *
 * Requirements validated: 9.1, 9.2, 9.3, 9.4, 9.6, 9.7
 * Design: "Property 8: Recommendation determinism".
 */

import { describe, it, expect } from 'vitest';

import type { AccuracyStats, BenchmarkResult, LatencyStats } from '../types.js';
import { Recommender } from './Recommender.js';

const KEYPOINT_COUNT = 33;

interface FixtureOptions {
  medianMs: number;
  meanOks?: number;
  perKeypointOks?: number[];
}

/** Build a minimal BenchmarkResult for the recommender. */
function makeResult(modelId: string, opts: FixtureOptions): BenchmarkResult {
  const latency: LatencyStats = {
    meanFps: opts.medianMs > 0 ? 1000 / opts.medianMs : 0,
    medianMs: opts.medianMs,
    p95Ms: opts.medianMs * 1.2,
    stdDevMs: 1,
  };

  const accuracy: AccuracyStats | null =
    opts.meanOks === undefined
      ? null
      : {
          meanOks: opts.meanOks,
          recallAt050: opts.meanOks,
          perKeypointOks:
            opts.perKeypointOks ??
            new Array<number>(KEYPOINT_COUNT).fill(opts.meanOks),
        };

  return {
    id: `id-${modelId}`,
    modelId,
    timestampMs: 0,
    frameCount: 100,
    successCount: 100,
    failedCount: 0,
    latency,
    accuracy,
    perFrameLatencyMs: [],
    valid: true,
  };
}

describe('Recommender determinism (Property 8)', () => {
  it('returns the same bestOverallModelId for identical inputs', () => {
    const results = [
      makeResult('alpha', { medianMs: 20, meanOks: 0.8 }),
      makeResult('beta', { medianMs: 40, meanOks: 0.9 }),
    ];
    const rec = new Recommender();
    const a = rec.analyze([...results]);
    const b = rec.analyze([...results]);
    expect(a.bestOverallModelId).toBe(b.bestOverallModelId);
  });

  it('breaks composite-score ties lexicographically by model id', () => {
    // Two models with identical latency and accuracy => identical composite.
    // The lexicographically smaller id ("aaa") must win.
    const results = [
      makeResult('zzz', { medianMs: 25, meanOks: 0.7 }),
      makeResult('aaa', { medianMs: 25, meanOks: 0.7 }),
    ];
    const rec = new Recommender().analyze(results);
    expect(rec.bestOverallModelId).toBe('aaa');
  });
});

describe('Recommender composite weighting (0.6 latency / 0.4 accuracy)', () => {
  it('lets a faster model beat a slower, slightly more accurate one', () => {
    // fast: median 20ms -> latencyScore 1.0 ; oks 0.80
    //   composite = 0.6*1.0 + 0.4*0.80 = 0.92
    // slow: median 40ms -> latencyScore 0.5 ; oks 0.90
    //   composite = 0.6*0.5 + 0.4*0.90 = 0.66
    const results = [
      makeResult('fast', { medianMs: 20, meanOks: 0.8 }),
      makeResult('slow', { medianMs: 40, meanOks: 0.9 }),
    ];
    const rec = new Recommender().analyze(results);
    expect(rec.bestOverallModelId).toBe('fast');
  });
});

describe('Recommender use-case categorization', () => {
  it('categorizes median <= 33ms as real-time coaching', () => {
    const rec = new Recommender().analyze([
      makeResult('rt', { medianMs: 30, meanOks: 0.5 }),
    ]);
    expect(rec.useCaseCategory['rt']).toBe('real-time coaching');
  });

  it('categorizes meanOks >= 0.75 (but slow) as accuracy-critical', () => {
    const rec = new Recommender().analyze([
      makeResult('acc', { medianMs: 60, meanOks: 0.8 }),
    ]);
    expect(rec.useCaseCategory['acc']).toBe('accuracy-critical');
  });

  it('categorizes neither-threshold models as balanced', () => {
    const rec = new Recommender().analyze([
      makeResult('mid', { medianMs: 60, meanOks: 0.5 }),
    ]);
    expect(rec.useCaseCategory['mid']).toBe('balanced');
  });
});

describe('Recommender summary and notes', () => {
  it('produces a summary <= 300 chars that references metrics', () => {
    const rec = new Recommender().analyze([
      makeResult('alpha', { medianMs: 20, meanOks: 0.82 }),
      makeResult('beta', { medianMs: 45, meanOks: 0.9 }),
    ]);
    expect(rec.summary.length).toBeLessThanOrEqual(300);
    // References FPS and latency figures.
    expect(rec.summary).toMatch(/FPS/i);
    expect(rec.summary).toMatch(/ms/);
  });

  it('produces non-empty per-region notes', () => {
    const rec = new Recommender().analyze([
      makeResult('alpha', { medianMs: 20, meanOks: 0.82 }),
      makeResult('beta', { medianMs: 45, meanOks: 0.9 }),
    ]);
    expect(rec.perRegionNotes.length).toBeGreaterThan(0);
    for (const note of rec.perRegionNotes) {
      expect(note.length).toBeGreaterThan(0);
    }
  });
});

describe('Recommender edge cases', () => {
  it('returns an empty bestOverallModelId for empty results', () => {
    const rec = new Recommender().analyze([]);
    expect(rec.bestOverallModelId).toBe('');
    expect(rec.perRegionNotes.length).toBeGreaterThan(0);
    expect(rec.useCaseCategory).toEqual({});
  });

  it('does not throw when multiple results share one model id (repeated runs)', () => {
    // Benchmarking the same model twice leaves no "other" model to compare;
    // buildSummary must not reduce an empty array (regression).
    const rec = new Recommender().analyze([
      makeResult('yolov8-pose', { medianMs: 185 }),
      makeResult('yolov8-pose', { medianMs: 183 }),
    ]);
    expect(rec.bestOverallModelId).toBe('yolov8-pose');
    expect(rec.summary.length).toBeGreaterThan(0);
    expect(rec.summary).toContain('yolov8-pose');
    expect(rec.perRegionNotes.length).toBeGreaterThan(0);
  });
});
