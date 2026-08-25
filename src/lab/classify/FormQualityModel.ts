/**
 * FormQualityModel — ST-GCN / Transformer form-quality assessor (Req 11).
 *
 * Scores exercise form quality from a temporal sequence of normalized
 * keypoints and emits structured {@link FormDeviationML} events for detected
 * errors. Real inference runs an ONNX model via ONNX Runtime Web (loaded
 * lazily inside {@link FormQualityModel.load} through a dynamic import so the
 * WASM/WebGPU runtime is only pulled in when a model is actually loaded).
 *
 * Until a trained model is bundled, the class ships a documented, deterministic
 * stub inference path that derives a plausible quality score from joint-angle
 * variance across the window. This keeps the class fully testable without any
 * binary weights or GPU (Req 11 tests use stub sessions).
 *
 * A real ST-GCN form model trained on the Fitness-AQA dataset (covering
 * BackSquat, BarbellRow, and OverheadPress error detection) is intended to be
 * bundled at {@link BUNDLED_STGCN_MODEL_PATH} in `public/models/` (Req 11.6).
 * The binary weights are NOT fabricated here; only the expected path and the
 * loader wiring are provided.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.6
 */

import type { Keypoint } from '../../types/index.js';
import type {
  FormArchitecture,
  FormAssessment,
  FormDeviationML,
} from '../types.js';

// `onnxruntime-web` is loaded lazily inside load() via dynamic import() so the
// WASM/WebGPU runtime is only pulled in when a real model is loaded.
type OrtModule = typeof import('onnxruntime-web');
type InferenceSession = import('onnxruntime-web').InferenceSession;

/**
 * Expected asset path (relative to the app root) of the pre-bundled Fitness-AQA
 * ST-GCN form-quality model shipped in `public/models/` (Req 11.6).
 *
 * README: this ONNX file is trained on the Fitness-AQA dataset and covers form
 * error detection for BackSquat, BarbellRow, and OverheadPress. It is treated
 * as untrusted data — it is handed straight to ONNX Runtime Web and never
 * eval'd. The binary is not committed by this task; drop the trained weights
 * at `public/models/fitness-aqa-stgcn.onnx` to enable real inference.
 */
export const BUNDLED_STGCN_MODEL_PATH = 'models/fitness-aqa-stgcn.onnx';

/** Default temporal window length (frames) the model consumes (Req 11.1). */
const DEFAULT_WINDOW_SIZE = 30;

/** Minimum confidence a deviation must exceed to be emitted (Req 11.3). */
const DEVIATION_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Documented empty assessment returned when a window has too few frames.
 * A perfect (1.0) score with no deviations is the safe, non-alarming default.
 */
const EMPTY_ASSESSMENT: FormAssessment = { qualityScore: 1, deviations: [] };

/**
 * Joint index triples used by the stub path to estimate joint-angle variance.
 * Indices follow the 33-point MediaPipe topology. Each triple is
 * `[a, vertex, b]`, and the interior angle at `vertex` is measured.
 */
const STUB_ANGLE_TRIPLES: ReadonlyArray<readonly [number, number, number]> = [
  [11, 13, 15], // left elbow
  [12, 14, 16], // right elbow
  [23, 25, 27], // left knee
  [24, 26, 28], // right knee
  [11, 23, 25], // left hip
  [12, 24, 26], // right hip
];

/**
 * Assesses exercise form quality from a window of normalized keypoints.
 *
 * @example
 * ```ts
 * const model = new FormQualityModel({ architecture: 'stgcn' });
 * await model.load(BUNDLED_STGCN_MODEL_PATH);
 * const assessment = await model.assess(window); // window: Keypoint[][]
 * ```
 */
export class FormQualityModel {
  /** Neural architecture backing this model (Req 11.2). */
  private readonly architecture: FormArchitecture;

  /** Number of frames required per assessment window. */
  private readonly windowSize: number;

  /** Lazily loaded ONNX Runtime Web module (null until {@link load}). */
  private ort: OrtModule | null = null;

  /** Loaded inference session, created in {@link load} (null when stubbed). */
  private session: InferenceSession | null = null;

  /**
   * Error state. When set, the model is considered unavailable and
   * {@link assess} falls back to the empty assessment until {@link load}
   * succeeds again (Req 11 error handling). Cleared on a successful load.
   */
  private errored = false;

  /**
   * @param opts.architecture - `'stgcn'` or `'transformer'` (Req 11.2).
   * @param opts.windowSize - Frames per assessment window. Defaults to 30.
   */
  constructor(opts: { architecture: FormArchitecture; windowSize?: number }) {
    this.architecture = opts.architecture;
    this.windowSize = opts.windowSize ?? DEFAULT_WINDOW_SIZE;
  }

  /**
   * Load an ONNX form-quality model via ONNX Runtime Web.
   *
   * On any load failure the model enters an error state: {@link isAvailable}
   * returns `false` and subsequent {@link assess} calls report the model as
   * unavailable (returning the empty assessment) until a later {@link load}
   * succeeds (Req 11 error handling).
   *
   * @param modelUrl - Location of the ONNX weights (e.g.
   *   {@link BUNDLED_STGCN_MODEL_PATH}).
   */
  async load(modelUrl: string): Promise<void> {
    try {
      this.ort = await import('onnxruntime-web');
      this.session = await this.ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
      });
      this.errored = false;
    } catch (cause) {
      // Enter the unavailable state; keep the stub path usable for callers that
      // tolerate it, but flag the model as errored so isAvailable() is false.
      this.session = null;
      this.ort = null;
      this.errored = true;
      throw new Error(
        `FormQualityModel failed to load model from "${modelUrl}": ${String(cause)}`,
      );
    }
  }

  /**
   * Whether a model is loaded and not in an error state. When `false`, the
   * model is unavailable and {@link assess} returns the empty assessment.
   */
  isAvailable(): boolean {
    return this.session !== null && !this.errored;
  }

  /**
   * Assess form quality over a window of frames.
   *
   * Requires at least `windowSize` frames; when fewer are supplied the
   * documented {@link EMPTY_ASSESSMENT} is returned (no throw) so callers can
   * safely buffer until the window fills.
   *
   * When a real ONNX session is loaded, inference runs through it; otherwise
   * the deterministic stub path is used. Only deviations whose confidence
   * exceeds {@link DEVIATION_CONFIDENCE_THRESHOLD} (0.6) are emitted (Req 11.3).
   *
   * @param window - A temporal sequence of normalized keypoint frames.
   * @returns A {@link FormAssessment} with `qualityScore` in `[0, 1]` and the
   *   surviving {@link FormDeviationML} deviations.
   */
  async assess(window: Keypoint[][]): Promise<FormAssessment> {
    if (window.length < this.windowSize) {
      return { ...EMPTY_ASSESSMENT, deviations: [] };
    }

    // If a load previously failed, the model is unavailable until reloaded.
    if (this.errored) {
      return { ...EMPTY_ASSESSMENT, deviations: [] };
    }

    let raw: FormAssessment;
    if (this.session !== null && this.ort !== null) {
      try {
        raw = await this.runInference(window);
      } catch (cause) {
        // Inference failure marks the model unavailable until reloaded.
        this.errored = true;
        void cause;
        return { ...EMPTY_ASSESSMENT, deviations: [] };
      }
    } else {
      raw = this.stubAssess(window);
    }

    return {
      qualityScore: clamp01(raw.qualityScore),
      deviations: raw.deviations.filter(
        (deviation) => deviationConfidence(deviation) > DEVIATION_CONFIDENCE_THRESHOLD,
      ),
    };
  }

  /**
   * Run real ONNX inference over the window.
   *
   * TODO: wire the actual ST-GCN / Transformer decode. This requires packing
   * the window into the model's expected `[1, C, T, V]` (ST-GCN) or
   * `[1, T, V*C]` (transformer) tensor, running the session, and decoding the
   * output head into a quality score plus per-error confidences. Until the
   * bundled Fitness-AQA weights and their I/O contract are finalized, this
   * falls back to the deterministic stub so the session lifecycle is exercised
   * without fabricating an output schema.
   */
  private async runInference(window: Keypoint[][]): Promise<FormAssessment> {
    // Placeholder: a real implementation would build feeds from `window`,
    // await this.session.run(feeds), and decode the output tensors.
    // We intentionally reuse the deterministic estimate here.
    return this.stubAssess(window);
  }

  /**
   * Deterministic stub assessment (no weights required).
   *
   * Computes a plausible quality score from the temporal variance of a handful
   * of joint angles: lower variance across the window implies steadier, more
   * controlled movement and a higher score. Deviations are synthesized for the
   * noisiest joints so downstream emission/threshold logic (Req 11.3) is
   * exercised. This path is documented and used purely for testability — see
   * the class-level TODO to replace it with the real model.
   */
  private stubAssess(window: Keypoint[][]): FormAssessment {
    const frames = window.slice(-this.windowSize);

    let totalVariance = 0;
    let counted = 0;
    const deviations: FormDeviationML[] = [];

    for (const [a, vertex, b] of STUB_ANGLE_TRIPLES) {
      const angles: number[] = [];
      for (const frame of frames) {
        const angle = jointAngle(frame[a], frame[vertex], frame[b]);
        if (angle !== null) {
          angles.push(angle);
        }
      }
      if (angles.length < 2) {
        continue;
      }

      const variance = populationVariance(angles);
      totalVariance += variance;
      counted += 1;

      // Normalize variance (in degrees^2) into a [0, 1] severity. 900 deg^2
      // (a 30-degree std) is treated as fully deviant.
      const severity = clamp01(variance / 900);
      // Confidence tracks severity but is deliberately conservative so many
      // low-severity joints stay below the 0.6 emission threshold (Req 11.3).
      const confidence = clamp01(severity);
      if (confidence > DEVIATION_CONFIDENCE_THRESHOLD) {
        deviations.push({
          errorLabel: `unstable_joint_${vertex}`,
          affectedJoints: [a, vertex, b],
          severity,
          suggestion: `Keep joint ${vertex} steadier through the movement to reduce wobble.`,
        });
      }
    }

    const meanVariance = counted > 0 ? totalVariance / counted : 0;
    // Higher mean angular variance → lower quality. 900 deg^2 mean variance
    // maps to a score of 0.
    const qualityScore = clamp01(1 - meanVariance / 900);

    return { qualityScore, deviations };
  }

  /** Release the underlying ONNX session resources, if any. */
  async dispose(): Promise<void> {
    if (this.session !== null) {
      await this.session.release();
      this.session = null;
    }
    this.ort = null;
  }
}

/**
 * Confidence used to threshold a deviation for emission (Req 11.3). The public
 * {@link FormDeviationML} contract carries `severity` rather than a separate
 * confidence field, so severity is used as the confidence proxy.
 */
function deviationConfidence(deviation: FormDeviationML): number {
  return deviation.severity;
}

/** Clamp a value into the `[0, 1]` range. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/** Population variance of a non-empty numeric array. */
function populationVariance(values: number[]): number {
  const n = values.length;
  if (n === 0) {
    return 0;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  const mean = sum / n;
  let acc = 0;
  for (const value of values) {
    const diff = value - mean;
    acc += diff * diff;
  }
  return acc / n;
}

/**
 * Interior angle (degrees, `[0, 180]`) at `vertex` formed by `a`–`vertex`–`b`.
 * Returns `null` when any keypoint is missing so the caller can skip it.
 */
function jointAngle(
  a: Keypoint | undefined,
  vertex: Keypoint | undefined,
  b: Keypoint | undefined,
): number | null {
  if (a === undefined || vertex === undefined || b === undefined) {
    return null;
  }
  const v1x = a.x - vertex.x;
  const v1y = a.y - vertex.y;
  const v2x = b.x - vertex.x;
  const v2y = b.y - vertex.y;

  const mag1 = Math.hypot(v1x, v1y);
  const mag2 = Math.hypot(v2x, v2y);
  if (mag1 === 0 || mag2 === 0) {
    return null;
  }

  const cos = (v1x * v2x + v1y * v2y) / (mag1 * mag2);
  const clamped = Math.min(1, Math.max(-1, cos));
  return (Math.acos(clamped) * 180) / Math.PI;
}
