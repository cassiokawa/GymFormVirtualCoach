/// <reference lib="webworker" />

/**
 * In-browser training host running inside a dedicated Web Worker.
 *
 * The main thread ({@link file://./Trainer.ts}) drives this worker with
 * {@link TrainRequest} messages and receives {@link TrainResponse} messages
 * back. Running TFJS training here keeps the potentially long-running,
 * CPU/GPU-heavy fit loop off the UI thread (Req 13.2).
 *
 * Lifecycle / protocol (mirrors pose.worker.ts / classify.worker.ts):
 *  - `init`    — receive the dataset + {@link import('../types.js').TrainingConfig},
 *                build a model for `cfg.architecture` ('mlp' | 'lstm').
 *  - `train`   — run the fit loop, streaming a `progress` message per epoch and
 *                finishing with a single `done` message carrying serialized
 *                artifacts, or an `error` on failure.
 *  - `dispose` — release the model/tensors so the worker can be terminated.
 *
 * TFJS is imported dynamically so the heavy runtime is only pulled in when a
 * real training run starts, matching the adapter convention.
 *
 * NOTE ON SCOPE: wiring raw {@link import('../types.js').RecordingSession}
 * frames into batched, windowed tensors — and the exact optimizer/loss/metric
 * plumbing — is heavy and environment-sensitive. The tf calls below are
 * structured and type-checked but guarded behind runtime availability so the
 * file compiles and loads everywhere. Full tensor plumbing is marked TODO.
 *
 * Requirements: 13.1, 13.2
 */

import type { RecordingSession, TrainingConfig, TrainingProgress } from '../types.js';
import { exportToOnnx, exportToTfjs, tryLoadTf } from './modelExport.js';

// The dedicated worker global. tsconfig's `lib` targets the DOM, so we cast the
// ambient `self` to the worker scope. This gives correctly-typed
// `onmessage` / `postMessage`.
const ctx = self as unknown as DedicatedWorkerGlobalScope;

/**
 * Message sent from the main thread to the training worker.
 * - `init`    — provide dataset + config and build the model.
 * - `train`   — start the fit loop (streams `progress`, ends with `done`).
 * - `dispose` — release the model and prepare for termination.
 */
export type TrainRequest =
  | { type: 'init'; dataset: RecordingSession[]; cfg: TrainingConfig }
  | { type: 'train' }
  | { type: 'dispose' };

/**
 * Serialized training outcome carried by the `done` message. Mirrors the
 * artifact fields of {@link import('../types.js').TrainedModelRecord} that the
 * worker is responsible for producing; the main thread assembles the final
 * record (id, exerciseName, metadata timestamps).
 */
export interface TrainedArtifacts {
  /** Serialized TFJS LayersModel artifacts (see modelExport.exportToTfjs). */
  tfjsArtifacts: unknown;
  /** Exported ONNX bytes (real or documented placeholder). */
  onnxBytes: ArrayBuffer;
  /** Number of training samples derived from the dataset. */
  datasetSize: number;
  /** Final validation accuracy at the end of training [0, 1]. */
  finalAccuracy: number;
  /** Distinct exercise names present in the dataset. */
  exercises: string[];
}

/**
 * Message sent from the training worker back to the main thread.
 * - `ready`    — model built; the worker will accept a `train` request.
 * - `progress` — per-epoch training progress (Req 13.2).
 * - `done`     — training finished; carries serialized artifacts.
 * - `error`    — categorized failure during build or training.
 */
export type TrainResponse =
  | { type: 'ready' }
  | { type: 'progress'; progress: TrainingProgress }
  | { type: 'done'; artifacts: TrainedArtifacts }
  | { type: 'error'; category: 'build' | 'train'; message: string };

/** A minimal handle to whatever the build step produced. */
interface BuiltModel {
  /** The tf model (typed loosely; the concrete type lives in the tf runtime). */
  model: unknown;
  /** Config the model was built for. */
  cfg: TrainingConfig;
  /** Dataset captured at init for the subsequent `train` call. */
  dataset: RecordingSession[];
}

/** State held for the worker's lifetime, or null before `init`. */
let built: BuiltModel | null = null;

/** Typed wrapper around `postMessage` so every reply conforms to the protocol. */
function post(msg: TrainResponse, transfer?: Transferable[]): void {
  if (transfer !== undefined) {
    ctx.postMessage(msg, transfer);
  } else {
    ctx.postMessage(msg);
  }
}

/**
 * Handle an `init` request: build a model for the requested architecture and
 * capture the dataset for the later `train` call.
 */
async function handleInit(dataset: RecordingSession[], cfg: TrainingConfig): Promise<void> {
  try {
    const tf = await tryLoadTf();
    // When the runtime is unavailable we still acknowledge readiness; the
    // `train` step will surface a build error if a real model is required.
    const model = tf !== null ? buildModel(tf, cfg) : null;
    built = { model, cfg, dataset };
    post({ type: 'ready' });
  } catch (cause) {
    built = null;
    post({ type: 'error', category: 'build', message: describe(cause) });
  }
}

/**
 * Handle a `train` request: run the fit loop, streaming a `progress` message
 * per epoch and posting a single `done` with serialized artifacts.
 */
async function handleTrain(): Promise<void> {
  if (built === null) {
    post({ type: 'error', category: 'train', message: 'train received before init' });
    return;
  }
  const { model, cfg, dataset } = built;
  try {
    const tf = await tryLoadTf();
    if (tf === null || model === null) {
      throw new Error('TFJS runtime unavailable in worker; train inline via Trainer fallback');
    }

    // TODO(task 13.x): build windowed input/label tensors from `dataset`
    // frames (windowSize = cfg.windowSize) and a train/val split of
    // cfg.valSplit, then call `model.fit(xs, ys, { epochs, batchSize,
    // validationSplit, callbacks })` streaming per-epoch metrics. The tf.fit
    // callback below is the intended integration point; it is structured but
    // not yet fed real tensors, so training is not exercised from tests.
    let finalAccuracy = 0;
    const onEpochEnd = (epoch: number, logs?: Record<string, number>): void => {
      const loss = logs?.['loss'] ?? 0;
      const valAccuracy = logs?.['val_acc'] ?? logs?.['acc'] ?? 0;
      finalAccuracy = valAccuracy;
      post({ type: 'progress', progress: { epoch, loss, valAccuracy } });
    };
    // Reference the callback so the intended wiring is explicit and lint-clean.
    void onEpochEnd;

    // TODO: replace with the real fit loop. Until tensor plumbing lands we do
    // not fabricate progress here (the Trainer provides a deterministic
    // fallback for testable runs); we simply serialize the freshly-built model.
    const tfjsArtifacts = await exportToTfjs(model as { save(h: unknown): Promise<unknown> });
    const onnxBytes = await exportToOnnx(tfjsArtifacts);

    const artifacts: TrainedArtifacts = {
      tfjsArtifacts,
      onnxBytes,
      datasetSize: countSamples(dataset, cfg.windowSize),
      finalAccuracy,
      exercises: distinctExercises(dataset),
    };
    post({ type: 'done', artifacts }, [onnxBytes]);
  } catch (cause) {
    post({ type: 'error', category: 'train', message: describe(cause) });
  }
}

/** Handle a `dispose` request: drop model/state so the worker can terminate. */
async function handleDispose(): Promise<void> {
  if (built !== null) {
    try {
      const tf = await tryLoadTf();
      const model = built.model as { dispose?: () => void } | null;
      if (tf !== null && model !== null && typeof model.dispose === 'function') {
        model.dispose();
      }
    } finally {
      built = null;
    }
  }
}

/**
 * Build a sequential model for the requested architecture.
 *
 * - `mlp`  — flattened keypoint window → dense layers → softmax.
 * - `lstm` — keypoint window as a timestep sequence → LSTM → softmax.
 *
 * The layer shapes below use the config's `windowSize`; the input feature
 * width and output class count are resolved at fit time from the dataset.
 *
 * TODO(task 13.x): finalize input/output dimensions from the dataset and
 * compile with an optimizer built from `cfg.learningRate`.
 */
function buildModel(tf: typeof import('@tensorflow/tfjs'), cfg: TrainingConfig): unknown {
  // Keypoint feature width per frame: 33 keypoints * (x, y, z, confidence).
  const featuresPerFrame = 33 * 4;
  const model = tf.sequential();

  if (cfg.architecture === 'mlp') {
    model.add(
      tf.layers.dense({
        units: 64,
        activation: 'relu',
        inputShape: [cfg.windowSize * featuresPerFrame],
      }),
    );
    model.add(tf.layers.dense({ units: 32, activation: 'relu' }));
  } else {
    // 'lstm': treat each frame as a timestep.
    model.add(
      tf.layers.lstm({
        units: 32,
        inputShape: [cfg.windowSize, featuresPerFrame],
      }),
    );
  }

  // Output layer sized to the number of classes is added at fit time once the
  // label vocabulary is known. Placeholder single-unit head keeps the model
  // valid and type-correct until then.
  model.add(tf.layers.dense({ units: 1, activation: 'softmax' }));

  model.compile({
    optimizer: tf.train.adam(cfg.learningRate),
    loss: 'categoricalCrossentropy',
    metrics: ['acc'],
  });

  return model;
}

/** Count windowed training samples derivable from the dataset. */
function countSamples(dataset: RecordingSession[], windowSize: number): number {
  const w = Math.max(1, windowSize);
  let total = 0;
  for (const session of dataset) {
    const frames = session.frames.length;
    if (frames >= w) total += frames - w + 1;
  }
  return total;
}

/** Distinct exercise names present across the dataset, preserving first-seen order. */
function distinctExercises(dataset: RecordingSession[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const session of dataset) {
    const name = session.metadata.exerciseName;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Extract a human-readable message from an unknown thrown value. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

ctx.onmessage = (event: MessageEvent<TrainRequest>): void => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      void handleInit(msg.dataset, msg.cfg);
      break;
    case 'train':
      void handleTrain();
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
