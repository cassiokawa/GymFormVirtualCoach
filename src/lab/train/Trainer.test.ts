/**
 * Unit tests for {@link Trainer}.
 *
 * Validates the streamed training-progress contract, the shape of the produced
 * {@link TrainedModelRecord} (including exported artifacts), input guards,
 * store-backed persistence, and registration into a real {@link ModelRegistry}.
 *
 * Requirements: 13.2, 13.3
 */

import { describe, it, expect, vi } from 'vitest';
import { Trainer } from './Trainer.js';
import { ModelRegistry } from '../registry/ModelRegistry.js';
import type {
  RecordingSession,
  TrainingConfig,
  TrainingProgress,
} from '../types.js';
import type { Keypoint } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A single keypoint at a deterministic position. */
function kp(index: number): Keypoint {
  return { index, x: 0.5, y: 0.5, z: 0, confidence: 0.9 };
}

/** A tiny RecordingSession with `frameCount` frames of a single keypoint. */
function makeSession(
  exerciseName: string,
  frameCount: number,
  idSuffix: string,
): RecordingSession {
  const frames = Array.from({ length: frameCount }, (_, i) => ({
    timestampMs: i * 33,
    keypoints: [kp(0)],
  }));
  return {
    id: `session-${idSuffix}`,
    metadata: {
      exerciseName,
      durationMs: frameCount * 33,
      modelId: 'movenet-thunder',
      createdMs: 1_700_000_000_000,
    },
    frames,
    labels: {
      exerciseName,
      repBoundaries: [{ startFrame: 0, endFrame: Math.max(0, frameCount - 1) }],
      qualityRating: 4,
    },
    schemaVersion: 1,
  };
}

/** A small, fast training config. */
function cfg(overrides: Partial<TrainingConfig> = {}): TrainingConfig {
  return {
    architecture: 'mlp',
    learningRate: 0.01,
    batchSize: 8,
    epochs: 3,
    windowSize: 3,
    valSplit: 0.2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// train() progress + record shape
// ---------------------------------------------------------------------------

describe('Trainer.train', () => {
  it('streams monotonic progress and resolves a well-formed record', async () => {
    const trainer = new Trainer();
    const dataset = [
      makeSession('BackSquat', 6, 'a'),
      makeSession('BackSquat', 5, 'b'),
    ];
    const progress: TrainingProgress[] = [];

    const record = await trainer.train(dataset, cfg({ epochs: 3 }), (p) => {
      progress.push(p);
    });

    // onProgress called once per epoch.
    expect(progress).toHaveLength(3);
    // Loss non-increasing, valAccuracy non-decreasing, valAccuracy in [0, 1].
    for (let i = 1; i < progress.length; i += 1) {
      const prev = progress[i - 1]!;
      const cur = progress[i]!;
      expect(cur.loss).toBeLessThanOrEqual(prev.loss);
      expect(cur.valAccuracy).toBeGreaterThanOrEqual(prev.valAccuracy);
    }
    for (const p of progress) {
      expect(p.valAccuracy).toBeGreaterThanOrEqual(0);
      expect(p.valAccuracy).toBeLessThanOrEqual(1);
    }

    // Record shape.
    expect(typeof record.id).toBe('string');
    expect(record.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(record.exerciseName).toBe('BackSquat');
    expect(record.onnxBytes).toBeInstanceOf(ArrayBuffer);
    expect(record.tfjsArtifacts).toBeDefined();

    // Metadata.
    expect(record.metadata.datasetSize).toBeGreaterThan(0);
    expect(record.metadata.finalAccuracy).toBeGreaterThanOrEqual(0);
    expect(record.metadata.finalAccuracy).toBeLessThanOrEqual(1);
    expect(record.metadata.exercises).toEqual(['BackSquat']);
    expect(typeof record.metadata.createdMs).toBe('number');
  });

  it('collects distinct exercises across the dataset', async () => {
    const trainer = new Trainer();
    const dataset = [
      makeSession('BackSquat', 5, 'a'),
      makeSession('Deadlift', 5, 'b'),
      makeSession('BackSquat', 5, 'c'),
    ];
    const record = await trainer.train(dataset, cfg(), () => {});
    expect(record.metadata.exercises).toEqual(['BackSquat', 'Deadlift']);
    expect(record.exerciseName).toBe('BackSquat');
  });

  it('persists via store.saveTrainedModel when a store is injected', async () => {
    const saveTrainedModel = vi.fn().mockResolvedValue(undefined);
    const trainer = new Trainer({ store: { saveTrainedModel } as never });
    const dataset = [makeSession('BackSquat', 5, 'a')];

    const record = await trainer.train(dataset, cfg(), () => {});
    expect(saveTrainedModel).toHaveBeenCalledTimes(1);
    expect(saveTrainedModel).toHaveBeenCalledWith(record);
  });

  it('throws when dataset is empty', async () => {
    const trainer = new Trainer();
    await expect(trainer.train([], cfg(), () => {})).rejects.toThrow();
  });

  it('throws when cfg.epochs <= 0', async () => {
    const trainer = new Trainer();
    const dataset = [makeSession('BackSquat', 5, 'a')];
    await expect(
      trainer.train(dataset, cfg({ epochs: 0 }), () => {}),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// registerTrainedModel
// ---------------------------------------------------------------------------

describe('Trainer.registerTrainedModel', () => {
  it('registers the trained model into a real ModelRegistry', async () => {
    const trainer = new Trainer();
    const dataset = [makeSession('BackSquat', 5, 'a')];
    const record = await trainer.train(dataset, cfg(), () => {});

    const registry = new ModelRegistry();
    const metadata = trainer.registerTrainedModel(record, registry);

    expect(registry.has(metadata.id)).toBe(true);
    const ids = registry.list().map((m) => m.id);
    expect(ids).toContain(metadata.id);
    expect(metadata.keypointCount).toBe(33);
    expect(metadata.backend).toBe('tfjs');
  });
});
