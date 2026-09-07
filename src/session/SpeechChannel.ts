/**
 * SpeechChannel — the Coaching seam's spoken-cue channel.
 *
 * The user is 3 metres from the screen and cannot touch it mid-set, so feedback
 * is audio-first. {@link AudioBus} owns the synthesised-tone half of that
 * channel; this module owns the SPOKEN half. It is a thin Coaching-owned adapter
 * over the existing {@link VoiceCoach} (`src/voice/VoiceCoach.ts`) — it wraps the
 * queue-based Web Speech engine, it does NOT reimplement text-to-speech.
 *
 * ## What this adapter adds on top of VoiceCoach
 *
 * `VoiceCoach` already does the hard TTS work: voice selection, a priority
 * queue, critical-priority interrupts, per-key debouncing, and offline
 * `speechSynthesis` playback. This channel exists to enforce two Coaching-seam
 * rules the raw engine does not:
 *
 * 1. **Overlap suppression (R3.6).** WHILE a spoken cue is in progress, any
 *    subsequent spoken cue is DROPPED — not queued behind it. The cue rationer
 *    (task 5.1) already limits cues to one per rep; this is the second guard
 *    that stops a late cue from a fast rep stacking on top of the previous one.
 *    We deliberately do NOT lean on `VoiceCoach`'s queue for this: the queue
 *    would speak the backlog eventually, which is exactly the stale-cue pileup
 *    R3.6 forbids. Dropping is correct — a cue that arrives while another is
 *    speaking is already out of date for a movement happening now.
 *
 *    Crucially this concerns the SPOKEN cue only. It has NO bearing on rep tones
 *    (those are {@link AudioBus.repTone}, a separate channel); a rep is always
 *    confirmed by its tone regardless of speech state (R3.6, `coaching-safety.md`).
 *
 * 2. **Independent, persisted speech mute (R3.8).** Speech mutes separately from
 *    tones, under its OWN storage key ({@link SPEECH_MUTE_STORAGE_KEY}), and the
 *    flag survives across sessions. When muted, {@link SpeechChannel.speak} is a
 *    no-op.
 *
 * ## Tracking "in progress" without an onend hook
 *
 * `VoiceCoach` does not expose its speaking state or an utterance `onend`
 * callback (`speaking` is private, and `say()` returns `void`). Rather than
 * reach into its internals or fork it, this channel tracks in-progress state
 * itself: on a routed `speak` it sets a busy flag and arms a timer for the
 * estimated spoken duration; when the timer fires the flag clears and the next
 * cue may be spoken. The duration is estimated from the text length at a
 * conservative speaking rate (see {@link estimateSpeechDurationMs}). An estimate
 * is acceptable here because the window only needs to cover the typical
 * ≤ 4-word cue; erring slightly long simply drops one extra near-simultaneous
 * cue, which is the safe direction for R3.6.
 *
 * The clock and timer are injectable seams so the busy window is unit-testable
 * with fake timers and without a real Web Speech engine.
 *
 * Requirements: 3.6, 3.8
 */

/**
 * The persisted-flag key for the SPEECH channel only. It is SEPARATE from the
 * tones key ({@link AudioBus.TONE_MUTE_STORAGE_KEY}, `'gym-coach-mute-tones'`)
 * so the two channels mute independently (R3.8).
 *
 * This is the single authoritative speech-mute key for the app. Session
 * persistence (task 3.1) MUST reuse this exported constant rather than
 * re-declare the literal, so there is exactly one key and the flags cannot
 * drift apart.
 */
export const SPEECH_MUTE_STORAGE_KEY = 'gym-coach-mute-speech';

/**
 * The slice of {@link VoiceCoach} this channel depends on: a single method to
 * speak a line. Declaring the seam as a structural interface (rather than the
 * concrete class) keeps the channel unit-testable without the Web Speech API
 * and honours the dependency rule — Coaching depends on a contract, not on
 * `speechSynthesis` internals. The real {@link VoiceCoach} satisfies this
 * structurally via its `say(text, priority?)` method.
 */
export interface VoiceLike {
  /** Speak a line. The concrete VoiceCoach accepts an optional priority we don't need here. */
  say(text: string): void;
}

/**
 * A minimal `Storage` seam so the mute flag can be unit-tested with an in-memory
 * store and runs without throwing where `localStorage` is unavailable (private
 * mode, SSR). Structurally satisfied by the DOM `Storage` interface. Mirrors the
 * `MuteStore` seam used by {@link AudioBus} so both channels share one shape.
 */
export interface SpeechMuteStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A timer seam: schedule a callback after `ms`, and cancel a pending one. */
export interface TimerSeam {
  set(handler: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/**
 * Words-per-minute used to estimate how long a cue takes to speak. Chosen a
 * touch slower than a typical TTS rate so the busy window errs LONG — the safe
 * direction for R3.6, where over-suppressing a near-simultaneous cue is better
 * than letting two overlap.
 */
const ESTIMATE_WPM = 150;

/** A floor on the busy window so even a one-word cue holds the channel briefly. */
const MIN_SPEECH_MS = 500;

/**
 * Estimate the spoken duration of `text` in milliseconds from its word count at
 * {@link ESTIMATE_WPM}, clamped to at least {@link MIN_SPEECH_MS}. Pure.
 */
export function estimateSpeechDurationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0).length;
  const ms = (words / ESTIMATE_WPM) * 60_000;
  return Math.max(MIN_SPEECH_MS, Math.round(ms));
}

/** Resolve the best available persistence store, or `null` if none is safe to use. */
function resolveDefaultStore(): SpeechMuteStore | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Accessing localStorage can throw (e.g. sandboxed iframes); treat as absent.
  }
  return null;
}

/** Resolve a default timer seam over the global `setTimeout`/`clearTimeout`. */
function resolveDefaultTimer(): TimerSeam {
  return {
    set: (handler, ms) => setTimeout(handler, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/** Options for {@link SpeechChannel}. `voice` is required; the rest have defaults. */
export interface SpeechChannelOptions {
  /** The VoiceCoach-like engine spoken cues are routed to. */
  readonly voice: VoiceLike;
  /** Persistence seam for the speech-mute flag. Defaults to `localStorage` when present. */
  readonly store?: SpeechMuteStore;
  /** Timer seam for the in-progress window. Defaults to `setTimeout`/`clearTimeout`. */
  readonly timer?: TimerSeam;
  /**
   * Override the busy-window duration estimator, primarily for tests. Defaults
   * to {@link estimateSpeechDurationMs}.
   */
  readonly estimateDurationMs?: (text: string) => number;
}

/**
 * The Coaching-owned spoken-cue channel: an overlap-suppressing, independently
 * mutable adapter over {@link VoiceCoach}. Construction never throws and never
 * touches the Web Speech API directly.
 */
export class SpeechChannel {
  private readonly voice: VoiceLike;
  private readonly store: SpeechMuteStore | null;
  private readonly timer: TimerSeam;
  private readonly estimateDurationMs: (text: string) => number;

  /** In-memory mirror of the persisted speech-mute flag, seeded from storage. */
  private speechMuted: boolean;
  /** True while a routed cue is within its estimated speaking window (R3.6). */
  private speaking = false;
  /** Handle for the pending busy-window timer, or `null` when idle. */
  private busyTimer: unknown = null;

  constructor(opts: SpeechChannelOptions) {
    this.voice = opts.voice;
    this.store = opts.store ?? resolveDefaultStore();
    this.timer = opts.timer ?? resolveDefaultTimer();
    this.estimateDurationMs = opts.estimateDurationMs ?? estimateSpeechDurationMs;
    this.speechMuted = this.readPersistedMute();
  }

  /**
   * Route a spoken cue through the underlying voice, enforcing R3.6 and R3.8.
   *
   * Dropped (no-op) when: the channel is muted (R3.8), the text is empty, OR a
   * previous cue is still within its speaking window (R3.6 — the new cue is
   * discarded, NOT queued). Otherwise the cue is spoken and the busy window is
   * armed for its estimated duration.
   *
   * Never touches tones — {@link AudioBus.repTone} is a separate channel and is
   * unaffected by anything here (R3.6).
   */
  speak(text: string): void {
    if (this.speechMuted) return;
    if (text.trim().length === 0) return;
    // R3.6: a cue arriving while another is in progress is dropped, not queued.
    if (this.speaking) return;

    this.speaking = true;
    this.voice.say(text);

    const windowMs = this.estimateDurationMs(text);
    this.busyTimer = this.timer.set(() => {
      this.speaking = false;
      this.busyTimer = null;
    }, windowMs);
  }

  /** Whether a routed cue is currently within its speaking window (R3.6). */
  isSpeaking(): boolean {
    return this.speaking;
  }

  /**
   * Mute or unmute the SPEECH channel and persist the flag across sessions
   * (R3.8). Muting also ends any in-progress busy window so a later unmute does
   * not inherit a stale "speaking" state.
   */
  setSpeechMute(muted: boolean): void {
    this.speechMuted = muted;
    if (muted) {
      this.clearBusyWindow();
    }
    if (!this.store) return;
    try {
      this.store.setItem(SPEECH_MUTE_STORAGE_KEY, muted ? '1' : '0');
    } catch {
      // Persistence is best-effort; a write failure must not break speech.
    }
  }

  /** Whether the speech channel is currently muted (seeded from persisted state). */
  isSpeechMuted(): boolean {
    return this.speechMuted;
  }

  // --- Internals ------------------------------------------------------------

  /** Read the persisted speech-mute flag; defaults to unmuted when absent/unreadable. */
  private readPersistedMute(): boolean {
    if (!this.store) return false;
    try {
      return this.store.getItem(SPEECH_MUTE_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  /** Cancel any pending busy-window timer and clear the in-progress flag. */
  private clearBusyWindow(): void {
    if (this.busyTimer !== null) {
      this.timer.clear(this.busyTimer);
      this.busyTimer = null;
    }
    this.speaking = false;
  }
}
