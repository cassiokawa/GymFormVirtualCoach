/**
 * AudioBus — the Coaching seam's synthesised-tone channel.
 *
 * The user is 3 metres from the screen and cannot touch it mid-set, so all
 * feedback is audio-first. This module owns the non-speech half of that
 * channel: short synthesised tones for rep counts, cues, set end, the armed
 * countdown, and framing readiness, plus an optional haptic pulse. Spoken cues
 * are a separate concern owned by the SpeechChannel (task 4.3); this module
 * never speaks.
 *
 * ## Why Web Audio (latency, R3.1)
 *
 * A counted rep must be confirmed by a tone within 120 ms of `RepCompleted` at
 * p95. Scheduled oscillator playback through the Web Audio API has far lower and
 * more predictable latency than `<audio>` media-element playback, which must
 * fetch/decode and is subject to media-pipeline jitter. To keep the rep-tone
 * path cheap:
 *
 * - A SINGLE {@link AudioContext} is created lazily and reused for every tone —
 *   there is no per-call context construction (context creation is expensive and
 *   is rate-limited by some browsers).
 * - `resume()` is attempted on first use, because browsers start an
 *   `AudioContext` suspended until a user gesture; the ARMED countdown / start
 *   action provides that gesture before WORKING begins.
 * - Each tone allocates only a throwaway `OscillatorNode` + `GainNode` (the Web
 *   Audio API gives no way to avoid this), schedules an envelope, and lets the
 *   nodes be garbage-collected on `onended`. No buffers are decoded, no fetches
 *   happen, nothing is retained frame-to-frame.
 *
 * ## Distinct, acoustically-distinguishable sounds (R3.1–R3.3)
 *
 * Every sound has a disjoint frequency/duration profile so it is identifiable by
 * ear from across a room, without looking at the screen. See {@link TONE_SPECS}.
 * These are TONES, not praise — no words, no melody that reads as celebration
 * (`coaching-safety.md`: a counted rep is confirmed by a tone, not by "great
 * job").
 *
 * ## Mute persistence (R3.8)
 *
 * The tones channel has its own persisted mute flag under a dedicated
 * localStorage key, independent of the speech channel's mute (owned by the
 * SpeechChannel). Muting tones survives across sessions.
 *
 * ## Degrades gracefully without Web Audio
 *
 * In jsdom / SSR / browsers without Web Audio, construction and every method are
 * safe no-ops. The tone-spec map and mute persistence are pure data and work
 * without an `AudioContext`, which is the seam unit tests exercise.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.7, 3.8
 */

/**
 * The persisted-flag key for the TONES channel only. The speech channel keeps
 * its own separate key (task 4.3) so the two mute independently (R3.8).
 */
export const TONE_MUTE_STORAGE_KEY = 'gym-coach-mute-tones';

/**
 * The five synthesised sounds this bus can emit.
 *
 * - `rep`        — a counted rep (R3.1): short, higher.
 * - `cue`        — precedes a spoken cue (R3.2): distinct, lower.
 * - `terminal`   — set end (R3.3): a chord, distinct from both.
 * - `countdown`  — one tick of the ARMED 5-second countdown.
 * - `readiness`  — framing satisfied, ready to start (R4.5).
 */
export type ToneName = 'rep' | 'cue' | 'terminal' | 'countdown' | 'readiness';

/**
 * The acoustic profile of one sound: the oscillator frequencies that sound
 * together and how long the whole thing lasts. A single frequency is a pure
 * tone; multiple frequencies form a chord.
 *
 * The profiles are chosen to be *pairwise distinct* in both frequency and
 * duration so the sounds cannot be confused by ear:
 *
 * | Sound     | Frequencies (Hz)     | Duration (ms) | Character                 |
 * |-----------|----------------------|---------------|---------------------------|
 * | rep       | 880                  | 90            | short, high — quick pip   |
 * | cue       | 440                  | 160           | lower, longer — attention |
 * | terminal  | 523.25 / 659.25 / 784| 420           | major chord — set done    |
 * | countdown | 660                  | 70            | mid, very short — tick    |
 * | readiness | 587.33 / 880         | 260           | rising two-note — ready   |
 *
 * `type` is the oscillator waveform; `sine` keeps the tones clean and
 * non-harsh (this is coaching, not an alarm).
 */
export interface ToneSpec {
  /** The frequencies (Hz) sounded simultaneously; one entry = pure tone, more = chord. */
  readonly frequencies: readonly number[];
  /** Total duration of the sound, in milliseconds. */
  readonly durationMs: number;
  /** Oscillator waveform. */
  readonly type: OscillatorType;
  /** Peak gain for the envelope (0–1), kept modest so tones are pleasant. */
  readonly peakGain: number;
}

/**
 * The canonical, disjoint tone specifications. Exported as a seam so tone
 * distinctness can be unit-tested without a real `AudioContext`.
 *
 * INVARIANT (tested): for any two distinct sounds, either their duration or
 * their (multiset of) frequencies differ — they are never acoustically
 * identical.
 */
export const TONE_SPECS: Readonly<Record<ToneName, ToneSpec>> = {
  rep: { frequencies: [880], durationMs: 90, type: 'sine', peakGain: 0.22 },
  cue: { frequencies: [440], durationMs: 160, type: 'sine', peakGain: 0.22 },
  terminal: {
    frequencies: [523.25, 659.25, 783.99],
    durationMs: 420,
    type: 'sine',
    peakGain: 0.16,
  },
  countdown: { frequencies: [660], durationMs: 70, type: 'sine', peakGain: 0.2 },
  readiness: { frequencies: [587.33, 880], durationMs: 260, type: 'sine', peakGain: 0.2 },
};

/**
 * A minimal `Storage` seam so the bus can be unit-tested with an in-memory store
 * and runs without throwing where `localStorage` is unavailable (private mode,
 * SSR). Structurally satisfied by the DOM `Storage` interface.
 */
export interface MuteStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The constructor `AudioContext` shape we need, without depending on the DOM lib at runtime. */
type AudioContextCtor = new () => AudioContext;

/**
 * Resolve an `AudioContext` constructor if Web Audio is available, else `null`.
 * Feature-detects both the standard and the webkit-prefixed names.
 */
function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof globalThis === 'undefined') return null;
  const g = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** Resolve the best available persistence store, or `null` if none is safe to use. */
function resolveDefaultStore(): MuteStore | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Accessing localStorage can throw (e.g. sandboxed iframes); treat as absent.
  }
  return null;
}

/** Options for {@link AudioBus}, all optional; sensible defaults are used. */
export interface AudioBusOptions {
  /** Persistence seam for the tone-mute flag. Defaults to `localStorage` when present. */
  readonly store?: MuteStore;
  /**
   * Override for the vibration function, primarily for tests. Defaults to
   * `navigator.vibrate` bound to `navigator` where available.
   */
  readonly vibrate?: (pattern: number | number[]) => boolean;
}

/**
 * The synthesised-tone + haptic channel of the Coaching seam.
 *
 * Construction never throws and never touches audio hardware; the
 * `AudioContext` is created lazily on the first tone request that follows a user
 * gesture. Where Web Audio is absent every tone method is a safe no-op, so the
 * class is usable (and testable) in jsdom.
 */
export class AudioBus {
  private readonly ctxCtor: AudioContextCtor | null;
  private readonly store: MuteStore | null;
  private readonly vibrateFn: ((pattern: number | number[]) => boolean) | null;

  /** Lazily-created, reused `AudioContext`. Created once, on first sounded tone. */
  private ctx: AudioContext | null = null;
  /** In-memory mirror of the persisted tone-mute flag, seeded from storage. */
  private tonesMuted: boolean;

  constructor(opts: AudioBusOptions = {}) {
    this.ctxCtor = resolveAudioContextCtor();
    this.store = opts.store ?? resolveDefaultStore();
    this.vibrateFn = opts.vibrate ?? resolveDefaultVibrate();
    this.tonesMuted = this.readPersistedMute();
  }

  /** Whether synthesised tones can be produced in this environment. */
  static isSupported(): boolean {
    return resolveAudioContextCtor() !== null;
  }

  // --- Sounds ---------------------------------------------------------------

  /** A counted rep: short, high tone within 120 ms of `RepCompleted` (R3.1). */
  repTone(): void {
    this.play('rep');
  }

  /** Precedes a spoken cue: distinct lower tone, acoustically unlike the rep tone (R3.2). */
  cueTone(): void {
    this.play('cue');
  }

  /** Set end: a chord distinct from both the rep and cue tones (R3.3). */
  terminalChord(): void {
    this.play('terminal');
  }

  /** One tick of the ARMED 5-second countdown. */
  countdownTick(): void {
    this.play('countdown');
  }

  /** Framing satisfied and ready to start (R4.5). */
  readinessTone(): void {
    this.play('readiness');
  }

  // --- Haptics (R3.7) -------------------------------------------------------

  /**
   * Emit a short haptic pulse where the device exposes a vibration API (R3.7).
   * A no-op — never throws — where vibration is unavailable.
   */
  haptic(): void {
    if (!this.vibrateFn) return;
    try {
      this.vibrateFn(30);
    } catch {
      // Some environments expose vibrate but reject calls without a gesture; ignore.
    }
  }

  // --- Tone mute (R3.8) -----------------------------------------------------

  /** Mute or unmute the TONES channel and persist the flag across sessions (R3.8). */
  setToneMute(muted: boolean): void {
    this.tonesMuted = muted;
    if (!this.store) return;
    try {
      this.store.setItem(TONE_MUTE_STORAGE_KEY, muted ? '1' : '0');
    } catch {
      // Persistence is best-effort; a write failure must not break audio.
    }
  }

  /** Whether the tones channel is currently muted (seeded from persisted state). */
  isToneMuted(): boolean {
    return this.tonesMuted;
  }

  // --- Internals ------------------------------------------------------------

  /** Read the persisted tone-mute flag; defaults to unmuted when absent/unreadable. */
  private readPersistedMute(): boolean {
    if (!this.store) return false;
    try {
      return this.store.getItem(TONE_MUTE_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  /**
   * Lazily create/reuse the single `AudioContext`, resuming it if a prior
   * gesture left it suspended. Returns `null` when Web Audio is unavailable.
   */
  private ensureContext(): AudioContext | null {
    if (!this.ctxCtor) return null;
    if (!this.ctx) {
      try {
        this.ctx = new this.ctxCtor();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') {
      // resume() returns a promise; we don't await it — a rep tone scheduled
      // fractionally early is inaudible, and blocking the hot path is worse.
      void this.ctx.resume().catch(() => undefined);
    }
    return this.ctx;
  }

  /**
   * Synthesise one sound from its spec. Cheap by design: no fetch, no decode,
   * only a throwaway oscillator + gain envelope that self-disposes. A no-op when
   * tones are muted (R3.8) or Web Audio is unavailable.
   */
  private play(name: ToneName): void {
    if (this.tonesMuted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const spec = TONE_SPECS[name];
    const now = ctx.currentTime;
    const durationS = spec.durationMs / 1000;

    // One shared gain node carries the amplitude envelope for the whole sound;
    // each frequency in a chord gets its own oscillator into that gain.
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    // Short attack + exponential release so tones don't click and don't ring.
    const attackS = 0.008;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(spec.peakGain, now + attackS);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationS);

    const oscillators: OscillatorNode[] = [];
    for (const frequency of spec.frequencies) {
      const osc = ctx.createOscillator();
      osc.type = spec.type;
      osc.frequency.setValueAtTime(frequency, now);
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + durationS);
      oscillators.push(osc);
    }

    // Dispose the graph once the sound finishes so nothing is retained.
    const last = oscillators[oscillators.length - 1];
    if (last) {
      last.onended = () => {
        for (const osc of oscillators) {
          try {
            osc.disconnect();
          } catch {
            // already disconnected
          }
        }
        try {
          gain.disconnect();
        } catch {
          // already disconnected
        }
      };
    }
  }
}

/** Resolve `navigator.vibrate` bound to `navigator`, or `null` when unavailable. */
function resolveDefaultVibrate(): ((pattern: number | number[]) => boolean) | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as Navigator & { vibrate?: (pattern: number | number[]) => boolean };
  if (typeof nav.vibrate !== 'function') return null;
  return (pattern: number | number[]): boolean => nav.vibrate!(pattern);
}
