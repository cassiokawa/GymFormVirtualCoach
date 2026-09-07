/**
 * @vitest-environment jsdom
 *
 * IndexedDB coordination for scoped Workout_Data erasure (Req 5.3).
 *
 * The bulk of Workout_Data lives in IndexedDB (`workout_sessions`,
 * `session_exercise_logs`), not in localStorage. These tests confirm that
 * `PrivacyManager.eraseWorkoutData()` clears those IndexedDB stores while
 * leaving Body_Data (encrypted, in localStorage) intact — and that
 * `Storage.clearWorkoutData()` is a no-op when the database was never opened.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { PrivacyManager } from './PrivacyManager.js';
import { PrivacyVault } from './PrivacyVault.js';
import { Storage as WorkoutStorage } from '../storage/Storage.js';
import type { Session } from '../types/index.js';

// The DOM localStorage interface, aliased so it is not shadowed by the imported
// `Storage` workout class above.
type DomStorage = typeof globalThis.localStorage;

// Deterministic in-memory localStorage (jsdom's may be incomplete).
function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  const mock: DomStorage = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
    key(i: number) { return Array.from(store.keys())[i] ?? null; },
    removeItem(k: string) { store.delete(k); },
    setItem(k: string, v: string) { store.set(k, String(v)); },
  } as unknown as DomStorage;
  Object.defineProperty(globalThis, 'localStorage', { value: mock, configurable: true, writable: true });
}

function sampleSession(id: string): Session {
  return {
    id,
    startedAt: new Date('2026-01-01T10:00:00.000Z'),
    endedAt: new Date('2026-01-01T10:30:00.000Z'),
    durationMs: 1_800_000,
    routineId: 'routine-1',
    sets: [
      {
        setNumber: 1,
        exerciseName: 'demo_movement',
        reps: [{ repNumber: 1, tutMs: 2000, category: 'correct', deviationEvents: [] }],
        actualTutMs: 2000,
        expectedTutMs: 2000,
        tutDeltaMs: 0,
      },
    ],
  };
}

beforeEach(() => {
  installMemoryLocalStorage();
  // Fresh IndexedDB and Storage singleton per test.
  globalThis.indexedDB = new IDBFactory();
  WorkoutStorage._resetInstance();
  PrivacyVault.getInstance().lock();
  PrivacyManager.getInstance().lock();
});

describe('eraseWorkoutData — IndexedDB coordination (Req 5.3)', () => {
  it('clears the IndexedDB workout stores and retains Body_Data', async () => {
    // Seed workout history in IndexedDB.
    const storage = WorkoutStorage.getInstance();
    await storage.open();
    await storage.persist(sampleSession('sess-1'));

    const range = { from: new Date('2026-01-01T00:00:00.000Z'), to: new Date('2026-01-02T00:00:00.000Z') };
    expect(await storage.query(range)).toHaveLength(1);

    // Seed Body_Data that must survive.
    const m = PrivacyManager.getInstance();
    await m.createVault('idb-scoped-pass');
    await m.saveScans([{
      id: 'b1', timestamp: 1000, poseQuality: 0.9,
      measurements: {
        shoulderWidth: 0.2, hipWidth: 0.15, shoulderToHipRatio: 1.33,
        leftUpperArm: 0.15, rightUpperArm: 0.15, leftForearm: 0.13, rightForearm: 0.13,
        leftThigh: 0.24, rightThigh: 0.24, leftCalf: 0.2, rightCalf: 0.2,
        torsoLength: 0.3, heightPx: 800,
      },
      weightKg: 79,
    }]);

    await m.eraseWorkoutData();

    // Workout_Data in IndexedDB is gone.
    expect(await storage.query(range)).toHaveLength(0);
    // Body_Data survives and is still decryptable.
    const loaded = await m.loadScans();
    expect(loaded[0]?.weightKg).toBe(79);
  });

  it('Storage.clearWorkoutData resolves as a no-op when the DB was never opened', async () => {
    // Fresh singleton, never opened.
    await expect(WorkoutStorage.getInstance().clearWorkoutData()).resolves.toBeUndefined();
  });
});
