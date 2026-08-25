/**
 * Unit tests for ModelRegistry.
 *
 * Verifies lazy adapter instantiation with caching, unknown-id error
 * reporting, metadata listing without instantiation, and membership checks.
 *
 * Requirements: 1.2, 1.4, 1.5
 */

import { describe, it, expect, vi } from 'vitest';
import { ModelRegistry, UnknownModelError } from './ModelRegistry.js';
import type { AdapterMetadata, PoseAdapter, RawPose } from '../types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Deterministic stub PoseAdapter with no real inference backend. */
class StubPoseAdapter implements PoseAdapter {
  readonly metadata: AdapterMetadata;

  constructor(metadata: AdapterMetadata) {
    this.metadata = metadata;
  }

  async load(): Promise<void> {
    // no-op
  }

  async detect(_frame: ImageBitmap, timestampMs: number): Promise<RawPose> {
    return { keypoints: [], timestampMs };
  }

  async dispose(): Promise<void> {
    // no-op
  }
}

/** Build adapter metadata with sensible defaults, overridable per field. */
function makeMetadata(overrides: Partial<AdapterMetadata> = {}): AdapterMetadata {
  return {
    id: 'stub-model',
    displayName: 'Stub Model',
    keypointCount: 17,
    backend: 'tfjs',
    modelSizeMb: 3,
    license: 'MIT',
    version: '1.0.0',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModelRegistry', () => {
  it('register + get returns the same cached instance across calls', () => {
    const registry = new ModelRegistry();
    const metadata = makeMetadata({ id: 'movenet-lightning' });
    registry.register(() => new StubPoseAdapter(metadata), metadata);

    const first = registry.get('movenet-lightning');
    const second = registry.get('movenet-lightning');

    expect(first).toBeInstanceOf(StubPoseAdapter);
    expect(second).toBe(first);
  });

  it('invokes the factory lazily — not until the first get()', () => {
    const registry = new ModelRegistry();
    const metadata = makeMetadata({ id: 'movenet-thunder' });
    const factory = vi.fn(() => new StubPoseAdapter(metadata));

    registry.register(factory, metadata);
    expect(factory).not.toHaveBeenCalled();

    registry.get('movenet-thunder');
    expect(factory).toHaveBeenCalledTimes(1);

    // Second lookup reuses the cache; factory not called again.
    registry.get('movenet-thunder');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('throws UnknownModelError with the id in the message for unknown id', () => {
    const registry = new ModelRegistry();

    expect(() => registry.get('does-not-exist')).toThrow(UnknownModelError);
    expect(() => registry.get('does-not-exist')).toThrow(/does-not-exist/);

    try {
      registry.get('does-not-exist');
      expect.unreachable('get() should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownModelError);
      expect((error as UnknownModelError).modelId).toBe('does-not-exist');
    }
  });

  it('has() returns true for registered ids and false otherwise', () => {
    const registry = new ModelRegistry();
    const metadata = makeMetadata({ id: 'yolo-pose' });
    registry.register(() => new StubPoseAdapter(metadata), metadata);

    expect(registry.has('yolo-pose')).toBe(true);
    expect(registry.has('rtm-pose')).toBe(false);
  });

  it('list() returns all registered metadata without instantiating adapters', () => {
    const registry = new ModelRegistry();
    const metaA = makeMetadata({ id: 'model-a', displayName: 'Model A', keypointCount: 33 });
    const metaB = makeMetadata({ id: 'model-b', displayName: 'Model B', backend: 'onnx-web' });
    const factoryA = vi.fn(() => new StubPoseAdapter(metaA));
    const factoryB = vi.fn(() => new StubPoseAdapter(metaB));

    registry.register(factoryA, metaA);
    registry.register(factoryB, metaB);

    const listed = registry.list();

    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([metaA, metaB]));
    // Listing metadata must never trigger adapter construction.
    expect(factoryA).not.toHaveBeenCalled();
    expect(factoryB).not.toHaveBeenCalled();
  });
});
