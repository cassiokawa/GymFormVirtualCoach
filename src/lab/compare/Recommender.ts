/**
 * Recommender — turns a set of benchmark results into a plain-language
 * recommendation about which pose model to use and why.
 *
 * The recommendation combines a latency score and an accuracy score into a
 * single composite, categorizes each model by use case, and produces
 * human-readable notes comparing per-body-region accuracy (or, when accuracy
 * is unavailable, the speed/complexity trade-off).
 *
 * Composite scoring (Req 9.4):
 *
 *   composite = 0.6 * latencyScore + 0.4 * accuracyScore
 *
 *   latencyScore — normalized so lower median latency scores higher. We use
 *     the stable ratio `minMedianMs / thisMedianMs` across the compared
 *     results: the fastest model scores exactly 1.0 and slower models scale
 *     down proportionally, always in (0, 1]. This formula is order-independent
 *     and needs no max value, so adding/removing a slow model never changes the
 *     fastest model's score relative to the others (determinism, Property 8).
 *   accuracyScore — the model's `meanOks` in [0, 1], or 0 when accuracy is
 *     unavailable (no ground truth).
 *
 * The best overall model is the argmax of the composite; ties are broken by
 * lexicographic model id so results are deterministic (Property 8).
 *
 * Requirements covered: 9.1, 9.2, 9.3, 9.4, 9.6, 9.7
 * Design: "6. ComparisonView + Recommender", "Property 8: Recommendation determinism".
 */

import type { BenchmarkResult, Recommendation } from '../types.js';

/** Weight applied to the latency component of the composite score. */
const LATENCY_WEIGHT = 0.6;
/** Weight applied to the accuracy component of the composite score. */
const ACCURACY_WEIGHT = 0.4;

/** Median-latency threshold (ms) at or below which a model is real-time capable. */
const REALTIME_LATENCY_MS = 33;
/** Mean-OKS threshold at or above which a model is accuracy-critical. */
const ACCURACY_CRITICAL_OKS = 0.75;

/** Maximum length of the plain-language summary string (Req 9.1). */
const MAX_SUMMARY_LENGTH = 300;

/**
 * Contiguous MediaPipe keypoint index ranges for the four body regions used in
 * per-region accuracy comparison. Ranges are inclusive on both ends and use
 * MediaPipe-33 indices.
 */
const REGIONS: ReadonlyArray<{ name: string; start: number; end: number }> = [
  { name: 'head', start: 0, end: 10 },
  { name: 'upper limbs', start: 11, end: 16 },
  { name: 'torso', start: 23, end: 24 },
  { name: 'lower limbs', start: 25, end: 32 },
];

/** A model's computed scores, retained for building notes and categories. */
interface ScoredModel {
  modelId: string;
  result: BenchmarkResult;
  latencyScore: number;
  accuracyScore: number;
  composite: number;
}

/**
 * Analyzes benchmark results and produces a recommendation.
 *
 * @example
 * const rec = new Recommender().analyze(results);
 * console.log(rec.bestOverallModelId, rec.summary);
 */
export class Recommender {
  /**
   * Analyze a set of benchmark results and produce a recommendation.
   *
   * The result is deterministic: for a fixed set of inputs, the same
   * `bestOverallModelId`, summary, notes, and categories are returned every
   * time. Ties in composite score are broken by lexicographic model id.
   *
   * Edge cases:
   * - Empty `results` → empty `bestOverallModelId` with an explanatory note.
   * - Single result → that model wins; notes describe it in isolation.
   *
   * @param results - Benchmark results to compare (one per model).
   * @returns A {@link Recommendation} describing the best model and rationale.
   */
  analyze(results: BenchmarkResult[]): Recommendation {
    if (results.length === 0) {
      return {
        bestOverallModelId: '',
        summary: 'No benchmark results available to compare. Run at least one benchmark to generate a recommendation.',
        perRegionNotes: ['No benchmark data available.'],
        useCaseCategory: {},
      };
    }

    const scored = this.scoreResults(results);

    // argmax composite; ties broken lexicographically by model id (Property 8).
    const best = scored.reduce((currentBest, candidate) => {
      if (candidate.composite > currentBest.composite) return candidate;
      if (candidate.composite === currentBest.composite) {
        return candidate.modelId < currentBest.modelId ? candidate : currentBest;
      }
      return currentBest;
    });

    return {
      bestOverallModelId: best.modelId,
      summary: this.buildSummary(best, scored),
      perRegionNotes: this.buildRegionNotes(scored),
      useCaseCategory: this.buildUseCaseCategories(scored),
    };
  }

  /**
   * Compute latency, accuracy, and composite scores for every result.
   *
   * The latency score uses `minMedianMs / thisMedianMs` so the fastest model
   * scores 1.0. A non-positive minimum (missing/degenerate latency data) yields
   * a latency score of 0 for all models.
   */
  private scoreResults(results: BenchmarkResult[]): ScoredModel[] {
    const medians = results.map((r) => r.latency.medianMs);
    const positiveMedians = medians.filter((m) => m > 0);
    const minMedian = positiveMedians.length > 0 ? Math.min(...positiveMedians) : 0;

    return results.map((result): ScoredModel => {
      const median = result.latency.medianMs;
      const latencyScore = minMedian > 0 && median > 0 ? minMedian / median : 0;
      const accuracyScore = result.accuracy?.meanOks ?? 0;
      const composite = LATENCY_WEIGHT * latencyScore + ACCURACY_WEIGHT * accuracyScore;
      return { modelId: result.modelId, result, latencyScore, accuracyScore, composite };
    });
  }

  /**
   * Build the <=300-char plain-language summary comparing the winner to the
   * rest, referencing FPS, latency, and accuracy (Req 9.1).
   */
  private buildSummary(best: ScoredModel, scored: ScoredModel[]): string {
    const fps = best.result.latency.meanFps.toFixed(1);
    const latency = best.result.latency.medianMs.toFixed(1);
    const accuracyPart =
      best.result.accuracy !== null
        ? ` and ${(best.result.accuracy.meanOks * 100).toFixed(0)}% mean OKS accuracy`
        : ' (accuracy not measured; no ground truth)';

    // "Others" are results from a *different* model. Repeated runs of a single
    // model leave this empty even when scored.length > 1, so branch on it
    // rather than on the raw result count (avoids reducing an empty array).
    const others = scored.filter((s) => s.modelId !== best.modelId);

    let summary: string;
    if (others.length === 0) {
      const runCount = scored.length;
      const runNote =
        runCount === 1
          ? 'It is the only benchmarked model, so no comparison is available.'
          : `Only this model has been benchmarked (${runCount} runs), so no cross-model comparison is available.`;
      summary = `${best.modelId} runs at ${fps} FPS with ${latency}ms median latency${accuracyPart}. ${runNote}`;
    } else {
      const fastestOther = others.reduce((a, b) =>
        b.result.latency.medianMs < a.result.latency.medianMs ? b : a,
      );
      const rivalLatency = fastestOther.result.latency.medianMs.toFixed(1);
      summary = `${best.modelId} is the best overall pick: ${fps} FPS at ${latency}ms median latency${accuracyPart}, ahead of ${fastestOther.modelId} (${rivalLatency}ms) on the combined speed+accuracy score.`;
    }

    return truncate(summary, MAX_SUMMARY_LENGTH);
  }

  /**
   * Build per-region notes for head, upper limbs, torso, and lower limbs.
   *
   * When accuracy is present for at least two models, each note names the model
   * with the highest mean per-keypoint OKS in that region (Req 9.2). When
   * accuracy is unavailable, a single note explains the speed/complexity
   * trade-off instead (Req 9.3).
   */
  private buildRegionNotes(scored: ScoredModel[]): string[] {
    const withAccuracy = scored.filter((s) => s.result.accuracy !== null);

    if (withAccuracy.length === 0) {
      return [this.buildLatencyTradeoffNote(scored)];
    }

    if (withAccuracy.length === 1) {
      const only = withAccuracy[0];
      if (only === undefined) return [this.buildLatencyTradeoffNote(scored)];
      return REGIONS.map((region) => {
        const oks = regionMeanOks(only.result, region.start, region.end);
        return `${region.name}: ${only.modelId} scores ${(oks * 100).toFixed(0)}% OKS (only model with accuracy data).`;
      });
    }

    return REGIONS.map((region) => {
      // Rank models in this region by mean OKS; tie-break lexicographically.
      const ranked = withAccuracy
        .map((s) => ({ modelId: s.modelId, oks: regionMeanOks(s.result, region.start, region.end) }))
        .sort((a, b) => (b.oks - a.oks) || a.modelId.localeCompare(b.modelId));

      const leader = ranked[0];
      const runnerUp = ranked[1];
      if (leader === undefined) {
        return `${region.name}: no accuracy data available.`;
      }
      if (runnerUp === undefined) {
        return `${region.name}: ${leader.modelId} leads at ${(leader.oks * 100).toFixed(0)}% OKS.`;
      }
      return `${region.name}: ${leader.modelId} tracks most accurately (${(leader.oks * 100).toFixed(0)}% OKS) vs ${runnerUp.modelId} (${(runnerUp.oks * 100).toFixed(0)}% OKS).`;
    });
  }

  /**
   * Build a single note describing the latency/complexity trade-off when no
   * accuracy data is available (Req 9.3).
   */
  private buildLatencyTradeoffNote(scored: ScoredModel[]): string {
    const ranked = [...scored].sort(
      (a, b) => (a.result.latency.medianMs - b.result.latency.medianMs) || a.modelId.localeCompare(b.modelId),
    );
    const fastest = ranked[0];
    if (fastest === undefined) {
      return 'No accuracy ground truth available; unable to compare per-region tracking.';
    }
    if (ranked.length === 1) {
      return `No accuracy ground truth available. ${fastest.modelId} runs at ${fastest.result.latency.medianMs.toFixed(1)}ms median latency; annotate frames to compare per-region tracking quality.`;
    }
    const slowest = ranked[ranked.length - 1];
    const slowestNote =
      slowest !== undefined && slowest.modelId !== fastest.modelId
        ? ` ${slowest.modelId} is slower (${slowest.result.latency.medianMs.toFixed(1)}ms) but heavier models often yield steadier keypoints.`
        : '';
    return `No accuracy ground truth available, so per-region comparison falls back to the speed/complexity trade-off. ${fastest.modelId} is fastest (${fastest.result.latency.medianMs.toFixed(1)}ms median).${slowestNote}`;
  }

  /**
   * Categorize each model by use case (Req 9.6, 9.7).
   *
   * - `real-time coaching` when median latency <= 33ms.
   * - `accuracy-critical` when mean OKS >= 0.75.
   * - `balanced` otherwise, or when a model qualifies for neither single
   *   threshold. When a model qualifies for both, real-time coaching wins
   *   (latency is prioritized for the coaching use case).
   */
  private buildUseCaseCategories(
    scored: ScoredModel[],
  ): Record<string, 'real-time coaching' | 'accuracy-critical' | 'balanced'> {
    const categories: Record<string, 'real-time coaching' | 'accuracy-critical' | 'balanced'> = {};

    for (const model of scored) {
      const isRealtime = model.result.latency.medianMs <= REALTIME_LATENCY_MS;
      const meanOks = model.result.accuracy?.meanOks ?? 0;
      const isAccurate = meanOks >= ACCURACY_CRITICAL_OKS;

      if (isRealtime) {
        categories[model.modelId] = 'real-time coaching';
      } else if (isAccurate) {
        categories[model.modelId] = 'accuracy-critical';
      } else {
        categories[model.modelId] = 'balanced';
      }
    }

    return categories;
  }
}

/**
 * Compute the mean per-keypoint OKS over an inclusive index range for a
 * benchmark result. Returns 0 when accuracy data is absent or the range
 * contains no valid entries.
 */
function regionMeanOks(result: BenchmarkResult, start: number, end: number): number {
  const perKeypoint = result.accuracy?.perKeypointOks;
  if (perKeypoint === undefined) return 0;

  let sum = 0;
  let count = 0;
  for (let i = start; i <= end; i++) {
    const value = perKeypoint[i];
    if (value === undefined) continue;
    sum += value;
    count++;
  }

  return count > 0 ? sum / count : 0;
}

/**
 * Truncate a string to at most `max` characters, appending an ellipsis
 * character when truncation occurs. The returned string never exceeds `max`.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}\u2026`;
}
