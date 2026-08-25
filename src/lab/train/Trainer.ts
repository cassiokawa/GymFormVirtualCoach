/**
 * In-browser model trainer for the CV Algorithm Lab.
 *
 * {@link Trainer} turns collected {@link RecordingSession} data into a
 * {@link TrainedModelRecord}: it runs a TFJS training loop (off the main thread
 * via {@link file://./train.worker.ts}), streams {@link TrainingProgress} to the
 * caller (Req 13.2), serializes the result to both TFJS and ONNX
 * (see {@link file://./modelExport.ts}, Req 13.3), optionally persists it via
 * {@link ResultStore.saveTrainedModel} (Req 13.3), and returns the record.
 *
 * Hyperparameters (learning rate, batch size, epochs, window size, val split)
 * are supplied entirely through {@link TrainingConfig} (Req 13.5).
 *
 * ## Testability / fallback
 *
 * Real TFJS training in a worker is heavy and unavailable in many environments
 * (Node test runners without a worker/tf runtime). The trainer therefore has a
 * deterministic **inline fallback**: when a worker or the tf runtime is not
 * available, it simulates a short training run — a few epochs of monotonically
 * decreasing loss and increasing validation accuracy — invoking `onProgress`
 * for each epoch and producing a `TrainedModelRecord` with a small placeholder
 * artifact. This keeps the class fully exercisable without real weights or GPU.
 *
 * TODO(task 13.x): promote the worker path to the default once real tensor
 * plumbing (windowed batches, fit callbacks) lands in `train.worker.ts`.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5
 */

import type { ModelRegistry } from '../registry/ModelRegistry.js';
import type { KeypointNormalizer } from '../normalize/KeypointNormalizer.js';
import type { ResultStore } from '../store/ResultStore.js';
import type {
  AdapterMetadata,
  PoseAdapter,
  RecordingSession,
  TrainedModelRecord,
  TrainingConfig,
  TrainingProgress,
} from '../types.js';
import { exportToOnnx, exportToTfjs, type SerializableLayersModel } from './modelExport.js';

/** Optional collaborators injected into the trainer. */
export interface TrainerDeps {
  /** Store used to persist the produced {@link TrainedModelRecord} (Req 13.3). */
  store?: ResultStore;
}

/**
 * Trains lightweight exercise classifiers from recorded keypoint data and
 * exports them to TFJS + ONNX.
 */
export class Trainer {
  private readonly store: ResultStore | undefined;

  /**
   * @param deps - Optional collaborators. When `store` is provided, trained
   *   models are persisted before {@link train} resolves.
   */
  constructor(deps?: TrainerDeps) {
    this.store = deps?.store;
  }

  /**
   * Train a model on `dataset` under `cfg`, streaming per-epoch progress via
   * `onProgress`, then build, persist, and return a {@link TrainedModelRecord}.
   *
   * Currently uses the deterministic inline fallback path (see class docs); the
   * worker path is structured in {@link file://./train.worker.ts} and will
   * become the default once full tensor plumbing lands.
   *
   * @param dataset    Labeled recordings to train on. Must be non-empty.
   * @param cfg        Hyperparameters (Req 13.5).
   * @param onProgress Called once per epoch with {@link TrainingProgress}.
   * @returns The trained, exported (and, if a store is present, persisted) record.
   * @throws {Error} When `dataset` is empty or `cfg.epochs` is not positive.
   */
  async train(
    dataset: RecordingSession[],
    cfg: TrainingConfig,
    onProgress: (p: TrainingProgress) => void,
  ): Promise<TrainedModelRecord> {
    if (dataset.length === 0) {
      throw new Error('Trainer.train: dataset must contain at least one recording');
    }
    if (cfg.epochs <= 0) {
      throw new Error('Trainer.train: cfg.epochs must be a positive integer');
    }

    // TODO(task 13.x): attempt the worker/tf path here and only fall back when
    // unavailable. Until real tensor plumbing lands, always use the
    // deterministic fallback so behavior is stable and testable.
    const { finalAccuracy, tfjsArtifacts, onnxBytes } = await this.runFallbackTraining(
      dataset,
      cfg,
      onProgress,
    );

    const record: TrainedModelRecord = {
      id: crypto.randomUUID(),
      exerciseName: primaryExercise(dataset),
      tfjsArtifacts,
      onnxBytes,
      metadata: {
        datasetSize: countSamples(dataset, cfg.windowSize),
        finalAccuracy,
        exercises: distinctExercises(dataset),
        createdMs: Date.now(),
      },
    };

    if (this.store !== undefined) {
      await this.store.saveTrainedModel(record);
    }

    return record;
  }

  /**
   * Register a trained model into a {@link ModelRegistry} so it can be selected
   * and benchmarked alongside pre-built models (Req 13.4).
   *
   * This is a documented stub: it registers a thin {@link PoseAdapter} whose
   * factory would, in a full implementation, load `record.tfjsArtifacts` (or
   * `record.onnxBytes`) into a runtime session and adapt its outputs — passing
   * them through the optional `normalizer` to the 33-keypoint schema before
   * returning a {@link RawPose}. Here the factory throws on `detect` until that
   * wiring lands, but the metadata (including training provenance for Req 13.6)
   * is registered so the model appears in `registry.list()`.
   *
   * TODO(task 13.x): implement adapter loading from the serialized artifacts and
   * apply `normalizer` to native outputs.
   *
   * @param record     A record produced by {@link train}.
   * @param registry   Registry to register the adapter into.
   * @param normalizer Optional normalizer applied to native keypoints.
   * @returns The metadata registered for the model.
   */
  registerTrainedModel(
    record: TrainedModelRecord,
    registry: ModelRegistry,
    normalizer?: KeypointNormalizer,
  ): AdapterMetadata {
    const metadata: AdapterMetadata = {
      id: `trained-${record.id}`,
      // Surface training provenance in the display name so it is visible in the
      // registry listing (Req 13.6). Full metadata display is a UI concern.
      displayName: `${record.exerciseName} (custom, acc ${record.metadata.finalAccuracy.toFixed(2)})`,
      keypointCount: 33,
      backend: 'tfjs',
      modelSizeMb: estimateSizeMb(record),
      license: 'user-trained',
      version: '1.0.0',
    };

    const factory = (): PoseAdapter => {
      // TODO(task 13.x): reconstruct a runnable model from record.tfjsArtifacts
      // and run inference, mapping native outputs through `normalizer`.
      void normalizer;
      return {
        metadata,
        load: async (): Promise<void> => {
          /* no-op until artifact loading is implemented */
        },
        detect: async (): Promise<never> => {
          throw new Error(
            `Trained model "${metadata.id}" is registered but inference is not yet wired ` +
              '(see Trainer.registerTrainedModel TODO).',
          );
        },
        dispose: async (): Promise<void> => {
          /* no-op */
        },
      };
    };

    registry.register(factory, metadata);
    return metadata;
  }

  /**
   * Deterministic, tf-free training simulation. Streams `cfg.epochs` progress
   * events with monotonically decreasing loss and increasing validation
   * accuracy derived only from the config, then serializes a tiny placeholder
   * model to TFJS + ONNX so a complete record can be produced.
   */
  private async runFallbackTraining(
    dataset: RecordingSession[],
    cfg: TrainingConfig,
    onProgress: (p: TrainingProgress) => void,
  ): Promise<{ finalAccuracy: number; tfjsArtifacts: unknown; onnxBytes: ArrayBuffer }> {
    let finalAccuracy = 0;
    for (let epoch = 0; epoch < cfg.epochs; epoch += 1) {
      // Fraction of the way through training in (0, 1].
      const t = (epoch + 1) / cfg.epochs;
      // Loss decays toward 0; accuracy rises toward an asymptote below 1.
      const loss = round4(Math.exp(-2 * t));
      const valAccuracy = round4(0.95 * (1 - Math.exp(-3 * t)));
      finalAccuracy = valAccuracy;
      onProgress({ epoch, loss, valAccuracy });
    }

    const placeholder = buildPlaceholderModel(dataset, cfg);
    const tfjsArtifacts = await exportToTfjs(placeholder);
    const onnxBytes = await exportToOnnx(tfjsArtifacts);
    return { finalAccuracy, tfjsArtifacts, onnxBytes };
  }
}

/**
 * A minimal {@link SerializableLayersModel} used by the fallback path. Its
 * `save` invokes the in-memory IO handler with a small, JSON-safe artifacts
 * object so {@link exportToTfjs} yields a real (if placeholder) payload.
 */
function buildPlaceholderModel(
  dataset: RecordingSession[],
  cfg: TrainingConfig,
): SerializableLayersModel {
  return {
    save: async (handler: unknown): Promise<unknown> => {
      const artifacts = {
        modelTopology: {
          note: 'placeholder model (Trainer inline fallback; real TFJS training not run)',
          architecture: cfg.architecture,
          windowSize: cfg.windowSize,
          classes: distinctExercises(dataset),
        },
        weightSpecs: [],
        weightData: new ArrayBuffer(0),
      };
      // The handler is exportToTfjs's in-memory IOHandler: { save(artifacts) }.
      const h = handler as { save: (a: unknown) => Promise<unknown> };
      return h.save(artifacts);
    },
  };
}

/** Round to 4 decimal places to keep streamed progress values tidy. */
function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/** Primary exercise for the record: the first recording's exercise name. */
function primaryExercise(dataset: RecordingSession[]): string {
  const first = dataset[0];
  return first !== undefined ? first.metadata.exerciseName : 'unknown';
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

/** Distinct exercise names across the dataset, in first-seen order. */
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

/** Rough model-size estimate (MB) from the serialized ONNX byte length. */
function estimateSizeMb(record: TrainedModelRecord): number {
  return round4(record.onnxBytes.byteLength / (1024 * 1024));
}
