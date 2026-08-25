/**
 * IndexedDB schema definitions for the CV Algorithm Lab.
 *
 * A single versioned database (`cv-algo-lab`) holds four object stores. Each
 * store is keyed by its record's `id` and carries a small set of indexes that
 * back the query methods on {@link ResultStore}. The constants here are the
 * single source of truth consumed by `ResultStore.open()` when creating the
 * stores and their indexes inside `onupgradeneeded`.
 *
 * Requirements covered: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 7.3, 12.4, 12.6, 13.3
 */

/** Name of the lab's IndexedDB database. */
export const DB_NAME = 'cv-algo-lab';

/** Current schema version. Bump when object stores or indexes change. */
export const DB_VERSION = 1;

/**
 * Object store names, keyed by a stable logical name used throughout the code.
 *
 * Every store uses `id` as its key path. The indexes maintained on each store
 * are:
 * - `benchmarks`    — `modelId`, `timestampMs`
 * - `annotations`   — `sourceVideoId`
 * - `recordings`    — `exerciseName`, `timestampMs`, `qualityRating`
 * - `trainedModels` — `exerciseName`
 */
export const STORES = {
  benchmarks: 'benchmarks',
  annotations: 'annotations',
  recordings: 'recordings',
  trainedModels: 'trainedModels',
} as const;

/** Union of the object store names present in the database. */
export type StoreName = (typeof STORES)[keyof typeof STORES];

/**
 * Index names per store. Kept alongside {@link STORES} so `open()` and the
 * query methods reference the same string constants.
 */
export const INDEXES = {
  benchmarks: {
    modelId: 'modelId',
    timestampMs: 'timestampMs',
  },
  annotations: {
    sourceVideoId: 'sourceVideoId',
  },
  recordings: {
    exerciseName: 'exerciseName',
    timestampMs: 'timestampMs',
    qualityRating: 'qualityRating',
  },
  trainedModels: {
    exerciseName: 'exerciseName',
  },
} as const;
