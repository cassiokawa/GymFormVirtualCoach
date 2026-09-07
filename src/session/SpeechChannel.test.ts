/**
 * Unit tests for SpeechChannel — the Coaching seam's spoken-cue adapter over
 * VoiceCoach.
 *
 * These exercise the seams without a real Web Speech engine, using a fake voice,
 * an in-memory store, and a controllable timer:
 *  - speak routes text to the underlying voice
 *  - a second speak while a cue is in progress is dropped, not queued (R3.6)
 *  - once the busy window elapses, the next cue speaks again (R3.6)
 *  - mute makes speak a no-op and persists (R3.8)
 *  - unmute restores speaking (R3.8)
 *  - a persisted mute survives a reload / fresh session (R3.8)
 *  - a separate storage key from tones (R3.8)
 *
 * Requirements: 3.6, 3.8
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  SpeechChannel,
  SPEECH_MUTE_STORAGE_KEY,
  estimateSpeechDurationMs,
  type VoiceLike,
  type SpeechMuteStore,
  type TimerSeam,
} from './SpeechChannel.js';
import { TONE_MUTE_STORAGE_KEY } from './AudioBus.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A fake VoiceCoach-like engine that records every spoken line. */
function makeFakeVoice(): VoiceLike & { readonly spoken: string[] } {
  const spoken: string[] = [];
  return {
    spoken,
    say(text: string) {
      spoken.push(text);
    },
  };
}

/** An in-memory store so persistence is testable without real localStorage. */
function makeMemoryStore(seed: Record<string, string> = {}): SpeechMuteStore & {
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

/**
 * A manually-driven timer seam. Pending callbacks fire only when `advance` is
 * called, so the busy window is fully deterministic in tests.
 */
function makeFakeTimer(): TimerSeam & { fireAll(): void; readonly pending: number } {
  let handlers: Array<(() => void) | null> = [];
  return {
    set(handler: () => void) {
      handlers.push(handler);
      return handlers.length - 1;
    },
    clear(handle: unknown) {
      const idx = handle as number;
      if (idx >= 0 && idx < handlers.length) handlers[idx] = null;
    },
    fireAll() {
      const snapshot = handlers;
      handlers = [];
      for (const h of snapshot) if (h) h();
    },
    get pending() {
      return handlers.filter((h) => h !== null).length;
    },
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('SpeechChannel routing', () => {
  it('routes a spoken cue through the underlying voice', () => {
    const voice = makeFakeVoice();
    const channel = new SpeechChannel({
      voice,
      store: makeMemoryStore(),
      timer: makeFakeTimer(),
    });
    channel.speak('knees out');
    expect(voice.spoken).toEqual(['knees out']);
  });

  it('ignores empty / whitespace-only cues', () => {
    const voice = makeFakeVoice();
    const channel = new SpeechChannel({
      voice,
      store: makeMemoryStore(),
      timer: makeFakeTimer(),
    });
    channel.speak('');
    channel.speak('   ');
    expect(voice.spoken).toEqual([]);
    expect(channel.isSpeaking()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Overlap suppression (R3.6)
// ---------------------------------------------------------------------------

describe('SpeechChannel overlap suppression (R3.6)', () => {
  it('drops a second cue while the first is in progress', () => {
    const voice = makeFakeVoice();
    const timer = makeFakeTimer();
    const channel = new SpeechChannel({ voice, store: makeMemoryStore(), timer });

    channel.speak('knees out');
    expect(channel.isSpeaking()).toBe(true);
    channel.speak('chest up'); // arrives mid-utterance -> dropped, not queued

    expect(voice.spoken).toEqual(['knees out']);
    // Dropped cue must not have been queued behind the first.
    expect(timer.pending).toBe(1);
  });

  it('speaks the next cue once the busy window elapses', () => {
    const voice = makeFakeVoice();
    const timer = makeFakeTimer();
    const channel = new SpeechChannel({ voice, store: makeMemoryStore(), timer });

    channel.speak('knees out');
    timer.fireAll(); // busy window elapses
    expect(channel.isSpeaking()).toBe(false);

    channel.speak('chest up');
    expect(voice.spoken).toEqual(['knees out', 'chest up']);
  });
});

// ---------------------------------------------------------------------------
// Mute + persistence (R3.8)
// ---------------------------------------------------------------------------

describe('SpeechChannel mute persistence (R3.8)', () => {
  it('defaults to unmuted with an empty store', () => {
    const channel = new SpeechChannel({ voice: makeFakeVoice(), store: makeMemoryStore() });
    expect(channel.isSpeechMuted()).toBe(false);
  });

  it('makes speak a no-op when muted, and persists the flag', () => {
    const voice = makeFakeVoice();
    const store = makeMemoryStore();
    const channel = new SpeechChannel({ voice, store, timer: makeFakeTimer() });

    channel.setSpeechMute(true);
    channel.speak('knees out');

    expect(channel.isSpeechMuted()).toBe(true);
    expect(voice.spoken).toEqual([]);
    expect(store.getItem(SPEECH_MUTE_STORAGE_KEY)).toBe('1');
  });

  it('restores speaking after unmute', () => {
    const voice = makeFakeVoice();
    const channel = new SpeechChannel({
      voice,
      store: makeMemoryStore(),
      timer: makeFakeTimer(),
    });

    channel.setSpeechMute(true);
    channel.speak('dropped while muted');
    channel.setSpeechMute(false);
    channel.speak('now audible');

    expect(voice.spoken).toEqual(['now audible']);
  });

  it('reloads a persisted mute on construction (survives a reload)', () => {
    const store = makeMemoryStore();
    new SpeechChannel({ voice: makeFakeVoice(), store }).setSpeechMute(true);

    // Fresh session with the same backing store.
    const reloaded = new SpeechChannel({ voice: makeFakeVoice(), store });
    expect(reloaded.isSpeechMuted()).toBe(true);
  });

  it('round-trips unmute back to storage across a reload', () => {
    const store = makeMemoryStore({ [SPEECH_MUTE_STORAGE_KEY]: '1' });
    const channel = new SpeechChannel({ voice: makeFakeVoice(), store });
    expect(channel.isSpeechMuted()).toBe(true);

    channel.setSpeechMute(false);
    expect(store.getItem(SPEECH_MUTE_STORAGE_KEY)).toBe('0');
    expect(new SpeechChannel({ voice: makeFakeVoice(), store }).isSpeechMuted()).toBe(false);
  });

  it('uses a storage key separate from the tones channel (R3.8)', () => {
    expect(SPEECH_MUTE_STORAGE_KEY).not.toBe(TONE_MUTE_STORAGE_KEY);

    const store = makeMemoryStore();
    const channel = new SpeechChannel({ voice: makeFakeVoice(), store });
    channel.setSpeechMute(true);

    // Muting speech must not touch the tones key.
    expect(store.getItem(TONE_MUTE_STORAGE_KEY)).toBeNull();
    expect(store.getItem(SPEECH_MUTE_STORAGE_KEY)).toBe('1');
  });

  it('clears any in-progress window when muted', () => {
    const voice = makeFakeVoice();
    const timer = makeFakeTimer();
    const channel = new SpeechChannel({ voice, store: makeMemoryStore(), timer });

    channel.speak('knees out');
    expect(channel.isSpeaking()).toBe(true);
    channel.setSpeechMute(true);
    expect(channel.isSpeaking()).toBe(false);
    expect(timer.pending).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Duration estimate
// ---------------------------------------------------------------------------

describe('estimateSpeechDurationMs', () => {
  it('is at least the minimum window for a short cue', () => {
    expect(estimateSpeechDurationMs('go')).toBeGreaterThanOrEqual(500);
  });

  it('grows with word count', () => {
    const short = estimateSpeechDurationMs('knees out');
    const long = estimateSpeechDurationMs('keep your chest up and your knees tracking outward now');
    expect(long).toBeGreaterThan(short);
  });
});
