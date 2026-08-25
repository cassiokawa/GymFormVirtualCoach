/**
 * Unit tests for ResultStore.
 *
 * Exercises the IndexedDB-backed persistence layer for the CV Algorithm Lab
 * using the `fake-indexeddb` polyfill. Covers round-trip identity of every
 * record type (Property 5), index-scoped queries, date-range filtering,
 * deletion counts, and typed StoreError surfacing when used before open().
 *
 * Requirements: 4.3, 4.5, 7.4
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { ResultStore, StoreError } from './ResultStore.js';
import type {
  BenchmarkResult,
  GroundTruthFrame,
  RecordingSession,
  TrainedModelRecord,
} from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBenchmark(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    id: 'bench-1',
    modelId: 'movenet-thunder',
    timestampMs: 1_000,
    frameCount: 100,
    successCount: 98,
    failedCount: 2,
    latency: {
      meanFps: 42.5,
      medianMs: 22.1,
      p95Ms: 31.7,
      stdDevMs: 3.2,
    },
    accuracy: {
      meanOks: 0.83,
      recallAt050: 0.91,
      perKeypointOks: Array.from({ length: 33 }, (_, i) => i / 33),
    },
    perFrameLatencyMs: [21.0, 22.5, 23.1, 20.9, 24.4],
    valid: true,
    warning: undefined,
    ...overrides,
  };
}

function makeAnnotation(overrides: Partial<GroundTruthFrame> = {}): GroundTruthFrame {
  return {
    id: 'anno-1',
    sourceVideoId: 'video-42',
    frameIndex: 7,
    imageRef: new Blob(['x']),
    keypoints: Array.from({ length: 33 }, (_, i) => ({ x: i / 33, y: (33 - i) / 33 })),
    visibility: Array.from({ length: 33 }, (_, i) => i % 2 === 0),
    createdMs: 5_000,
    ...overrides,
  };
}

function makeRecording(overrides: Partial<RecordingSession> = {}): RecordingSession {
  return {
    id: 'rec-1',
    metadata: {
      exerciseName: 'barbell_squat',
      durationMs: 12_000,
      modelId: 'movenet-thunder',
      createdMs: 2_000,
    },
    frames: [
      {
        timestampMs: 0,
        keypoints: [{ index: 0, x: 0.5, y: 0.5, z: 0, confidence: 0.9 }],
      },
      {
        timestampMs: 33,
        keypoints: [{ index: 0, x: 0.51, y: 0.49, z: 0, confidence: 0.92 }],
      },
    ],
    labels: {
      exerciseName: 'barbell_squat',
      repBoundaries: [{ startFrame: 0, endFrame: 1 }],
      qualityRating: 4,
      frameErrors: { 1: ['knee_valgus'] },
    },
    schemaVersion: 1,
    ...overrides,
  };
}

function makeTrainedModel(overrides: Partial<TrainedModelRecord> = {}): TrainedModelRecord {
  return {
    id: 'model-1',
    exerciseName: 'barbell_squat',
    tfjsArtifacts: { topology: 'stub', weights: [1, 2, 3] },
    onnxBytes: new Uint8Array([1, 2, 3, 4]).buffer,
    metadata: {
      datasetSize: 500,
      finalAccuracy: 0.88,
      exercises: ['barbell_squat', 'deadlift'],
      createdMs: 3_000,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Isolation: fresh DB per test
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reassign a clean IDBFactory so each test starts with an empty database.
  globalThis.indexedDB = new IDBFactory();
});

// ---------------------------------------------------------------------------
// open()
// ---------------------------------------------------------------------------

describe('open()', () => {
  it('creates the database and resolves', async () => {
    const store = new ResultStore();
    await expect(store.open()).resolves.toBeUndefined();
  });

  it('is idempotent when called repeatedly', async () => {
    const store = new ResultStore();
    await store.open();
    await expect(store.open()).resolves.toBeUndefined();
    // A subsequent operation still works after multiple opens.
    await store.saveBenchmark(makeBenchmark());
    expect(await store.getBenchmark('bench-1')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe('benchmarks', () => {
  it('saveBenchmark then getBenchmark returns a deep-equal record (round-trip identity)', async () => {
    const store = new ResultStore();
    await store.open();
    const record = makeBenchmark();
    await store.saveBenchmark(record);

    const loaded = await store.getBenchmark(record.id);
    expect(loaded).toEqual(record);
    // Nested structures survive intact.
    expect(loaded?.perFrameLatencyMs).toEqual(record.perFrameLatencyMs);
    expect(loaded?.accuracy).toEqual(record.accuracy);
  });

  it('getBenchmark returns undefined for a missing id', async () => {
    const store = new ResultStore();
    await store.open();
    expect(await store.getBenchmark('does-not-exist')).toBeUndefined();
  });

  it('queryBenchmarks by modelId returns only matching records', async () => {
    const store = new ResultStore();
    await store.open();
    await store.saveBenchmark(makeBenchmark({ id: 'a', modelId: 'movenet' }));
    await store.saveBenchmark(makeBenchmark({ id: 'b', modelId: 'yolo' }));
    await store.saveBenchmark(makeBenchmark({ id: 'c', modelId: 'movenet' }));

    const results = await store.queryBenchmarks({ modelId: 'movenet' });
    expect(results.map((r) => r.id).sort()).toEqual(['a', 'c']);
    expect(results.every((r) => r.modelId === 'movenet')).toBe(true);
  });

  it('queryBenchmarks by date range filters on timestampMs inclusively', async () => {
    const store = new ResultStore();
    await store.open();
    await store.saveBenchmark(makeBenchmark({ id: 'early', timestampMs: 100 }));
    await store.saveBenchmark(makeBenchmark({ id: 'mid', timestampMs: 200 }));
    await store.saveBenchmark(makeBenchmark({ id: 'late', timestampMs: 300 }));

    const inclusive = await store.queryBenchmarks({ from: 200, to: 300 });
    expect(inclusive.map((r) => r.id).sort()).toEqual(['late', 'mid']);

    const onlyFrom = await store.queryBenchmarks({ from: 250 });
    expect(onlyFrom.map((r) => r.id)).toEqual(['late']);

    const onlyTo = await store.queryBenchmarks({ to: 150 });
    expect(onlyTo.map((r) => r.id)).toEqual(['early']);
  });

  it('queryBenchmarks combines modelId and date range', async () => {
    const store = new ResultStore();
    await store.open();
    await store.saveBenchmark(makeBenchmark({ id: 'a', modelId: 'm', timestampMs: 100 }));
    await store.saveBenchmark(makeBenchmark({ id: 'b', modelId: 'm', timestampMs: 500 }));
    await store.saveBenchmark(makeBenchmark({ id: 'c', modelId: 'other', timestampMs: 100 }));

    const results = await store.queryBenchmarks({ modelId: 'm', from: 50, to: 150 });
    expect(results.map((r) => r.id)).toEqual(['a']);
  });

  it('deleteBenchmark returns 1 when present, 0 when absent, and removes the record', async () => {
    const store = new ResultStore();
    await store.open();
    await store.saveBenchmark(makeBenchmark({ id: 'x' }));

    expect(await store.deleteBenchmark('x')).toBe(1);
    expect(await store.getBenchmark('x')).toBeUndefined();
    expect(await store.deleteBenchmark('x')).toBe(0);
  });

  it('deleteBenchmarksForModel returns the correct count and removes all for that model', async () => {
    const store = new ResultStore();
    await store.open();
    await store.saveBenchmark(makeBenchmark({ id: 'a', modelId: 'movenet' }));
    await store.saveBenchmark(makeBenchmark({ id: 'b', modelId: 'movenet' }));
    await store.saveBenchmark(makeBenchmark({ id: 'c', modelId: 'yolo' }));

    expect(await store.deleteBenchmarksForModel('movenet')).toBe(2);
    expect(await store.queryBenchmarks({ modelId: 'movenet' })).toEqual([]);
    // Unrelated model records remain.
    expect((await store.queryBenchmarks({ modelId: 'yolo' })).map((r) => r.id)).toEqual(['c']);
  });
});

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

describe('annotations', () => {
  it('saveAnnotation then getAnnotation round-trips including visibility and Blob', async () => {
    const store = new ResultStore();
    await store.open();
    const record = makeAnnotation();
    await store.saveAnnotation(record);

    const loaded = await store.getAnnotation(record.id);
    expect(loaded).toBeDefined();
    expect(loaded?.id).toBe(record.id);
    expect(loaded?.sourceVideoId).toBe(record.sourceVideoId);
    expect(loaded?.frameIndex).toBe(record.frameIndex);
    expect(loaded?.keypoints).toEqual(record.keypoints);
    expect(loaded?.visibility).toEqual(record.visibility);
    expect(loaded?.createdMs).toBe(record.createdMs);
    // Blob survives the round-trip.
    expect(loaded?.imageRef).toBeInstanceOf(Blob);
    expect(await loaded?.imageRef.text()).toBe('x');
  });

  it('getAnnotation returns undefined for a missing id', async () => {
    const store = new ResultStore();
    await store.open();
    expect(await store.getAnnotation('missing')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

describe('recordings', () => {
  it('saveRecording then queryRecordings round-trips a matching record', async () => {
    const store = new ResultStore();
    await store.open();
    const record = makeRecording();
    await store.saveRecording(record);

    const results = await store.queryRecordings({ exerciseName: 'barbell_squat' });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(record);
  });

  it('queryRecordings by exerciseName returns only matching records', async () => {
    const store = new ResultStore();
    await store.open();
    await store.saveRecording(
      makeRecording({ id: 'r1', metadata: { ...makeRecording().metadata, exerciseName: 'squat' } }),
    );
    await store.saveRecording(
      makeRecording({
        id: 'r2',
        metadata: { ...makeRecording().metadata, exerciseName: 'deadlift' },
      }),
    );

    const squats = await store.queryRecordings({ exerciseName: 'squat' });
    expect(squats.map((r) => r.id)).toEqual(['r1']);
  });

  it('queryRecordings by minQuality filters on labels.qualityRating', async () => {
    const store = new ResultStore();
    await store.open();
    await store.saveRecording(
      makeRecording({ id: 'low', labels: { ...makeRecording().labels, qualityRating: 2 } }),
    );
    await store.saveRecording(
      makeRecording({ id: 'high', labels: { ...makeRecording().labels, qualityRating: 5 } }),
    );

    const good = await store.queryRecordings({ minQuality: 4 });
    expect(good.map((r) => r.id)).toEqual(['high']);
  });
});

// ---------------------------------------------------------------------------
// Trained models
// ---------------------------------------------------------------------------

describe('trained models', () => {
  it('saveTrainedModel then listTrainedModels round-trips', async () => {
    const store = new ResultStore();
    await store.open();
    const record = makeTrainedModel();
    await store.saveTrainedModel(record);

    const listed = await store.listTrainedModels();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(record.id);
    expect(listed[0].exerciseName).toBe(record.exerciseName);
    expect(listed[0].metadata).toEqual(record.metadata);
    expect(new Uint8Array(listed[0].onnxBytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('listTrainedModels returns an empty array when none are stored', async () => {
    const store = new ResultStore();
    await store.open();
    expect(await store.listTrainedModels()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// StoreError: use before open()
// ---------------------------------------------------------------------------

describe('StoreError before open()', () => {
  it('saveBenchmark rejects with a StoreError carrying the op name', async () => {
    const store = new ResultStore();
    await expect(store.saveBenchmark(makeBenchmark())).rejects.toBeInstanceOf(StoreError);
    await store.saveBenchmark(makeBenchmark()).catch((err: StoreError) => {
      expect(err.op).toBe('saveBenchmark');
    });
  });

  it('getBenchmark rejects with a StoreError carrying the op name', async () => {
    const store = new ResultStore();
    await store.getBenchmark('x').catch((err: StoreError) => {
      expect(err).toBeInstanceOf(StoreError);
      expect(err.op).toBe('getBenchmark');
    });
    await expect(store.getBenchmark('x')).rejects.toBeInstanceOf(StoreError);
  });

  it('queryBenchmarks rejects with a StoreError carrying the op name', async () => {
    const store = new ResultStore();
    await store.queryBenchmarks({ modelId: 'm' }).catch((err: StoreError) => {
      expect(err).toBeInstanceOf(StoreError);
      expect(err.op).toBe('queryBenchmarks');
    });
    await expect(store.queryBenchmarks({})).rejects.toBeInstanceOf(StoreError);
  });
});
