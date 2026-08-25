import type { AdapterMetadata, PoseAdapter, RawPose } from '../../types.js';

// Re-export the PoseAdapter contract for convenience so adapter authors can
// import the interface and the base class from a single module.
export type { PoseAdapter } from '../../types.js';

/**
 * Abstract base implementation of the {@link PoseAdapter} contract that
 * centralizes the load/dispose lifecycle and the "must be loaded before
 * detect" guard. Concrete adapters (MediaPipe, MoveNet, YOLOv8-Pose, RTMPose)
 * implement only the backend-specific hooks: {@link loadModel} and
 * {@link runInference} (and optionally {@link disposeModel}).
 *
 * The base guarantees:
 * - `load()` is idempotent: it invokes {@link loadModel} at most once while the
 *   adapter is loaded, and a failed load leaves the adapter unloaded so callers
 *   can retry.
 * - `detect()` rejects with a descriptive error until `load()` has resolved.
 * - `dispose()` clears the loaded flag and calls {@link disposeModel} so the
 *   adapter can be loaded again afterwards.
 *
 * Requirements: 1.3, 8.1, 8.3, 8.5
 */
export abstract class BasePoseAdapter implements PoseAdapter {
  /** Static descriptor for this adapter. Supplied by the concrete subclass. */
  abstract readonly metadata: AdapterMetadata;

  /** Whether {@link loadModel} has completed successfully and not been disposed. */
  private loaded = false;

  /** In-flight load promise, retained so concurrent `load()` calls share it. */
  private loadPromise: Promise<void> | null = null;

  /**
   * Backend-specific model initialization hook. Called at most once per
   * successful load. Should download/compile weights and prepare inference
   * resources. Rejecting here leaves the adapter unloaded.
   */
  protected abstract loadModel(): Promise<void>;

  /**
   * Backend-specific single-frame inference hook. Only invoked after
   * {@link loadModel} has resolved. Must return keypoints in the model's
   * native format.
   *
   * @param frame - Source frame to run inference on.
   * @param timestampMs - Wall-clock timestamp of the source frame.
   */
  protected abstract runInference(frame: ImageBitmap, timestampMs: number): Promise<RawPose>;

  /**
   * Backend-specific resource-release hook. Defaults to a no-op; override to
   * free GPU/WASM resources. Called by {@link dispose}.
   */
  protected disposeModel(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Load model weights. Idempotent: resolves immediately when already loaded,
   * and coalesces concurrent calls onto a single {@link loadModel} invocation.
   * On failure the adapter stays unloaded so the caller can retry, and the
   * rejection carries a descriptive error.
   */
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    if (this.loadPromise !== null) {
      return this.loadPromise;
    }

    this.loadPromise = (async (): Promise<void> => {
      try {
        await this.loadModel();
        this.loaded = true;
      } catch (cause) {
        // Stay unloaded so a retry is possible; surface a descriptive error.
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`Failed to load adapter "${this.metadata.id}": ${reason}`, { cause });
      } finally {
        this.loadPromise = null;
      }
    })();

    return this.loadPromise;
  }

  /**
   * Run inference on a single frame. Throws a descriptive error if the adapter
   * has not been loaded; otherwise delegates to {@link runInference}.
   *
   * @param frame - Source frame to run inference on.
   * @param timestampMs - Wall-clock timestamp of the source frame.
   */
  async detect(frame: ImageBitmap, timestampMs: number): Promise<RawPose> {
    if (!this.loaded) {
      throw new Error(
        `Adapter "${this.metadata.id}" is not loaded. Call load() and await it before detect().`,
      );
    }
    return this.runInference(frame, timestampMs);
  }

  /**
   * Release resources held by the adapter and reset the loaded flag so the
   * adapter can be loaded again. Delegates to {@link disposeModel}.
   */
  async dispose(): Promise<void> {
    this.loaded = false;
    this.loadPromise = null;
    await this.disposeModel();
  }
}
