/**
 * Unit tests for the pure session transition relation (task 2.1).
 *
 * Covers every legal edge in the design's state-transition diagram, the
 * framing-valid gate on `START_REQUESTED` (R4.5), and that illegal
 * `(state, event)` pairs are no-ops that return the context unchanged (R1.1).
 *
 * Requirements: 1.1, 1.5, 4.5
 */

import { describe, it, expect } from 'vitest';

import { transition } from './machine';
import type { SessionContext, SessionEvent, SessionState } from './types';

/** A base context in the given state; framing valid by default. */
function ctxIn(
  state: SessionState,
  overrides: Partial<SessionContext> = {},
): SessionContext {
  return {
    state,
    exerciseId: null,
    framingValid: true,
    set: null,
    ...overrides,
  };
}

const ALL_STATES: readonly SessionState[] = ['SETUP', 'ARMED', 'WORKING', 'REVIEW'];

const ALL_EVENTS: readonly SessionEvent[] = [
  { kind: 'START_REQUESTED' },
  { kind: 'COUNTDOWN_ELAPSED' },
  { kind: 'COUNTDOWN_CANCELLED' },
  { kind: 'SET_ENDED' },
  { kind: 'STALLED' },
  { kind: 'REPEAT_SET' },
  { kind: 'RETURN_TO_SETUP' },
];

/** The legal edges the transition relation must implement. */
const LEGAL_EDGES: ReadonlyArray<{
  from: SessionState;
  event: SessionEvent['kind'];
  to: SessionState;
}> = [
  { from: 'SETUP', event: 'START_REQUESTED', to: 'ARMED' },
  { from: 'ARMED', event: 'COUNTDOWN_ELAPSED', to: 'WORKING' },
  { from: 'ARMED', event: 'COUNTDOWN_CANCELLED', to: 'SETUP' },
  { from: 'WORKING', event: 'SET_ENDED', to: 'REVIEW' },
  { from: 'WORKING', event: 'STALLED', to: 'REVIEW' },
  { from: 'REVIEW', event: 'REPEAT_SET', to: 'ARMED' },
  { from: 'REVIEW', event: 'RETURN_TO_SETUP', to: 'SETUP' },
];

describe('transition — legal edges', () => {
  it('SETUP + START_REQUESTED → ARMED when framing is valid', () => {
    const next = transition(ctxIn('SETUP', { framingValid: true }), { kind: 'START_REQUESTED' });
    expect(next.state).toBe('ARMED');
  });

  it('ARMED + COUNTDOWN_ELAPSED → WORKING', () => {
    const next = transition(ctxIn('ARMED'), { kind: 'COUNTDOWN_ELAPSED' });
    expect(next.state).toBe('WORKING');
  });

  it('ARMED + COUNTDOWN_CANCELLED → SETUP', () => {
    const next = transition(ctxIn('ARMED'), { kind: 'COUNTDOWN_CANCELLED' });
    expect(next.state).toBe('SETUP');
  });

  it('WORKING + SET_ENDED → REVIEW', () => {
    const next = transition(ctxIn('WORKING'), { kind: 'SET_ENDED' });
    expect(next.state).toBe('REVIEW');
  });

  it('WORKING + STALLED → REVIEW (8s no-motion case, R1.5)', () => {
    const next = transition(ctxIn('WORKING'), { kind: 'STALLED' });
    expect(next.state).toBe('REVIEW');
  });

  it('REVIEW + REPEAT_SET → ARMED', () => {
    const next = transition(ctxIn('REVIEW'), { kind: 'REPEAT_SET' });
    expect(next.state).toBe('ARMED');
  });

  it('REVIEW + RETURN_TO_SETUP → SETUP', () => {
    const next = transition(ctxIn('REVIEW'), { kind: 'RETURN_TO_SETUP' });
    expect(next.state).toBe('SETUP');
  });

  it('carries every non-state field through unchanged on a legal transition', () => {
    const ctx = ctxIn('ARMED', {
      exerciseId: 'opaque-id-from-data',
      framingValid: true,
      set: null,
    });
    const next = transition(ctx, { kind: 'COUNTDOWN_ELAPSED' });
    expect(next.state).toBe('WORKING');
    expect(next.exerciseId).toBe('opaque-id-from-data');
    expect(next.framingValid).toBe(true);
    expect(next.set).toBeNull();
  });

  it('does not mutate the input context', () => {
    const ctx = ctxIn('SETUP', { framingValid: true });
    transition(ctx, { kind: 'START_REQUESTED' });
    expect(ctx.state).toBe('SETUP');
  });
});

describe('transition — start gating (R4.5)', () => {
  it('SETUP + START_REQUESTED is a no-op when framing is invalid', () => {
    const ctx = ctxIn('SETUP', { framingValid: false });
    const next = transition(ctx, { kind: 'START_REQUESTED' });
    expect(next.state).toBe('SETUP');
    // No-op returns the same reference.
    expect(next).toBe(ctx);
  });

  it('SETUP + START_REQUESTED advances to ARMED only when framing is valid', () => {
    expect(transition(ctxIn('SETUP', { framingValid: true }), { kind: 'START_REQUESTED' }).state).toBe(
      'ARMED',
    );
    expect(transition(ctxIn('SETUP', { framingValid: false }), { kind: 'START_REQUESTED' }).state).toBe(
      'SETUP',
    );
  });
});

describe('transition — illegal pairs are no-ops (R1.1)', () => {
  it('returns the same context reference for every illegal (state, event) pair', () => {
    const legal = new Set(LEGAL_EDGES.map((e) => `${e.from}:${e.event}`));
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        // Framing valid so START_REQUESTED-from-SETUP is treated as the legal edge.
        const ctx = ctxIn(state, { framingValid: true });
        const next = transition(ctx, event);
        if (legal.has(`${state}:${event.kind}`)) {
          expect(next).not.toBe(ctx);
        } else {
          expect(next).toBe(ctx);
          expect(next.state).toBe(state);
        }
      }
    }
  });

  it('only ever produces one of the four legal states', () => {
    for (const state of ALL_STATES) {
      for (const framingValid of [true, false]) {
        for (const event of ALL_EVENTS) {
          const next = transition(ctxIn(state, { framingValid }), event);
          expect(ALL_STATES).toContain(next.state);
        }
      }
    }
  });
});
