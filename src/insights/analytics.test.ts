/**
 * Unit tests for the insights analytics engine.
 */

import { describe, it, expect } from 'vitest';
import {
  computeInsights,
  computeMuscleActivations,
  computeExerciseQuality,
  computeStreak,
  computeGrowthStats,
  computeSymmetry,
} from './analytics.js';
import type { Session, SetRecord, Rep, DeviationEvent } from '../types/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rep(category: Rep['category'], deviations: DeviationEvent[] = []): Rep {
  return { repNumber: 1, tutMs: 1000, category, deviationEvents: deviations };
}

function dev(joint: string, severity: 'warning' | 'critical' = 'warning'): DeviationEvent {
  return { jointName: joint, angleValue: 45, severity, timestampMs: 0, repNumber: 1 };
}

function set(exerciseName: string, reps: Rep[], setNumber = 1): SetRecord {
  return {
    setNumber,
    exerciseName,
    reps,
    actualTutMs: reps.length * 1000,
    expectedTutMs: reps.length * 1000,
    tutDeltaMs: 0,
  };
}

function session(startedAt: Date, sets: SetRecord[]): Session {
  return {
    id: `s-${startedAt.getTime()}`,
    startedAt,
    endedAt: new Date(startedAt.getTime() + 60000),
    durationMs: 60000,
    routineId: 'test',
    sets,
  };
}

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Muscle activation
// ---------------------------------------------------------------------------

describe('computeMuscleActivations', () => {
  it('attributes squat reps to leg muscles', () => {
    const s = session(new Date(), [set('barbell_squat', [rep('correct'), rep('correct'), rep('correct')])]);
    const acts = computeMuscleActivations([s]);
    const regions = acts.map((a) => a.region);
    expect(regions).toContain('quads');
    expect(regions).toContain('glutes');
    // Primary mover (quads) has the highest weighted volume.
    const quads = acts.find((a) => a.region === 'quads')!;
    expect(quads.intensity).toBe(1); // most-worked muscle normalizes to 1
  });

  it('reflects form quality: all-correct reps yield high quality, flawed lowers it', () => {
    const good = session(new Date(), [set('push_up', [rep('correct'), rep('correct')])]);
    const bad = session(new Date(), [set('push_up', [rep('flawed'), rep('dangerous_aborted')])]);

    const goodChest = computeMuscleActivations([good]).find((a) => a.region === 'chest')!;
    const badChest = computeMuscleActivations([bad]).find((a) => a.region === 'chest')!;
    expect(goodChest.quality).toBeGreaterThan(badChest.quality);
    expect(goodChest.quality).toBe(1);
  });

  it('ignores exercises with no mappable muscles gracefully', () => {
    const s = session(new Date(), [set('unknown_exercise', [rep('correct')])]);
    expect(computeMuscleActivations([s])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Form quality
// ---------------------------------------------------------------------------

describe('computeExerciseQuality', () => {
  it('computes clean-rep percentage and top deviations per exercise', () => {
    const s = session(new Date(), [
      set('barbell_squat', [
        rep('correct'),
        rep('flawed', [dev('left_knee'), dev('left_knee')]),
        rep('flawed', [dev('right_hip')]),
        rep('correct'),
      ]),
    ]);
    const q = computeExerciseQuality([s]);
    expect(q).toHaveLength(1);
    expect(q[0]!.totalReps).toBe(4);
    expect(q[0]!.correctReps).toBe(2);
    expect(q[0]!.qualityPercent).toBe(50);
    // left_knee flagged twice -> top deviation.
    expect(q[0]!.topDeviations[0]).toEqual({ joint: 'left_knee', count: 2 });
  });

  it('sorts worst-quality exercises first', () => {
    const s = session(new Date(), [
      set('push_up', [rep('correct'), rep('correct')]),          // 100%
      set('barbell_squat', [rep('flawed'), rep('correct')]),      // 50%
    ]);
    const q = computeExerciseQuality([s]);
    expect(q[0]!.exerciseName).toBe('barbell_squat');
  });
});

// ---------------------------------------------------------------------------
// Streak
// ---------------------------------------------------------------------------

describe('computeStreak', () => {
  const now = new Date('2026-03-10T12:00:00Z').getTime();

  it('counts consecutive days ending today', () => {
    const sessions = [
      session(new Date(now), []),
      session(new Date(now - DAY), []),
      session(new Date(now - 2 * DAY), []),
    ];
    expect(computeStreak(sessions, now)).toBe(3);
  });

  it('allows the streak to count from yesterday', () => {
    const sessions = [session(new Date(now - DAY), []), session(new Date(now - 2 * DAY), [])];
    expect(computeStreak(sessions, now)).toBe(2);
  });

  it('breaks the streak on a gap', () => {
    const sessions = [session(new Date(now), []), session(new Date(now - 3 * DAY), [])];
    expect(computeStreak(sessions, now)).toBe(1);
  });

  it('returns 0 when the last workout is too old', () => {
    const sessions = [session(new Date(now - 5 * DAY), [])];
    expect(computeStreak(sessions, now)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

describe('computeInsights recommendations', () => {
  it('flags low-form exercises as high priority', () => {
    const s = session(new Date(), [
      set('barbell_squat', [rep('flawed', [dev('left_knee')]), rep('dangerous_aborted'), rep('flawed')]),
    ]);
    const report = computeInsights([s]);
    const formRec = report.recommendations.find((r) => r.kind === 'form');
    expect(formRec).toBeDefined();
    expect(formRec!.priority).toBe('high');
    expect(formRec!.message).toMatch(/squat/i);
  });

  it('flags push/pull imbalance', () => {
    // Lots of push (push-ups), no pull.
    const s = session(new Date(), [
      set('push_up', Array.from({ length: 30 }, () => rep('correct'))),
    ]);
    const report = computeInsights([s]);
    const balance = report.recommendations.find((r) => r.kind === 'balance');
    expect(balance).toBeDefined();
  });

  it('reports no data for an empty history', () => {
    const report = computeInsights([]);
    expect(report.hasData).toBe(false);
    expect(report.activations).toEqual([]);
  });
});

describe('computeGrowthStats', () => {
  const now = new Date('2026-03-10T12:00:00Z').getTime();
  const DAY2 = 24 * 60 * 60 * 1000;

  it('counts weekly sets per muscle and flags under-target muscles', () => {
    // 3 squat sets this week -> quads get ~3 weighted sets, below 10 target.
    const s = session(new Date(now - DAY2), [
      set('barbell_squat', [rep('correct')], 1),
      set('barbell_squat', [rep('correct')], 2),
      set('barbell_squat', [rep('correct')], 3),
    ]);
    const g = computeGrowthStats([s], now);
    const quads = g.find((x) => x.region === 'quads')!;
    expect(quads.weeklySets).toBeGreaterThan(0);
    expect(quads.status).toBe('under');
    expect(quads.daysSinceTrained).toBe(1);
    // 1 day of rest = still recovering (< 2 days).
    expect(quads.recovery).toBe('recovering');
  });

  it('marks muscles trained long ago as stale', () => {
    const s = session(new Date(now - 9 * DAY2), [set('push_up', [rep('correct')])]);
    const g = computeGrowthStats([s], now);
    const chest = g.find((x) => x.region === 'chest')!;
    expect(chest.recovery).toBe('stale');
    expect(chest.weeklySets).toBe(0); // outside the 7-day window
  });
});

describe('computeSymmetry', () => {
  it('flags a side that is disproportionately deviation-flagged', () => {
    const reps = [
      rep('flawed', [dev('left_knee'), dev('left_knee')]),
      rep('flawed', [dev('left_knee'), dev('right_knee')]),
    ];
    const s = session(new Date(), [set('barbell_squat', reps)]);
    const sym = computeSymmetry([s]);
    const knee = sym.find((x) => x.joint === 'knee')!;
    expect(knee.leftFlags).toBe(3);
    expect(knee.rightFlags).toBe(1);
    expect(knee.dominantSide).toBe('left');
  });

  it('ignores joints with too little signal', () => {
    const s = session(new Date(), [set('barbell_squat', [rep('flawed', [dev('left_knee')])])]);
    expect(computeSymmetry([s])).toEqual([]); // only 1 flag < threshold of 3
  });
});

