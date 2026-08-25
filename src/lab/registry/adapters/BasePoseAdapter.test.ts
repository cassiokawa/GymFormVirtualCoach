/**
 * Unit tests for BasePoseAdapter (the abstract load/dispose lifecycle base).
 *
 * A concrete TestAdapter exercises the base guarantees: detect-before-load
 * rejection, idempotent load (loadModel called once), retry after a failed
 * load, and dispose resetting back to the unloaded state.
 *
 * Requirements validated: 8.5 (and lifecycle contract 1.3, 8.1, 8.3)
 */

import { describe, it, expect, vi } from 'vitest';
import type { AdapterMetadata, RawPose } from '../../types.js';
import { BasePoseAdapter } from './PoseAdapter.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const metadata: AdapterMetadata = {
  id: 'test-adapter',
  displayName: 'Test Adapter',
  keypointCount: 17,
  backend: 'tfjs',
  modelSizeMb: 1,
  license: 'MIT',
  version: '1.0.0',
};

/** Deterministic single-frame pose the stub inference returns. */
function stubPose(timestampMs: number): RawPose {
  return {
    timestampMs,
    keypoints: Array.from({ length: 17 }, (_, index) => ({
      index,
      x: 0.5,
      y: 0.5,
      z: 0,
      confidence: 1,
    })),
  };
}

/**
 * Concrete adapter whose load behaviour is controllable. When `failNext` is
 * true the next loadModel() rejects; the spies count invocations.
 */
class TestAdapter extends BasePoseAdapter {
  readonly metadata = metadata;

  failNext = false;

  readonly loadSpy = vi.fn();
  readonly inferSpy = vi.fn();
  readonly disposeSpy = vi.fn();

  protected override loadModel(): Promise<void> {
    this.loadSpy();
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('boom'));
    }
    return Promise.resolve();
  }

  protected override runInference(_frame: ImageBitmap, timestampMs: number): Promise<RawPose> {
    this.inferSpy();
    return Promise.resolve(stubPose(timestampMs));
  }

  protected override disposeModel(): Promise<void> {
    this.disposeSpy();
    return Promise.resolve();
  }
}

/** Minimal fake ImageBitmap; the stub inference never inspects it. */
function makeFrame(): ImageBitmap {
  return { width: 4, height: 4, close: () => {} } as unknown as ImageBitmap;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BasePoseAdapter', () => {
  it('exposes the concrete subclass metadata', () => {
    const adapter = new TestAdapter();
    expect(adapter.metadata).toEqual(metadata);
  });

  it('detect() throws before load()', async () => {
    const adapter = new TestAdapter();
    await expect(adapter.detect(makeFrame(), 0)).rejects.toThrow(/not loaded/);
    expect(adapter.inferSpy).not.toHaveBeenCalled();
  });

  it('load() is idempotent: loadModel called once across multiple load() calls', async () => {
    const adapter = new TestAdapter();

    // Concurrent loads coalesce onto a single loadModel invocation.
    await Promise.all([adapter.load(), adapter.load()]);
    // A later sequential load resolves immediately without re-invoking.
    await adapter.load();

    expect(adapter.loadSpy).toHaveBeenCalledTimes(1);

    const pose = await adapter.detect(makeFrame(), 123);
    expect(pose.timestampMs).toBe(123);
    expect(adapter.inferSpy).toHaveBeenCalledTimes(1);
  });

  it('after a failed load the adapter stays unloaded and a subsequent load() can succeed', async () => {
    const adapter = new TestAdapter();
    adapter.failNext = true;

    await expect(adapter.load()).rejects.toThrow(/Failed to load adapter "test-adapter": boom/);

    // Still unloaded: detect must reject.
    await expect(adapter.detect(makeFrame(), 0)).rejects.toThrow(/not loaded/);

    // Retry succeeds; loadModel invoked a second time.
    await adapter.load();
    expect(adapter.loadSpy).toHaveBeenCalledTimes(2);

    await expect(adapter.detect(makeFrame(), 5)).resolves.toMatchObject({ timestampMs: 5 });
  });

  it('dispose() resets so detect() throws again', async () => {
    const adapter = new TestAdapter();
    await adapter.load();
    await expect(adapter.detect(makeFrame(), 1)).resolves.toBeDefined();

    await adapter.dispose();
    expect(adapter.disposeSpy).toHaveBeenCalledTimes(1);

    // Back to unloaded.
    await expect(adapter.detect(makeFrame(), 2)).rejects.toThrow(/not loaded/);

    // Can be loaded again afterwards.
    await adapter.load();
    expect(adapter.loadSpy).toHaveBeenCalledTimes(2);
    await expect(adapter.detect(makeFrame(), 3)).resolves.toMatchObject({ timestampMs: 3 });
  });
});
