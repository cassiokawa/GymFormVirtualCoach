/**
 * Main-thread manager for pose inference workers.
 *
 * Each {@link WorkerHandle} owns one dedicated {@link Worker} running the
 * generic `pose.worker.ts` host. The pool drives the workers with typed
 * {@link WorkerRequest} messages and consumes typed {@link WorkerResponse}
 * messages, keeping heavy model inference off the UI thread.
 *
 * ## Generation-safety mechanism (Req 8.2)
 *
 * Model switching in comparison/benchmark flows is `terminate(old)` followed by
 * `spawn(new)`. A `result` message for a frame submitted before termination can
 * still be sitting in the message queue when the worker is torn down, and — more
 * subtly — a handle object could be reused conceptually across a switch. To make
 * stale results impossible to observe, every handle carries a monotonically
 * increasing `generation` counter:
 *
 * - `detect()` captures the handle's generation at submit time inside the pending
 *   entry.
 * - `terminate()` increments the handle's generation, terminates the worker, and
 *   rejects every in-flight detect promise, then clears the pending map.
 * - The worker's `message` listener ignores any response whose captured
 *   generation no longer matches the handle's current generation.
 *
 * Because termination bumps the generation, any `result` that arrives after
 * `terminate()` — whether still queued or racing the teardown — fails the
 * generation check and is dropped. No stale keypoints ever reach a caller.
 *
 * Requirements: 8.1, 8.2, 8.4, 8.5
 */

import type { Keypoint } from '../../types/index.js';
import type { RuntimeBackend, WorkerRequest, WorkerResponse } from '../types.js';

/**
 * A pending `detect` request awaiting its matching `result`/`error` response.
 */
interface PendingDetect {
  /** Resolve the caller's promise with the worker's keypoints. */
  resolve: (keypoints: Keypoint[]) => void;
  /** Reject the caller's promise on inference error or termination. */
  reject: (reason: Error) => void;
  /** Handle generation captured at submit time; used to drop stale results. */
  generation: number;
}

/**
 * Handle to a spawned pose worker. Callers pass this back into
 * {@link PoseWorkerPool.detect} and {@link PoseWorkerPool.terminate}.
 */
export interface WorkerHandle {
  /** Model id this worker was initialized with. */
  readonly modelId: string;
  /** The underlying dedicated worker. */
  readonly worker: Worker;
  /**
   * Monotonic generation counter. Incremented on {@link PoseWorkerPool.terminate}
   * so results produced before termination are recognizable as stale.
   */
  generation: number;
  /** In-flight detect requests keyed by frameId. */
  readonly pending: Map<number, PendingDetect>;
}

/**
 * Manages the lifecycle of one or more pose inference workers and routes
 * frame-level detect requests to them.
 */
export class PoseWorkerPool {
  /** All live handles, tracked so the pool can support concurrent comparison. */
  private readonly handles = new Set<WorkerHandle>();

  /**
   * Spawn a new worker, initialize it with the given model/backend, and resolve
   * once the worker posts `ready`. Rejects with a `load`-category error if the
   * worker reports a load failure before becoming ready.
   *
   * @param modelId  Registered model id to load in the worker.
   * @param backend  Runtime backend the model executes on.
   * @param modelUrl Optional override URL for the model weights.
   */
  spawn(modelId: string, backend: RuntimeBackend, modelUrl?: string): Promise<WorkerHandle> {
    // Vite rewrites `new URL(..., import.meta.url)` worker construction at build
    // time. TypeScript's lib.dom `Worker` constructor accepts a URL directly.
    const worker = new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' });

    const handle: WorkerHandle = {
      modelId,
      worker,
      generation: 0,
      pending: new Map<number, PendingDetect>(),
    };
    this.handles.add(handle);

    return new Promise<WorkerHandle>((resolve, reject) => {
      /**
       * Handshake listener: waits for the initial `ready`/`error`. Once the
       * worker is ready we swap in the steady-state routing listener.
       */
      const onInit = (event: MessageEvent<WorkerResponse>): void => {
        const msg = event.data;
        if (msg.type === 'ready' && msg.modelId === modelId) {
          worker.removeEventListener('message', onInit);
          worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
            this.routeMessage(handle, e.data);
          });
          resolve(handle);
        } else if (msg.type === 'error') {
          worker.removeEventListener('message', onInit);
          this.handles.delete(handle);
          worker.terminate();
          reject(new Error(`Worker failed to load model "${modelId}": ${msg.message}`));
        }
        // Any other message before `ready` (e.g. a stray result) is ignored.
      };

      worker.addEventListener('message', onInit);
      worker.addEventListener('error', (e: ErrorEvent) => {
        // A hard worker error during load surfaces as a load failure.
        reject(new Error(`Worker crashed while loading model "${modelId}": ${e.message}`));
      });

      // Omit `modelUrl` entirely when undefined to satisfy exactOptionalPropertyTypes.
      const initRequest: WorkerRequest =
        modelUrl === undefined
          ? { type: 'init', modelId, backend }
          : { type: 'init', modelId, modelUrl, backend };
      worker.postMessage(initRequest);
    });
  }

  /**
   * Run inference on a single frame. The `ImageBitmap` is transferred (not
   * copied) into the worker for zero-copy performance, so the caller must not
   * use it afterwards. Resolves with keypoints on the matching `result`, and
   * rejects on an `inference`/`oom` error or if the handle is terminated.
   *
   * @param handle      Handle returned by {@link spawn}.
   * @param frameId     Caller-assigned id used to correlate the response.
   * @param frame       Frame to analyze; transferred into the worker.
   * @param timestampMs Wall-clock timestamp of the source frame.
   */
  detect(handle: WorkerHandle, frameId: number, frame: ImageBitmap, timestampMs: number): Promise<Keypoint[]> {
    return new Promise<Keypoint[]>((resolve, reject) => {
      if (handle.pending.has(frameId)) {
        reject(new Error(`Duplicate in-flight frameId ${frameId} for model "${handle.modelId}".`));
        return;
      }

      handle.pending.set(frameId, { resolve, reject, generation: handle.generation });

      const request: WorkerRequest = { type: 'detect', frameId, frame, timestampMs };
      // Transfer the bitmap so the worker owns it without a structured-clone copy.
      handle.worker.postMessage(request, [frame]);
    });
  }

  /**
   * Terminate a worker and discard any in-flight detect promises so no stale
   * results can be delivered (Req 8.2). Incrementing the generation first means
   * any `result` still queued for this handle fails the generation check in
   * {@link routeMessage} and is dropped.
   *
   * @param handle Handle returned by {@link spawn}.
   */
  terminate(handle: WorkerHandle): void {
    // Bump generation before teardown so late results are recognized as stale.
    handle.generation += 1;

    // Reject and clear every in-flight detect for this handle.
    for (const [frameId, pending] of handle.pending) {
      pending.reject(new Error(`Worker for model "${handle.modelId}" was terminated (frameId ${frameId}).`));
    }
    handle.pending.clear();

    this.handles.delete(handle);
    handle.worker.terminate();
  }

  /**
   * Number of currently live handles. Comparison mode requires at least 2.
   */
  get activeCount(): number {
    return this.handles.size;
  }

  /**
   * Route a steady-state worker message to its pending detect request. Results
   * whose captured generation no longer matches the handle's current generation
   * are dropped as stale (see the class-level generation-safety note).
   */
  private routeMessage(handle: WorkerHandle, msg: WorkerResponse): void {
    switch (msg.type) {
      case 'result': {
        const pending = handle.pending.get(msg.frameId);
        if (pending === undefined) {
          // Unknown or already-settled frame; nothing to deliver.
          return;
        }
        handle.pending.delete(msg.frameId);
        // Drop results produced before a terminate() bumped the generation.
        if (pending.generation !== handle.generation) {
          return;
        }
        pending.resolve(msg.keypoints);
        break;
      }
      case 'error': {
        // Inference/oom errors are not frame-addressed by the protocol, so fail
        // the oldest in-flight detect for this handle to unblock the caller.
        const oldest = handle.pending.entries().next();
        if (!oldest.done) {
          const [frameId, pending] = oldest.value;
          handle.pending.delete(frameId);
          if (pending.generation === handle.generation) {
            pending.reject(new Error(`Inference error (${msg.category}) for model "${handle.modelId}": ${msg.message}`));
          }
        }
        break;
      }
      case 'ready':
        // Late/duplicate ready after handshake; ignore.
        break;
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  }
}
