/**
 * VoiceCoach — real-time spoken cues during a workout using the Web Speech API.
 *
 * Announces exercise setup, framing warnings, rep counts, form deviations,
 * tips, time-under-tension, and rest recommendations. All speech is
 * client-side (speechSynthesis) — no network, no cost, works offline.
 *
 * Queue-based: messages are queued and spoken one at a time so they don't
 * overlap. High-priority messages (safety warnings) interrupt the queue.
 */

/** Priority levels. Higher interrupts lower. */
export type VoicePriority = 'low' | 'normal' | 'high' | 'critical';

export interface VoiceCoachOptions {
  /** Speech rate (0.5-2.0). Default 1.1 for a natural pace. */
  rate?: number;
  /** Speech pitch (0-2). Default 1.0. */
  pitch?: number;
  /** Preferred voice name substring (e.g. "Samantha", "Google"). */
  preferredVoice?: string;
  /** Whether the coach is initially enabled. Default true. */
  enabled?: boolean;
}

/** A queued speech item. */
interface QueueItem {
  text: string;
  priority: VoicePriority;
}

const PRIORITY_RANK: Record<VoicePriority, number> = { low: 0, normal: 1, high: 2, critical: 3 };

/**
 * Minimum interval (ms) between two spoken messages of the same type to avoid
 * spam (e.g. repeated form warnings every frame).
 */
const DEBOUNCE_MS = 3500;

export class VoiceCoach {
  private enabled: boolean;
  private readonly rate: number;
  private readonly pitch: number;
  private readonly preferredVoice: string;
  private voice: SpeechSynthesisVoice | null = null;
  private speaking = false;
  private queue: QueueItem[] = [];
  private readonly lastSpoken = new Map<string, number>();

  constructor(opts: VoiceCoachOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.rate = opts.rate ?? 1.1;
    this.pitch = opts.pitch ?? 1.0;
    this.preferredVoice = opts.preferredVoice ?? '';
    this.pickVoice();
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.addEventListener('voiceschanged', () => this.pickVoice());
    }
  }

  /** Whether TTS is supported in this browser. */
  static isSupported(): boolean {
    return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  setEnabled(on: boolean): void { this.enabled = on; }
  isEnabled(): boolean { return this.enabled; }

  // --- Public announce methods -----------------------------------------------

  /** Announce exercise setup instructions at session start. */
  announceExerciseSetup(exerciseName: string, steps: string[], cameraAngle: string): void {
    const intro = 'Starting ' + exerciseName.replace(/_/g, ' ') + '. ';
    const angle = cameraAngle === 'side' ? 'Position your camera to the side. ' :
      cameraAngle === 'front' ? 'Position camera in front of you. ' : '';
    const stepsText = steps.length > 0 ? steps.join('. ') + '.' : '';
    this.say(intro + angle + stepsText, 'normal');
  }

  /** Warn about framing issues (body not fully visible). */
  announceFramingWarning(message: string): void {
    this.sayDebounced('framing', message, 'high');
  }

  /** Count a completed rep. */
  announceRep(repNumber: number): void {
    this.say(String(repNumber), 'normal');
  }

  /** Critical form / safety warning. Interrupts everything. */
  announceDangerousForm(jointName: string, message: string): void {
    const text = 'Warning! ' + jointName.replace(/_/g, ' ') + ': ' + message;
    this.sayDebounced('danger_' + jointName, text, 'critical');
  }

  /** Form tip after a rep. */
  announceFormTip(tip: string): void {
    this.sayDebounced('tip', tip, 'low');
  }

  /** Time under tension callout after a rep. */
  announceTut(tutMs: number): void {
    const secs = (tutMs / 1000).toFixed(1);
    this.say(secs + ' seconds', 'low');
  }

  /** Recommend rest after a set. */
  announceRest(restSeconds: number): void {
    this.say('Good set! Rest for ' + restSeconds + ' seconds.', 'normal');
  }

  /** Announce session start with a motivational cue. */
  announceSessionStart(): void {
    this.say("Let's go! I'll count your reps and watch your form.", 'normal');
  }

  /** Announce session end. */
  announceSessionEnd(totalReps: number): void {
    this.say('Session complete. ' + totalReps + ' reps total. Great work!', 'normal');
  }

  /** Generic announcement. */
  say(text: string, priority: VoicePriority = 'normal'): void {
    if (!this.enabled || !VoiceCoach.isSupported()) return;
    const item: QueueItem = { text, priority };

    if (PRIORITY_RANK[priority] >= PRIORITY_RANK['critical']) {
      // Critical: interrupt current speech.
      speechSynthesis.cancel();
      this.speaking = false;
      this.queue.unshift(item);
    } else {
      this.queue.push(item);
    }
    this.processQueue();
  }

  /** Stop all queued and current speech. */
  stop(): void {
    this.queue = [];
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.speaking = false;
  }

  // --- Private ---------------------------------------------------------------

  private sayDebounced(key: string, text: string, priority: VoicePriority): void {
    const now = Date.now();
    const last = this.lastSpoken.get(key) ?? 0;
    if (now - last < DEBOUNCE_MS) return;
    this.lastSpoken.set(key, now);
    this.say(text, priority);
  }

  private processQueue(): void {
    if (this.speaking || this.queue.length === 0) return;
    const item = this.queue.shift()!;
    this.speaking = true;

    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.rate = this.rate;
    utterance.pitch = this.pitch;
    if (this.voice) utterance.voice = this.voice;
    utterance.onend = () => { this.speaking = false; this.processQueue(); };
    utterance.onerror = () => { this.speaking = false; this.processQueue(); };
    speechSynthesis.speak(utterance);
  }

  private pickVoice(): void {
    if (typeof speechSynthesis === 'undefined') return;
    const voices = speechSynthesis.getVoices();
    if (voices.length === 0) return;
    if (this.preferredVoice) {
      const pref = voices.find((v) => v.name.includes(this.preferredVoice));
      if (pref) { this.voice = pref; return; }
    }
    const english = voices.filter((v) => v.lang.startsWith('en'));
    const local = english.find((v) => v.localService);
    this.voice = local ?? english[0] ?? voices[0] ?? null;
  }
}
