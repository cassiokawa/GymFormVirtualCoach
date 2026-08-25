/**
 * Unit tests for BenchmarkRunner.
 *
 * The runner is driven with a FAKE PoseWorkerPool (no real workers): spawn
 * resolves a fake handle, detect resolves deterministic keypoints or throws on
 * demand, and terminate is a spy. This keeps the tests fast and deterministic
 * while exercising warm-up exclusion, failure handling, stats shape, accuracy
 * computation, and worker cleanup.
 *
 * Requirements validated: 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 3.8, 3.9, 11.5
 * Design: "Property 4: Benchmark validity".
 */

import { describe, it, expect, vi } from 'vitest';

import type { Keypoint } from '../../types/index.js';
import type {
  BenchmarkOptions,
  GroundTruthFrame,
  RuntimeBackend,
} from '../types.js';
import { BenchmarkRunner } from './BenchmarkRunner.js';
import type { PoseWorkerPool, WorkerHandle } from '../workers/PoseWorkerPool.js';

const KEYPOINT_COUNT = 33;

/** Minimal fake ImageBitmap stand-in; the fake pool never inspects it. */
function fakeFrame(): ImageBitmap {
  return {} as unknown as ImageBitmap;
}

function makeFrames(n: number): ImageBitmap[] {
  return Array.from({ length: n }, () => fakeFrame());
}

function kp(index: number, x: number, y: number): Keypoint {
  return { index, x, y, z: 0, confidence: 1 };
}

/** 33 deterministic keypoints spread across the frame. */
function deterministicKeypoints(): Keypoint[] {
  return Array.from({ length: KEYPOINT_COUNT }, (_, i) =>
    kp(i, 0.1 + (i / KEYPOINT_COUNT) * 0.8, 0.1 + (i / KEYPOINT_COUNT) * 0.8),
  );
}

/** GT frame matching the deterministic keypoints at a given frame index. */
function matchingGt(frameIndex: number): GroundTruthFrame {
  const kps = deterministicKeypoints();
  return {
    id: `gt-${frameIndex}`,
    sourceVideoId: 'vid',
    frameIndex,
    imageRef: new Blob(['x']),
    keypoints: kps.map((k) => ({ x: k.x, y: k.y })),
    visibility: new Array(KEYPOINT_COUNT).fill(true),
    createdMs: 0,
  };
}

interface FakePoolOptions {
  /** Return true to make detect throw for a given (frameId). */
  failFrame?: (frameId: number) => boolean;
  /** Keypoints returned on success. Defaults to deterministic 33. */
  keypoints?: () => Keypoint[];
}

interface FakePool {
  pool: PoseWorkerPool;
  terminate: ReturnType<typeof vi.fn<[WorkerHandle], void>>;
  spawn: ReturnType<typeof vi.fn<[string, RuntimeBackend], Promise<WorkerHandle>>>;
}

/**
 * Build a fake PoseWorkerPool exposing only the surface BenchmarkRunner uses:
 * spawn(modelId, backend) -> handle, detect(handle, frameId, frame, ts),
 * terminate(handle).
 */
function makeFakePool(opts: FakePoolOptions = {}): FakePool {
  const keypoints = opts.keypoints ?? deterministicKeypoints;
  const handle = { modelId: 'stub', generation: 0 } as unknown as WorkerHandle;

  const spawn = vi.fn(async (_modelId: string, _backend: RuntimeBackend) => handle);
  const detect = vi.fn(
    async (_handle: WorkerHandle, frameId: number, _frame: ImageBitmap, _ts: number) => {
      if (opts.failFrame?.(frameId)) {
        throw new Error(`forced failure on frame ${frameId}`);
      }
      return keypoints();
    },
  );
  const terminate = vi.fn((_handle: WorkerHandle) => {});

  const pool = { spawn, detect, terminate } as unknown as PoseWorkerPool;
  return { pool, terminate, spawn };
}

// onnx-web routes through the worker pool (tfjs/mediapipe-wasm run on the main thread).
const BACKEND: RuntimeBackend = 'onnx-web';

describe('BenchmarkRunner', () => {
  it('excludes warm-up frames from perFrameLatencyMs', async () => {
    const { pool } = makeFakePool();
    const runner = new BenchmarkRunner(pool);

    const totalFrames = 10;
    const warmupFrames = 3;
    const opts: BenchmarkOptions = {
      frames: makeFrames(totalFrames),
      warmupFrames,
    };

    const result = await runner.run('stub', BACKEND, opts);

    // Only non-warm-up successful frames appear in the latency samples.
    expect(result.perFrameLatencyMs).toHaveLength(totalFrames - warmupFrames);
    expect(result.frameCount).toBe(totalFrames - warmupFrames);
    expect(result.successCount).toBe(totalFrames - warmupFrames);
  });

  it('increments failedCount and marks invalid when >50% of frames fail', async () => {
    // Fail every frame except the first two -> well over 50% failure.
    const { pool } = makeFakePool({ failFrame: (id) => id >= 2 });
    const runner = new BenchmarkRunner(pool);

    const opts: BenchmarkOptions = {
      frames: makeFrames(12),
      warmupFrames: 0,
    };

    const result = await runner.run('stub', BACKEND, opts);

    expect(result.failedCount).toBeGreaterThan(0);
    expect(result.failedCount).toBe(10);
    expect(result.successCount).toBe(2);
    expect(result.valid).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning).toMatch(/invalid/i);
  });

  it('emits a partial warning when successful frames < 50', async () => {
    const { pool } = makeFakePool();
    const runner = new BenchmarkRunner(pool);

    const opts: BenchmarkOptions = {
      frames: makeFrames(20),
      warmupFrames: 0,
    };

    const result = await runner.run('stub', BACKEND, opts);

    expect(result.valid).toBe(true);
    expect(result.successCount).toBe(20);
    expect(result.warning).toBeDefined();
    expect(result.warning).toMatch(/partial/i);
  });

  it('reports latency stats shape and null accuracy when no ground truth', async () => {
    const { pool } = makeFakePool();
    const runner = new BenchmarkRunner(pool);

    const result = await runner.run('stub', BACKEND, {
      frames: makeFrames(60),
      warmupFrames: 5,
    });

    expect(result.accuracy).toBeNull();
    expect(result.latency).toEqual(
      expect.objectContaining({
        meanFps: expect.any(Number),
        medianMs: expect.any(Number),
        p95Ms: expect.any(Number),
        stdDevMs: expect.any(Number),
      }),
    );
    // No warning at >=50 successful frames without failures.
    expect(result.warning).toBeUndefined();
  });

  it('computes accuracy when ground truth is provided (meanOks > 0)', async () => {
    const { pool } = makeFakePool();
    const runner = new BenchmarkRunner(pool);

    const frameCount = 10;
    // Provide matching GT for each non-warm-up frame index.
    const groundTruth: GroundTruthFrame[] = Array.from(
      { length: frameCount },
      (_, i) => matchingGt(i),
    );

    const result = await runner.run('stub', BACKEND, {
      frames: makeFrames(frameCount),
      groundTruth,
      warmupFrames: 0,
    });

    expect(result.accuracy).not.toBeNull();
    expect(result.accuracy!.meanOks).toBeGreaterThan(0);
    // Detect returns keypoints matching GT exactly -> OKS should be ~1.
    expect(result.accuracy!.meanOks).toBeCloseTo(1, 6);
    expect(result.accuracy!.recallAt050).toBeCloseTo(1, 6);
    expect(result.accuracy!.perKeypointOks).toHaveLength(KEYPOINT_COUNT);
  });

  it('terminates the worker at the end (terminate spy called)', async () => {
    const { pool, terminate, spawn } = makeFakePool();
    const runner = new BenchmarkRunner(pool);

    await runner.run('stub', BACKEND, { frames: makeFrames(8), warmupFrames: 2 });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('produces a result with a uuid id and the requested modelId', async () => {
    const { pool } = makeFakePool();
    const runner = new BenchmarkRunner(pool);

    const result = await runner.run('movenet-thunder', BACKEND, {
      frames: makeFrames(6),
      warmupFrames: 1,
    });

    expect(result.modelId).toBe('movenet-thunder');
    // RFC-4122 v4 uuid shape.
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(typeof result.timestampMs).toBe('number');
  });
});
