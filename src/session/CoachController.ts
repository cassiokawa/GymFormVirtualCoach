/**
 * CoachController — the assembly seam that wires the Session UX machine to the
 * Analysis event stream and the Coaching audio channels (Task 12.1).
 *
 * ## What this module is (and deliberately is NOT)
 *
 * This is the ONE place the four bounded pieces built in earlier tasks are
 * composed into a running coach session:
 *
 *   - the four {@link Surface}s registered on a {@link SessionMachine};
 *   - the {@link AudioBus} (rep tone / cue tone / terminal chord / haptics);
 *   - a {@link SpeechChannel} over a {@link VoiceLike} (the existing VoiceCoach);
 *   - the {@link CueRationer} (one spoken cue per rep, highest severity wins).
 *
 * It consumes the Analysis {@link DomainEvent} stream through an INJECTED
 * {@link AnalysisEventSource} — never the live camera. Until the spec 02 engine
 * is connected, that source is a fixture/mock replay, so the whole session can
 * run and be tested in isolation. Swapping in the real engine later is a matter
 * of passing a different `AnalysisEventSource`; nothing here changes.
 *
 * This module does NOT own pose inference, the frame loop, or any Analysis
 * internals — the dependency rule holds (`structure.md`): Session UX / Coaching
 * depend INWARD on the domain event contract and never reach into signal math,
 * the phase FSM, or fault evaluation.
 *
 * ## The event wiring (design "Architecture", `structure.md` pub/sub matrix)
 *
 * | Event             | Handling                                                     |
 * |-------------------|--------------------------------------------------------------|
 * | `RepCompleted`    | rep tone + haptic; bump rep count; flush the rationer → if a |
 * |                   | cue survives, cue tone then speak it + show it on the cue     |
 * |                   | line; accumulate the rep into the live {@link SetRecord};     |
 * |                   | reset the 8 s no-motion timer.                                |
 * | `FaultDetected`   | offer to the rationer (spoken later at the rep boundary) and  |
 * |                   | record it as REVIEW evidence for the rep it belongs to.       |
 * | `HoldProgressed`  | forward to the active surface (hold display).                 |
 * | `AnalysisStalled` | surface "not detecting movement" on the WORKING surface.      |
 *
 * The 8-second no-motion rule (R1.5) is a timer OWNED BY THIS CONTROLLER: it is
 * armed on entering WORKING, reset on every `RepCompleted`, and on expiry it
 * sends `STALLED` → REVIEW. It is deliberately independent of the engine's own
 * `AnalysisStalled` (which the engine may emit on a different threshold); the
 * controller's timer is the authoritative UX stall clock so the session behaves
 * even against a fixture replay that never emits `AnalysisStalled` itself.
 *
 * ## One cue per rep, never gating the rep tone (R3.4, R3.6, `coaching-safety.md`)
 *
 * The rep tone fires unconditionally on `RepCompleted`. The rationed spoken cue
 * is a separate channel: `flush` returns at most one cue for the rep, and the
 * SpeechChannel drops it if speech is already in progress. Nothing about cue
 * rationing or speech can ever suppress the rep tone.
 *
 * ## Persistence & the 120 s resume window (R1.7)
 *
 * A {@link SessionSnapshot} is written on every transition; on construction the
 * controller restores the prior state when the snapshot is < 120 s old, else it
 * starts at SETUP. Persistence goes through the injectable seam in
 * `./persistence` so tests need no real `localStorage`.
 *
 * ## Exercise identity is data, never code (`tech.md` rule 1)
 *
 * No exercise id, name, or alias appears as a literal here. The selected id is
 * an opaque string threaded from the SetupSurface's grid selection into the
 * machine context and the accumulated {@link SetRecord}.
 *
 * Framework-free. Strict tsconfig.
 *
 * Requirements: 1.2, 1.4, 1.5, 3.1, 5.3
 */

import { AudioBus } from './AudioBus';
import { CueRationer } from './CueRationer';
import { SpeechChannel, type VoiceLike } from './SpeechChannel';
import { SessionMachine } from './SessionMachine';
import {
  clearSnapshot,
  loadSnapshot,
  saveSnapshot,
  type PersistenceOptions,
} from './persistence';
import { ArmedSurface } from './surfaces/ArmedSurface';
import { ReviewSurface } from './surfaces/ReviewSurface';
import { SetupSurface } from './surfaces/SetupSurface';
import { WorkingSurface } from './surfaces/WorkingSurface';
import type {
  AnalysisStalled,
  ExerciseSpecMeta,
  FaultDetected,
  FramingVerdict,
  HoldProgressed,
  RepCompleted,
  RepRecord,
  SessionContext,
  SessionSnapshot,
  SessionState,
  SetRecord,
} from './types';
import type { DomainEvent } from '../domain/analysis/types';

// ---------------------------------------------------------------------------
// Injected Analysis event source (the seam that replaces the live camera)
// ---------------------------------------------------------------------------

/**
 * The inbound Analysis event stream, injected so the controller never depends
 * on the live camera or the spec 02 engine directly. A fixture/mock replay
 * satisfies it for tests and for running before the engine lands; the real
 * engine will satisfy it later by exposing the same `subscribe` shape.
 */
export interface AnalysisEventSource {
  /**
   * Subscribe to the Analysis {@link DomainEvent} stream. Returns an
   * unsubscribe function the controller calls on dispose.
   */
  subscribe(cb: (event: DomainEvent) => void): () => void;
}

/** The default timer seam (`setTimeout`/`clearTimeout`); injectable for tests. */
export interface ControllerTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimer: ControllerTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The no-motion stall window (R1.5): 8 seconds without a completed rep. */
export const NO_MOTION_STALL_MS = 8_000;

// ---------------------------------------------------------------------------
// Controller options
// ---------------------------------------------------------------------------

/** Construction options for {@link CoachController}. */
export interface CoachControllerOptions {
  /** The element every surface mounts into (a full-bleed camera container). */
  readonly host: HTMLElement;
  /** The Analysis event stream (fixture/mock replay until spec 02 lands). */
  readonly events: AnalysisEventSource;
  /** The exercise catalogue (DATA projection) fed to the SETUP grid. */
  readonly exercises?: readonly ExerciseSpecMeta[];
  /** Performance history (opaque ids, most-recent last) for the recents row. */
  readonly history?: readonly string[];
  /**
   * The spoken-cue engine. Structurally an existing `VoiceCoach`; a spy
   * `{ say() }` satisfies it in tests. When omitted, spoken cues are dropped
   * (the tone still fires) — audio-first still works, it is just silent speech.
   */
  readonly voice?: VoiceLike;
  /** Pre-built audio channel (inject a spy in tests). Defaults to a real AudioBus. */
  readonly audio?: CoachAudio;
  /** Pre-built SpeechChannel. Defaults to one over {@link CoachControllerOptions.voice}. */
  readonly speech?: SpeechChannel;
  /** Persistence seam options (store override for tests). */
  readonly persistence?: PersistenceOptions;
  /** Timer seam for the no-motion stall clock; defaults to platform timers. */
  readonly timer?: ControllerTimer;
  /** Current wall-clock time (ms); injectable for deterministic restore tests. */
  readonly now?: () => number;
  /** Start in mirrored-display mode (R2.6). */
  readonly mirrored?: boolean;
  /** Invoked when a flagged rep's evidence clip is requested from REVIEW (R6.3). */
  readonly onEvidence?: (clipRef: string) => void;
}

/**
 * The minimal AudioBus slice the controller drives. The concrete {@link AudioBus}
 * satisfies it; a spy `{ repTone, cueTone, terminalChord, haptic }` satisfies it
 * in tests without Web Audio.
 */
export interface CoachAudio {
  repTone(): void;
  cueTone(): void;
  terminalChord(): void;
  countdownTick(): void;
  readinessTone(): void;
  haptic(): void;
}

// ---------------------------------------------------------------------------
// CoachController
// ---------------------------------------------------------------------------

/**
 * Assembles the machine, surfaces, audio, speech, and rationer, then subscribes
 * to the Analysis event stream. Framework-free; construct with a host element
 * and an {@link AnalysisEventSource}, and call {@link dispose} to tear down.
 */
export class CoachController {
  private readonly machine: SessionMachine;
  private readonly audio: CoachAudio;
  private readonly speech: SpeechChannel | null;
  private readonly rationer = new CueRationer();

  private readonly setup: SetupSurface;
  private readonly working: WorkingSurface;

  private readonly timer: ControllerTimer;
  private readonly now: () => number;
  private readonly persistence: PersistenceOptions | undefined;

  /** Unsubscribe from the Analysis stream, set on construction. */
  private readonly unsubscribe: () => void;
  /** Unsubscribe from the machine's context stream (for snapshot writes). */
  private readonly unsubscribeMachine: () => void;

  /** The set being accumulated during WORKING; frozen into the machine on end. */
  private liveSet: MutableSetRecord | null = null;
  /** Pending no-motion stall handle, or `null` when not armed. */
  private stallHandle: unknown = null;
  /** The opaque exercise id chosen in SETUP (data, never a literal). */
  private selectedExerciseId: string | null = null;
  private disposed = false;

  constructor(options: CoachControllerOptions) {
    this.timer = options.timer ?? defaultTimer;
    this.now = options.now ?? (() => Date.now());
    this.persistence = options.persistence;

    const audio = options.audio ?? new AudioBus();
    this.audio = audio;
    this.speech =
      options.speech ??
      (options.voice ? new SpeechChannel({ voice: options.voice }) : null);

    // --- Restore the prior session within the 120 s window (R1.7) ----------
    const snapshot = loadSnapshot(this.now(), this.persistence);
    const initial = this.initialContext(snapshot);
    this.selectedExerciseId = initial.exerciseId;
    if (snapshot?.set) {
      // A restored in-progress/frozen set: rehydrate it as the live set so a
      // subsequent SET_ENDED/STALLED still has data to freeze into REVIEW.
      this.liveSet = rehydrateSet(snapshot.set);
    }

    // --- Build the four surfaces -------------------------------------------
    this.setup = new SetupSurface({
      audio,
      onStart: () => this.machine.send({ kind: 'START_REQUESTED' }),
      ...(options.exercises ? { exercises: options.exercises } : {}),
      ...(options.history ? { history: options.history } : {}),
    });
    // Track the SETUP grid selection so it flows into the machine context and
    // the accumulated SetRecord. The SetupSurface owns the grid; we mirror its
    // selection here at each transition (see onContext).
    this.working = new WorkingSurface(
      options.mirrored !== undefined ? { mirrored: options.mirrored } : {},
    );

    const armed = new ArmedSurface({
      audio,
      onElapsed: () => this.machine.send({ kind: 'COUNTDOWN_ELAPSED' }),
      onCancel: () => this.machine.send({ kind: 'COUNTDOWN_CANCELLED' }),
    });

    const review = new ReviewSurface({
      onRepeat: () => this.machine.send({ kind: 'REPEAT_SET' }),
      onReturnToSetup: () => this.machine.send({ kind: 'RETURN_TO_SETUP' }),
      ...(options.onEvidence ? { onEvidence: options.onEvidence } : {}),
    });

    // --- Build the machine and register the surfaces (R1.2) ----------------
    this.machine = new SessionMachine({
      host: options.host,
      initial,
      surfaces: {
        SETUP: this.setup,
        ARMED: armed,
        WORKING: this.working,
        REVIEW: review,
      },
    });

    // React to every transition: persist a snapshot, manage the stall timer,
    // reset per-set state on entering WORKING, and freeze the set for REVIEW.
    this.unsubscribeMachine = this.machine.subscribe((ctx) => this.onContext(ctx));

    this.machine.start();
    // start() mounts the initial surface but does not fire subscribers; run the
    // entry side-effects for the initial state explicitly.
    this.onEnter(initial.state, initial);

    // --- Subscribe to the Analysis event stream ----------------------------
    this.unsubscribe = options.events.subscribe((event) => this.onEvent(event));
  }

  // --- Public surface -------------------------------------------------------

  /** The current session state. */
  get state(): SessionState {
    return this.machine.state;
  }

  /** The machine's current context (read-only). */
  get context(): SessionContext {
    return this.machine.context;
  }

  /** The SETUP surface, exposed so the frame loop can drive framing verdicts. */
  get setupSurface(): SetupSurface {
    return this.setup;
  }

  /** The WORKING surface, exposed so the frame loop can drive the phase arc. */
  get workingSurface(): WorkingSurface {
    return this.working;
  }

  /**
   * Feed a fresh framing verdict from the frame loop into the SETUP surface
   * (R4.1–R4.5). A convenience pass-through so callers hold only the controller.
   * Also mirrors the SETUP grid's current selection into the controller so the
   * chosen exercise id flows into the machine and the accumulated set.
   */
  updateFraming(verdict: FramingVerdict): void {
    this.setup.updateFraming(verdict);
    const picked = this.setup.getSelectedExerciseId();
    if (picked !== null) {
      this.selectedExerciseId = picked;
    }
    // Mirror framing validity and the selected exercise into the machine
    // context so `START_REQUESTED` is gated on framing (R4.5) and the accepted
    // exercise id flows into the session. The pure transition carries these
    // fields through unchanged, so writing them here is what the SETUP → ARMED
    // guard reads. Only meaningful while in SETUP.
    if (this.machine.state === 'SETUP') {
      const ctx = this.machine.context as {
        framingValid: boolean;
        exerciseId: string | null;
      };
      ctx.framingValid = verdict.ok;
      if (picked !== null) {
        ctx.exerciseId = picked;
      }
    }
  }

  /**
   * Tear everything down: unsubscribe from both streams, clear the stall timer,
   * and dispose the machine (which unmounts the current surface). Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearStallTimer();
    this.unsubscribe();
    this.unsubscribeMachine();
    this.machine.dispose();
  }

  // --- Analysis event handling ---------------------------------------------

  /** Route one inbound {@link DomainEvent} to its handler. */
  private onEvent(event: DomainEvent): void {
    switch (event.type) {
      case 'RepCompleted':
        this.onRepCompleted(event);
        return;
      case 'FaultDetected':
        this.onFaultDetected(event);
        return;
      case 'HoldProgressed':
        this.onHoldProgressed(event);
        return;
      case 'AnalysisStalled':
        this.onAnalysisStalled(event);
        return;
      default:
        return;
    }
  }

  /**
   * A rep completed (R3.1). Rep tone + haptic fire UNCONDITIONALLY and first, so
   * the counted rep is confirmed within 120 ms regardless of any cue (R3.6).
   * Then: bump the rep count on the WORKING surface, flush the rationer for this
   * rep (cue tone → speak → cue line when a cue survives), accumulate the rep,
   * and reset the no-motion stall clock.
   */
  private onRepCompleted(event: RepCompleted): void {
    if (this.machine.state !== 'WORKING') return;

    // 1) Rep tone + haptic — never gated by cue rationing (R3.1, R3.6).
    this.audio.repTone();
    this.audio.haptic();

    // 2) Rep count on the WORKING surface (R1.4).
    this.working.setReps(event.repNumber);

    // 3) One spoken cue for the rep, highest severity wins (R3.4, R3.5).
    const cue = this.rationer.flush(event.repNumber);
    if (cue) {
      this.audio.cueTone();
      this.speech?.speak(cue.text);
      this.working.setCue(cue.text);
    } else {
      // Silence when nothing is worth saying (`coaching-safety.md`).
      this.working.setCue(null);
    }

    // 4) Accumulate the rep into the live set for REVIEW. Fault cue ids for the
    //    rep were recorded on FaultDetected; velocity is null until spec 02
    //    supplies it (no absolute units, ever — `tech.md` rule 2).
    this.accumulateRep(event);

    // 5) Motion happened → reset the 8 s no-motion clock (R1.5).
    this.armStallTimer();
  }

  /**
   * A fault was detected (R3.5). Offer it to the rationer (it is voiced, if it
   * wins, at the next rep boundary) and record it as evidence for its rep so it
   * marks the rep in REVIEW (R6.3).
   */
  private onFaultDetected(event: FaultDetected): void {
    if (this.machine.state !== 'WORKING') return;
    this.rationer.offer(event);
    this.recordFaultEvidence(event);
  }

  /** A hold progressed — forward the elapsed seconds to the WORKING surface. */
  private onHoldProgressed(event: HoldProgressed): void {
    if (this.machine.state !== 'WORKING') return;
    // The WORKING surface reflects hold progress on the phase arc; a fuller
    // hold display is a later refinement. Forward it as a normalised sweep is
    // out of scope here, so surface the seconds on the cue line is avoided to
    // keep the three-child allowlist clean; instead we no-op the visual and
    // leave the hook for Session UX. (Kept explicit for the pub/sub matrix.)
    void event.elapsedSeconds;
  }

  /**
   * The engine reported a stall. Surface "not detecting movement" in camera
   * terms (R5.5) on the WORKING surface. The authoritative UX transition to
   * REVIEW is driven by the controller's own 8 s no-motion timer (R1.5), not by
   * this event, so a fixture replay that never emits it still stalls correctly.
   */
  private onAnalysisStalled(event: AnalysisStalled): void {
    if (this.machine.state !== 'WORKING') return;
    void event;
    this.working.onStalled();
  }

  // --- Transition side-effects ---------------------------------------------

  /**
   * Runs after every genuine transition. The machine has already applied the
   * pure transition and remounted the surface for the new state; here we run
   * the entry side-effects for the new state and persist a snapshot (R1.7).
   */
  private onContext(ctx: SessionContext): void {
    this.onEnter(ctx.state, ctx);
    this.persist(ctx);
  }

  /**
   * State-entry side-effects that the pure machine cannot own (they touch audio,
   * timers, and the accumulated set):
   *
   * - WORKING: mirror the selected exercise into a fresh live set, reset the
   *   rationer, clear the cue line, and arm the 8 s no-motion clock (R1.5).
   * - REVIEW: freeze the accumulated set onto the context, sound the terminal
   *   chord (R3.3), and clear the stall clock.
   * - SETUP/ARMED: no audio here (the surfaces own their own tones); just make
   *   sure the stall clock is not running.
   */
  private onEnter(state: SessionState, ctx: SessionContext): void {
    // Any state other than WORKING must not have a live stall clock ticking.
    if (state !== 'WORKING') {
      this.clearStallTimer();
    }

    switch (state) {
      case 'WORKING': {
        // A fresh set starts unless we are resuming one restored from a snapshot.
        if (this.liveSet === null) {
          const exerciseId = this.selectedExerciseId ?? ctx.exerciseId ?? '';
          this.liveSet = newLiveSet(exerciseId, this.now());
        }
        this.rationer.reset();
        this.working.setReps(this.liveSet.reps.length);
        this.working.setCue(null);
        this.armStallTimer();
        return;
      }
      case 'REVIEW': {
        // The frozen set was written onto the context BEFORE the transition
        // (see endWorking) so the ReviewSurface read it at mount time. Here we
        // only sound the terminal chord (R3.3).
        this.audio.terminalChord();
        return;
      }
      case 'SETUP': {
        // Returning to SETUP discards any prior set so the next one is clean.
        this.liveSet = null;
        return;
      }
      case 'ARMED':
      default:
        return;
    }
  }

  // --- No-motion stall clock (R1.5) ----------------------------------------

  /** (Re)arm the 8 s no-motion timer; on expiry send STALLED → REVIEW. */
  private armStallTimer(): void {
    this.clearStallTimer();
    this.stallHandle = this.timer.set(() => {
      this.stallHandle = null;
      // Surface the message, then transition. Guard state in case a late timer
      // survived a transition race.
      if (this.machine.state === 'WORKING') {
        this.working.onStalled();
        this.endWorking('STALLED');
      }
    }, NO_MOTION_STALL_MS);
  }

  /** Clear any pending no-motion timer. */
  private clearStallTimer(): void {
    if (this.stallHandle !== null) {
      this.timer.clear(this.stallHandle);
      this.stallHandle = null;
    }
  }

  // --- Set accumulation -----------------------------------------------------

  /** Append a completed rep to the live set, carrying its recorded fault ids. */
  private accumulateRep(event: RepCompleted): void {
    if (this.liveSet === null) {
      const exerciseId = this.selectedExerciseId ?? this.machine.context.exerciseId ?? '';
      this.liveSet = newLiveSet(exerciseId, this.now());
    }
    const faultCueIds = this.liveSet.pendingFaultsByRep.get(event.repNumber) ?? [];
    const evidenceClipRef = this.liveSet.pendingEvidenceByRep.get(event.repNumber) ?? null;
    const rep: RepRecord = {
      index: event.repNumber,
      tUnderTensionMs: event.tutMs,
      // Velocity is RELATIVE only and is not carried on the domain RepCompleted
      // yet; null until spec 02 supplies it (`tech.md` rule 2).
      concentricVelocityRel: null,
      faultCueIds,
      evidenceClipRef,
    };
    this.liveSet.reps.push(rep);
    this.liveSet.pendingFaultsByRep.delete(event.repNumber);
    this.liveSet.pendingEvidenceByRep.delete(event.repNumber);
  }

  /** Record a detected fault against the rep it will close, for REVIEW evidence. */
  private recordFaultEvidence(event: FaultDetected): void {
    if (this.liveSet === null) {
      const exerciseId = this.selectedExerciseId ?? this.machine.context.exerciseId ?? '';
      this.liveSet = newLiveSet(exerciseId, this.now());
    }
    // Faults arrive within the rep window that CLOSES at the next RepCompleted.
    // The current in-progress rep index is reps.length + 1 (1-based).
    const repNumber = this.liveSet.reps.length + 1;
    const ids = this.liveSet.pendingFaultsByRep.get(repNumber) ?? [];
    if (!ids.includes(event.faultId)) {
      ids.push(event.faultId);
    }
    this.liveSet.pendingFaultsByRep.set(repNumber, ids);
    // First evidence clip for the rep wins; the fault carries none on the domain
    // event yet, so this is a hook the engine fills later.
  }

  /**
   * End the WORKING set and enter REVIEW. This is the single path from WORKING →
   * REVIEW: it freezes the live set into an immutable {@link SetRecord}, writes
   * it onto the machine context BEFORE sending the transition (so the machine
   * mounts REVIEW with `ctx.set` populated — the surface reads it at mount time),
   * then sends the event. `SET_ENDED` is the normal end; `STALLED` the 8 s
   * no-motion end (R1.5).
   */
  private endWorking(kind: 'SET_ENDED' | 'STALLED'): void {
    if (this.machine.state !== 'WORKING') return;
    this.clearStallTimer();
    const frozen = this.liveSet ? finalizeSet(this.liveSet) : null;
    // The pure transition carries context fields through unchanged, so writing
    // `set` here means the next context (and thus the REVIEW mount) sees it.
    (this.machine.context as { set: SetRecord | null }).set = frozen;
    this.machine.send({ kind });
  }

  /** Signal a normal set end (WORKING → REVIEW). For callers/fixtures. */
  endSet(): void {
    this.endWorking('SET_ENDED');
  }

  // --- Persistence (R1.7) ---------------------------------------------------

  /** Write a snapshot of the current context on every transition (R1.7). */
  private persist(ctx: SessionContext): void {
    const snapshot: SessionSnapshot = {
      state: ctx.state,
      exerciseId: ctx.exerciseId ?? this.selectedExerciseId,
      set: ctx.state === 'REVIEW' ? ctx.set : setFromLive(this.liveSet),
      savedAt: this.now(),
    };
    saveSnapshot(snapshot, this.persistence);
  }

  /**
   * Compute the initial context from a restored snapshot (R1.7) or a fresh
   * SETUP. A restored WORKING state is honoured — the live set is rehydrated in
   * the constructor — so a user who navigated away mid-set returns to it.
   */
  private initialContext(snapshot: SessionSnapshot | null): SessionContext {
    if (snapshot) {
      return {
        state: snapshot.state,
        exerciseId: snapshot.exerciseId,
        framingValid: false,
        set: snapshot.set,
      };
    }
    return { state: 'SETUP', exerciseId: null, framingValid: false, set: null };
  }

  /** Clear any persisted snapshot (e.g. on an explicit reset). */
  clearPersisted(): void {
    clearSnapshot(this.persistence);
  }
}

// ---------------------------------------------------------------------------
// Live set accumulation helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * A mutable working copy of a {@link SetRecord} accumulated during WORKING.
 * Frozen into an immutable `SetRecord` via {@link finalizeSet} on entering
 * REVIEW. Pending fault/evidence maps hold faults detected before their rep's
 * closing {@link RepCompleted}.
 */
interface MutableSetRecord {
  exerciseId: string;
  startedAt: number;
  reps: RepRecord[];
  lowConfidence: boolean;
  /** Fault cue ids awaiting the rep that closes them, keyed by 1-based rep no. */
  pendingFaultsByRep: Map<number, string[]>;
  /** Evidence clip refs awaiting the rep that closes them. */
  pendingEvidenceByRep: Map<number, string>;
}

/** Start a fresh mutable set for an opaque exercise id. */
function newLiveSet(exerciseId: string, startedAt: number): MutableSetRecord {
  return {
    exerciseId,
    startedAt,
    reps: [],
    lowConfidence: false,
    pendingFaultsByRep: new Map(),
    pendingEvidenceByRep: new Map(),
  };
}

/** Rehydrate a restored immutable set into a mutable one for continued accrual. */
function rehydrateSet(set: SetRecord): MutableSetRecord {
  return {
    exerciseId: set.exerciseId,
    startedAt: set.startedAt,
    reps: set.reps.slice(),
    lowConfidence: set.lowConfidence,
    pendingFaultsByRep: new Map(),
    pendingEvidenceByRep: new Map(),
  };
}

/**
 * Freeze a mutable set into an immutable {@link SetRecord}, computing the best
 * rep as the highest relative-velocity rep (or `null` when no rep has a value).
 */
function finalizeSet(live: MutableSetRecord): SetRecord {
  let bestRepIndex: number | null = null;
  let bestVel = -Infinity;
  live.reps.forEach((rep, i) => {
    const v = rep.concentricVelocityRel;
    if (v !== null && Number.isFinite(v) && v > bestVel) {
      bestVel = v;
      bestRepIndex = i;
    }
  });
  return {
    exerciseId: live.exerciseId,
    startedAt: live.startedAt,
    reps: live.reps.slice(),
    lowConfidence: live.lowConfidence,
    bestRepIndex,
  };
}

/** Project a mutable live set into an immutable snapshot value, or `null`. */
function setFromLive(live: MutableSetRecord | null): SetRecord | null {
  return live ? finalizeSet(live) : null;
}

// ---------------------------------------------------------------------------
// mountCoach — the app entry point
// ---------------------------------------------------------------------------

/**
 * Construct and start a {@link CoachController} mounted into `host`.
 *
 * This is the entry the app (or a demo hook) calls to stand up the full coach
 * session over a full-bleed camera container. It accepts a fixture/mock
 * {@link AnalysisEventSource} so it runs and is testable BEFORE the live pose
 * pipeline (spec 02 engine) is connected — the live camera is never required.
 *
 * Returns the controller so the caller can drive framing verdicts
 * ({@link CoachController.updateFraming}) and tear it down ({@link
 * CoachController.dispose}).
 *
 * @param host The full-bleed camera container the surfaces mount into.
 * @param opts The controller options minus `host` (supplied here).
 */
export function mountCoach(
  host: HTMLElement,
  opts: Omit<CoachControllerOptions, 'host'>,
): CoachController {
  return new CoachController({ host, ...opts });
}
