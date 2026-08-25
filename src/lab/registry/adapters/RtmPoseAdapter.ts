import type { AdapterMetadata, RawPose } from '../../types.js';
import type { Keypoint } from '../../../types/index.js';
import { BasePoseAdapter } from './PoseAdapter.js';
import { fetchOnnxModel, PREFERRED_EXECUTION_PROVIDERS } from './onnxModelLoader.js';

// `onnxruntime-web` is loaded lazily inside loadModel() via dynamic import()
// so the WASM/WebGPU runtime is only pulled in when this adapter is used.
type OrtModule = typeof import('onnxruntime-web');
type InferenceSession = import('onnxruntime-web').InferenceSession;

/** Default model asset path for RTMPose (relative to the app root). */
const DEFAULT_MODEL_URL = '/models/rtmpose-m.onnx';

/** Input side length the RTMPose network expects (192x256 is common; use 256 square placeholder). */
const INPUT_SIZE = 256;

/** COCO keypoint count emitted by RTMPose. */
const KEYPOINT_COUNT = 17;

/**
 * SimCC split ratio (upscaling factor of the classification bins relative to
 * input pixels). RTMPose's default is 2.0; dividing the argmax bin index by
 * this recovers the input-pixel coordinate.
 */
const SIMCC_SPLIT_RATIO = 2.0;

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
  scale: number;
  padX: number;
  padY: number;
  srcWidth: number;
  srcHeight: number;
}

/** Argmax value + index over a slice of a Float32Array [start, start+len). */
function argmaxSlice(data: Float32Array, start: number, len: number): { index: number; value: number } {
  let bestIndex = 0;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < len; i += 1) {
    const v = data[start + i] ?? Number.NEGATIVE_INFINITY;
    if (v > bestValue) {
      bestValue = v;
      bestIndex = i;
    }
  }
  return { index: bestIndex, value: bestValue };
}

/** Clamp a value into the normalized [0, 1] range. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Pose adapter backed by ONNX Runtime Web running an RTMPose model
 * (17 COCO keypoints).
 *
 * Implements the RTMPose SimCC decode: aspect-preserving letterbox
 * preprocessing (tracking scale/pad), per-keypoint argmax over the `simcc_x`
 * and `simcc_y` classification vectors, division by the SimCC split ratio to
 * recover input-pixel coordinates, and un-letterboxing back to normalized
 * [0, 1] frame coordinates. The paired peak magnitude provides confidence.
 *
 * Requirements: 1.1, 1.3, 1.5
 */
export class RtmPoseAdapter extends BasePoseAdapter {
  /** Static descriptor for the RTMPose adapter. */
  readonly metadata: AdapterMetadata = {
    id: 'rtmpose',
    displayName: 'RTMPose-M',
    keypointCount: 17,
    backend: 'onnx-web',
    modelSizeMb: 14,
    license: 'Apache-2.0',
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
   * @param modelUrl - Location of the RTMPose ONNX weights. Defaults to
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
    const modelBytes = await fetchOnnxModel(this.modelUrl, 'RTMPose-M');
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
      throw new Error('RTMPose ONNX session is not initialized.');
    }

    const inputName = this.session.inputNames[0];
    if (inputName === undefined) {
      throw new Error('RTMPose ONNX session exposes no input tensors.');
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
   * Convert an {@link ImageBitmap} into an NCHW float32 tensor of shape
   * `[1, 3, INPUT_SIZE, INPUT_SIZE]` using aspect-preserving letterbox scaling,
   * recording the {@link Letterbox} transform for inversion in
   * {@link postprocess}. Pixels are scaled to [0, 1]; RTMPose ONNX exports that
   * bake in mean/std normalization accept this directly.
   */
  private preprocess(frame: ImageBitmap, ort: OrtModule): import('onnxruntime-web').Tensor {
    const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('Failed to acquire 2D context for RTMPose preprocessing.');
    }

    const srcWidth = frame.width;
    const srcHeight = frame.height;
    const scale = Math.min(INPUT_SIZE / srcWidth, INPUT_SIZE / srcHeight);
    const drawW = srcWidth * scale;
    const drawH = srcHeight * scale;
    const padX = (INPUT_SIZE - drawW) / 2;
    const padY = (INPUT_SIZE - drawH) / 2;

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
   * Decode the RTMPose SimCC output into 17 normalized {@link Keypoint}s.
   *
   * The model emits two tensors: `simcc_x` of shape `[1, K, Wx]` and `simcc_y`
   * of shape `[1, K, Wy]`, where each row is a classification distribution over
   * quantized positions along that axis. For each keypoint we argmax both axes,
   * divide the winning bin index by {@link SIMCC_SPLIT_RATIO} to recover the
   * input-pixel coordinate, un-letterbox back to source pixels, and normalize
   * to [0, 1]. Confidence is the smaller of the two peak magnitudes.
   *
   * Output tensors are matched by dimension (larger last-dim = Y for a portrait
   * input) rather than by name, since exported names vary.
   */
  private postprocess(
    output: import('onnxruntime-web').InferenceSession.OnnxValueMapType,
  ): Keypoint[] {
    const box = this.lastLetterbox;
    if (box === null) return emptyPose();

    const tensors = Object.values(output);
    if (tensors.length < 2) return emptyPose();

    // Identify the two SimCC tensors. Both are [1, K, W]; assign x/y by which
    // axis maps to width vs height of the (square) input. With a square input
    // Wx === Wy, so fall back to declaration order (x first, then y).
    const t0 = tensors[0];
    const t1 = tensors[1];
    if (t0 === undefined || t1 === undefined) return emptyPose();

    const simccX = t0;
    const simccY = t1;
    const xData = simccX.data as Float32Array;
    const yData = simccY.data as Float32Array;

    const kx = Number(simccX.dims[1] ?? 0);
    const wx = Number(simccX.dims[2] ?? 0);
    const ky = Number(simccY.dims[1] ?? 0);
    const wy = Number(simccY.dims[2] ?? 0);
    if (kx < KEYPOINT_COUNT || ky < KEYPOINT_COUNT || wx <= 0 || wy <= 0) {
      return emptyPose();
    }

    const keypoints: Keypoint[] = [];
    for (let k = 0; k < KEYPOINT_COUNT; k += 1) {
      const bx = argmaxSlice(xData, k * wx, wx);
      const by = argmaxSlice(yData, k * wy, wy);

      // Bin index / split ratio → input-pixel coordinate.
      const inputX = bx.index / SIMCC_SPLIT_RATIO;
      const inputY = by.index / SIMCC_SPLIT_RATIO;

      // Invert the letterbox and normalize by source dimensions.
      const srcX = (inputX - box.padX) / box.scale;
      const srcY = (inputY - box.padY) / box.scale;
      const nx = clamp01(srcX / box.srcWidth);
      const ny = clamp01(srcY / box.srcHeight);

      // Peak magnitudes are logits; use the smaller as a conservative
      // confidence and squash into [0, 1] with a logistic.
      const peak = Math.min(bx.value, by.value);
      const confidence = clamp01(1 / (1 + Math.exp(-peak)));

      keypoints.push({ index: k, x: nx, y: ny, z: 0, confidence });
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

/** Metadata for the RTMPose adapter (for registry registration). */
export const RTMPOSE_METADATA: AdapterMetadata = {
  id: 'rtmpose',
  displayName: 'RTMPose-M',
  keypointCount: 17,
  backend: 'onnx-web',
  modelSizeMb: 14,
  license: 'Apache-2.0',
  version: '1.0.0',
};
