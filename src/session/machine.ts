/**
 * Session UX — the pure transition relation for the four-state coach session
 * machine (SETUP → ARMED → WORKING → REVIEW).
 *
 * This module is the transition *relation* only: a single pure, synchronous
 * function {@link transition} that maps a {@link SessionContext} and a
 * {@link SessionEvent} to the next {@link SessionContext}. It performs no I/O,
 * no DOM work, no allocation on the no-op path, and has no side effects — the
 * machine runtime (task 2.4) layers surface mount/unmount and snapshot
 * persistence on top of this, and set accumulation is threaded in there.
 *
 * ## The legal edges (design "State transition diagram")
 *
 * | From    | Event                | To      | Guard                     |
 * |---------|----------------------|---------|---------------------------|
 * | SETUP   | START_REQUESTED      | ARMED   | `ctx.framingValid` (R4.5) |
 * | ARMED   | COUNTDOWN_ELAPSED    | WORKING | —                         |
 * | ARMED   | COUNTDOWN_CANCELLED  | SETUP   | —                         |
 * | WORKING | SET_ENDED            | REVIEW  | —                         |
 * | WORKING | STALLED              | REVIEW  | — (no motion 8s, R1.5)    |
 * | REVIEW  | REPEAT_SET           | ARMED   | —                         |
 * | REVIEW  | RETURN_TO_SETUP      | SETUP   | —                         |
 *
 * Every other `(state, event)` pair — and `START_REQUESTED` while framing is
 * invalid — is a no-op: the SAME context reference is returned unchanged. This
 * is what keeps the reachable state set exactly the four states (R1.1) and ties
 * the framing gate (R4.2/R4.3/R4.5) to the machine.
 *
 * Requirements: 1.1, 1.5, 4.5
 */

import type { SessionContext, SessionEvent, SessionState } from './types';

/**
 * Produce a new {@link SessionContext} with `state` replaced. Every other field
 * is carried through unchanged — this task owns the transition relation only;
 * exercise-selection and set handling are threaded in by the runtime (2.4).
 */
function withState(ctx: SessionContext, state: SessionState): SessionContext {
  return { ...ctx, state };
}

/**
 * The pure session transition relation.
 *
 * Applies the single legal edge for `(ctx.state, ev.kind)`, if one exists and
 * its guard is satisfied, and returns the resulting context. For any illegal
 * pair — or `START_REQUESTED` when `ctx.framingValid` is false — the input
 * `ctx` is returned unchanged (same reference), so callers can treat identity
 * equality as "no transition occurred".
 *
 * Pure and synchronous: no I/O, no mutation of `ctx`, no side effects.
 *
 * @param ctx The current session context (never mutated).
 * @param ev  The event to apply.
 * @returns The next context, or `ctx` itself when the transition is illegal.
 */
export function transition(ctx: SessionContext, ev: SessionEvent): SessionContext {
  switch (ctx.state) {
    case 'SETUP':
      // SETUP → ARMED, but only when framing is valid (R4.5). When framing is
      // invalid the start request is a no-op, which is how the framing gate
      // (R4.2/R4.3) is enforced structurally rather than in the UI.
      if (ev.kind === 'START_REQUESTED' && ctx.framingValid) {
        return withState(ctx, 'ARMED');
      }
      return ctx;

    case 'ARMED':
      // ARMED → WORKING after the 5s countdown (R4.6); ARMED → SETUP on cancel.
      if (ev.kind === 'COUNTDOWN_ELAPSED') {
        return withState(ctx, 'WORKING');
      }
      if (ev.kind === 'COUNTDOWN_CANCELLED') {
        return withState(ctx, 'SETUP');
      }
      return ctx;

    case 'WORKING':
      // WORKING → REVIEW on a normal set end OR on an 8s no-motion stall (R1.5).
      if (ev.kind === 'SET_ENDED' || ev.kind === 'STALLED') {
        return withState(ctx, 'REVIEW');
      }
      return ctx;

    case 'REVIEW':
      // REVIEW → ARMED to repeat the same exercise; REVIEW → SETUP to pick anew.
      if (ev.kind === 'REPEAT_SET') {
        return withState(ctx, 'ARMED');
      }
      if (ev.kind === 'RETURN_TO_SETUP') {
        return withState(ctx, 'SETUP');
      }
      return ctx;

    default:
      // Exhaustiveness: SessionState is a closed union of four states (R1.1).
      return ctx;
  }
}
