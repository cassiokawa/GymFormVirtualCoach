import { describe, it, expect, beforeEach } from 'vitest';
import { CueRationer, CUE_COOLDOWN_REPS } from './CueRationer.js';
import type { FaultDetected, FaultSeverity } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFault(
  faultId: string,
  severity: FaultSeverity,
  overrides: Partial<FaultDetected> = {},
): FaultDetected {
  return {
    type: 'FaultDetected',
    t: 0,
    faultId,
    phase: 'concentric',
    severity,
    cue: `${faultId} cue`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CueRationer', () => {
  let rationer: CueRationer;

  beforeEach(() => {
    rationer = new CueRationer();
  });

  it('emits nothing when no fault was offered this rep (R3.6 — silence)', () => {
    expect(rationer.flush(1)).toBeNull();
  });

  it('selects the highest-severity fault offered within a rep (R3.5)', () => {
    rationer.offer(makeFault('a', 'info'));
    rationer.offer(makeFault('b', 'critical'));
    rationer.offer(makeFault('c', 'warning'));

    const cue = rationer.flush(1);
    expect(cue).not.toBeNull();
    expect(cue?.cueId).toBe('b');
    expect(cue?.severity).toBe('critical');
    expect(cue?.text).toBe('b cue');
  });

  it('emits at most one cue per rep even when many faults occur (R3.4)', () => {
    rationer.offer(makeFault('a', 'warning'));
    rationer.offer(makeFault('b', 'warning'));
    rationer.offer(makeFault('c', 'info'));

    const first = rationer.flush(1);
    expect(first).not.toBeNull();
    // A second flush for the same rep window returns nothing: accumulation was
    // reset, so there is no second cue for the rep.
    expect(rationer.flush(1)).toBeNull();
  });

  it('breaks equal-severity ties by first-offered (documented tie-break)', () => {
    rationer.offer(makeFault('first', 'warning'));
    rationer.offer(makeFault('second', 'warning'));

    expect(rationer.flush(1)?.cueId).toBe('first');
  });

  it('suppresses the same cueId within the 3-rep cooldown, then allows it again (coaching-safety)', () => {
    // Rep 1: emit 'a'.
    rationer.offer(makeFault('a', 'critical'));
    expect(rationer.flush(1)?.cueId).toBe('a');

    // Reps 2, 3, 4 (r+1..r+3): 'a' is the only candidate and is cooling down.
    for (const rep of [2, 3, 4]) {
      rationer.offer(makeFault('a', 'critical'));
      expect(rationer.flush(rep)).toBeNull();
    }

    // Rep 5 (r + COOLDOWN + 1): 'a' is allowed again.
    expect(CUE_COOLDOWN_REPS).toBe(3);
    rationer.offer(makeFault('a', 'critical'));
    expect(rationer.flush(5)?.cueId).toBe('a');
  });

  it('falls through to the next-highest non-cooled-down fault when the winner is cooling down', () => {
    // Rep 1: emit the critical 'a'.
    rationer.offer(makeFault('a', 'critical'));
    expect(rationer.flush(1)?.cueId).toBe('a');

    // Rep 2: 'a' (critical) is cooling down, so the lower-severity but allowed
    // 'b' (warning) is spoken instead of falling silent.
    rationer.offer(makeFault('a', 'critical'));
    rationer.offer(makeFault('b', 'warning'));
    const cue = rationer.flush(2);
    expect(cue?.cueId).toBe('b');
    expect(cue?.severity).toBe('warning');
  });

  it('returns null when every offered fault is cooling down', () => {
    rationer.offer(makeFault('a', 'critical'));
    rationer.offer(makeFault('b', 'warning'));
    expect(rationer.flush(1)?.cueId).toBe('a'); // 'a' emitted
    // Rep 2: manually emit 'b' so both are now cooling down.
    rationer.offer(makeFault('b', 'warning'));
    expect(rationer.flush(2)?.cueId).toBe('b'); // 'b' emitted ('a' cooling)

    // Rep 3: both 'a' and 'b' are within cooldown -> silence.
    rationer.offer(makeFault('a', 'critical'));
    rationer.offer(makeFault('b', 'warning'));
    expect(rationer.flush(3)).toBeNull();
  });

  it('reset clears both the rep window and all cooldown state', () => {
    rationer.offer(makeFault('a', 'critical'));
    expect(rationer.flush(1)?.cueId).toBe('a');

    rationer.reset();

    // After reset, no leftover accumulation for the previous window...
    expect(rationer.flush(1)).toBeNull();

    // ...and 'a' is emittable again immediately at the same rep index, because
    // its cooldown history was cleared.
    rationer.offer(makeFault('a', 'critical'));
    expect(rationer.flush(2)?.cueId).toBe('a');
  });
});
