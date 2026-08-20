import { describe, it, expect, vi } from 'vitest';
import { SessionPersister } from './SessionPersister.js';
import type { Session, SessionSummary } from '../types/index.js';
import type { Storage } from '../storage/Storage.js';
import type { AnalyticsEngine } from '../analyticsEngine/AnalyticsEngine.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-001',
    startedAt: new Date('2025-01-01T10:00:00Z'),
    endedAt: new Date('2025-01-01T10:30:00Z'),
    durationMs: 1_800_000,
    routineId: 'routine-abc',
    sets: [
      {
        setNumber: 1,
        exerciseName: 'barbell_squat',
        reps: [
          { repNumber: 1, tutMs: 3000, category: 'correct', deviationEvents: [] },
          { repNumber: 2, tutMs: 2800, category: 'flawed', deviationEvents: [
            { jointName: 'left_knee', angleValue: 45, severity: 'warning', timestampMs: 100, repNumber: 2 },
          ] },
        ],
        actualTutMs: 5800,
        expectedTutMs: 6000,
        tutDeltaMs: -200,
      },
    ],
    ...overrides,
  };
}

function makeSummary(sessionId: string): SessionSummary {
  return {
    sessionId,
    totalCorrectReps: 1,
    totalFlawedReps: 1,
    totalDangerousReps: 0,
    setBreakdowns: [
      {
        exerciseName: 'barbell_squat',
        actualTutMs: 5800,
        expectedTutMs: 6000,
        tutDeltaMs: -200,
        correctReps: 1,
        flawedReps: 1,
        dangerousReps: 0,
      },
    ],
    allDeviationEvents: [
      { jointName: 'left_knee', angleValue: 45, severity: 'warning', timestampMs: 100, repNumber: 2 },
    ],
  };
}

describe('SessionPersister', () => {
  it('calls Storage.persist() with the session', async () => {
    const session = makeSession();
    const summary = makeSummary(session.id);

    const mockStorage = {
      persist: vi.fn().mockResolvedValue(undefined),
    } as unknown as Storage;

    const mockAnalytics = {
      assembleSessionSummary: vi.fn().mockReturnValue(summary),
    } as unknown as AnalyticsEngine;

    const persister = new SessionPersister(mockStorage, mockAnalytics);
    await persister.persistAndAnalyze(session);

    expect(mockStorage.persist).toHaveBeenCalledOnce();
    expect(mockStorage.persist).toHaveBeenCalledWith(session);
  });

  it('calls AnalyticsEngine.assembleSessionSummary() with the session', async () => {
    const session = makeSession();
    const summary = makeSummary(session.id);

    const mockStorage = {
      persist: vi.fn().mockResolvedValue(undefined),
    } as unknown as Storage;

    const mockAnalytics = {
      assembleSessionSummary: vi.fn().mockReturnValue(summary),
    } as unknown as AnalyticsEngine;

    const persister = new SessionPersister(mockStorage, mockAnalytics);
    await persister.persistAndAnalyze(session);

    expect(mockAnalytics.assembleSessionSummary).toHaveBeenCalledOnce();
    expect(mockAnalytics.assembleSessionSummary).toHaveBeenCalledWith(session);
  });

  it('returns both the session and the summary', async () => {
    const session = makeSession();
    const summary = makeSummary(session.id);

    const mockStorage = {
      persist: vi.fn().mockResolvedValue(undefined),
    } as unknown as Storage;

    const mockAnalytics = {
      assembleSessionSummary: vi.fn().mockReturnValue(summary),
    } as unknown as AnalyticsEngine;

    const persister = new SessionPersister(mockStorage, mockAnalytics);
    const result = await persister.persistAndAnalyze(session);

    expect(result.session).toBe(session);
    expect(result.summary).toBe(summary);
  });

  it('propagates Storage.persist() rejection', async () => {
    const session = makeSession();

    const mockStorage = {
      persist: vi.fn().mockRejectedValue(new Error('IndexedDB write failed')),
    } as unknown as Storage;

    const mockAnalytics = {
      assembleSessionSummary: vi.fn(),
    } as unknown as AnalyticsEngine;

    const persister = new SessionPersister(mockStorage, mockAnalytics);

    await expect(persister.persistAndAnalyze(session)).rejects.toThrow('IndexedDB write failed');
    // AnalyticsEngine should NOT be called if persist fails
    expect(mockAnalytics.assembleSessionSummary).not.toHaveBeenCalled();
  });
});
