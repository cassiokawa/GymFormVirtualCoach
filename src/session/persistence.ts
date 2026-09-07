/**
 * Session persistence — the write/read seam behind the 120-second resume window
 * (R1.7) and the two independent audio mute flags (R3.8).
 *
 * ## What this owns
 *
 * - {@link saveSnapshot} / {@link loadSnapshot}: persist a {@link SessionSnapshot}
 *   on every transition and restore it on load, but ONLY within the 120-second
 *   window. Past that the snapshot is stale and the machine starts fresh at
 *   SETUP. Corrupt or partial JSON is treated as absent, never thrown.
 * - {@link loadMute} / {@link saveMute}: persist the tone and speech mute flags
 *   (R3.8) under SEPARATE keys so they toggle independently and survive reloads.
 *
 * ## Shared-key coordination with AudioBus
 *
 * The tones mute flag has ONE source of truth. `AudioBus` (task 4.1) already
 * persists it under `'gym-coach-mute-tones'` with the encoding `'1'` (muted) /
 * `'0'` (unmuted) — see {@link TONE_MUTE_STORAGE_KEY} in `./AudioBus`. This
 * module RE-USES that exact key and encoding for {@link MuteState.tones} so a
 * mute toggled through the bus and one read here never disagree. The speech
 * flag has no other owner yet (the SpeechChannel adapter lands in task 4.3), so
 * it gets its own key, {@link SPEECH_MUTE_STORAGE_KEY}, with the same encoding.
 * When task 4.3 wires the SpeechChannel it MUST reuse {@link SPEECH_MUTE_STORAGE_KEY}
 * for the same single-source-of-truth reason.
 *
 * ## Storage seam
 *
 * Like {@link MuteStore} in `./AudioBus`, this module writes through an
 * injectable {@link SessionStore} so tests need no real `localStorage` and the
 * code is safe where storage is unavailable (private mode, SSR, sandboxed
 * iframes). Every read and write is wrapped so a storage or parse failure
 * degrades to a clean default rather than throwing into the hot path.
 *
 * Requirements: 1.7, 3.8
 */

import { TONE_MUTE_STORAGE_KEY } from './AudioBus';
import type { MuteState, SessionSnapshot, SessionState } from './types';

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

/** localStorage key for the 120-second resume snapshot (R1.7). */
export const SNAPSHOT_STORAGE_KEY = 'gym-coach-session-snapshot';

/**
 * localStorage key for the SPEECH mute flag (R3.8). Distinct from
 * {@link TONE_MUTE_STORAGE_KEY} so tones and speech mute independently. The
 * SpeechChannel adapter (task 4.3) reuses this same key.
 */
export const SPEECH_MUTE_STORAGE_KEY = 'gym-coach-mute-speech';

/** The resume window: a snapshot older than this is stale and ignored (R1.7). */
export const RESUME_WINDOW_MS = 120_000;

// ---------------------------------------------------------------------------
// Storage seam
// ---------------------------------------------------------------------------

/**
 * The minimal `Storage` surface this module needs. Structurally satisfied by
 * the DOM `Storage` interface (`localStorage`) and by an in-memory test double.
 * Deliberately wider than {@link MuteStore} because snapshots may be cleared.
 */
export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Options for the persistence functions; the store defaults to `localStorage`. */
export interface PersistenceOptions {
  /** Persistence seam. Defaults to `localStorage` when present, else a no-op. */
  readonly store?: SessionStore;
}

/** Resolve the ambient `localStorage`, or `null` when it is unsafe to touch. */
function resolveDefaultStore(): SessionStore | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Accessing localStorage can throw (sandboxed iframes); treat as absent.
  }
  return null;
}

function resolveStore(opts: PersistenceOptions | undefined): SessionStore | null {
  return opts?.store ?? resolveDefaultStore();
}

// ---------------------------------------------------------------------------
// Snapshot write / read (R1.7)
// ---------------------------------------------------------------------------

/**
 * Persist a session snapshot. Called on every machine transition. Best-effort:
 * a serialisation or storage failure is swallowed so it can never break a
 * transition.
 */
export function saveSnapshot(snap: SessionSnapshot, opts?: PersistenceOptions): void {
  const store = resolveStore(opts);
  if (!store) return;
  try {
    store.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snap));
  } catch {
    // Persistence is best-effort; a write failure must not break the machine.
  }
}

/**
 * Load the persisted snapshot, honouring it ONLY inside the 120-second resume
 * window (R1.7). Returns `null` — meaning "start fresh at SETUP" — when there is
 * no snapshot, the stored value is corrupt or structurally invalid, or its age
 * exceeds {@link RESUME_WINDOW_MS}.
 *
 * @param now Current wall-clock time in ms. Defaults to `Date.now()`; injectable
 *   for deterministic tests.
 */
export function loadSnapshot(now: number = Date.now(), opts?: PersistenceOptions): SessionSnapshot | null {
  const store = resolveStore(opts);
  if (!store) return null;

  let raw: string | null;
  try {
    raw = store.getItem(SNAPSHOT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  const snap = parseSnapshot(raw);
  if (snap === null) return null;

  // Honour the snapshot only within the resume window (R1.7). A negative age
  // (clock skew) is treated as fresh — within window — never as stale.
  if (now - snap.savedAt > RESUME_WINDOW_MS) return null;

  return snap;
}

/** Remove any persisted snapshot (e.g. on an explicit reset). Best-effort. */
export function clearSnapshot(opts?: PersistenceOptions): void {
  const store = resolveStore(opts);
  if (!store) return;
  try {
    store.removeItem(SNAPSHOT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

const VALID_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'SETUP',
  'ARMED',
  'WORKING',
  'REVIEW',
]);

/**
 * Parse and structurally validate a stored snapshot. Returns `null` for any
 * JSON error or shape mismatch — a corrupt entry must never crash the load.
 */
function parseSnapshot(raw: string): SessionSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;

  const obj = value as Record<string, unknown>;
  const state = obj['state'];
  const exerciseId = obj['exerciseId'];
  const set = obj['set'];
  const savedAt = obj['savedAt'];

  if (typeof state !== 'string' || !VALID_STATES.has(state as SessionState)) return null;
  if (!(exerciseId === null || typeof exerciseId === 'string')) return null;
  if (!(set === null || (typeof set === 'object' && set !== null))) return null;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;

  return {
    state: state as SessionState,
    exerciseId: exerciseId as string | null,
    set: set as SessionSnapshot['set'],
    savedAt,
  };
}

// ---------------------------------------------------------------------------
// Mute flags (R3.8) — two independent keys, one source of truth each
// ---------------------------------------------------------------------------

/** Encode a mute flag using the same `'1'`/`'0'` convention as AudioBus. */
function encodeFlag(muted: boolean): string {
  return muted ? '1' : '0';
}

/** Decode a stored flag; anything other than `'1'` is treated as unmuted. */
function decodeFlag(raw: string | null): boolean {
  return raw === '1';
}

function readFlag(store: SessionStore, key: string): boolean {
  try {
    return decodeFlag(store.getItem(key));
  } catch {
    return false;
  }
}

function writeFlag(store: SessionStore, key: string, muted: boolean): void {
  try {
    store.setItem(key, encodeFlag(muted));
  } catch {
    // best-effort
  }
}

/**
 * Load both mute flags (R3.8). The tones flag is read from the AudioBus-owned
 * key ({@link TONE_MUTE_STORAGE_KEY}) so there is one source of truth; the speech
 * flag from {@link SPEECH_MUTE_STORAGE_KEY}. Both default to `false` (unmuted)
 * when absent or unreadable.
 */
export function loadMute(opts?: PersistenceOptions): MuteState {
  const store = resolveStore(opts);
  if (!store) return { tones: false, speech: false };
  return {
    tones: readFlag(store, TONE_MUTE_STORAGE_KEY),
    speech: readFlag(store, SPEECH_MUTE_STORAGE_KEY),
  };
}

/**
 * Persist both mute flags under their separate keys (R3.8) so they toggle
 * independently. Writing tones here is equivalent to `AudioBus.setToneMute`
 * because they share {@link TONE_MUTE_STORAGE_KEY} and encoding.
 */
export function saveMute(m: MuteState, opts?: PersistenceOptions): void {
  const store = resolveStore(opts);
  if (!store) return;
  writeFlag(store, TONE_MUTE_STORAGE_KEY, m.tones);
  writeFlag(store, SPEECH_MUTE_STORAGE_KEY, m.speech);
}
