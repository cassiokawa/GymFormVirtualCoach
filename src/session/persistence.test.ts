/**
 * Unit tests for session persistence — the 120-second resume window (R1.7) and
 * the two independent, persisted mute flags (R3.8).
 *
 * These use an injected in-memory {@link SessionStore}, so no real localStorage
 * is touched and time is deterministic (an explicit `now` is passed to
 * {@link loadSnapshot}).
 *
 * Requirements: 1.7, 3.8
 */

import { describe, it, expect } from 'vitest';

import { TONE_MUTE_STORAGE_KEY } from './AudioBus';
import {
  RESUME_WINDOW_MS,
  SNAPSHOT_STORAGE_KEY,
  SPEECH_MUTE_STORAGE_KEY,
  loadMute,
  loadSnapshot,
  saveMute,
  saveSnapshot,
  type SessionStore,
} from './persistence';
import type { SessionSnapshot } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An in-memory SessionStore so persistence is testable without localStorage. */
function makeMemoryStore(seed: Record<string, string> = {}): SessionStore & {
  readonly map: Map<string, string>;
} {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

function snapshotAt(savedAt: number): SessionSnapshot {
  return {
    state: 'WORKING',
    exerciseId: 'opaque-id-123',
    set: {
      exerciseId: 'opaque-id-123',
      startedAt: savedAt - 5_000,
      reps: [],
      lowConfidence: false,
      bestRepIndex: null,
    },
    savedAt,
  };
}

// ---------------------------------------------------------------------------
// Snapshot round-trip (R1.7)
// ---------------------------------------------------------------------------

describe('saveSnapshot / loadSnapshot', () => {
  it('round-trips a snapshot through storage', () => {
    const store = makeMemoryStore();
    const snap = snapshotAt(1_000_000);

    saveSnapshot(snap, { store });
    expect(store.map.has(SNAPSHOT_STORAGE_KEY)).toBe(true);

    // Read back at the same instant — well inside the window.
    const loaded = loadSnapshot(snap.savedAt, { store });
    expect(loaded).toEqual(snap);
  });

  it('restores a snapshot within the 120s window', () => {
    const store = makeMemoryStore();
    const snap = snapshotAt(1_000_000);
    saveSnapshot(snap, { store });

    // 119.999s later — still inside the window.
    const now = snap.savedAt + RESUME_WINDOW_MS - 1;
    expect(loadSnapshot(now, { store })).toEqual(snap);
  });

  it('restores at exactly the 120s boundary (age <= 120s honoured)', () => {
    const store = makeMemoryStore();
    const snap = snapshotAt(1_000_000);
    saveSnapshot(snap, { store });

    const now = snap.savedAt + RESUME_WINDOW_MS; // age == 120s exactly
    expect(loadSnapshot(now, { store })).toEqual(snap);
  });

  it('returns null for a snapshot older than 120s (start fresh at SETUP)', () => {
    const store = makeMemoryStore();
    const snap = snapshotAt(1_000_000);
    saveSnapshot(snap, { store });

    const now = snap.savedAt + RESUME_WINDOW_MS + 1; // age just over 120s
    expect(loadSnapshot(now, { store })).toBeNull();
  });

  it('returns null when there is no persisted snapshot', () => {
    const store = makeMemoryStore();
    expect(loadSnapshot(Date.now(), { store })).toBeNull();
  });

  it('returns null for corrupt JSON rather than throwing', () => {
    const store = makeMemoryStore({ [SNAPSHOT_STORAGE_KEY]: '{not valid json' });
    expect(() => loadSnapshot(Date.now(), { store })).not.toThrow();
    expect(loadSnapshot(Date.now(), { store })).toBeNull();
  });

  it('returns null for structurally invalid snapshots', () => {
    const badState = makeMemoryStore({
      [SNAPSHOT_STORAGE_KEY]: JSON.stringify({ state: 'BOGUS', exerciseId: null, set: null, savedAt: 1 }),
    });
    expect(loadSnapshot(1, { store: badState })).toBeNull();

    const missingSavedAt = makeMemoryStore({
      [SNAPSHOT_STORAGE_KEY]: JSON.stringify({ state: 'SETUP', exerciseId: null, set: null }),
    });
    expect(loadSnapshot(1, { store: missingSavedAt })).toBeNull();
  });

  it('degrades to no-op / null when no store is available', () => {
    // No store injected and no ambient localStorage in this (node) environment.
    expect(() => saveSnapshot(snapshotAt(1))).not.toThrow();
    expect(loadSnapshot(1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mute flags (R3.8)
// ---------------------------------------------------------------------------

describe('loadMute / saveMute', () => {
  it('defaults both flags to false when absent', () => {
    const store = makeMemoryStore();
    expect(loadMute({ store })).toEqual({ tones: false, speech: false });
  });

  it('round-trips both flags through storage', () => {
    const store = makeMemoryStore();
    saveMute({ tones: true, speech: true }, { store });
    expect(loadMute({ store })).toEqual({ tones: true, speech: true });
  });

  it('persists tones and speech under SEPARATE keys so they toggle independently', () => {
    const store = makeMemoryStore();

    saveMute({ tones: true, speech: false }, { store });
    expect(store.map.get(TONE_MUTE_STORAGE_KEY)).toBe('1');
    expect(store.map.get(SPEECH_MUTE_STORAGE_KEY)).toBe('0');
    expect(loadMute({ store })).toEqual({ tones: true, speech: false });

    // Flip only speech; tones must stay muted.
    saveMute({ tones: true, speech: true }, { store });
    expect(store.map.get(TONE_MUTE_STORAGE_KEY)).toBe('1');
    expect(store.map.get(SPEECH_MUTE_STORAGE_KEY)).toBe('1');

    // Flip only tones; speech must stay muted.
    saveMute({ tones: false, speech: true }, { store });
    expect(loadMute({ store })).toEqual({ tones: false, speech: true });
  });

  it('shares the tones key with AudioBus (one source of truth)', () => {
    // A value written under the AudioBus-owned key is seen by loadMute as tones.
    const store = makeMemoryStore({ [TONE_MUTE_STORAGE_KEY]: '1' });
    expect(loadMute({ store }).tones).toBe(true);
  });

  it('treats any non-"1" stored value as unmuted', () => {
    const store = makeMemoryStore({
      [TONE_MUTE_STORAGE_KEY]: 'true',
      [SPEECH_MUTE_STORAGE_KEY]: 'yes',
    });
    expect(loadMute({ store })).toEqual({ tones: false, speech: false });
  });

  it('degrades to defaults / no-op when no store is available', () => {
    expect(() => saveMute({ tones: true, speech: true })).not.toThrow();
    expect(loadMute()).toEqual({ tones: false, speech: false });
  });
});
