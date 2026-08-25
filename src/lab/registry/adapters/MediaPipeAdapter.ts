import type { AdapterMetadata, RawPose } from '../../types.js';
import type { Keypoint } from '../../../types/index.js';
import { BasePoseAdapter } from './PoseAdapter.js';

// The `@mediapipe/tasks-vision` module is loaded lazily via dynamic import()
// inside loadModel() so the heavy WASM runtime is only pulled in when this
// adapter is actually used. The PoseLandmarker constructor is private, so the
// instance type is referenced directly rather than via InstanceType<...>.
type PoseLandmarkerInstance = import('@mediapipe/tasks-vision').PoseLandmarker;
type NormalizedLandmark = import('@mediapipe/tasks-vision').NormalizedLandmark;

/**
 * Location of the MediaPipe Tasks Vision WASM fileset.
 *
 * Served locally from `public/mediapipe-wasm/` (copied from the installed
 * `@mediapipe/tasks-vision` package) so the WASM runtime version always matches
 * the bundled JS. Using the `@latest` CDN caused a version mismatch that failed
 * with "ModuleFactory not set" when initializing inside a Web Worker.
 */
const WASM_FILESET_URL = '/mediapipe-wasm';

/** Hosted pose_landmarker_lite model asset. */
const MODEL_ASSET_PATH =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

/**
 * Pose adapter backed by MediaPipe Tasks Vision `PoseLandmarker`
 * (BlazePose, 33 keypoints). Runs on the MediaPipe WASM backend.
 *
 * The model is created with the `pose_landmarker_lite` asset, the CPU
 * delegate (workers have no WebGL context for GPU), and `IMAGE` running mode so
 * single {@link ImageBitmap} frames can be scored via `detect()`.
 *
 * Requirements: 1.1, 1.3, 1.5
 */
export class MediaPipeAdapter extends BasePoseAdapter {
  /** Static descriptor for the MediaPipe BlazePose adapter. */
  readonly metadata: AdapterMetadata = {
    id: 'mediapipe-blazepose',
    displayName: 'MediaPipe BlazePose (Lite)',
    keypointCount: 33,
    backend: 'mediapipe-wasm',
    modelSizeMb: 3,
    license: 'Apache-2.0',
    version: '1.0.0',
  };

  /** Loaded PoseLandmarker instance, created in {@link loadModel}. */
  private landmarker: PoseLandmarkerInstance | null = null;

  /**
   * Create the PoseLandmarker via FilesetResolver + createFromOptions using
   * the lite model on the GPU delegate in IMAGE running mode.
   */
  protected async loadModel(): Promise<void> {
    const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');

    const fileset = await FilesetResolver.forVisionTasks(WASM_FILESET_URL);
    this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: MODEL_ASSET_PATH,
        // CPU delegate: this adapter runs inside a Web Worker, which has no
        // WebGL context for the GPU delegate.
        delegate: 'CPU',
      },
      runningMode: 'IMAGE',
      numPoses: 1,
    });
  }

  /**
   * Run inference on a single frame and map the 33 MediaPipe landmarks to the
   * native {@link Keypoint} format. Confidence is taken from each landmark's
   * visibility score.
   *
   * @param frame - Source frame to run inference on.
   * @param timestampMs - Wall-clock timestamp of the source frame.
   */
  protected async runInference(frame: ImageBitmap, timestampMs: number): Promise<RawPose> {
    if (this.landmarker === null) {
      throw new Error('MediaPipe PoseLandmarker is not initialized.');
    }

    const result = this.landmarker.detect(frame);
    const landmarks: NormalizedLandmark[] = result.landmarks[0] ?? [];
    const keypoints: Keypoint[] = landmarks.map((landmark: NormalizedLandmark, index: number) => ({
      index,
      x: landmark.x,
      y: landmark.y,
      z: landmark.z,
      confidence: landmark.visibility ?? 0,
    }));

    return { keypoints, timestampMs };
  }

  /** Release the underlying PoseLandmarker resources. */
  protected override async disposeModel(): Promise<void> {
    if (this.landmarker !== null) {
      this.landmarker.close();
      this.landmarker = null;
    }
  }
}
