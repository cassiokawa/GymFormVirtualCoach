/**
 * Session UX bounded-context types — the shared contracts for the four-state
 * coach session machine and the thin Coaching seam (audio bus + cue rationing)
 * that lives alongside it.
 *
 * ## Dependency rule
 *
 * Session UX depends **inward** on domain contracts and never the reverse. It
 * *consumes* the events the Analysis context (spec 02) publishes —
 * {@link RepCompleted}, {@link FaultDetected}, {@link HoldProgressed},
 * {@link AnalysisStalled} — and it never reaches into analysis internals (no
 * signal math, no phase FSM, no fault evaluation here). Those inbound event
 * shapes are RE-USED verbatim from `src/domain/analysis` rather than
 * re-declared, so the contract cannot drift: a change to the Analysis event
 * shape is a compile error here, not a silent structural mismatch.
 *
 * ## Exercise identity is data, never code
 *
 * HARD CONSTRAINT (`tech.md` rule 1): no exercise `id`, name, or alias appears
 * as a literal in this file or anywhere under `src/**` /*.ts`. Exercise
 * metadata is read as DATA — an {@link ExerciseSpecMeta} record projected from
 * the spec 02 document — and every `id` is an opaque string carried at runtime.
 *
 * ## Velocity is relative only
 *
 * HARD CONSTRAINT (`tech.md` rule 2): no absolute velocity units appear in any
 * model here or on screen. Per-rep velocity is carried as an unitless RELATIVE
 * value and is `null` when it could not be computed with confidence.
 *
 * This module is TYPES ONLY — no logic. The transition function, machine
 * runtime, audio bus, cue rationer, and surfaces are implemented in later
 * tasks against these contracts.
 *
 * Requirements: 1.1, 6.4
 */

import type {
  AnalysisStalled,
  FaultDetected,
  FaultSeverity,
  HoldProgressed,
  LandmarkFrame,
  RepCompleted,
} from '../domain/analysis/types';
import type { SpecMeta } from '../domain/analysis/engine';

// ---------------------------------------------------------------------------
// Inbound Analysis event contract (consumed, not owned)
// ---------------------------------------------------------------------------

/**
 * Re-export the inbound Analysis event shapes so Session UX and the Coaching
 * seam import them from a single context-local surface. These are the SAME
 * structural types the Analysis context publishes (`src/domain/analysis`);
 * they are re-exported, never redefined, so the cross-context contract stays
 * exact. See structure.md's publish/subscribe matrix:
 *
 * | Event              | Published by | Consumed by                          |
 * |--------------------|--------------|--------------------------------------|
 * | `RepCompleted`     | Analysis     | Coaching (tone), Session UX (count)  |
 * | `FaultDetected`    | Analysis     | Coaching (rationed cue), Session UX  |
 * | `HoldProgressed`   | Analysis     | Session UX                           |
 * | `AnalysisStalled`  | Analysis     | Session UX                           |
 */
export type {
  RepCompleted,
  FaultDetected,
  HoldProgressed,
  AnalysisStalled,
  FaultSeverity,
  LandmarkFrame,
};

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------

/**
 * The four — and only four — states of a coach session (R1.1). The machine's
 * reachable state set is exactly this union; illegal `(state, event)` pairs are
 * no-ops that leave the state unchanged.
 */
export type SessionState = 'SETUP' | 'ARMED' | 'WORKING' | 'REVIEW';

/**
 * The events that drive the session machine. Each maps to at most one legal
 * transition; anything else is a no-op.
 *
 * - `START_REQUESTED`  SETUP → ARMED, accepted only when `framingValid` (R4.5).
 * - `COUNTDOWN_ELAPSED` ARMED → WORKING, after the 5-second countdown (R4.6).
 * - `COUNTDOWN_CANCELLED` ARMED → SETUP, user cancels before the countdown ends.
 * - `SET_ENDED`        WORKING → REVIEW, the set finished normally.
 * - `STALLED`          WORKING → REVIEW, no motion for 8s (`AnalysisStalled`, R1.5).
 * - `REPEAT_SET`       REVIEW → ARMED, run the same exercise again.
 * - `RETURN_TO_SETUP`  REVIEW → SETUP, pick a different exercise.
 */
export type SessionEvent =
  | { readonly kind: 'START_REQUESTED' }
  | { readonly kind: 'COUNTDOWN_ELAPSED' }
  | { readonly kind: 'COUNTDOWN_CANCELLED' }
  | { readonly kind: 'SET_ENDED' }
  | { readonly kind: 'STALLED' }
  | { readonly kind: 'REPEAT_SET' }
  | { readonly kind: 'RETURN_TO_SETUP' };

/**
 * The live state of a session. This is the single source of truth the machine
 * threads through every transition.
 */
export interface SessionContext {
  /** The current session state. */
  readonly state: SessionState;
  /** Selected exercise id — an opaque string from data, or `null` if unpicked. */
  readonly exerciseId: string | null;
  /** Gates `START_REQUESTED`: true only when all framing sub-checks pass (R4.5). */
  readonly framingValid: boolean;
  /** The set accumulated during WORKING and frozen for REVIEW; `null` otherwise. */
  readonly set: SetRecord | null;
}

/**
 * A surface's mount/unmount lifecycle. The machine guarantees exactly one
 * surface is mounted per state (R1.2): on every transition it unmounts the
 * outgoing surface and mounts exactly one incoming surface.
 */
export interface Surface {
  /** Attach this surface's DOM into `host`, reading the current context. */
  mount(host: HTMLElement, ctx: SessionContext): void;
  /** Detach and dispose this surface's DOM and listeners. */
  unmount(): void;
}

// ---------------------------------------------------------------------------
// Exercise metadata (DATA projection — no identity literals in TS)
// ---------------------------------------------------------------------------

/**
 * The descriptive projection of an exercise spec document that Session UX reads
 * as DATA: the grid, filters, silhouette, and required-camera-angle readout all
 * consume it. It is the Analysis context's {@link SpecMeta} — reused, not
 * redefined — so there is one authoritative shape for exercise metadata across
 * contexts.
 *
 * Carries `id`, `displayName`, and `aliases` as runtime strings; none is a
 * literal in TypeScript (`tech.md` rule 1).
 */
export type ExerciseSpecMeta = SpecMeta;

// ---------------------------------------------------------------------------
// Domain records — accumulated during WORKING, frozen for REVIEW
// ---------------------------------------------------------------------------

/**
 * One completed rep. Populated from a {@link RepCompleted} event plus the
 * fault cue ids the {@link CueRationer} rationed for that rep.
 */
export interface RepRecord {
  /** 1-based index of this rep within the set (mirrors `RepCompleted.repNumber`). */
  readonly index: number;
  /** Time under tension for this rep, in milliseconds. */
  readonly tUnderTensionMs: number;
  /**
   * RELATIVE concentric velocity — unitless. `null` when it could not be
   * computed with confidence (low-confidence frames, R6.4). No absolute units,
   * ever (`tech.md` rule 2).
   */
  readonly concentricVelocityRel: number | null;
  /** Fault cue ids attributed to this rep (for chart flagging / evidence). */
  readonly faultCueIds: readonly string[];
  /** Evidence-clip reference reachable from REVIEW in one interaction, or `null`. */
  readonly evidenceClipRef: string | null;
}

/**
 * A full set, accumulated live during WORKING and frozen for REVIEW.
 */
export interface SetRecord {
  /** Opaque exercise id this set was performed under (data, not a literal). */
  readonly exerciseId: string;
  /** Capture timestamp when the set started, in milliseconds. */
  readonly startedAt: number;
  /** The reps completed in this set, in order. */
  readonly reps: readonly RepRecord[];
  /**
   * True when landmark confidence was below threshold for more than 20% of the
   * set; velocity figures are suppressed in REVIEW when set (R6.4).
   */
  readonly lowConfidence: boolean;
  /** Index of the set's best rep, marked in the velocity chart (R6.2), or `null`. */
  readonly bestRepIndex: number | null;
}

/**
 * The persisted session snapshot backing the 120-second resume window (R1.7).
 * Written on every transition; on load it is honoured only when
 * `now - savedAt <= 120_000`, otherwise the machine starts at SETUP.
 */
export interface SessionSnapshot {
  /** The session state at snapshot time. */
  readonly state: SessionState;
  /** The selected exercise id (opaque string) at snapshot time, or `null`. */
  readonly exerciseId: string | null;
  /** The in-progress or frozen set, or `null`. */
  readonly set: SetRecord | null;
  /** Wall-clock time the snapshot was written; used to age it out at 120s. */
  readonly savedAt: number;
}

// ---------------------------------------------------------------------------
// Framing verdict (SETUP gate)
// ---------------------------------------------------------------------------

/**
 * How the subject's on-screen size compares to the target frame-height
 * occupancy band (40–90%, R4.4). `too_close` / `too_far` drive a plain-language
 * "move closer / further" instruction expressed in approximate metres.
 */
export type FramingDistance = 'too_close' | 'too_far' | 'ok';

/**
 * The direction and magnitude the camera must rotate to bring the view within
 * the exercise's preferred-angle tolerance (R4.3).
 */
export interface AngleCorrection {
  /** Which way to rotate the camera. */
  readonly direction: 'left' | 'right';
  /** How many degrees of correction are needed. */
  readonly degrees: number;
}

/**
 * The structured framing verdict produced continuously in SETUP (R4.1). `ok` is
 * the conjunction of all sub-checks: no missing required landmarks, angle within
 * tolerance, and distance in range (R4.5). The SetupSurface maps `ok` directly
 * onto {@link SessionContext.framingValid}.
 */
export interface FramingVerdict {
  /** True only if every sub-check below passes (R4.5). */
  readonly ok: boolean;
  /** Plain-language body-part names for any landmark outside the frame (R4.2). */
  readonly missingLandmarks: readonly string[];
  /** The required camera correction, or `null` when the angle is within tolerance. */
  readonly angleCorrection: AngleCorrection | null;
  /** Distance verdict from frame-height occupancy (R4.4). */
  readonly distance: FramingDistance;
  /** Approximate metres to move, or `null` when distance is `ok` (R4.4). */
  readonly distanceHintMetres: number | null;
}

// ---------------------------------------------------------------------------
// Coaching seam — cue rationing + mute state
// ---------------------------------------------------------------------------

/**
 * The single spoken cue the {@link CueRationer} lets through for a rep: the
 * highest-severity, non-cooled-down fault (R3.4, R3.5, `coaching-safety.md`).
 * `cueText` is passed through unchanged from data; the banned-word guarantee is
 * enforced upstream in spec 02's validator.
 */
export interface RationedCue {
  /** Fault identifier this cue came from (drives the 3-rep cooldown). */
  readonly cueId: string;
  /** Movement-focused cue text (≤ 4 words), passed through from data. */
  readonly text: string;
  /** Severity that won the rep's rationing. */
  readonly severity: FaultSeverity;
}

/**
 * Independent mute flags for the two audio channels, persisted across sessions
 * under separate keys so they toggle independently (R3.8). Tones (rep / cue /
 * terminal chord) and speech mute separately.
 */
export interface MuteState {
  /** Whether synthesised tones are muted. */
  readonly tones: boolean;
  /** Whether spoken cues are muted. */
  readonly speech: boolean;
}

// ---------------------------------------------------------------------------
// Exercise selection filter
// ---------------------------------------------------------------------------

/**
 * The filter applied to the exercise grid (R7.2, R7.3). All fields are
 * optional; an absent field imposes no constraint. `query` is free-text matched
 * over exercise names AND aliases (R7.3). Facet values are opaque data strings.
 */
export interface ExerciseFilter {
  /** Equipment facet to match, if any (R7.2). */
  readonly equipment?: string;
  /** Primary muscle group facet to match, if any (R7.2). */
  readonly muscleGroup?: string;
  /** Body position facet to match, if any (R7.2). */
  readonly position?: string;
  /** Free-text query over name + aliases, if any (R7.3). */
  readonly query?: string;
}
