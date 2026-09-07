import { describe, it, expect } from 'vitest';
import {
  validateSpec,
  BANNED_CUE_WORDS,
  MAX_CUE_WORDS,
  MIN_HYSTERESIS_PCT,
  MIN_PHASE_DURATION_MS,
  type ValidationError,
  type ValidationErrorCode,
} from './validator';

// ---------------------------------------------------------------------------
// Fixtures — a structurally + semantically valid spec, mutated per-test.
//
// No exercise identity: this is a synthetic, generic document. Landmark indices
// are arbitrary-but-consistent; joint names are anatomy, not exercise names.
// ---------------------------------------------------------------------------

/** A deep clone helper so each test mutates an independent copy. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Build a fresh, fully-valid spec document (as parsed JSON, i.e. `unknown`). */
function validSpec(): Record<string, unknown> {
  return {
    id: 'synthetic-movement',
    version: '1.0.0',
    displayName: 'Synthetic Movement',
    aliases: ['synth'],
    facets: {
      equipment: 'none',
      primaryMuscles: ['quads'],
      position: 'standing',
    },
    mode: 'reps',
    bilateral: true,
    landmarkPairs: {
      hip: { left: 23, right: 24 },
      knee: { left: 25, right: 26 },
      ankle: { left: 27, right: 28 },
    },
    // Every index referenced by hip/knee/ankle midpoints must appear here.
    requiredLandmarks: [23, 24, 25, 26, 27, 28],
    optionalLandmarks: [],
    camera: { preferredAngleDeg: 90, toleranceDeg: 15, view: 'side' },
    signal: {
      expr: 'angle(hip,knee,ankle)',
      smoothing: { type: 'oneEuro', minCutoff: 1, beta: 0.1 },
    },
    rom: { source: 'calibration', floorPercentile: 20, gateTolerance: 5 },
    phases: {
      states: ['TOP', 'BOTTOM'],
      initial: 'TOP',
      hysteresisPct: 0.1,
      minPhaseDurationMs: 300,
      transitions: [
        { from: 'TOP', to: 'BOTTOM', when: 'dSignal < -0.01' },
        {
          from: 'BOTTOM',
          to: 'TOP',
          when: 'dSignal > 0.01',
          emits: 'RepCompleted',
        },
      ],
    },
    velocity: {
      trackedPoint: 'midpoint(left_hip,right_hip)',
      axis: 'y',
      normalizeBy: 'femur',
    },
    faults: [
      {
        id: 'shallow-depth',
        phase: 'BOTTOM',
        when: 'signal > romFloor',
        minDeviation: 5,
        severity: 'warning',
        cue: 'Go deeper',
      },
    ],
  };
}

/** All fixture ids present in the injected known-fixture set for happy-path. */
const KNOWN_FIXTURES = new Set(['synthetic-movement']);

function expectCodes(errors: ValidationError[], codes: ValidationErrorCode[]): void {
  const found = new Set(errors.map((e) => e.code));
  for (const c of codes) {
    expect(found.has(c), `expected error code ${c}, got ${[...found].join(', ')}`).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('validateSpec — valid spec', () => {
  it('accepts a structurally and semantically valid spec (with fixture)', () => {
    const result = validateSpec(validSpec(), { knownFixtureIds: KNOWN_FIXTURES });
    expect(result).toEqual({ ok: true });
  });

  it('accepts a valid spec when the fixture check is skipped (no options)', () => {
    expect(validateSpec(validSpec())).toEqual({ ok: true });
  });

  it('accepts a valid hold-mode spec with zero RepCompleted transitions', () => {
    const spec = clone(validSpec());
    spec['mode'] = 'hold';
    const phases = spec['phases'] as Record<string, unknown>;
    phases['transitions'] = [
      { from: 'TOP', to: 'BOTTOM', when: 'dSignal < -0.01' },
      { from: 'BOTTOM', to: 'TOP', when: 'dSignal > 0.01' },
    ];
    expect(validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES })).toEqual({ ok: true });
  });

  it('accepts a valid spec via a hasFixture predicate', () => {
    const result = validateSpec(validSpec(), { hasFixture: (id) => id === 'synthetic-movement' });
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Schema (structural) failures
// ---------------------------------------------------------------------------

describe('validateSpec — schema failures', () => {
  it('rejects a non-object document', () => {
    const r = validateSpec(42);
    expect(r.ok).toBe(false);
    if (!r.ok) expectCodes(r.errors, ['schema/type']);
  });

  it('reports the path of a missing required property', () => {
    const spec = clone(validSpec());
    delete spec['version'];
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.errors.find((e) => e.code === 'schema/required');
      expect(err?.path).toBe('version');
    }
  });

  it('rejects an unexpected additional property with its path', () => {
    const spec = clone(validSpec());
    spec['surprise'] = true;
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.errors.find((e) => e.code === 'schema/additional-property');
      expect(err?.path).toBe('surprise');
    }
  });

  it('rejects a bad mode enum', () => {
    const spec = clone(validSpec());
    spec['mode'] = 'timed';
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) expectCodes(r.errors, ['schema/enum']);
  });

  it('rejects a bad fault severity enum with its path', () => {
    const spec = clone(validSpec());
    (spec['faults'] as Record<string, unknown>[])[0]!['severity'] = 'fatal';
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.errors.find((e) => e.code === 'schema/enum');
      expect(err?.path).toBe('faults[0].severity');
    }
  });

  it('rejects a non-integer landmark index', () => {
    const spec = clone(validSpec());
    (spec['requiredLandmarks'] as unknown[])[0] = 1.5;
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.errors.find((e) => e.path === 'requiredLandmarks[0]');
      expect(err?.code).toBe('schema/type');
    }
  });

  it('rejects an unknown smoothing filter (Req 5.8) with its path', () => {
    const spec = clone(validSpec());
    ((spec['signal'] as Record<string, unknown>)['smoothing'] as Record<string, unknown>)['type'] =
      'kalman';
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.errors.find((e) => e.code === 'schema/unknown-smoothing-filter');
      expect(err?.path).toBe('signal.smoothing.type');
    }
  });
});

// ---------------------------------------------------------------------------
// Semantic failures
// ---------------------------------------------------------------------------

describe('validateSpec — semantic failures', () => {
  it('rejects an expression landmark missing from requiredLandmarks (Req 5.3)', () => {
    const spec = clone(validSpec());
    // Drop knee's indices from requiredLandmarks; the signal expr uses `knee`.
    spec['requiredLandmarks'] = [23, 24, 27, 28];
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expectCodes(r.errors, ['semantic/landmark-not-required']);
      const err = r.errors.find((e) => e.code === 'semantic/landmark-not-required');
      expect(err?.path).toBe('signal.expr');
    }
  });

  it('rejects an unresolvable joint reference', () => {
    const spec = clone(validSpec());
    (spec['signal'] as Record<string, unknown>)['expr'] = 'angle(hip,elbow,ankle)';
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) expectCodes(r.errors, ['semantic/unresolvable-ref']);
  });

  it('rejects a transition naming a phase not in phases.states (Req 5.3)', () => {
    const spec = clone(validSpec());
    const phases = spec['phases'] as Record<string, unknown>;
    (phases['transitions'] as Record<string, unknown>[])[0]!['to'] = 'MIDDLE';
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.errors.find((e) => e.code === 'semantic/unknown-phase');
      expect(err?.path).toBe('phases.transitions[0].to');
    }
  });

  it('rejects a fault naming a phase not in phases.states', () => {
    const spec = clone(validSpec());
    (spec['faults'] as Record<string, unknown>[])[0]!['phase'] = 'NOWHERE';
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.errors.find((e) => e.code === 'semantic/unknown-phase');
      expect(err?.path).toBe('faults[0].phase');
    }
  });

  it('rejects a phase graph that is not strongly connected (unreachable phase)', () => {
    const spec = clone(validSpec());
    const phases = spec['phases'] as Record<string, unknown>;
    phases['states'] = ['TOP', 'BOTTOM', 'ISLAND'];
    // ISLAND is declared but no transition touches it — unreachable both ways.
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) expectCodes(r.errors, ['semantic/unreachable-phase']);
  });

  it('rejects a graph reachable from initial but unable to return (not strongly connected)', () => {
    const spec = clone(validSpec());
    const phases = spec['phases'] as Record<string, unknown>;
    phases['states'] = ['TOP', 'BOTTOM', 'END'];
    phases['transitions'] = [
      { from: 'TOP', to: 'BOTTOM', when: 'dSignal < -0.01' },
      { from: 'BOTTOM', to: 'END', when: 'dSignal > 0.01', emits: 'RepCompleted' },
      // END is a sink: reachable from initial but cannot reach initial.
    ];
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) expectCodes(r.errors, ['semantic/unreachable-phase']);
  });

  it('rejects reps mode with zero RepCompleted transitions (Req 5.4)', () => {
    const spec = clone(validSpec());
    const phases = spec['phases'] as Record<string, unknown>;
    (phases['transitions'] as Record<string, unknown>[])[1]!['emits'] = undefined;
    delete (phases['transitions'] as Record<string, unknown>[])[1]!['emits'];
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) expectCodes(r.errors, ['semantic/rep-completed-count']);
  });

  it('rejects reps mode with two RepCompleted transitions (Req 5.4)', () => {
    const spec = clone(validSpec());
    const phases = spec['phases'] as Record<string, unknown>;
    (phases['transitions'] as Record<string, unknown>[])[0]!['emits'] = 'RepCompleted';
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) expectCodes(r.errors, ['semantic/rep-completed-count']);
  });

  it('rejects a cue longer than 4 words (Req 5.5)', () => {
    const spec = clone(validSpec());
    (spec['faults'] as Record<string, unknown>[])[0]!['cue'] = 'please try to go deeper';
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.errors.find((e) => e.code === 'semantic/cue-too-long');
      expect(err?.path).toBe('faults[0].cue');
    }
  });

  it('rejects a cue containing a banned word (e.g. corrective) (Req 5.5)', () => {
    const spec = clone(validSpec());
    (spec['faults'] as Record<string, unknown>[])[0]!['cue'] = 'corrective knees out';
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) expectCodes(r.errors, ['semantic/cue-banned-word']);
  });

  it('matches banned words case-insensitively and ignoring trailing punctuation', () => {
    const spec = clone(validSpec());
    (spec['faults'] as Record<string, unknown>[])[0]!['cue'] = 'Unsafe, stop';
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) expectCodes(r.errors, ['semantic/cue-banned-word']);
  });

  it('does not flag a benign word that merely contains a banned substring', () => {
    // "corrective" is banned; "correct" is not — whole-word match only.
    const spec = clone(validSpec());
    (spec['faults'] as Record<string, unknown>[])[0]!['cue'] = 'correct depth';
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r).toEqual({ ok: true });
  });

  it('rejects hysteresisPct below 0.05 (Req 5.6)', () => {
    const spec = clone(validSpec());
    (spec['phases'] as Record<string, unknown>)['hysteresisPct'] = 0.04;
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) expectCodes(r.errors, ['semantic/hysteresis-too-low']);
  });

  it('rejects minPhaseDurationMs below 250 (Req 5.6)', () => {
    const spec = clone(validSpec());
    (spec['phases'] as Record<string, unknown>)['minPhaseDurationMs'] = 200;
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) expectCodes(r.errors, ['semantic/min-phase-duration-too-low']);
  });

  it('rejects a spec with no matching fixture (Req 5.7)', () => {
    const r = validateSpec(validSpec(), { knownFixtureIds: new Set(['other-id']) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.errors.find((e) => e.code === 'semantic/missing-fixture');
      expect(err?.path).toBe('id');
    }
  });

  it('reports a malformed expression as a parse error', () => {
    const spec = clone(validSpec());
    (spec['signal'] as Record<string, unknown>)['expr'] = 'angle(hip,,ankle)';
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) expectCodes(r.errors, ['semantic/expression-parse']);
  });
});

// ---------------------------------------------------------------------------
// Error collection — all errors, not just the first
// ---------------------------------------------------------------------------

describe('validateSpec — collects multiple errors', () => {
  it('reports several independent semantic failures in one pass', () => {
    const spec = clone(validSpec());
    (spec['phases'] as Record<string, unknown>)['hysteresisPct'] = 0.01;
    (spec['phases'] as Record<string, unknown>)['minPhaseDurationMs'] = 100;
    (spec['faults'] as Record<string, unknown>[])[0]!['cue'] = 'this cue is dangerous and long';
    const r = validateSpec(spec, { knownFixtureIds: KNOWN_FIXTURES });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expectCodes(r.errors, [
        'semantic/hysteresis-too-low',
        'semantic/min-phase-duration-too-low',
        'semantic/cue-too-long',
        'semantic/cue-banned-word',
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// Exported constants sanity
// ---------------------------------------------------------------------------

describe('validator exported constants', () => {
  it('exposes the coaching-safety banned words', () => {
    expect(BANNED_CUE_WORDS).toContain('corrective');
    expect(BANNED_CUE_WORDS).toContain('injury');
  });

  it('exposes the documented bounds', () => {
    expect(MAX_CUE_WORDS).toBe(4);
    expect(MIN_HYSTERESIS_PCT).toBe(0.05);
    expect(MIN_PHASE_DURATION_MS).toBe(250);
  });
});
