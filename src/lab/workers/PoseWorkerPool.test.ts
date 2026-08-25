/**
 * Unit tests for PoseWorkerPool.
 *
 * The pool constructs dedicated Workers via
 * `new Worker(new URL('./pose.worker.ts', import.meta.url), {type:'module'})`.
 * We stub the global `Worker` constructor with a controllable MockWorker so the
 * test can drive `postMessage`-triggered responses and emit worker messages on
 * demand (per the vi.stubGlobal pattern used in WorkoutSession.test.ts).
 *
 * Requirements validated: 8.2, 8.5
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Keypoint } from '../../types/index.js';
import type { WorkerResponse } from '../types.js';
import { PoseWorkerPool, type WorkerHandle } from './PoseWorkerPool.js';

// ---------------------------------------------------------------------------
// Controllable mock Worker
// ---------------------------------------------------------------------------

interface PostedMessage {
  data: unknown;
  transfer: Transferable[] | undefined;
}

/**
 * A fake `Worker` that records posted messages and lets tests emit `message`
 * (and `error`) events synchronously. Only the surface PoseWorkerPool uses is
 * implemented: addEventListener/removeEventListener/postMessage/terminate.
 */
class MockWorker {
  /** Every MockWorker constructed during a test, in creation order. */
  static instances: MockWorker[] = [];

  readonly url: unknown;
  readonly options: unknown;

  /** Messages posted from the main thread into this worker. */
  readonly posted: PostedMessage[] = [];

  terminated = false;

  private readonly messageListeners = new Set<(event: MessageEvent) => void>();
  private readonly errorListeners = new Set<(event: ErrorEvent) => void>();

  constructor(url: unknown, options?: unknown) {
    this.url = url;
    this.options = options;
    MockWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    if (type === 'message') {
      this.messageListeners.add(listener as (event: MessageEvent) => void);
    } else if (type === 'error') {
      this.errorListeners.add(listener as (event: ErrorEvent) => void);
    }
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    if (type === 'message') {
      this.messageListeners.delete(listener as (event: MessageEvent) => void);
    } else if (type === 'error') {
      this.errorListeners.delete(listener as (event: ErrorEvent) => void);
    }
  }

  postMessage(data: unknown, transfer?: Transferable[]): void {
    this.posted.push({ data, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  // --- Test helpers ---------------------------------------------------------

  /** Emit a `message` event carrying the given WorkerResponse to all listeners. */
  emit(response: WorkerResponse): void {
    const event = { data: response } as MessageEvent<WorkerResponse>;
    // Copy to array so listeners removing themselves mid-dispatch is safe.
    for (const listener of [...this.messageListeners]) {
      listener(event);
    }
  }

  /** Emit a hard `error` event. */
  emitError(message: string): void {
    const event = { message } as ErrorEvent;
    for (const listener of [...this.errorListeners]) {
      listener(event);
    }
  }

  /** The most recent message posted into this worker. */
  get lastPosted(): PostedMessage | undefined {
    return this.posted[this.posted.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal fake ImageBitmap; the pool only forwards/transfers it. */
function makeFrame(): ImageBitmap {
  return { width: 4, height: 4, close: () => {} } as unknown as ImageBitmap;
}

function makeKeypoints(): Keypoint[] {
  return Array.from({ length: 3 }, (_, index): Keypoint => ({
    index,
    x: index * 0.1,
    y: index * 0.2,
    z: 0,
    confidence: 0.9,
  }));
}

/**
 * Spawn a handle, driving the ready handshake against the freshly-created
 * MockWorker. Returns both the handle and its backing MockWorker.
 */
async function spawnReady(
  pool: PoseWorkerPool,
  modelId: string,
): Promise<{ handle: WorkerHandle; mock: MockWorker }> {
  const promise = pool.spawn(modelId, 'tfjs');
  const mock = MockWorker.instances[MockWorker.instances.length - 1];
  mock.emit({ type: 'ready', modelId });
  const handle = await promise;
  return { handle, mock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PoseWorkerPool', () => {
  beforeEach(() => {
    MockWorker.instances = [];
    vi.stubGlobal('Worker', MockWorker as unknown as typeof Worker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('spawn() resolves with a WorkerHandle after the mock emits ready', async () => {
    const pool = new PoseWorkerPool();
    const promise = pool.spawn('movenet-thunder', 'tfjs');

    expect(MockWorker.instances).toHaveLength(1);
    const mock = MockWorker.instances[0];

    // init request should have been posted immediately.
    expect(mock.posted[0].data).toMatchObject({ type: 'init', modelId: 'movenet-thunder', backend: 'tfjs' });

    mock.emit({ type: 'ready', modelId: 'movenet-thunder' });
    const handle = await promise;

    expect(handle.modelId).toBe('movenet-thunder');
    expect(handle.worker).toBe(mock as unknown as Worker);
    expect(pool.activeCount).toBe(1);
  });

  it('spawn() rejects when the mock emits a load error', async () => {
    const pool = new PoseWorkerPool();
    const promise = pool.spawn('yolo-pose', 'onnx-web');
    const mock = MockWorker.instances[0];

    mock.emit({ type: 'error', category: 'load', message: 'weights 404' });

    await expect(promise).rejects.toThrow(/weights 404/);
    expect(mock.terminated).toBe(true);
    expect(pool.activeCount).toBe(0);
  });

  it('detect() resolves with keypoints when the mock emits a matching result', async () => {
    const pool = new PoseWorkerPool();
    const { handle, mock } = await spawnReady(pool, 'movenet-lightning');

    const frame = makeFrame();
    const kps = makeKeypoints();
    const detectPromise = pool.detect(handle, 42, frame, 1000);

    mock.emit({ type: 'result', frameId: 42, keypoints: kps, timestampMs: 1000 });

    await expect(detectPromise).resolves.toEqual(kps);
    expect(handle.pending.size).toBe(0);
  });

  it('detect() posts a detect request with the frame in the transfer list', async () => {
    const pool = new PoseWorkerPool();
    const { handle, mock } = await spawnReady(pool, 'movenet-lightning');

    const frame = makeFrame();
    void pool.detect(handle, 7, frame, 500);

    const posted = mock.lastPosted;
    expect(posted?.data).toMatchObject({ type: 'detect', frameId: 7, timestampMs: 500 });
    expect(posted?.transfer).toEqual([frame]);
  });

  it('terminate() rejects in-flight detect promises and calls worker.terminate()', async () => {
    const pool = new PoseWorkerPool();
    const { handle, mock } = await spawnReady(pool, 'rtmpose');

    const detectPromise = pool.detect(handle, 99, makeFrame(), 250);
    // Prevent unhandled rejection races by attaching the assertion up front.
    const assertion = expect(detectPromise).rejects.toThrow(/terminated/);

    pool.terminate(handle);

    await assertion;
    expect(mock.terminated).toBe(true);
    expect(pool.activeCount).toBe(0);
    expect(handle.pending.size).toBe(0);
  });

  it('Property 7: a late result after terminate() does not resolve/deliver and does not crash', async () => {
    const pool = new PoseWorkerPool();
    const { handle, mock } = await spawnReady(pool, 'movenet-thunder');

    const detectPromise = pool.detect(handle, 5, makeFrame(), 100);
    const assertion = expect(detectPromise).rejects.toThrow(/terminated/);

    // Terminate while the frame is in flight — this bumps generation and rejects.
    pool.terminate(handle);
    await assertion;

    // A late result for the pre-termination frameId arrives after teardown.
    // It must be dropped silently (generation mismatch / already-settled) with
    // no crash and no second settlement of the promise.
    let threw = false;
    try {
      mock.emit({ type: 'result', frameId: 5, keypoints: makeKeypoints(), timestampMs: 100 });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(handle.pending.size).toBe(0);
  });

  it('activeCount reflects spawned/terminated handles and supports 2 concurrent handles', async () => {
    const pool = new PoseWorkerPool();
    expect(pool.activeCount).toBe(0);

    const { handle: a } = await spawnReady(pool, 'movenet-lightning');
    const { handle: b } = await spawnReady(pool, 'movenet-thunder');
    expect(pool.activeCount).toBe(2);

    pool.terminate(a);
    expect(pool.activeCount).toBe(1);

    pool.terminate(b);
    expect(pool.activeCount).toBe(0);
  });
});
