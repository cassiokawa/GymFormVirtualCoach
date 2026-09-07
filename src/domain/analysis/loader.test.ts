import { describe, it, expect } from 'vitest';
import { loadSpecFromJson, loadAllSpecs, SpecParseError } from './loader';

/**
 * A minimal, well-formed raw document. Built inline (not from data files) so the
 * test never hardcodes a real exercise identity — the id/name here are dummies.
 */
function makeRawSpec(): Record<string, unknown> {
  return {
    id: 'dummy-id',
    version: '1',
    displayName: 'Dummy',
    aliases: [],
    facets: { equipment: 'none', primaryMuscles: [], position: 'standing' },
    mode: 'reps',
    bilateral: true,
    landmarkPairs: {},
    requiredLandmarks: [],
    optionalLandmarks: [],
    camera: { preferredAngleDeg: 90, toleranceDeg: 15, view: 'side' },
    signal: { expr: 'signal', smoothing: { type: 'oneEuro', minCutoff: 1, beta: 0.1 } },
    rom: { source: 'calibration', floorPercentile: 25, gateTolerance: 0.1 },
    phases: {
      states: ['A', 'B'],
      initial: 'A',
      hysteresisPct: 0.1,
      minPhaseDurationMs: 300,
      transitions: [{ from: 'A', to: 'B', when: 'signal > 0', emits: 'RepCompleted' }],
    },
    faults: [],
  };
}

describe('loadSpecFromJson', () => {
  it('parses a well-formed document into a typed ExerciseSpec', () => {
    const spec = loadSpecFromJson(makeRawSpec());
    expect(spec.mode).toBe('reps');
    expect(spec.phases.initial).toBe('A');
    expect(spec.signal.expr).toBe('signal');
  });

  it('accepts an optional velocity block', () => {
    const raw = makeRawSpec();
    raw['velocity'] = { trackedPoint: 'midpoint(left_hip,right_hip)', axis: 'y', normalizeBy: 'femur' };
    const spec = loadSpecFromJson(raw);
    expect(spec.velocity?.axis).toBe('y');
  });

  it('rejects a non-object document', () => {
    expect(() => loadSpecFromJson(null)).toThrow(SpecParseError);
    expect(() => loadSpecFromJson(42)).toThrow(SpecParseError);
    expect(() => loadSpecFromJson([])).toThrow(SpecParseError);
  });

  it('rejects a document missing a required primitive', () => {
    const raw = makeRawSpec();
    delete raw['id'];
    expect(() => loadSpecFromJson(raw)).toThrow(/id must be a string/);
  });

  it('rejects an invalid mode', () => {
    const raw = makeRawSpec();
    raw['mode'] = 'timed';
    expect(() => loadSpecFromJson(raw)).toThrow(/mode must be/);
  });

  it('rejects a signal without an expr', () => {
    const raw = makeRawSpec();
    raw['signal'] = { smoothing: {} };
    expect(() => loadSpecFromJson(raw)).toThrow(/signal.expr/);
  });

  it('rejects a malformed velocity block', () => {
    const raw = makeRawSpec();
    raw['velocity'] = 'fast';
    expect(() => loadSpecFromJson(raw)).toThrow(/velocity/);
  });
});

describe('loadAllSpecs', () => {
  it('returns an array and handles an empty exercises directory gracefully', () => {
    // With no exercise JSON present, discovery yields an empty list rather than
    // throwing. (When documents are added later this simply grows.)
    const specs = loadAllSpecs();
    expect(Array.isArray(specs)).toBe(true);
  });
});
