import type { AdapterMetadata, RawPose } from '../../types.js';
import type { Keypoint } from '../../../types/index.js';
import { BasePoseAdapter } from './PoseAdapter.js';

// `@tensorflow-models/pose-detection` and the TFJS core backend are loaded
// lazily inside loadModel() so the heavy runtime is only pulled in when this
// adapter is actually used.
type PoseDetectionModule = typeof import('@tensorflow-models/pose-detection');
type PoseDetector = import('@tensorflow-models/pose-detection').PoseDetector;

/** MoveNet model variant. Thunder is more accurate; Lightning is faster. */
export type MoveNetVariant = 'lightning' | 'thunder';

/** Per-variant static metadata for the two MoveNet adapters. */
const VARIANT_METADATA: Record<MoveNetVariant, AdapterMetadata> = {
  lightning: {
    id: 'movenet-lightning',
    displayName: 'MoveNet Lightning',
    keypointCount: 17,
    backend: 'tfjs',
    modelSizeMb: 5,
    license: 'Apache-2.0',
    version: '1.0.0',
  },
  thunder: {
    id: 'movenet-thunder',
    displayName: 'MoveNet Thunder',
    keypointCount: 17,
    backend: 'tfjs',
    modelSizeMb: 12,
    license: 'Apache-2.0',
    version: '1.0.0',
  },
};

/**
 * Pose adapter backed by TensorFlow.js MoveNet (17 COCO keypoints). Supports
 * both the Lightning and Thunder model types selected via the constructor.
 *
 * MoveNet emits pixel coordinates, so {@link runInference} normalizes each
 * keypoint by the source frame width/height to keep the output in the same
 * `[0, 1]` space as the other adapters. `z` is unavailable and reported as 0.
 *
 * Requirements: 1.1, 1.3, 1.5
 */
export class MoveNetAdapter extends BasePoseAdapter {
  /** Static descriptor for the configured MoveNet variant. */
  readonly metadata: AdapterMetadata;

  /** The MoveNet model variant this instance runs. */
  private readonly variant: MoveNetVariant;

  /** Loaded pose detector, created in {@link loadModel}. */
  private detector: PoseDetector | null = null;

  /**
   * @param variant - Which MoveNet model type to load ('lightning' | 'thunder').
   */
  constructor(variant: MoveNetVariant) {
    super();
    this.variant = variant;
    this.metadata = VARIANT_METADATA[variant];
  }

  /**
   * Create the MoveNet detector for the configured variant. The TFJS core
   * backend is imported first to register its kernels.
   */
  protected async loadModel(): Promise<void> {
    await import('@tensorflow/tfjs');
    const poseDetection: PoseDetectionModule = await import(
      '@tensorflow-models/pose-detection'
    );

    const modelType =
      this.variant === 'thunder'
        ? poseDetection.movenet.modelType.SINGLEPOSE_THUNDER
        : poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING;

    this.detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      { modelType },
    );
  }

  /**
   * Estimate poses on a single frame and map the 17 COCO keypoints to the
   * native {@link Keypoint} format. Pixel coordinates are normalized by the
   * frame dimensions; `z` is 0 and `confidence` is the per-keypoint score.
   *
   * @param frame - Source frame to run inference on.
   * @param timestampMs - Wall-clock timestamp of the source frame.
   */
  protected async runInference(frame: ImageBitmap, timestampMs: number): Promise<RawPose> {
    if (this.detector === null) {
      throw new Error('MoveNet detector is not initialized.');
    }

    const width = frame.width || 1;
    const height = frame.height || 1;
    const poses = await this.detector.estimatePoses(frame);
    const pose = poses[0];
    const keypoints: Keypoint[] = (pose?.keypoints ?? []).map((kp, index) => ({
      index,
      x: kp.x / width,
      y: kp.y / height,
      z: 0,
      confidence: kp.score ?? 0,
    }));

    return { keypoints, timestampMs };
  }

  /** Release the underlying TFJS detector resources. */
  protected override async disposeModel(): Promise<void> {
    if (this.detector !== null) {
      this.detector.dispose();
      this.detector = null;
    }
  }
}

/** Factory helper that constructs the MoveNet Lightning adapter. */
export function createMoveNetLightning(): MoveNetAdapter {
  return new MoveNetAdapter('lightning');
}

/** Factory helper that constructs the MoveNet Thunder adapter. */
export function createMoveNetThunder(): MoveNetAdapter {
  return new MoveNetAdapter('thunder');
}

/** Metadata for the MoveNet Lightning adapter (for registry registration). */
export const MOVENET_LIGHTNING_METADATA: AdapterMetadata = VARIANT_METADATA.lightning;

/** Metadata for the MoveNet Thunder adapter (for registry registration). */
export const MOVENET_THUNDER_METADATA: AdapterMetadata = VARIANT_METADATA.thunder;
