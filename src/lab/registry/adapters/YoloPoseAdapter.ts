import type { AdapterMetadata, RawPose } from '../../types.js';
import type { Keypoint } from '../../../types/index.js';
import { BasePoseAdapter } from './PoseAdapter.js';
import { fetchOnnxModel, PREFERRED_EXECUTION_PROVIDERS } from './onnxModelLoader.js';

// `onnxruntime-web` is loaded lazily inside loadModel() via dynamic import()
// so the WASM/WebGPU runtime is only pulled in when this adapter is used.
type OrtModule = typeof import('onnxruntime-web');
type InferenceSession = import('onnxruntime-web').InferenceSession;

/** Default model asset path for YOLOv8-Pose (relative to the app root). */
const DEFAULT_MODEL_URL = '/models/yolov8n-pose.onnx';

/** Square input side length the YOLOv8-Pose network expects. */
const INPUT_SIZE = 640;

/** COCO keypoint count emitted by YOLOv8-Pose. */
const KEYPOINT_COUNT = 17;

/** Minimum person-detection score for a pose to be considered present. */
const SCORE_THRESHOLD = 0.25;

/** An all-zero (unavailable) pose of the correct shape. */
function emptyPose(): Keypoint[] {
  return Array.from({ length: KEYPOINT_COUNT }, (_unused, index): Keypoint => ({
    index,
    x: 0,
    y: 0,
    z: 0,
    confidence: 0,
  }));
}

/** Letterbox transform recorded during preprocessing for later inversion. */
interface Letterbox {
  /** Uniform scale applied to the source frame. */
  scale: number;
  /** Horizontal padding (px) added on the left inside the square canvas. */
  padX: number;
  /** Vertical padding (px) added on top inside the square canvas. */
  padY: number;
  /** Original source frame width in pixels. */
  srcWidth: number;
  /** Original source frame height in pixels. */
  srcHeight: number;
}

/**
 * Pose adapter backed by ONNX Runtime Web running a YOLOv8-Pose model
 * (17 COCO keypoints).
 *
 * Implements the full single-person YOLOv8-Pose decode: aspect-preserving
 * letterbox preprocessing (tracking scale/pad), selection of the highest-score
 * anchor from the `[1, 56, N]` output, and un-letterboxing of the 17 keypoints
 * back to normalized [0, 1] frame coordinates. Confidence below
 * {@link SCORE_THRESHOLD} yields an all-zero (unavailable) pose.
 *
 * Requirements: 1.1, 1.3, 1.5
 */
export class YoloPoseAdapter extends BasePoseAdapter {
  /** Static descriptor for the YOLOv8-Pose adapter. */
  readonly metadata: AdapterMetadata = {
    id: 'yolov8-pose',
    displayName: 'YOLOv8-Pose',
    keypointCount: 17,
    backend: 'onnx-web',
    modelSizeMb: 13,
    license: 'AGPL-3.0',
    version: '1.0.0',
  };

  /** URL the ONNX model is loaded from. */
  private readonly modelUrl: string;

  /** Lazily loaded ONNX Runtime Web module. */
  private ort: OrtModule | null = null;

  /** Loaded inference session, created in {@link loadModel}. */
  private session: InferenceSession | null = null;

  /** Letterbox transform from the most recent preprocess, for inversion. */
  private lastLetterbox: Letterbox | null = null;

  /**
   * @param modelUrl - Location of the YOLOv8-Pose ONNX weights. Defaults to
   *   {@link DEFAULT_MODEL_URL}.
   */
  constructor(modelUrl: string = DEFAULT_MODEL_URL) {
    super();
    this.modelUrl = modelUrl;
  }

  /** Create the ONNX inference session from {@link modelUrl}. */
  protected async loadModel(): Promise<void> {
    this.ort = await import('onnxruntime-web');
    // Fetch + validate the file first so a missing weight file yields a clear
    // message instead of ORT's opaque "protobuf parsing failed".
    const modelBytes = await fetchOnnxModel(this.modelUrl, 'YOLOv8-Pose');
    this.session = await this.ort.InferenceSession.create(modelBytes, {
      executionProviders: [...PREFERRED_EXECUTION_PROVIDERS],
    });
  }

  /**
   * Preprocess the frame to an input tensor, run the session, and post-process
   * the raw output into 17 {@link Keypoint}s.
   *
   * @param frame - Source frame to run inference on.
   * @param timestampMs - Wall-clock timestamp of the source frame.
   */
  protected async runInference(frame: ImageBitmap, timestampMs: number): Promise<RawPose> {
    if (this.ort === null || this.session === null) {
      throw new Error('YOLOv8-Pose ONNX session is not initialized.');
    }

    const inputName = this.session.inputNames[0];
    if (inputName === undefined) {
      throw new Error('YOLOv8-Pose ONNX session exposes no input tensors.');
    }
    const inputTensor = this.preprocess(frame, this.ort);
    const feeds: Record<string, import('onnxruntime-web').Tensor> = {
      [inputName]: inputTensor,
    };
    const output = await this.session.run(feeds);
    const keypoints = this.postprocess(output);

    return { keypoints, timestampMs };
  }

  /**
   * Convert an {@link ImageBitmap} into a normalized NCHW float32 tensor of
   * shape `[1, 3, INPUT_SIZE, INPUT_SIZE]` using aspect-preserving letterbox
   * scaling. The applied {@link Letterbox} transform is recorded on
   * {@link lastLetterbox} so {@link postprocess} can invert it.
   */
  private preprocess(frame: ImageBitmap, ort: OrtModule): import('onnxruntime-web').Tensor {
    const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('Failed to acquire 2D context for YOLOv8-Pose preprocessing.');
    }

    const srcWidth = frame.width;
    const srcHeight = frame.height;
    // Uniform scale that fits the source inside the square input.
    const scale = Math.min(INPUT_SIZE / srcWidth, INPUT_SIZE / srcHeight);
    const drawW = srcWidth * scale;
    const drawH = srcHeight * scale;
    const padX = (INPUT_SIZE - drawW) / 2;
    const padY = (INPUT_SIZE - drawH) / 2;

    // Grey letterbox background (matches Ultralytics' 114/255 fill).
    ctx.fillStyle = 'rgb(114, 114, 114)';
    ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
    ctx.drawImage(frame, padX, padY, drawW, drawH);

    this.lastLetterbox = { scale, padX, padY, srcWidth, srcHeight };

    const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
    const pixelCount = INPUT_SIZE * INPUT_SIZE;
    const chw = new Float32Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i += 1) {
      chw[i] = (data[i * 4] ?? 0) / 255;
      chw[pixelCount + i] = (data[i * 4 + 1] ?? 0) / 255;
      chw[pixelCount * 2 + i] = (data[i * 4 + 2] ?? 0) / 255;
    }

    return new ort.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  }

  /**
   * Decode the raw ONNX output into 17 normalized {@link Keypoint}s.
   *
   * YOLOv8-Pose emits a single output tensor of shape `[1, 56, N]` where each of
   * the N anchors packs `[cx, cy, w, h, score, then 17*(x, y, conf)]` — box and
   * keypoint coordinates are in input-pixel space (0–{@link INPUT_SIZE}). We
   * transpose-index the flattened data, pick the highest-scoring anchor, and
   * un-letterbox each keypoint back to normalized [0, 1] source coordinates.
   *
   * Returns an all-zero pose when no anchor clears {@link SCORE_THRESHOLD} or
   * the letterbox transform is unavailable.
   */
  private postprocess(
    output: import('onnxruntime-web').InferenceSession.OnnxValueMapType,
  ): Keypoint[] {
    const box = this.lastLetterbox;
    if (box === null) return emptyPose();

    // Take the first (only) output tensor.
    const first = Object.values(output)[0];
    if (first === undefined) return emptyPose();
    const data = first.data as Float32Array;
    const dims = first.dims;
    // Expect [1, 56, N]. channels = 4 box + 1 score + 17*3 keypoints = 56.
    const channels = dims.length === 3 ? Number(dims[1]) : 0;
    const anchors = dims.length === 3 ? Number(dims[2]) : 0;
    if (channels < 5 + KEYPOINT_COUNT * 3 || anchors <= 0) return emptyPose();

    // Column-major access: value(channel, anchor) = data[channel * anchors + anchor].
    const at = (channel: number, anchor: number): number =>
      data[channel * anchors + anchor] ?? 0;

    // Find the anchor with the highest person score (channel index 4).
    let bestAnchor = -1;
    let bestScore = SCORE_THRESHOLD;
    for (let a = 0; a < anchors; a += 1) {
      const score = at(4, a);
      if (score > bestScore) {
        bestScore = score;
        bestAnchor = a;
      }
    }
    if (bestAnchor < 0) return emptyPose();

    const keypoints: Keypoint[] = [];
    for (let k = 0; k < KEYPOINT_COUNT; k += 1) {
      // Keypoint block starts after box(4) + score(1) = channel 5.
      const base = 5 + k * 3;
      const inputX = at(base, bestAnchor);
      const inputY = at(base + 1, bestAnchor);
      const conf = at(base + 2, bestAnchor);

      // Invert the letterbox: remove padding, undo scale, normalize by source.
      const srcX = (inputX - box.padX) / box.scale;
      const srcY = (inputY - box.padY) / box.scale;
      const nx = clamp01(srcX / box.srcWidth);
      const ny = clamp01(srcY / box.srcHeight);

      keypoints.push({ index: k, x: nx, y: ny, z: 0, confidence: clamp01(conf) });
    }
    return keypoints;
  }

  /** Release the underlying ONNX session resources. */
  protected override async disposeModel(): Promise<void> {
    if (this.session !== null) {
      await this.session.release();
      this.session = null;
    }
    this.ort = null;
  }
}

/** Metadata for the YOLOv8-Pose adapter (for registry registration). */
export const YOLO_POSE_METADATA: AdapterMetadata = {
  id: 'yolov8-pose',
  displayName: 'YOLOv8-Pose',
  keypointCount: 17,
  backend: 'onnx-web',
  modelSizeMb: 13,
  license: 'AGPL-3.0',
  version: '1.0.0',
};

/** Clamp a value into the normalized [0, 1] range. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
