/**
 * Integration test for the CoachController end-to-end event loop (Task 12.1).
 *
 * Drives the full session over a MOCK AnalysisEventSource — no live camera:
 *   SETUP → (framing ok) → START → 5 s countdown → WORKING
 *        → feed N RepCompleted (assert rep count, ONE cue per rep, rep tones)
 *        → 8 s no-motion stall → REVIEW (assert the SetRecord is shown).
 *
 * Uses a spy AudioBus (no Web Audio), an in-memory persistence store (no real
 * localStorage), a spy voice, and fake timers so both the ArmedSurface countdown
 * and the controller's 8 s no-motion clock are deterministic.
 *
 * Requirements: 1.2, 1.4, 1.5, 3.1, 5.3
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoachController, type CoachAudio } from './CoachController';
import { ManualEventSource } from './demoEventSource';
import type { FramingVerdict } from './types';
import type { SessionStore } from './persistence';
import type { DomainEvent, FaultSeverity } from '../domain/analysis/types';

/** A verdict that satisfies every framing sub-check (R4.5). */
const OK_VERDICT: FramingVerdict = {
  ok: true,
  missingLandmarks: [],
  angleCorrection: null,
  distance: 'ok',
  distanceHintMetres: null,
};

/** A spy AudioBus that only counts calls; satisfies {@link CoachAudio}. */
function makeAudioSpy(): CoachAudio & {
  repTone: ReturnType<typeof vi.fn>;
  cueTone: ReturnType<typeof vi.fn>;
  terminalChord: ReturnType<typeof vi.fn>;
  countdownTick: ReturnType<typeof vi.fn>;
  readinessTone: ReturnType<typeof vi.fn>;
  haptic: ReturnType<typeof vi.fn>;
} {
  return {
    repTone: vi.fn(),
    cueTone: vi.fn(),
    terminalChord: vi.fn(),
    countdownTick: vi.fn(),
    readinessTone: vi.fn(),
    haptic: vi.fn(),
  };
}

/** An in-memory {@link SessionStore} so persistence needs no real localStorage. */
function makeStore(): SessionStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function repEvent(repNumber: number): DomainEvent {
  return {
    type: 'RepCompleted',
    t: repNumber * 1000,
    repNumber,
    tutMs: 1500,
    minSignal: 0.1,
    maxSignal: 0.9,
    romGatePassed: true,
  };
}

function faultEvent(faultId: string, severity: FaultSeverity, cue: string): DomainEvent {
  return { type: 'FaultDetected', t: 0, faultId, phase: 'concentric', severity, cue };
}

describe('CoachController end-to-end loop over a mock event source', () => {
  let host: HTMLElement;
  let events: ManualEventSource;
  let audio: ReturnType<typeof makeAudioSpy>;
  let saySpy: ReturnType<typeof vi.fn>;
  let controller: CoachController;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    events = new ManualEventSource();
    audio = makeAudioSpy();
    saySpy = vi.fn();
    controller = new CoachController({
      host,
      events,
      audio,
      voice: { say: saySpy },
      persistence: { store: makeStore() },
      exercises: [],
    });
  });

  afterEach(() => {
    controller.dispose();
    host.remove();
    vi.useRealTimers();
  });

  /** Drive SETUP → ARMED → WORKING (framing ok, Start, 5 s countdown). */
  function reachWorking(): void {
    // Valid framing unblocks the SETUP → ARMED gate (R4.5).
    controller.updateFraming(OK_VERDICT);
    expect(controller.state).toBe('SETUP');

    // Take the single Start action → ARMED.
    const startBtn = host.querySelector('.setup-surface__start') as HTMLButtonElement;
    startBtn.click();
    expect(controller.state).toBe('ARMED');

    // Run the 5-second audible countdown → WORKING (R4.6).
    vi.advanceTimersByTime(5000);
    expect(controller.state).toBe('WORKING');
  }

  it('renders exactly the surface bound to each state (single-surface, R1.2)', () => {
    expect(host.querySelectorAll('.setup-surface')).toHaveLength(1);
    reachWorking();
    // Entering WORKING unmounts SETUP and mounts exactly the WORKING surface.
    expect(host.querySelectorAll('.setup-surface')).toHaveLength(0);
    expect(host.querySelectorAll('.armed-surface')).toHaveLength(0);
    expect(host.querySelectorAll('.working-surface')).toHaveLength(1);
  });

  it('counts reps, fires a rep tone per rep, and rations one cue per rep', () => {
    reachWorking();
    const N = 4;

    for (let i = 1; i <= N; i += 1) {
      // Two faults in the rep window → highest severity wins, at most one cue.
      events.emit(faultEvent(`f-info-${i}`, 'info', 'chin down'));
      events.emit(faultEvent(`f-crit-${i}`, 'critical', 'knees out'));
      events.emit(repEvent(i));
    }

    // Rep count reflects the last RepCompleted (R1.4).
    const count = host.querySelector('.rep-count-display__count') as HTMLElement;
    expect(count.textContent).toBe(String(N));

    // A distinct rep tone fired for every rep (R3.1) — never gated by cues.
    expect(audio.repTone).toHaveBeenCalledTimes(N);
    expect(audio.haptic).toHaveBeenCalledTimes(N);

    // At most one spoken cue per rep (R3.4): a cue tone + spoken line per rep,
    // and the highest-severity cue text won ("knees out"), not the info one.
    expect(audio.cueTone.mock.calls.length).toBeLessThanOrEqual(N);
    expect(audio.cueTone).toHaveBeenCalled();
    expect(saySpy).toHaveBeenCalledWith('knees out');
    expect(saySpy).not.toHaveBeenCalledWith('chin down');
    // One spoken cue per rep at most.
    expect(saySpy.mock.calls.length).toBeLessThanOrEqual(N);
  });

  it('transitions WORKING → REVIEW after 8 s of no motion and shows the set', () => {
    reachWorking();

    // Two reps, then go quiet. Each rep resets the 8 s no-motion clock (R1.5).
    events.emit(repEvent(1));
    vi.advanceTimersByTime(5000);
    events.emit(repEvent(2));
    // Only 5 s since the last rep — still WORKING.
    vi.advanceTimersByTime(5000);
    expect(controller.state).toBe('WORKING');

    // Cross the 8 s no-motion threshold → REVIEW (R1.5).
    vi.advanceTimersByTime(3000);
    expect(controller.state).toBe('REVIEW');

    // The terminal chord sounded on set end (R3.3).
    expect(audio.terminalChord).toHaveBeenCalledTimes(1);

    // REVIEW is the only mounted surface (R1.2) and shows the frozen SetRecord.
    expect(host.querySelectorAll('.working-surface')).toHaveLength(0);
    const review = host.querySelector('.review-surface');
    expect(review).not.toBeNull();
    // Two reps were accumulated into the set summary (R6.1).
    const reps = review!.querySelector('.set-summary__reps__value') as HTMLElement;
    expect(reps.textContent).toBe('2');
  });

  it('does not stall while reps keep arriving inside the 8 s window', () => {
    reachWorking();
    for (let i = 1; i <= 5; i += 1) {
      events.emit(repEvent(i));
      vi.advanceTimersByTime(7000); // < 8 s each → clock keeps resetting
    }
    expect(controller.state).toBe('WORKING');
  });
});

describe('CoachController restores the prior session within 120 s (R1.7)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resumes WORKING from a fresh snapshot instead of resetting to SETUP', () => {
    vi.useFakeTimers();
    const store = makeStore();
    const host1 = document.createElement('div');
    const c1 = new CoachController({
      host: host1,
      events: new ManualEventSource(),
      audio: makeAudioSpy(),
      persistence: { store },
      now: () => 1_000_000,
    });
    // Drive c1 into WORKING so a WORKING snapshot is written.
    c1.updateFraming(OK_VERDICT);
    (host1.querySelector('.setup-surface__start') as HTMLButtonElement).click();
    vi.advanceTimersByTime(5000);
    expect(c1.state).toBe('WORKING');
    c1.dispose();

    // A second controller constructed 60 s later restores WORKING (R1.7).
    const host2 = document.createElement('div');
    const c2 = new CoachController({
      host: host2,
      events: new ManualEventSource(),
      audio: makeAudioSpy(),
      persistence: { store },
      now: () => 1_060_000,
    });
    expect(c2.state).toBe('WORKING');
    c2.dispose();
  });
});
