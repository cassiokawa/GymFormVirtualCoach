/**
 * Sliding-window exercise classifier for the CV Algorithm Lab.
 *
 * The classifier consumes a stream of normalized {@link Keypoint} frames one at
 * a time via {@link ExerciseClassifier.pushFrame}. It buffers frames until a
 * full window is available, then runs inference over the most recent window on
 * a fixed stride cadence. Predictions below the configured confidence threshold
 * are reported as `"unknown"` rather than a low-confidence guess.
 *
 * Design references:
 * - Design "7. ExerciseClassifier + FormQualityModel" (window 30 / stride 15).
 * - Requirement 6 (LSTM exercise classification) and "Property 6: Classifier
 *   windowing".
 *
 * Inference is intended to run inside {@link file://./classify.worker.ts} off
 * the main thread. Each inference pass targets <100ms so the classifier can
 * keep up with a real-time frame stream (Req 6.4).
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import type { Keypoint } from '../../types/index.js';
import type { ClassificationResult } from '../types.js';

/** Default sliding-window length in frames (Req 6.1). */
const DEFAULT_WINDOW_SIZE = 30;
/** Default stride between inference passes in frames (Req 6.1). */
const DEFAULT_STRIDE = 15;
/** Default confidence threshold below which results are "unknown" (Req 6.2). */
const DEFAULT_THRESHOLD = 0.7;

/**
 * Built-in exercise labels used by the deterministic stub classifier. Callers
 * may override these via {@link ExerciseClassifier.setLabels}; a real trained
 * model would expose its own label ordering (Req 6.6).
 */
const DEFAULT_LABELS: readonly string[] = ['squat', 'push_up', 'shoulder_press', 'bicep_curl'];

/** The reserved label emitted when confidence falls below the threshold. */
const UNKNOWN_LABEL = 'unknown';

/**
 * Optional configuration for {@link ExerciseClassifier}. All fields fall back
 * to the design defaults (window 30, stride 15, threshold 0.7).
 */
export interface ExerciseClassifierOptions {
  /** Sliding-window length in frames. Defaults to 30. */
  windowSize?: number;
  /** Frames between inference passes once the window is full. Defaults to 15. */
  stride?: number;
  /** Minimum confidence to emit a concrete label. Defaults to 0.7. */
  threshold?: number;
}

/**
 * A loaded inference session. Kept intentionally minimal so it can wrap either
 * an ONNX Runtime Web session or a TFJS model without the classifier caring
 * which backend produced it. Returns a raw score per label in `labels` order.
 */
interface InferenceSession {
  /** Run a forward pass over a window, returning one raw score per label. */
  run(window: Keypoint[][], labels: readonly string[]): number[];
}

/**
 * Streaming exercise classifier over a sliding window of keypoint frames.
 *
 * Usage:
 * ```ts
 * const clf = new ExerciseClassifier();
 * await clf.loadModel('/models/exercise-classifier.onnx'); // optional
 * for (const frame of frames) {
 *   const result = clf.pushFrame(frame);
 *   if (result) handle(result);
 * }
 * ```
 */
export class ExerciseClassifier {
  private readonly windowSize: number;
  private readonly stride: number;
  private readonly threshold: number;

  /** Ring-like buffer of the most recent frames, capped at `windowSize`. */
  private readonly buffer: Keypoint[][] = [];

  /** Exercise class labels in model output order. */
  private labels: string[] = [...DEFAULT_LABELS];

  /**
   * Frames observed since the last inference pass. Inference runs when the
   * window is full and this counter reaches `stride`.
   */
  private framesSinceLastRun = 0;

  /** Whether at least one full window has been buffered. */
  private windowReady = false;

  /** Loaded inference session, or null while using the deterministic stub. */
  private session: InferenceSession | null = null;

  /**
   * @param opts Optional window/stride/threshold overrides.
   */
  constructor(opts?: ExerciseClassifierOptions) {
    this.windowSize = opts?.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.stride = opts?.stride ?? DEFAULT_STRIDE;
    this.threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  }

  /**
   * Set the exercise class labels the classifier reports. The ordering must
   * match the model's output ordering (Req 6.6).
   *
   * @param labels Non-empty list of exercise label names.
   */
  setLabels(labels: string[]): void {
    if (labels.length === 0) {
      throw new Error('ExerciseClassifier.setLabels requires at least one label');
    }
    this.labels = [...labels];
  }

  /**
   * Load a model for inference. An ONNX model is loaded via onnxruntime-web
   * (dynamically imported so the dependency is only pulled in when actually
   * used); a `.json` URL is treated as a TFJS LayersModel.
   *
   * Until a model is loaded (or if loading fails to produce a usable session),
   * {@link pushFrame} falls back to a deterministic stub classifier so the
   * class remains fully testable without trained weights.
   *
   * @param modelUrl URL to an ONNX (`.onnx`) or TFJS (`.json`) model.
   */
  async loadModel(modelUrl: string): Promise<void> {
    if (modelUrl.endsWith('.json')) {
      this.session = await this.loadTfjsSession(modelUrl);
      return;
    }
    this.session = await this.loadOnnxSession(modelUrl);
  }

  /**
   * Buffer a single frame of keypoints and, when appropriate, run inference.
   *
   * Returns `null` until at least `windowSize` frames have been buffered
   * (Property 6 / Req 6.5). Once the window is full, inference runs on the
   * first full window and then every `stride` frames thereafter, returning a
   * {@link ClassificationResult} for the latest window.
   *
   * @param keypoints Normalized keypoints for the current frame.
   * @returns A classification result on inference frames, otherwise `null`.
   */
  pushFrame(keypoints: Keypoint[]): ClassificationResult | null {
    // Append and cap the buffer to the window length.
    this.buffer.push(keypoints);
    if (this.buffer.length > this.windowSize) {
      this.buffer.shift();
    }

    // Buffer silently until the first full window is available (Req 6.5).
    if (this.buffer.length < this.windowSize) {
      return null;
    }

    if (!this.windowReady) {
      // First full window: run immediately and start the stride cadence.
      this.windowReady = true;
      this.framesSinceLastRun = 0;
      return this.infer();
    }

    // Subsequent frames: run once every `stride` frames.
    this.framesSinceLastRun += 1;
    if (this.framesSinceLastRun < this.stride) {
      return null;
    }
    this.framesSinceLastRun = 0;
    return this.infer();
  }

  /**
   * Clear the frame buffer and reset windowing state. After a reset the
   * classifier again buffers silently until a full window is re-accumulated.
   */
  reset(): void {
    this.buffer.length = 0;
    this.framesSinceLastRun = 0;
    this.windowReady = false;
  }

  /**
   * Run inference over the latest window and map raw scores to a
   * {@link ClassificationResult}, applying the confidence threshold.
   */
  private infer(): ClassificationResult {
    // Snapshot the current window so downstream inference sees a stable view.
    const window = this.buffer.slice();
    const scores =
      this.session !== null ? this.session.run(window, this.labels) : this.stubScores(window);

    const { label, confidence } = this.argmax(scores);

    // Below-threshold predictions collapse to "unknown" with actual confidence
    // (Req 6.2 / 6.3, Property 6).
    if (confidence < this.threshold) {
      return { label: UNKNOWN_LABEL, confidence };
    }
    return { label, confidence };
  }

  /**
   * Select the highest-scoring label and normalize scores into a confidence in
   * `[0, 1]` via softmax. Guards against an empty label set.
   */
  private argmax(scores: number[]): { label: string; confidence: number } {
    if (this.labels.length === 0 || scores.length === 0) {
      return { label: UNKNOWN_LABEL, confidence: 0 };
    }

    const probs = softmax(scores);

    let bestIndex = 0;
    let bestProb = probs[0] ?? 0;
    for (let i = 1; i < probs.length; i += 1) {
      const p = probs[i] ?? 0;
      if (p > bestProb) {
        bestProb = p;
        bestIndex = i;
      }
    }

    const label = this.labels[bestIndex] ?? UNKNOWN_LABEL;
    // Clamp defensively; softmax already yields [0,1] but floating point drift
    // could nudge it slightly outside the range (Property 6 requires [0,1]).
    const confidence = Math.min(1, Math.max(0, bestProb));
    return { label, confidence };
  }

  /**
   * Deterministic stub classifier used when no trained model is loaded.
   *
   * TODO(model): replace with a real trained LSTM/ONNX classifier. This stub
   * derives a per-label score from simple motion heuristics (aggregate vertical
   * travel and mean confidence across the window) so the class is exercisable
   * and deterministic in tests without any weights. It is NOT a real classifier.
   */
  private stubScores(window: Keypoint[][]): number[] {
    const motion = verticalMotion(window);
    const meanConfidence = windowMeanConfidence(window);

    // Spread the (bounded) motion signal deterministically across labels so a
    // single label dominates for a given input. Each label gets a fixed phase
    // offset; the label whose phase best matches the motion signal wins.
    const labelCount = this.labels.length;
    const scores = new Array<number>(labelCount).fill(0);
    for (let i = 0; i < labelCount; i += 1) {
      const phase = labelCount > 0 ? i / labelCount : 0;
      // Triangular affinity between the motion signal and this label's phase.
      const affinity = 1 - Math.abs(motion - phase);
      scores[i] = affinity * (0.5 + 0.5 * meanConfidence);
    }
    return scores;
  }

  /**
   * Load an ONNX model via onnxruntime-web using a dynamic import so the heavy
   * runtime is only pulled in when a model is actually loaded.
   *
   * TODO(model): map the real model's input tensor shape and output logits to
   * `labels`. The current structure documents the call site without shipping a
   * trained model; it falls back to the stub if the runtime is unavailable.
   */
  private async loadOnnxSession(modelUrl: string): Promise<InferenceSession | null> {
    try {
      // Dynamic import keeps onnxruntime-web out of the main bundle graph until
      // a model is requested. The specifier is a bare package name resolved by
      // the bundler.
      const ort = await import('onnxruntime-web');
      const ortSession = await ort.InferenceSession.create(modelUrl);
      return {
        run: (window, labels) => {
          // TODO(model): flatten `window` into the model's expected input
          // tensor, invoke `ortSession.run`, and read logits back into a
          // score-per-label array. Until wired, fall back to the stub so the
          // structure is exercised without real weights.
          void ortSession;
          void window;
          void labels;
          return this.stubScores(window);
        },
      };
    } catch {
      // Runtime unavailable (e.g. in a bare test environment): use the stub.
      return null;
    }
  }

  /**
   * Load a TFJS LayersModel. Structured like {@link loadOnnxSession}; wired to
   * the stub until a real model + tensor plumbing is provided.
   *
   * TODO(model): load with `tf.loadLayersModel(modelUrl)` and run `predict`.
   */
  private async loadTfjsSession(modelUrl: string): Promise<InferenceSession | null> {
    try {
      const tf = await import('@tensorflow/tfjs');
      const model = await tf.loadLayersModel(modelUrl);
      return {
        run: (window, labels) => {
          // TODO(model): shape `window` into a tensor, call `model.predict`,
          // and read the output back into scores. Stubbed for now.
          void model;
          void window;
          void labels;
          return this.stubScores(window);
        },
      };
    } catch {
      return null;
    }
  }
}

/**
 * Aggregate normalized vertical travel of the hips across a window, scaled to
 * roughly [0, 1]. Used only by the deterministic stub.
 */
function verticalMotion(window: Keypoint[][]): number {
  // MediaPipe hip landmarks (23 left hip, 24 right hip).
  const LEFT_HIP = 23;
  const RIGHT_HIP = 24;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const frame of window) {
    const left = frame[LEFT_HIP];
    const right = frame[RIGHT_HIP];
    const ys: number[] = [];
    if (left !== undefined) ys.push(left.y);
    if (right !== undefined) ys.push(right.y);
    if (ys.length === 0) continue;
    const y = ys.reduce((sum, v) => sum + v, 0) / ys.length;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    return 0;
  }
  // Normalized coordinates are already in [0,1]; the travel is at most 1.
  return Math.min(1, Math.max(0, maxY - minY));
}

/**
 * Mean keypoint confidence across every frame in the window, in [0, 1]. Used
 * only by the deterministic stub. Returns 0 for an empty window.
 */
function windowMeanConfidence(window: Keypoint[][]): number {
  let sum = 0;
  let count = 0;
  for (const frame of window) {
    for (const kp of frame) {
      sum += kp.confidence;
      count += 1;
    }
  }
  if (count === 0) return 0;
  return Math.min(1, Math.max(0, sum / count));
}

/**
 * Numerically stable softmax mapping arbitrary scores to a probability
 * distribution in [0, 1] summing to 1. Returns an empty array for empty input.
 */
function softmax(scores: number[]): number[] {
  if (scores.length === 0) return [];
  let max = Number.NEGATIVE_INFINITY;
  for (const s of scores) {
    if (s > max) max = s;
  }
  const exps = scores.map((s) => Math.exp(s - max));
  const total = exps.reduce((sum, v) => sum + v, 0);
  if (total === 0) {
    // Degenerate: uniform distribution.
    return scores.map(() => 1 / scores.length);
  }
  return exps.map((v) => v / total);
}
