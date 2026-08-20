import { describe, it, expect, vi } from 'vitest';
import { AnalyticsEngine } from './AnalyticsEngine.js';
import type { Session, SessionSummary, DeviationEvent, Rep, SetRecord } from '../types/index.js';

function makeDeviationEvent(overrides: Partial<DeviationEvent> = {}): DeviationEvent {
  return {
    jointName: 'left_knee',
    angleValue: 45,
    severity: 'warning',
    timestampMs: 1000,
    repNumber: 1,
    ...overrides,
  };
}

function makeRep(overrides: Partial<Rep> = {}): Rep {
  return {
    repNumber: 1,
    tutMs: 3000,
    category: 'correct',
    deviationEvents: [],
    ...overrides,
  };
}

function makeSetRecord(overrides: Partial<SetRecord> = {}): SetRecord {
  return {
    setNumber: 1,
    exerciseName: 'barbell_squat',
    reps: [makeRep()],
    actualTutMs: 3000,
    expectedTutMs: 4000,
    tutDeltaMs: -1000,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-001',
    startedAt: new Date('2025-01-01T10:00:00Z'),
    endedAt: new Date('2025-01-01T11:00:00Z'),
    durationMs: 3600000,
    routineId: 'routine-001',
    sets: [makeSetRecord()],
    ...overrides,
  };
}

describe('AnalyticsEngine.assembleSessionSummary', () => {
  const engine = new AnalyticsEngine();

  it('assembles a summary with correct rep counts across multiple sets', () => {
    const session = makeSession({
      sets: [
        makeSetRecord({
          setNumber: 1,
          reps: [
            makeRep({ repNumber: 1, tutMs: 2000, deviationEvents: [] }),
            makeRep({ repNumber: 2, tutMs: 2500, deviationEvents: [makeDeviationEvent({ severity: 'warning' })] }),
          ],
          expectedTutMs: 5000,
        }),
        makeSetRecord({
          setNumber: 2,
          exerciseName: 'deadlift',
          reps: [
            makeRep({ repNumber: 1, tutMs: 3000, deviationEvents: [makeDeviationEvent({ severity: 'critical' })] }),
            makeRep({ repNumber: 2, tutMs: 3000, deviationEvents: [] }),
          ],
          expectedTutMs: 7000,
        }),
      ],
    });

    const summary = engine.assembleSessionSummary(session);

    expect(summary.sessionId).toBe('session-001');
    // Set 1: 1 correct, 1 flawed; Set 2: 1 dangerous, 1 correct
    expect(summary.totalCorrectReps).toBe(2);
    expect(summary.totalFlawedReps).toBe(1);
    expect(summary.totalDangerousReps).toBe(1);
    expect(summary.setBreakdowns).toHaveLength(2);
    expect(summary.setBreakdowns[0]!.exerciseName).toBe('barbell_squat');
    expect(summary.setBreakdowns[0]!.correctReps).toBe(1);
    expect(summary.setBreakdowns[0]!.flawedReps).toBe(1);
    expect(summary.setBreakdowns[1]!.exerciseName).toBe('deadlift');
    expect(summary.setBreakdowns[1]!.dangerousReps).toBe(1);
  });

  it('includes all deviation events from all sets', () => {
    const evt1 = makeDeviationEvent({ jointName: 'left_knee', severity: 'warning' });
    const evt2 = makeDeviationEvent({ jointName: 'right_hip', severity: 'critical' });
    const session = makeSession({
      sets: [
        makeSetRecord({
          reps: [
            makeRep({ deviationEvents: [evt1] }),
            makeRep({ deviationEvents: [evt2] }),
          ],
        }),
      ],
    });

    const summary = engine.assembleSessionSummary(session);

    expect(summary.allDeviationEvents).toHaveLength(2);
    expect(summary.allDeviationEvents).toContainEqual(evt1);
    expect(summary.allDeviationEvents).toContainEqual(evt2);
  });

  it('computes TUT delta correctly in setBreakdowns', () => {
    const session = makeSession({
      sets: [
        makeSetRecord({
          reps: [makeRep({ tutMs: 2000 }), makeRep({ tutMs: 3000 })],
          expectedTutMs: 6000,
        }),
      ],
    });

    const summary = engine.assembleSessionSummary(session);

    // actualTutMs = 2000 + 3000 = 5000, expectedTutMs = 6000, delta = -1000
    expect(summary.setBreakdowns[0]!.actualTutMs).toBe(5000);
    expect(summary.setBreakdowns[0]!.expectedTutMs).toBe(6000);
    expect(summary.setBreakdowns[0]!.tutDeltaMs).toBe(-1000);
  });

  it('handles an empty session with no sets', () => {
    const session = makeSession({ sets: [] });

    const summary = engine.assembleSessionSummary(session);

    expect(summary.totalCorrectReps).toBe(0);
    expect(summary.totalFlawedReps).toBe(0);
    expect(summary.totalDangerousReps).toBe(0);
    expect(summary.setBreakdowns).toHaveLength(0);
    expect(summary.allDeviationEvents).toHaveLength(0);
  });
});

describe('AnalyticsEngine.dispatchSummary', () => {
  const engine = new AnalyticsEngine();

  it('dispatches summary to both Coaching_Advisor and Storage', async () => {
    const summary: SessionSummary = {
      sessionId: 'session-001',
      totalCorrectReps: 5,
      totalFlawedReps: 2,
      totalDangerousReps: 1,
      setBreakdowns: [],
      allDeviationEvents: [],
    };

    const coachingAdvisor = { receiveSummary: vi.fn().mockResolvedValue(undefined) };
    const storage = { persistSummary: vi.fn().mockResolvedValue(undefined) };

    await engine.dispatchSummary(summary, coachingAdvisor, storage);

    expect(coachingAdvisor.receiveSummary).toHaveBeenCalledWith(summary);
    expect(storage.persistSummary).toHaveBeenCalledWith(summary);
  });

  it('calls both consumers concurrently', async () => {
    const summary: SessionSummary = {
      sessionId: 'session-002',
      totalCorrectReps: 0,
      totalFlawedReps: 0,
      totalDangerousReps: 0,
      setBreakdowns: [],
      allDeviationEvents: [],
    };

    const order: string[] = [];
    const coachingAdvisor = {
      receiveSummary: vi.fn(async () => { order.push('coach'); }),
    };
    const storage = {
      persistSummary: vi.fn(async () => { order.push('storage'); }),
    };

    await engine.dispatchSummary(summary, coachingAdvisor, storage);

    expect(order).toContain('coach');
    expect(order).toContain('storage');
  });
});
