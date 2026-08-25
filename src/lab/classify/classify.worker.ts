/// <reference lib="webworker" />

/**
 * Exercise-classification host running inside a dedicated Web Worker.
 *
 * The main thread drives this worker with {@link ClassifyRequest} messages and
 * receives {@link ClassifyResponse} messages back. The worker owns a single
 * {@link ExerciseClassifier} for its lifetime: `init` constructs it (and
 * optionally loads a model), `frame` pushes one frame of keypoints, and
 * `reset`/`dispose` clear or tear down state. Keeping inference off the UI
 * thread is the whole point of this host (Req 6.4).
 *
 * Structured to mirror {@link file://../workers/pose.worker.ts}.
 *
 * Requirements: 6.1, 6.4, 6.5
 */

import type { Keypoint } from '../../types/index.js';
import type { ClassificationResult } from '../types.js';
import { ExerciseClassifier, type ExerciseClassifierOptions } from './ExerciseClassifier.js';

// The dedicated worker global. tsconfig's `lib` targets the DOM, so we cast the
// ambient `self` to the worker scope brought in by the reference directive
// above. This gives us correctly-typed `onmessage` / `postMessage`.
const ctx = self as unknown as DedicatedWorkerGlobalScope;

/**
 * Message sent from the main thread to the classifier worker.
 * - `init`  — construct the classifier, optionally load a model and set labels.
 * - `frame` — push one frame of keypoints for a given frame id.
 * - `reset` — clear the classifier's frame buffer.
 * - `dispose` — release the classifier and prepare for termination.
 */
export type ClassifyRequest =
  | {
      type: 'init';
      options?: ExerciseClassifierOptions;
      labels?: string[];
      modelUrl?: string;
    }
  | { type: 'frame'; frameId: number; keypoints: Keypoint[] }
  | { type: 'reset' }
  | { type: 'dispose' };

/**
 * Message sent from the classifier worker back to the main thread.
 * - `ready`  — classifier constructed (and model loaded, if requested).
 * - `result` — a classification result produced for a frame id.
 * - `error`  — categorized failure during load or inference.
 */
export type ClassifyResponse =
  | { type: 'ready' }
  | { type: 'result'; frameId: number; result: ClassificationResult }
  | { type: 'error'; category: 'load' | 'inference'; message: string };

/** The classifier owned for this worker's lifetime, or null before `init`. */
let classifier: ExerciseClassifier | null = null;

/** Typed wrapper around `postMessage` so every reply conforms to the protocol. */
function post(msg: ClassifyResponse): void {
  ctx.postMessage(msg);
}

/**
 * Handle an `init` request: build the classifier, apply optional labels, and
 * load a model when a URL is supplied. Failures are reported as `load` errors.
 */
async function handleInit(
  options?: ExerciseClassifierOptions,
  labels?: string[],
  modelUrl?: string,
): Promise<void> {
  try {
    classifier = new ExerciseClassifier(options);
    if (labels !== undefined && labels.length > 0) {
      classifier.setLabels(labels);
    }
    if (modelUrl !== undefined) {
      await classifier.loadModel(modelUrl);
    }
    post({ type: 'ready' });
  } catch (cause) {
    classifier = null;
    post({ type: 'error', category: 'load', message: describe(cause) });
  }
}

/**
 * Handle a `frame` request: push the frame through the classifier and post a
 * `result` only when the window emits one (Req 6.5).
 */
function handleFrame(frameId: number, keypoints: Keypoint[]): void {
  if (classifier === null) {
    post({ type: 'error', category: 'inference', message: 'frame received before classifier was initialized' });
    return;
  }
  try {
    const result = classifier.pushFrame(keypoints);
    if (result !== null) {
      post({ type: 'result', frameId, result });
    }
  } catch (cause) {
    post({ type: 'error', category: 'inference', message: describe(cause) });
  }
}

/** Handle a `reset` request: clear the classifier's buffered window. */
function handleReset(): void {
  classifier?.reset();
}

/** Handle a `dispose` request: drop the classifier so the worker can terminate. */
function handleDispose(): void {
  classifier = null;
}

/** Extract a human-readable message from an unknown thrown value. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

ctx.onmessage = (event: MessageEvent<ClassifyRequest>): void => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      void handleInit(msg.options, msg.labels, msg.modelUrl);
      break;
    case 'frame':
      handleFrame(msg.frameId, msg.keypoints);
      break;
    case 'reset':
      handleReset();
      break;
    case 'dispose':
      handleDispose();
      break;
    default: {
      // Exhaustiveness guard: a new request variant must be handled above.
      const _exhaustive: never = msg;
      void _exhaustive;
    }
  }
};
