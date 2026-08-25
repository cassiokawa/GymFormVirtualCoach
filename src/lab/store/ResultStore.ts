/**
 * IndexedDB-backed persistence for the CV Algorithm Lab.
 *
 * {@link ResultStore} wraps a single versioned database (see {@link schema})
 * and exposes typed CRUD/query helpers for benchmark runs, ground-truth
 * annotations, recording sessions, and trained models. Every stored record is
 * a plain, structured-cloneable object so round-trip identity holds (Req 4.3);
 * no class instances are persisted.
 *
 * All IndexedDB request failures are caught on their `onerror`/`onabort`
 * handlers and surfaced as a typed {@link StoreError} carrying the failing
 * operation name and the underlying cause, rather than leaking raw DOM
 * exceptions to callers (Req 4.4).
 *
 * The code targets the standard global `indexedDB`; tests substitute
 * `fake-indexeddb`.
 *
 * Requirements covered: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 7.3, 12.4, 12.6, 13.3
 */

import type {
  BenchmarkResult,
  GroundTruthFrame,
  RecordingSession,
  TrainedModelRecord,
} from '../types.js';
import { DB_NAME, DB_VERSION, INDEXES, STORES, type StoreName } from './schema.js';

/**
 * Error thrown/rejected for every IndexedDB failure inside {@link ResultStore}.
 *
 * `op` identifies the logical operation (e.g. `"saveBenchmark"`, `"open"`) and
 * `cause` carries the originating error, if any, so callers can inspect the
 * root DOM exception without depending on its concrete type.
 */
export class StoreError extends Error {
  /** Logical operation that failed, e.g. `"queryBenchmarks"`. */
  readonly op: string;
  /** Underlying cause of the failure, typically a `DOMException`. */
  override readonly cause: unknown;

  constructor(op: string, cause: unknown, message?: string) {
    super(message ?? `ResultStore operation "${op}" failed`);
    this.name = 'StoreError';
    this.op = op;
    this.cause = cause;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, StoreError.prototype);
  }
}

/**
 * Filter accepted by {@link ResultStore.queryBenchmarks}. All fields are
 * optional; omitted fields impose no constraint.
 */
export interface BenchmarkQuery {
  /** Restrict to a single adapter id. */
  modelId?: string;
  /** Inclusive lower bound on `timestampMs`. */
  from?: number;
  /** Inclusive upper bound on `timestampMs`. */
  to?: number;
}

/**
 * Filter accepted by {@link ResultStore.queryRecordings}. All fields are
 * optional; omitted fields impose no constraint.
 */
export interface RecordingQuery {
  /** Restrict to recordings of a single exercise. */
  exerciseName?: string;
  /** Inclusive lower bound on the recording's `createdMs`. */
  from?: number;
  /** Inclusive upper bound on the recording's `createdMs`. */
  to?: number;
  /** Minimum subjective quality rating (1-5), inclusive. */
  minQuality?: number;
}

export class ResultStore {
  private db: IDBDatabase | null = null;

  /**
   * Opens (and, on first use or version bump, upgrades) the database. Creates
   * every object store and index declared in {@link schema} inside
   * `onupgradeneeded`. Idempotent: repeated calls resolve immediately once the
   * connection is established.
   *
   * @throws {StoreError} If the environment lacks IndexedDB or the open fails.
   */
  open(): Promise<void> {
    if (this.db) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const idb: IDBFactory | undefined =
        typeof indexedDB !== 'undefined' ? indexedDB : undefined;
      if (!idb) {
        reject(new StoreError('open', undefined, 'IndexedDB is not available'));
        return;
      }

      let request: IDBOpenDBRequest;
      try {
        request = idb.open(DB_NAME, DB_VERSION);
      } catch (cause) {
        reject(new StoreError('open', cause));
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(STORES.benchmarks)) {
          const store = db.createObjectStore(STORES.benchmarks, { keyPath: 'id' });
          store.createIndex(INDEXES.benchmarks.modelId, 'modelId', { unique: false });
          store.createIndex(INDEXES.benchmarks.timestampMs, 'timestampMs', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.annotations)) {
          const store = db.createObjectStore(STORES.annotations, { keyPath: 'id' });
          store.createIndex(INDEXES.annotations.sourceVideoId, 'sourceVideoId', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.recordings)) {
          const store = db.createObjectStore(STORES.recordings, { keyPath: 'id' });
          // Indexed fields live under nested paths on RecordingSession.
          store.createIndex(INDEXES.recordings.exerciseName, 'metadata.exerciseName', {
            unique: false,
          });
          store.createIndex(INDEXES.recordings.timestampMs, 'metadata.createdMs', {
            unique: false,
          });
          store.createIndex(INDEXES.recordings.qualityRating, 'labels.qualityRating', {
            unique: false,
          });
        }

        if (!db.objectStoreNames.contains(STORES.trainedModels)) {
          const store = db.createObjectStore(STORES.trainedModels, { keyPath: 'id' });
          store.createIndex(INDEXES.trainedModels.exerciseName, 'exerciseName', { unique: false });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        // Surface unexpected connection-level failures instead of swallowing them.
        this.db.onversionchange = () => this.db?.close();
        resolve();
      };

      request.onerror = () => reject(new StoreError('open', request.error));
      request.onblocked = () =>
        reject(new StoreError('open', request.error, 'IndexedDB open blocked by an older connection'));
    });
  }

  // -------------------------------------------------------------------------
  // Benchmarks (Req 4)
  // -------------------------------------------------------------------------

  /** Persists (or overwrites) a benchmark result keyed by its `id`. */
  saveBenchmark(r: BenchmarkResult): Promise<void> {
    return this.put('saveBenchmark', STORES.benchmarks, r);
  }

  /** Retrieves a benchmark result by id, or `undefined` when absent. */
  getBenchmark(id: string): Promise<BenchmarkResult | undefined> {
    return this.get<BenchmarkResult>('getBenchmark', STORES.benchmarks, id);
  }

  /**
   * Returns benchmark results matching the given filter. When `modelId` is
   * supplied the `modelId` index narrows the scan; `from`/`to` bound
   * `timestampMs` inclusively. Results are returned in store (key) order.
   */
  async queryBenchmarks(f: BenchmarkQuery): Promise<BenchmarkResult[]> {
    const all = await this.getAll<BenchmarkResult>(
      'queryBenchmarks',
      STORES.benchmarks,
      f.modelId !== undefined ? { index: INDEXES.benchmarks.modelId, value: f.modelId } : undefined,
    );
    return all.filter((r) => withinRange(r.timestampMs, f.from, f.to));
  }

  /**
   * Deletes a single benchmark by id.
   * @returns The number of records removed (0 or 1).
   */
  async deleteBenchmark(id: string): Promise<number> {
    const existing = await this.getBenchmark(id);
    if (existing === undefined) return 0;
    await this.delete('deleteBenchmark', STORES.benchmarks, id);
    return 1;
  }

  /**
   * Deletes every benchmark associated with a model.
   * @returns The number of records removed.
   */
  async deleteBenchmarksForModel(modelId: string): Promise<number> {
    const matches = await this.getAll<BenchmarkResult>(
      'deleteBenchmarksForModel',
      STORES.benchmarks,
      { index: INDEXES.benchmarks.modelId, value: modelId },
    );
    for (const r of matches) {
      await this.delete('deleteBenchmarksForModel', STORES.benchmarks, r.id);
    }
    return matches.length;
  }

  // -------------------------------------------------------------------------
  // Annotations (Req 7)
  // -------------------------------------------------------------------------

  /** Persists (or overwrites) a ground-truth annotation frame. */
  saveAnnotation(a: GroundTruthFrame): Promise<void> {
    return this.put('saveAnnotation', STORES.annotations, a);
  }

  /** Retrieves a ground-truth annotation by id, or `undefined` when absent. */
  getAnnotation(id: string): Promise<GroundTruthFrame | undefined> {
    return this.get<GroundTruthFrame>('getAnnotation', STORES.annotations, id);
  }

  // -------------------------------------------------------------------------
  // Recordings (Req 12)
  // -------------------------------------------------------------------------

  /** Persists (or overwrites) a recording session. */
  saveRecording(r: RecordingSession): Promise<void> {
    return this.put('saveRecording', STORES.recordings, r);
  }

  /**
   * Returns recording sessions matching the given filter. When `exerciseName`
   * is supplied the corresponding index narrows the scan; `from`/`to` bound the
   * recording's `metadata.createdMs` inclusively, and `minQuality` filters on
   * `labels.qualityRating`.
   */
  async queryRecordings(f: RecordingQuery): Promise<RecordingSession[]> {
    const all = await this.getAll<RecordingSession>(
      'queryRecordings',
      STORES.recordings,
      f.exerciseName !== undefined
        ? { index: INDEXES.recordings.exerciseName, value: f.exerciseName }
        : undefined,
    );
    return all.filter(
      (r) =>
        withinRange(r.metadata.createdMs, f.from, f.to) &&
        (f.minQuality === undefined || r.labels.qualityRating >= f.minQuality),
    );
  }

  // -------------------------------------------------------------------------
  // Trained models (Req 13)
  // -------------------------------------------------------------------------

  /** Persists (or overwrites) a trained model record. */
  saveTrainedModel(m: TrainedModelRecord): Promise<void> {
    return this.put('saveTrainedModel', STORES.trainedModels, m);
  }

  /** Returns every persisted trained model record in store order. */
  listTrainedModels(): Promise<TrainedModelRecord[]> {
    return this.getAll<TrainedModelRecord>('listTrainedModels', STORES.trainedModels);
  }

  // -------------------------------------------------------------------------
  // Internal request helpers
  // -------------------------------------------------------------------------

  /** Returns the open database or rejects if `open()` has not been called. */
  private requireDb(op: string): IDBDatabase {
    if (!this.db) {
      throw new StoreError(op, undefined, 'ResultStore.open() must be called before use');
    }
    return this.db;
  }

  /** Wraps a single-request write into a readwrite transaction. */
  private put(op: string, store: StoreName, value: unknown): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = this.requireDb(op).transaction(store, 'readwrite');
      } catch (cause) {
        reject(new StoreError(op, cause));
        return;
      }
      tx.onabort = () => reject(new StoreError(op, tx.error));
      const request = tx.objectStore(store).put(value);
      request.onerror = () => reject(new StoreError(op, request.error));
      request.onsuccess = () => resolve();
    });
  }

  /** Reads a single record by primary key. */
  private get<T>(op: string, store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = this.requireDb(op).transaction(store, 'readonly');
      } catch (cause) {
        reject(new StoreError(op, cause));
        return;
      }
      tx.onabort = () => reject(new StoreError(op, tx.error));
      const request = tx.objectStore(store).get(key);
      request.onerror = () => reject(new StoreError(op, request.error));
      request.onsuccess = () => resolve(request.result as T | undefined);
    });
  }

  /** Deletes a single record by primary key. */
  private delete(op: string, store: StoreName, key: IDBValidKey): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = this.requireDb(op).transaction(store, 'readwrite');
      } catch (cause) {
        reject(new StoreError(op, cause));
        return;
      }
      tx.onabort = () => reject(new StoreError(op, tx.error));
      const request = tx.objectStore(store).delete(key);
      request.onerror = () => reject(new StoreError(op, request.error));
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Reads all records from a store, optionally scoped to a single-value index
   * lookup. Returns an empty array when nothing matches.
   */
  private getAll<T>(
    op: string,
    store: StoreName,
    scope?: { index: string; value: IDBValidKey },
  ): Promise<T[]> {
    return new Promise<T[]>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = this.requireDb(op).transaction(store, 'readonly');
      } catch (cause) {
        reject(new StoreError(op, cause));
        return;
      }
      tx.onabort = () => reject(new StoreError(op, tx.error));
      const objectStore = tx.objectStore(store);
      const source: IDBObjectStore | IDBIndex = scope
        ? objectStore.index(scope.index)
        : objectStore;
      const request = scope ? source.getAll(scope.value) : source.getAll();
      request.onerror = () => reject(new StoreError(op, request.error));
      request.onsuccess = () => resolve((request.result ?? []) as T[]);
    });
  }
}

/** Inclusive range check tolerant of undefined bounds. */
function withinRange(value: number, from?: number, to?: number): boolean {
  if (from !== undefined && value < from) return false;
  if (to !== undefined && value > to) return false;
  return true;
}
