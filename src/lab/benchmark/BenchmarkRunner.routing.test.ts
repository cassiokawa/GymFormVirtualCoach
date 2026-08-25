/**
 * Verifies BenchmarkRunner routing: adapters with the `mediapipe-wasm` backend
 * run on the main thread via the injected ModelRegistry (workers lack the
 * `document` MediaPipe needs), while all other backends use the worker pool.
 *
 * Requirements: 3.5, 8.1
 */

import { describe, it, expect, vi } from 'vitest';
import { BenchmarkRunner } from './BenchmarkRunner.js';
import type { PoseWorkerPool, WorkerHandle } from '../workers/PoseWorkerPool.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';
import type { Keypoint } from '../../types/index.js';
import type { BenchmarkOptions, PoseAdapter, RawPose, RuntimeBackend } from '../types.js';

const KEYPOINT_COUNT = 33;

function fakeFrame(): ImageBitmap {
  return { close: vi.fn() } as unknown as ImageBitmap;
}

function makeFrames(n: number): ImageBitmap[] {
  return Array.from({ length: n }, () => fakeFrame());
}

function keypoints(): Keypoint[] {
  return Array.from({ length: KEYPOINT_COUNT }, (_, i) => ({
    index: i,
    x: 0.5,
    y: 0.5,
    z: 0,
    confidence: 1,
  }));
}

const BENCH: BenchmarkOptions = { frames: makeFrames(8), warmupFrames: 2 };

describe('BenchmarkRunner routing', () => {
  it('runs mediapipe-wasm models on the main thread via the registry (never the worker)', async () => {
    const detect = vi.fn(
      async (_f: ImageBitmap, timestampMs: number): Promise<RawPose> => ({
        keypoints: keypoints(),
        timestampMs,
      }),
    );
    const adapter: PoseAdapter = {
      metadata: {
        id: 'mediapipe-blazepose',
        displayName: 'MediaPipe',
        keypointCount: 33,
        backend: 'mediapipe-wasm',
        modelSizeMb: 3,
        license: 'Apache-2.0',
        version: '1.0.0',
      },
      load: vi.fn(async () => {}),
      detect,
      dispose: vi.fn(async () => {}),
    };
    const registry = {
      get: vi.fn(() => adapter),
      has: vi.fn(() => true),
      list: vi.fn(() => [adapter.metadata]),
    } as unknown as ModelRegistry;

    const pool = {
      spawn: vi.fn(),
      detect: vi.fn(),
      terminate: vi.fn(),
    } as unknown as PoseWorkerPool;

    const runner = new BenchmarkRunner(pool, registry);
    const result = await runner.run('mediapipe-blazepose', 'mediapipe-wasm', BENCH);

    // Main-thread path used: adapter loaded, detected per frame, disposed.
    expect(adapter.load).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledTimes(8);
    expect(adapter.dispose).toHaveBeenCalledTimes(1);
    // Worker pool never touched.
    expect(pool.spawn).not.toHaveBeenCalled();
    expect(pool.detect).not.toHaveBeenCalled();

    expect(result.modelId).toBe('mediapipe-blazepose');
    expect(result.successCount).toBe(6); // 8 - 2 warmup
  });

  it('runs onnx-web models through the worker pool', async () => {
    const handle = { modelId: 'yolov8-pose' } as unknown as WorkerHandle;
    const pool = {
      spawn: vi.fn(async () => handle),
      detect: vi.fn(async () => keypoints()),
      terminate: vi.fn(),
    } as unknown as PoseWorkerPool;
    const registry = {
      get: vi.fn(),
      has: vi.fn(() => true),
      list: vi.fn(() => []),
    } as unknown as ModelRegistry;

    const runner = new BenchmarkRunner(pool, registry);
    const backend: RuntimeBackend = 'onnx-web';
    const result = await runner.run('yolov8-pose', backend, BENCH);

    // Worker path used; registry.get (main-thread adapter) never called.
    expect(pool.spawn).toHaveBeenCalledTimes(1);
    expect(pool.detect).toHaveBeenCalledTimes(8);
    expect(pool.terminate).toHaveBeenCalledTimes(1);
    expect(registry.get).not.toHaveBeenCalled();

    expect(result.successCount).toBe(6);
  });

  it('runs tfjs (MoveNet) models on the main thread via the registry', async () => {
    const detect = vi.fn(
      async (_f: ImageBitmap, timestampMs: number): Promise<RawPose> => ({
        keypoints: keypoints(),
        timestampMs,
      }),
    );
    const adapter: PoseAdapter = {
      metadata: {
        id: 'movenet-lightning',
        displayName: 'MoveNet Lightning',
        keypointCount: 17,
        backend: 'tfjs',
        modelSizeMb: 5,
        license: 'Apache-2.0',
        version: '1.0.0',
      },
      load: vi.fn(async () => {}),
      detect,
      dispose: vi.fn(async () => {}),
    };
    const registry = {
      get: vi.fn(() => adapter),
      has: vi.fn(() => true),
      list: vi.fn(() => [adapter.metadata]),
    } as unknown as ModelRegistry;
    const pool = {
      spawn: vi.fn(),
      detect: vi.fn(),
      terminate: vi.fn(),
    } as unknown as PoseWorkerPool;

    const runner = new BenchmarkRunner(pool, registry);
    await runner.run('movenet-lightning', 'tfjs', BENCH);

    expect(adapter.load).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledTimes(8);
    expect(pool.spawn).not.toHaveBeenCalled();
  });

  it('throws for a main-thread model when no registry was provided', async () => {
    const pool = {
      spawn: vi.fn(),
      detect: vi.fn(),
      terminate: vi.fn(),
    } as unknown as PoseWorkerPool;
    const runner = new BenchmarkRunner(pool);
    await expect(
      runner.run('mediapipe-blazepose', 'mediapipe-wasm', BENCH),
    ).rejects.toThrow(/without a ModelRegistry/);
  });
});
