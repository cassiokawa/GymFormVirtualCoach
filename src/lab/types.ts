/**
 * Lab-specific shared types for the CV Algorithm Lab.
 *
 * The Algorithm Lab is an in-browser ML research platform layered on top of
 * the live workout pipeline. Every pose model, classifier, and form assessor
 * is accessed through the uniform contracts defined here so downstream code
 * stays model-agnostic.
 *
 * Requirements covered: 1.3, 1.5, 2.1, 3.1, 4.1, 6.1, 8.1, 11.1, 12.1, 13.1, 14.1
 */

import type { Keypoint } from '../types/index.js';

// ---------------------------------------------------------------------------
// Pose Adapters (Req 1)
// ---------------------------------------------------------------------------

/**
 * Runtime inference backend a pose model executes on.
 * - `mediapipe-wasm` — MediaPipe Tasks Vision (WASM).
 * - `tfjs`          — TensorFlow.js (MoveNet, TFJS classifiers).
 * - `onnx-web`      — ONNX Runtime Web (YOLOv8-Pose, RTMPose, form models).
 */
export type RuntimeBackend = 'mediapipe-wasm' | 'tfjs' | 'onnx-web';

/**
 * Static descriptor for a registered pose adapter. Exposed via
 * `ModelRegistry.list()` so the UI can present model choices without
 * instantiating adapters.
 */
export interface AdapterMetadata {
  /** Stable unique identifier, e.g. "movenet-thunder". */
  id: string;
  /** Human-readable name for UI, e.g. "MoveNet Thunder". */
  displayName: string;
  /** Native keypoint count emitted by the model (17 COCO or 33 MediaPipe). */
  keypointCount: 17 | 33;
  /** Runtime backend the adapter executes on. */
  backend: RuntimeBackend;
  /** Approximate on-disk model weight size in megabytes. */
  modelSizeMb: number;
  /** SPDX-style license identifier or short license name. */
  license: string;
  /** Semantic version of the bundled/registered model. */
  version: string;
}

/**
 * A single-frame pose inference result in the adapter's native keypoint
 * format (17 or 33). Normalization to the 33-keypoint MediaPipe schema
 * happens downstream so adapters remain simple.
 */
export interface RawPose {
  /** Native keypoints (17 COCO or 33 MediaPipe). */
  keypoints: Keypoint[];
  /** Wall-clock timestamp of the source frame in milliseconds. */
  timestampMs: number;
}

/**
 * Uniform contract every pose model implements. Adapters are lazily
 * instantiated by the registry; callers must `await load()` before `detect()`.
 */
export interface PoseAdapter {
  /** Static descriptor for this adapter. */
  readonly metadata: AdapterMetadata;
  /** Load model weights. Idempotent. Rejects with a descriptive error on failure. */
  load(): Promise<void>;
  /** Run inference on a single frame. Requires `load()` to have resolved. */
  detect(frame: ImageBitmap, timestampMs: number): Promise<RawPose>;
  /** Release GPU/WASM resources held by the adapter. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Benchmarking (Req 3)
// ---------------------------------------------------------------------------

/**
 * Latency distribution statistics for a benchmark run. All millisecond
 * figures exclude warm-up frames.
 */
export interface LatencyStats {
  /** Mean frames per second across successful frames. */
  meanFps: number;
  /** Median per-frame latency in milliseconds. */
  medianMs: number;
  /** 95th-percentile per-frame latency in milliseconds. */
  p95Ms: number;
  /** Standard deviation of per-frame latency in milliseconds. */
  stdDevMs: number;
}

/**
 * Accuracy statistics computed against ground-truth annotations using OKS.
 * Present only when a benchmark run supplies ground truth.
 */
export interface AccuracyStats {
  /** Mean Object Keypoint Similarity across scored frames [0, 1]. */
  meanOks: number;
  /** Fraction of ground-truth keypoints with OKS >= 0.5. */
  recallAt050: number;
  /** Per-keypoint mean OKS, length 33 (MediaPipe schema). */
  perKeypointOks: number[];
}

/**
 * Persistent record of a completed benchmark run.
 */
export interface BenchmarkResult {
  /** UUID identifying this run. */
  id: string;
  /** Adapter id that was benchmarked. */
  modelId: string;
  /** Wall-clock timestamp when the run completed, in milliseconds. */
  timestampMs: number;
  /** Total frames submitted (excluding warm-up). */
  frameCount: number;
  /** Number of frames that produced a pose. */
  successCount: number;
  /** Number of frames that failed inference. */
  failedCount: number;
  /** Latency distribution statistics. */
  latency: LatencyStats;
  /** Accuracy statistics, or null when no ground truth was provided. */
  accuracy: AccuracyStats | null;
  /** Per-frame latency samples in milliseconds (warm-up excluded). */
  perFrameLatencyMs: number[];
  /** false when more than 50% of frames failed. */
  valid: boolean;
  /** Optional advisory, e.g. "insufficient successful frames". */
  warning?: string;
}

/**
 * Inputs to a single benchmark run.
 */
export interface BenchmarkOptions {
  /** Frames to benchmark; >=100 recommended for stable statistics. */
  frames: ImageBitmap[];
  /** Optional ground-truth frames enabling accuracy scoring. */
  groundTruth?: GroundTruthFrame[];
  /** Number of leading frames excluded from stats. Defaults to 5. */
  warmupFrames?: number;
}

// ---------------------------------------------------------------------------
// Ground Truth Annotation (Req 7)
// ---------------------------------------------------------------------------

/**
 * A hand-annotated ground-truth frame used for accuracy benchmarking.
 * Positions are in the 33-keypoint MediaPipe schema, normalized to [0, 1].
 */
export interface GroundTruthFrame {
  /** UUID identifying this annotation. */
  id: string;
  /** Identifier of the source video the frame was captured from. */
  sourceVideoId: string;
  /** Zero-based index of the frame within its source video. */
  frameIndex: number;
  /** Captured frame image bytes. */
  imageRef: Blob;
  /** 33 normalized [0, 1] positions in MediaPipe index order. */
  keypoints: Array<{ x: number; y: number }>;
  /** 33 visibility flags aligned with `keypoints`. */
  visibility: boolean[];
  /** Wall-clock creation timestamp in milliseconds. */
  createdMs: number;
}

// ---------------------------------------------------------------------------
// Recording & Training Data (Req 12, 13)
// ---------------------------------------------------------------------------

/**
 * A single captured frame of keypoints within a recording session.
 */
export interface RecordedFrame {
  /** Wall-clock timestamp of the frame in milliseconds. */
  timestampMs: number;
  /** Keypoints captured for the frame. */
  keypoints: Keypoint[];
}

/**
 * Human-provided labels attached to a recording session.
 */
export interface RecordingLabels {
  /** Exercise name the recording represents. */
  exerciseName: string;
  /** Rep segment boundaries within the recorded frame sequence. */
  repBoundaries: Array<{ startFrame: number; endFrame: number }>;
  /** Overall subjective quality rating, 1 (poor) to 5 (excellent). */
  qualityRating: 1 | 2 | 3 | 4 | 5;
  /** Optional per-frame-index error labels. */
  frameErrors?: Record<number, string[]>;
}

/**
 * A recorded, labeled sequence of keypoints usable as training data.
 */
export interface RecordingSession {
  /** UUID identifying this recording. */
  id: string;
  /** Provenance and summary metadata for the recording. */
  metadata: {
    exerciseName: string;
    durationMs: number;
    modelId: string;
    createdMs: number;
  };
  /** Ordered captured frames. */
  frames: RecordedFrame[];
  /** Human-provided labels. */
  labels: RecordingLabels;
  /** Export/persistence schema version. */
  schemaVersion: 1;
}

/**
 * Hyperparameters controlling an in-browser training run.
 */
export interface TrainingConfig {
  /** Model architecture to train. */
  architecture: 'mlp' | 'lstm';
  /** Optimizer learning rate. */
  learningRate: number;
  /** Mini-batch size. */
  batchSize: number;
  /** Number of training epochs. */
  epochs: number;
  /** Sliding-window length in frames used to form training samples. */
  windowSize: number;
  /** Fraction of data held out for validation [0, 1]. */
  valSplit: number;
}

/**
 * Progress event streamed during training.
 */
export interface TrainingProgress {
  /** Completed epoch index. */
  epoch: number;
  /** Training loss at the end of the epoch. */
  loss: number;
  /** Validation accuracy at the end of the epoch [0, 1]. */
  valAccuracy: number;
}

/**
 * A trained classifier persisted in the lab, exported to both TFJS and ONNX.
 */
export interface TrainedModelRecord {
  /** UUID identifying this trained model. */
  id: string;
  /** Exercise the model was trained to classify. */
  exerciseName: string;
  /** Serialized TFJS LayersModel artifacts. */
  tfjsArtifacts: unknown;
  /** Exported ONNX model bytes. */
  onnxBytes: ArrayBuffer;
  /** Training provenance and outcome metadata. */
  metadata: {
    datasetSize: number;
    finalAccuracy: number;
    exercises: string[];
    createdMs: number;
  };
}

// ---------------------------------------------------------------------------
// Classification & Form Assessment (Req 6, 11)
// ---------------------------------------------------------------------------

/**
 * Output of the exercise classifier for a completed window.
 */
export interface ClassificationResult {
  /** Predicted exercise name, or "unknown" below the confidence threshold. */
  label: string;
  /** Prediction confidence [0, 1]. */
  confidence: number;
}

/**
 * A single form deviation detected by the form-quality model.
 */
export interface FormDeviationML {
  /** Short label describing the deviation. */
  errorLabel: string;
  /** Keypoint indices most affected by the deviation. */
  affectedJoints: number[];
  /** Deviation severity [0, 1]. */
  severity: number;
  /** Actionable correction suggestion for the user. */
  suggestion: string;
}

/**
 * Aggregate form assessment for a window of frames.
 */
export interface FormAssessment {
  /** Overall form quality score [0, 1]. */
  qualityScore: number;
  /** Detected deviations (emitted above the model's confidence threshold). */
  deviations: FormDeviationML[];
}

/**
 * Neural architecture backing the form-quality model.
 */
export type FormArchitecture = 'stgcn' | 'transformer';

// ---------------------------------------------------------------------------
// Recommendation (Req 9)
// ---------------------------------------------------------------------------

/**
 * A model recommendation derived from a set of benchmark results.
 */
export interface Recommendation {
  /** Adapter id with the best composite score. */
  bestOverallModelId: string;
  /** Concise summary, <= 300 characters. */
  summary: string;
  /** Per body-region notes (head/upper/torso/lower). */
  perRegionNotes: string[];
  /** Best-fit model id per use-case category. */
  useCaseCategory: Record<string, 'real-time coaching' | 'accuracy-critical' | 'balanced'>;
}

// ---------------------------------------------------------------------------
// Pre-trained Catalog (Req 14)
// ---------------------------------------------------------------------------

/**
 * A downloadable pre-trained adapter entry in the catalog.
 */
export interface CatalogEntry {
  /** Stable unique identifier. */
  id: string;
  /** Human-readable name for UI. */
  displayName: string;
  /** Kind of model provided by this entry. */
  kind: 'repnet-counter' | 'exercise-classifier' | 'form-assessor' | 'dtw-matcher';
  /** Download URL for the model weights. */
  url: string;
  /** Serialization format of the weights. */
  format: 'onnx' | 'tfjs';
  /** Download size in megabytes. */
  sizeMb: number;
  /** Exercises the model supports. */
  supportedExercises: string[];
  /** Expected accuracy for the model [0, 1]. */
  expectedAccuracy: number;
  /** Sliding-window length in frames expected by the model. */
  windowSize: number;
  /** Keypoint schema the model consumes. */
  keypointFormat: 17 | 33;
  /** SPDX-style license identifier or short license name. */
  license: string;
  /** Semantic version of the catalog entry. */
  version: string;
}

// ---------------------------------------------------------------------------
// Web Worker Protocol (Req 8)
// ---------------------------------------------------------------------------

/**
 * Message sent from the main thread to a pose worker.
 * - `init`    — load a model on a chosen backend.
 * - `detect`  — run inference on a transferred frame.
 * - `dispose` — release resources and prepare for termination.
 */
export type WorkerRequest =
  | { type: 'init'; modelId: string; modelUrl?: string; backend: RuntimeBackend }
  | { type: 'detect'; frameId: number; frame: ImageBitmap; timestampMs: number }
  | { type: 'dispose' };

/**
 * Message sent from a pose worker back to the main thread.
 * - `ready`  — model loaded; the worker will accept `detect` requests.
 * - `result` — inference output for a specific frame.
 * - `error`  — categorized failure during load or inference.
 */
export type WorkerResponse =
  | { type: 'ready'; modelId: string }
  | { type: 'result'; frameId: number; keypoints: Keypoint[]; timestampMs: number }
  | { type: 'error'; category: 'load' | 'inference' | 'oom'; message: string };
