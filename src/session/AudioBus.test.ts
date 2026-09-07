/**
 * Unit tests for AudioBus — the Coaching seam's synthesised-tone channel.
 *
 * These exercise the seams that do NOT require a real Web Audio context:
 *  - tone specs are pairwise acoustically distinct (freq/duration differ)
 *  - the tones-channel mute flag persists to and reloads from storage (R3.8)
 *  - haptics no-op when the vibration API is absent (R3.7)
 *  - construction and every method are safe no-ops without an AudioContext
 *
 * Requirements: 3.1, 3.2, 3.3, 3.7, 3.8
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AudioBus,
  TONE_SPECS,
  TONE_MUTE_STORAGE_KEY,
  type MuteStore,
  type ToneName,
  type ToneSpec,
} from './AudioBus.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An in-memory MuteStore so persistence is testable without real localStorage. */
function makeMemoryStore(seed: Record<string, string> = {}): MuteStore & {
  readonly map: Map<string, string>;
} {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

/** A stable, order-independent signature of a tone's frequency content. */
function freqSignature(spec: ToneSpec): string {
  return [...spec.frequencies].sort((a, b) => a - b).join(',');
}

const ALL_TONES: ToneName[] = ['rep', 'cue', 'terminal', 'countdown', 'readiness'];

// ---------------------------------------------------------------------------
// Tone distinctness (R3.1, R3.2, R3.3)
// ---------------------------------------------------------------------------

describe('AudioBus tone specs — pairwise distinctness', () => {
  it('defines a spec for every tone', () => {
    for (const name of ALL_TONES) {
      expect(TONE_SPECS[name]).toBeDefined();
      expect(TONE_SPECS[name].frequencies.length).toBeGreaterThan(0);
      expect(TONE_SPECS[name].durationMs).toBeGreaterThan(0);
    }
  });

  it('every pair of tones differs in duration or frequency content', () => {
    for (let i = 0; i < ALL_TONES.length; i++) {
      for (let j = i + 1; j < ALL_TONES.length; j++) {
        const a = TONE_SPECS[ALL_TONES[i]!]!;
        const b = TONE_SPECS[ALL_TONES[j]!]!;
        const differ = a.durationMs !== b.durationMs || freqSignature(a) !== freqSignature(b);
        expect(differ, `${ALL_TONES[i]} vs ${ALL_TONES[j]} must be distinct`).toBe(true);
      }
    }
  });

  it('rep, cue and terminal are mutually distinguishable (R3.1/R3.2/R3.3)', () => {
    const rep = TONE_SPECS.rep;
    const cue = TONE_SPECS.cue;
    const terminal = TONE_SPECS.terminal;

    // rep is higher than cue (R3.2: cue is a distinct LOWER tone).
    expect(Math.max(...rep.frequencies)).toBeGreaterThan(Math.max(...cue.frequencies));
    // terminal is a chord (multiple simultaneous frequencies), the others are pure tones.
    expect(terminal.frequencies.length).toBeGreaterThan(1);
    expect(rep.frequencies.length).toBe(1);
    expect(cue.frequencies.length).toBe(1);
    // all three have distinct durations.
    const durations = new Set([rep.durationMs, cue.durationMs, terminal.durationMs]);
    expect(durations.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Mute persistence (R3.8)
// ---------------------------------------------------------------------------

describe('AudioBus tone mute persistence', () => {
  it('defaults to unmuted with an empty store', () => {
    const bus = new AudioBus({ store: makeMemoryStore() });
    expect(bus.isToneMuted()).toBe(false);
  });

  it('persists the mute flag to storage', () => {
    const store = makeMemoryStore();
    const bus = new AudioBus({ store });
    bus.setToneMute(true);
    expect(bus.isToneMuted()).toBe(true);
    expect(store.getItem(TONE_MUTE_STORAGE_KEY)).toBe('1');
  });

  it('reloads a persisted mute flag on construction (survives a session)', () => {
    const store = makeMemoryStore();
    new AudioBus({ store }).setToneMute(true);
    // Simulate a fresh session with the same backing store.
    const reloaded = new AudioBus({ store });
    expect(reloaded.isToneMuted()).toBe(true);
  });

  it('round-trips unmute back to storage', () => {
    const store = makeMemoryStore({ [TONE_MUTE_STORAGE_KEY]: '1' });
    const bus = new AudioBus({ store });
    expect(bus.isToneMuted()).toBe(true);
    bus.setToneMute(false);
    expect(bus.isToneMuted()).toBe(false);
    expect(store.getItem(TONE_MUTE_STORAGE_KEY)).toBe('0');
    expect(new AudioBus({ store }).isToneMuted()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Haptics (R3.7)
// ---------------------------------------------------------------------------

describe('AudioBus haptics', () => {
  it('calls the vibration API when present', () => {
    const vibrate = vi.fn(() => true);
    const bus = new AudioBus({ store: makeMemoryStore(), vibrate });
    bus.haptic();
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('no-ops (does not throw) when the vibration API is absent', () => {
    // jsdom has no navigator.vibrate; construct without an override.
    const bus = new AudioBus({ store: makeMemoryStore() });
    expect(() => bus.haptic()).not.toThrow();
  });

  it('swallows vibration errors', () => {
    const vibrate = vi.fn(() => {
      throw new Error('gesture required');
    });
    const bus = new AudioBus({ store: makeMemoryStore(), vibrate });
    expect(() => bus.haptic()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation without a real AudioContext (jsdom)
// ---------------------------------------------------------------------------

describe('AudioBus without Web Audio', () => {
  beforeEach(() => {
    // jsdom does not implement AudioContext; assert our assumption holds.
    expect(typeof (globalThis as { AudioContext?: unknown }).AudioContext).toBe('undefined');
  });

  it('reports Web Audio as unsupported', () => {
    expect(AudioBus.isSupported()).toBe(false);
  });

  it('construction does not throw', () => {
    expect(() => new AudioBus({ store: makeMemoryStore() })).not.toThrow();
  });

  it('every tone method is a safe no-op', () => {
    const bus = new AudioBus({ store: makeMemoryStore() });
    expect(() => {
      bus.repTone();
      bus.cueTone();
      bus.terminalChord();
      bus.countdownTick();
      bus.readinessTone();
    }).not.toThrow();
  });

  it('mute still works and persists without an AudioContext', () => {
    const store = makeMemoryStore();
    const bus = new AudioBus({ store });
    bus.setToneMute(true);
    expect(bus.isToneMuted()).toBe(true);
    expect(store.getItem(TONE_MUTE_STORAGE_KEY)).toBe('1');
  });
});
