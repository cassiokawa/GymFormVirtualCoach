/**
 * BenchmarkRunner — drives a pose model through a fixed set of frames and
 * produces a {@link BenchmarkResult} with latency and (optionally) OKS accuracy
 * statistics.
 *
 * The runner spawns a dedicated worker for the model via a {@link PoseWorkerPool},
 * processes frames sequentially, discards a leading warm-up window from the
 * statistics, and normalizes each predicted pose to the 33-keypoint MediaPipe
 * schema before scoring against ground truth. Failed frames are skipped and
 * counted; a run that fails more than half its frames is marked invalid.
 *
 * Latency is measured on the main thread as wall-clock time around each
 * {@link PoseWorkerPool.detect} call, so it includes worker round-trip overhead
 * — the same overhead a live consumer would experience.
 *
 * Requirements covered: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 11.5
 * Design: "3. BenchmarkRunner + OKS", "Property 4: Benchmark validity".
 */

import type { Keypoint } from '../../types/index.js';
import type {
  AccuracyStats,
  BenchmarkOptions,
  BenchmarkResult,
  GroundTruthFrame,
  LatencyStats,
  RuntimeBackend,
} from '../types.js';
import { KeypointNormalizer } from '../normalize/KeypointNormalizer.js';
import { computeOks, computeRecall, perKeypointOks, MEDIAPIPE_SIGMAS } from './oks.js';
import type { PoseWorkerPool } from '../workers/PoseWorkerPool.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';
import type { PoseAdapter } from '../types.js';

/** Default number of leading frames excluded from statistics (Req 3.1). */
const DEFAULT_WARMUP_FRAMES = 5;
/** Minimum successful non-warm-up frames for a run to be considered complete (Req 3.9). */
const MIN_SUCCESSFUL_FRAMES = 50;
/** Fraction of failed frames above which a run is marked invalid (Req 3.7). */
const MAX_FAILURE_RATIO = 0.5;
/** Number of landmarks in the MediaPipe-33 schema. */
const MEDIAPIPE_KEYPOINT_COUNT = 33;

/**
 * A per-frame outcome captured while iterating the benchmark frames. Warm-up
 * frames are recorded with `warmup: true` so they can be excluded from stats
 * while still counting toward the failure ratio denominator when they fail.
 */
interface FrameOutcome {
  /** true when this frame belongs to the warm-up window. */
  warmup: boolean;
  /** true when inference succeeded and produced a pose. */
  success: boolean;
  /** Wall-clock latency in ms; only meaningful on success. */
  latencyMs: number;
  /** OKS score for this frame, or null when no matching ground truth. */
  oks: number | null;
  /** Recall@0.5 for this frame, or null when no matching ground truth. */
  recall: number | null;
  /** Per-keypoint OKS terms (length 33), or null when no matching ground truth. */
  perKeypoint: number[] | null;
}

/**
 * Runs timed inference passes over a fixed frame set and computes latency and
 * accuracy statistics for a single pose model.
 */
export class BenchmarkRunner {
  private readonly normalizer = new KeypointNormalizer();

  /**
   * @param workerPool Pool used to spawn/terminate the per-run inference worker.
   * @param registry Optional registry used to instantiate adapters that must
   *   run on the main thread (e.g. MediaPipe, which needs `document`). When
   *   omitted, all models run through the worker pool.
   */
  constructor(
    private readonly workerPool: PoseWorkerPool,
    private readonly registry?: ModelRegistry,
  ) {}

  /**
   * Backends that run on the main thread rather than in a Web Worker.
   *
   * - `mediapipe-wasm`: MediaPipe Tasks Vision touches `document`, absent in workers.
   * - `tfjs`: TensorFlow.js defaults to the WebGL backend, which needs a GL
   *   context; it is also unreliable to dynamically import inside a dev-mode
   *   worker (Vite's pre-bundled dep URL fails to fetch from the worker scope).
   *
   * Only `onnx-web` (ONNX Runtime Web, designed for worker execution) runs in
   * the worker pool.
   */
  private mustRunOnMainThread(backend: RuntimeBackend): boolean {
    return backend === 'mediapipe-wasm' || backend === 'tfjs';
  }

  /**
   * Benchmark a single model over the supplied frames.
   *
   * Frames are processed sequentially. The first `opts.warmupFrames` (default 5)
   * are excluded from all statistics. Each successful prediction is normalized to
   * the 33-keypoint schema and, when a ground-truth frame with a matching
   * `frameIndex` exists, scored with OKS. Failed frames are skipped and counted;
   * the worker is always terminated when the run completes.
   *
   * @param modelId Registered model id to benchmark.
   * @param backend Runtime backend the model executes on.
   * @param opts    Frames, optional ground truth, and warm-up size.
   * @returns A fully populated {@link BenchmarkResult}.
   */
  async run(
    modelId: string,
    backend: RuntimeBackend,
    opts: BenchmarkOptions,
  ): Promise<BenchmarkResult> {
    if (this.mustRunOnMainThread(backend)) {
      return this.runOnMainThread(modelId, backend, opts);
    }
    return this.runInWorker(modelId, backend, opts);
  }

  /**
   * Worker-backed benchmark path (default). Spawns a per-run worker, streams
   * frames to it, and always terminates it when finished.
   */
  private async runInWorker(
    modelId: string,
    backend: RuntimeBackend,
    opts: BenchmarkOptions,
  ): Promise<BenchmarkResult> {
    const warmupFrames = opts.warmupFrames ?? DEFAULT_WARMUP_FRAMES;
    const groundTruthByIndex = indexGroundTruth(opts.groundTruth);

    const handle = await this.workerPool.spawn(modelId, backend);
    try {
      const outcomes: FrameOutcome[] = [];

      for (let frameIndex = 0; frameIndex < opts.frames.length; frameIndex++) {
        const frame = opts.frames[frameIndex];
        if (frame === undefined) continue;
        const isWarmup = frameIndex < warmupFrames;
        const gt = groundTruthByIndex.get(frameIndex);

        const start = performance.now();
        try {
          const rawKeypoints = await this.workerPool.detect(
            handle,
            frameIndex,
            frame,
            start,
          );
          const latencyMs = performance.now() - start;
          const normalized = this.normalizer.normalize(rawKeypoints);
          outcomes.push(this.scoreFrame(isWarmup, latencyMs, normalized, gt));
        } catch {
          // Req 3.6: skip and count failed frames, then continue.
          outcomes.push({
            warmup: isWarmup,
            success: false,
            latencyMs: 0,
            oks: null,
            recall: null,
            perKeypoint: null,
          });
        }
      }

      return this.buildResult(modelId, outcomes, groundTruthByIndex.size > 0);
    } finally {
      // Always release the worker, even on unexpected errors.
      this.workerPool.terminate(handle);
    }
  }

  /**
   * Main-thread benchmark path for adapters that cannot run in a worker
   * (MediaPipe). Instantiates the adapter from the injected registry, loads it,
   * runs inference inline, and disposes it afterwards.
   *
   * @throws When no registry was provided to construct the adapter.
   */
  private async runOnMainThread(
    modelId: string,
    _backend: RuntimeBackend,
    opts: BenchmarkOptions,
  ): Promise<BenchmarkResult> {
    if (this.registry === undefined) {
      throw new Error(
        `Model "${modelId}" must run on the main thread, but BenchmarkRunner ` +
          'was constructed without a ModelRegistry.',
      );
    }
    const warmupFrames = opts.warmupFrames ?? DEFAULT_WARMUP_FRAMES;
    const groundTruthByIndex = indexGroundTruth(opts.groundTruth);

    const adapter: PoseAdapter = this.registry.get(modelId);
    await adapter.load();
    try {
      const outcomes: FrameOutcome[] = [];

      for (let frameIndex = 0; frameIndex < opts.frames.length; frameIndex++) {
        const frame = opts.frames[frameIndex];
        if (frame === undefined) continue;
        const isWarmup = frameIndex < warmupFrames;
        const gt = groundTruthByIndex.get(frameIndex);

        const start = performance.now();
        try {
          const pose = await adapter.detect(frame, start);
          const latencyMs = performance.now() - start;
          const normalized = this.normalizer.normalize(pose.keypoints);
          outcomes.push(this.scoreFrame(isWarmup, latencyMs, normalized, gt));
        } catch {
          outcomes.push({
            warmup: isWarmup,
            success: false,
            latencyMs: 0,
            oks: null,
            recall: null,
            perKeypoint: null,
          });
        } finally {
          // The main-thread path owns the frame; release it after inference.
          frame.close();
        }
      }

      return this.buildResult(modelId, outcomes, groundTruthByIndex.size > 0);
    } finally {
      await adapter.dispose();
    }
  }

  /**
   * Score a single successful frame against optional ground truth.
   */
  private scoreFrame(
    isWarmup: boolean,
    latencyMs: number,
    normalized: Keypoint[],
    gt: GroundTruthFrame | undefined,
  ): FrameOutcome {
    if (gt === undefined) {
      return {
        warmup: isWarmup,
        success: true,
        latencyMs,
        oks: null,
        recall: null,
        perKeypoint: null,
      };
    }
    return {
      warmup: isWarmup,
      success: true,
      latencyMs,
      oks: computeOks(normalized, gt),
      recall: computeRecall(normalized, gt, 0.5),
      perKeypoint: perKeypointOks(normalized, gt, { sigmas: MEDIAPIPE_SIGMAS }),
    };
  }

  /**
   * Assemble the final {@link BenchmarkResult} from per-frame outcomes.
   *
   * Statistics are computed only over successful, non-warm-up frames. The run's
   * validity and warning fields follow the failure-ratio and minimum-sample
   * rules (Req 3.7, 3.9).
   */
  private buildResult(
    modelId: string,
    outcomes: FrameOutcome[],
    hasGroundTruth: boolean,
  ): BenchmarkResult {
    // Non-warm-up frames form the reported frame count and failure denominator.
    const scored = outcomes.filter((o) => !o.warmup);
    const frameCount = scored.length;
    const successful = scored.filter((o) => o.success);
    const successCount = successful.length;
    const failedCount = frameCount - successCount;

    const perFrameLatencyMs = successful.map((o) => o.latencyMs);
    const latency = this.computeLatencyStats(perFrameLatencyMs);
    const accuracy = hasGroundTruth ? this.computeAccuracyStats(successful) : null;

    const failureRatio = frameCount > 0 ? failedCount / frameCount : 0;
    const valid = failureRatio <= MAX_FAILURE_RATIO;

    const warning = deriveWarning(valid, failureRatio, successCount);

    const result: BenchmarkResult = {
      id: crypto.randomUUID(),
      modelId,
      timestampMs: Date.now(),
      frameCount,
      successCount,
      failedCount,
      latency,
      accuracy,
      perFrameLatencyMs,
      valid,
    };
    // Assign optionally to satisfy exactOptionalPropertyTypes.
    if (warning !== undefined) {
      result.warning = warning;
    }
    return result;
  }

  /**
   * Compute latency distribution statistics from successful-frame samples.
   * Returns zeroed stats when there are no samples.
   */
  private computeLatencyStats(latenciesMs: number[]): LatencyStats {
    if (latenciesMs.length === 0) {
      return { meanFps: 0, medianMs: 0, p95Ms: 0, stdDevMs: 0 };
    }
    const meanLatency = mean(latenciesMs);
    return {
      meanFps: meanLatency > 0 ? 1000 / meanLatency : 0,
      medianMs: median(latenciesMs),
      p95Ms: percentile(latenciesMs, 95),
      stdDevMs: stdDev(latenciesMs),
    };
  }

  /**
   * Aggregate OKS accuracy statistics over successful frames that had matching
   * ground truth. Returns zeroed stats when no such frames exist.
   */
  private computeAccuracyStats(successful: FrameOutcome[]): AccuracyStats {
    const scored = successful.filter((o) => o.oks !== null);
    if (scored.length === 0) {
      return {
        meanOks: 0,
        recallAt050: 0,
        perKeypointOks: new Array<number>(MEDIAPIPE_KEYPOINT_COUNT).fill(0),
      };
    }

    const meanOks = mean(scored.map((o) => o.oks ?? 0));
    const recallAt050 = mean(scored.map((o) => o.recall ?? 0));

    // Average the per-keypoint OKS terms across all scored frames.
    const perKeypointSum = new Array<number>(MEDIAPIPE_KEYPOINT_COUNT).fill(0);
    for (const outcome of scored) {
      const terms = outcome.perKeypoint;
      if (terms === undefined || terms === null) continue;
      for (let i = 0; i < MEDIAPIPE_KEYPOINT_COUNT; i++) {
        perKeypointSum[i] = (perKeypointSum[i] ?? 0) + (terms[i] ?? 0);
      }
    }
    const perKeypointOksAvg = perKeypointSum.map((sum) => sum / scored.length);

    return { meanOks, recallAt050, perKeypointOks: perKeypointOksAvg };
  }
}

/**
 * Build a lookup from ground-truth frame index to its annotation. When multiple
 * annotations share a frame index the last one wins.
 */
function indexGroundTruth(
  groundTruth: readonly GroundTruthFrame[] | undefined,
): Map<number, GroundTruthFrame> {
  const map = new Map<number, GroundTruthFrame>();
  if (groundTruth === undefined) return map;
  for (const frame of groundTruth) {
    map.set(frame.frameIndex, frame);
  }
  return map;
}

/**
 * Derive the advisory warning for a run, if any. An invalid run (too many
 * failures) takes precedence over the partial-sample warning.
 */
function deriveWarning(
  valid: boolean,
  failureRatio: number,
  successCount: number,
): string | undefined {
  if (!valid) {
    const pct = Math.round(failureRatio * 100);
    return `Benchmark invalid: ${pct}% of frames failed (threshold 50%).`;
  }
  if (successCount < MIN_SUCCESSFUL_FRAMES) {
    return `Partial benchmark: only ${successCount} successful frames (recommended >= ${MIN_SUCCESSFUL_FRAMES}).`;
  }
  return undefined;
}

/**
 * Arithmetic mean of a numeric array. Returns 0 for an empty array.
 */
function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/**
 * Median of a numeric array (average of the two middle values for even lengths).
 * Returns 0 for an empty array. Does not mutate the input.
 */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lower = sorted[mid - 1] ?? 0;
    const upper = sorted[mid] ?? 0;
    return (lower + upper) / 2;
  }
  return sorted[mid] ?? 0;
}

/**
 * The `p`th percentile (0–100) of a numeric array using linear interpolation
 * between closest ranks. Returns 0 for an empty array. Does not mutate the input.
 */
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? 0;

  const rank = (p / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? 0;
  if (lowerIndex === upperIndex) return lower;
  const weight = rank - lowerIndex;
  return lower + (upper - lower) * weight;
}

/**
 * Population standard deviation of a numeric array. Returns 0 for arrays with
 * fewer than two elements.
 */
function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  let sumSq = 0;
  for (const value of values) {
    const diff = value - avg;
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq / values.length);
}
