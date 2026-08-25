/// <reference lib="webworker" />

/**
 * Generic pose inference host running inside a dedicated Web Worker.
 *
 * The main thread drives this worker with {@link WorkerRequest} messages and
 * receives {@link WorkerResponse} messages back. The worker owns a single
 * loaded {@link PoseAdapter} for its lifetime: `init` loads it, `detect` runs
 * inference, and `dispose` releases it. Keeping heavy inference off the UI
 * thread is the whole point of this host.
 *
 * Requirements: 1.3, 8.1, 8.3, 8.5
 */

import type { PoseAdapter, RuntimeBackend, WorkerRequest, WorkerResponse } from '../types.js';

// The dedicated worker global. tsconfig's `lib` targets the DOM, so we cast the
// ambient `self` to the worker scope brought in by the reference directive
// above. This gives us correctly-typed `onmessage` / `postMessage`.
const ctx = self as unknown as DedicatedWorkerGlobalScope;

/**
 * Construct the adapter for `modelId`, dynamically importing only that
 * adapter's module. Dynamic import keeps each adapter's heavy runtime
 * (`@mediapipe/tasks-vision`, `@tensorflow-models/pose-detection`,
 * `onnxruntime-web`) out of this worker's static bundle graph, so nothing loads
 * until the corresponding model is actually selected. Returns `null` for an
 * unknown id.
 */
async function createAdapter(
  modelId: string,
  _backend: RuntimeBackend,
  modelUrl?: string,
): Promise<PoseAdapter | null> {
  switch (modelId) {
    case 'mediapipe-blazepose': {
      const { MediaPipeAdapter } = await import('../registry/adapters/MediaPipeAdapter.js');
      return new MediaPipeAdapter();
    }
    case 'movenet-lightning': {
      const { MoveNetAdapter } = await import('../registry/adapters/MoveNetAdapter.js');
      return new MoveNetAdapter('lightning');
    }
    case 'movenet-thunder': {
      const { MoveNetAdapter } = await import('../registry/adapters/MoveNetAdapter.js');
      return new MoveNetAdapter('thunder');
    }
    case 'yolov8-pose': {
      const { YoloPoseAdapter } = await import('../registry/adapters/YoloPoseAdapter.js');
      return modelUrl !== undefined ? new YoloPoseAdapter(modelUrl) : new YoloPoseAdapter();
    }
    case 'rtmpose': {
      const { RtmPoseAdapter } = await import('../registry/adapters/RtmPoseAdapter.js');
      return modelUrl !== undefined ? new RtmPoseAdapter(modelUrl) : new RtmPoseAdapter();
    }
    default:
      return null;
  }
}

/** The adapter loaded for this worker's lifetime, or null before `init`. */
let adapter: PoseAdapter | null = null;

/** Typed wrapper around `postMessage` so every reply conforms to the protocol. */
function post(msg: WorkerResponse): void {
  ctx.postMessage(msg);
}

/**
 * Handle an `init` request: construct the adapter for `modelId` via the factory
 * registry, load its weights, and acknowledge with `ready`. Any failure is
 * reported as a `load`-category error and leaves the worker without an adapter.
 */
async function handleInit(
  modelId: string,
  backend: RuntimeBackend,
  modelUrl?: string,
): Promise<void> {
  try {
    const created = await createAdapter(modelId, backend, modelUrl);
    if (created === null) {
      adapter = null;
      post({ type: 'error', category: 'load', message: `Unknown model id "${modelId}"` });
      return;
    }
    adapter = created;
    await adapter.load();
    post({ type: 'ready', modelId });
  } catch (cause) {
    adapter = null;
    post({ type: 'error', category: 'load', message: describe(cause) });
  }
}

/**
 * Handle a `detect` request: run the loaded adapter on the transferred frame
 * and post the resulting keypoints. Failures are reported as `inference`
 * errors so the run can skip the frame and continue.
 */
async function handleDetect(frameId: number, frame: ImageBitmap, timestampMs: number): Promise<void> {
  if (adapter === null) {
    post({ type: 'error', category: 'inference', message: 'detect received before adapter was initialized' });
    return;
  }
  try {
    const pose = await adapter.detect(frame, timestampMs);
    post({ type: 'result', frameId, keypoints: pose.keypoints, timestampMs: pose.timestampMs });
  } catch (cause) {
    post({ type: 'error', category: 'inference', message: describe(cause) });
  } finally {
    // Release the transferred frame's resources once inference has consumed it.
    frame.close();
  }
}

/**
 * Handle a `dispose` request: release the adapter so the main thread can safely
 * terminate this worker.
 */
async function handleDispose(): Promise<void> {
  if (adapter !== null) {
    try {
      await adapter.dispose();
    } finally {
      adapter = null;
    }
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      void handleInit(msg.modelId, msg.backend, msg.modelUrl);
      break;
    case 'detect':
      void handleDetect(msg.frameId, msg.frame, msg.timestampMs);
      break;
    case 'dispose':
      void handleDispose();
      break;
    default: {
      // Exhaustiveness guard: a new request variant must be handled above.
      const _exhaustive: never = msg;
      void _exhaustive;
    }
  }
};
