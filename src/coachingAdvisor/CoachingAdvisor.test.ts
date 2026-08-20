import { describe, it, expect, beforeEach } from 'vitest';
import { CoachingAdvisor } from './CoachingAdvisor.js';
import type { NextSessionParams, FullCoachingResult } from './CoachingAdvisor.js';
import { LlmGateway } from '../llmGateway/LlmGateway.js';
import type { SessionSummary, DeviationEvent } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeviationEvent(overrides: Partial<DeviationEvent> = {}): DeviationEvent {
  return {
    jointName: 'left_knee',
    angleValue: 45.5,
    severity: 'warning',
    timestampMs: 1000,
    repNumber: 1,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'test-session-001',
    totalCorrectReps: 5,
    totalFlawedReps: 0,
    totalDangerousReps: 0,
    setBreakdowns: [
      {
        exerciseName: 'barbell_squat',
        actualTutMs: 15000,
        expectedTutMs: 15000,
        tutDeltaMs: 0,
        correctReps: 5,
        flawedReps: 0,
        dangerousReps: 0,
      },
    ],
    allDeviationEvents: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CoachingAdvisor', () => {
  let gateway: LlmGateway;
  let advisor: CoachingAdvisor;

  beforeEach(() => {
    LlmGateway._resetInstance();
    gateway = LlmGateway.getInstance();
    // Set phase to post_workout so Coaching_Advisor calls are permitted
    gateway.setPhase('post_workout');
    advisor = new CoachingAdvisor(gateway);
  });

  describe('generateAdvice', () => {
    it('returns coaching advice with at least one recommendation for a clean session', async () => {
      const summary = makeSummary();
      const advice = await advisor.generateAdvice(summary);

      expect(advice.sessionId).toBe('test-session-001');
      expect(advice.recommendations.length).toBeGreaterThanOrEqual(1);
      expect(advice.generatedAt).toBeInstanceOf(Date);
    });

    it('produces ≥1 recommendation per deviation event', async () => {
      const events: DeviationEvent[] = [
        makeDeviationEvent({ jointName: 'left_knee', repNumber: 1, severity: 'warning' }),
        makeDeviationEvent({ jointName: 'right_knee', repNumber: 2, severity: 'critical' }),
        makeDeviationEvent({ jointName: 'left_hip', repNumber: 3, severity: 'warning' }),
      ];

      const summary = makeSummary({
        totalFlawedReps: 2,
        totalDangerousReps: 1,
        allDeviationEvents: events,
      });

      const advice = await advisor.generateAdvice(summary);

      // At least one recommendation per deviation event
      const jointRecommendations = advice.recommendations.filter((r) => r.relatedJoint !== undefined);
      expect(jointRecommendations.length).toBeGreaterThanOrEqual(events.length);
    });

    it('produces safety_warning for critical deviations', async () => {
      const events: DeviationEvent[] = [
        makeDeviationEvent({ severity: 'critical', jointName: 'left_knee', repNumber: 1 }),
      ];

      const summary = makeSummary({
        totalDangerousReps: 1,
        allDeviationEvents: events,
      });

      const advice = await advisor.generateAdvice(summary);
      const safetyWarnings = advice.recommendations.filter((r) => r.category === 'safety_warning');
      expect(safetyWarnings.length).toBeGreaterThanOrEqual(1);
    });

    it('produces form_correction for warning-level deviations', async () => {
      const events: DeviationEvent[] = [
        makeDeviationEvent({ severity: 'warning', jointName: 'right_hip', repNumber: 2 }),
      ];

      const summary = makeSummary({
        totalFlawedReps: 1,
        allDeviationEvents: events,
      });

      const advice = await advisor.generateAdvice(summary);
      const formCorrections = advice.recommendations.filter((r) => r.category === 'form_correction');
      expect(formCorrections.length).toBeGreaterThanOrEqual(1);
    });

    it('produces technique_tip when all reps are correct', async () => {
      const summary = makeSummary({
        totalCorrectReps: 10,
        totalFlawedReps: 0,
        totalDangerousReps: 0,
        allDeviationEvents: [],
      });

      const advice = await advisor.generateAdvice(summary);
      const tips = advice.recommendations.filter((r) => r.category === 'technique_tip');
      expect(tips.length).toBeGreaterThanOrEqual(1);
    });

    it('produces rep-category recommendation for dangerous reps', async () => {
      const summary = makeSummary({
        totalCorrectReps: 3,
        totalDangerousReps: 2,
        allDeviationEvents: [],
      });

      const advice = await advisor.generateAdvice(summary);
      const safetyRecs = advice.recommendations.filter(
        (r) => r.category === 'safety_warning' && r.message.includes('aborted'),
      );
      expect(safetyRecs.length).toBe(1);
    });

    it('falls back to rule-based when LLM gateway is in wrong phase', async () => {
      gateway.setPhase('session_active'); // LLM calls rejected during active session
      const summary = makeSummary({ totalFlawedReps: 2, allDeviationEvents: [] });

      const advice = await advisor.generateAdvice(summary);

      // Should still produce advice via fallback
      expect(advice.sessionId).toBe('test-session-001');
      expect(advice.recommendations.length).toBeGreaterThanOrEqual(1);
    });

    it('always produces at least one recommendation even for empty sessions', async () => {
      const summary = makeSummary({
        totalCorrectReps: 0,
        totalFlawedReps: 0,
        totalDangerousReps: 0,
        allDeviationEvents: [],
      });

      const advice = await advisor.generateAdvice(summary);
      expect(advice.recommendations.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('receiveSummary', () => {
    it('returns coaching advice when called via receiveSummary', async () => {
      const summary = makeSummary();
      const advice = await advisor.receiveSummary(summary);

      expect(advice.sessionId).toBe('test-session-001');
      expect(advice.recommendations.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('generateFullResult', () => {
    it('returns FullCoachingResult with advice, nextSessionParams, and rawSummary', async () => {
      const summary = makeSummary();
      const result = await advisor.generateFullResult(summary);

      expect(result.advice.sessionId).toBe('test-session-001');
      expect(result.nextSessionParams).toHaveLength(1);
      expect(result.rawSummary).toBe(summary);
      expect(result.advice.generatedAt).toBeInstanceOf(Date);
    });

    it('marks isLlmAvailable as true when LLM responds successfully', async () => {
      const summary = makeSummary();
      const result = await advisor.generateFullResult(summary);

      // The stub gateway returns "LLM response stub" which triggers rule-based,
      // but doesn't throw, so isLlmAvailable should be true
      expect(result.isLlmAvailable).toBe(true);
    });

    it('marks isLlmAvailable as false when LLM is unavailable and includes fallback message', async () => {
      gateway.setPhase('session_active'); // Forces PolicyViolationError
      const summary = makeSummary();
      const result = await advisor.generateFullResult(summary);

      expect(result.isLlmAvailable).toBe(false);
      const fallbackTip = result.advice.recommendations.find(
        (r) => r.category === 'technique_tip' && r.message === 'AI coaching unavailable. Showing raw session summary.',
      );
      expect(fallbackTip).toBeDefined();
    });

    it('always includes rawSummary for fallback display', async () => {
      gateway.setPhase('session_active');
      const summary = makeSummary({ totalFlawedReps: 3 });
      const result = await advisor.generateFullResult(summary);

      expect(result.rawSummary).toBe(summary);
      expect(result.rawSummary.totalFlawedReps).toBe(3);
    });
  });

  describe('computeNextSessionParams (via generateFullResult)', () => {
    it('returns UP action when ≥80% correct reps and TUT delta ≥ 0', async () => {
      const summary = makeSummary({
        setBreakdowns: [
          {
            exerciseName: 'barbell_squat',
            actualTutMs: 16000,
            expectedTutMs: 15000,
            tutDeltaMs: 1000,
            correctReps: 9,
            flawedReps: 1,
            dangerousReps: 0,
          },
        ],
      });

      const result = await advisor.generateFullResult(summary);
      const params = result.nextSessionParams[0] as NextSessionParams;

      expect(params.action).toBe('UP');
      expect(params.exerciseName).toBe('barbell_squat');
      expect(params.suggestedReps).toBe(10); // correctReps + 1 = 10
      expect(params.suggestedSets).toBe(4);
      expect(params.reason).toContain('Performance targets met');
    });

    it('returns HOLD action when correctness < 80%', async () => {
      const summary = makeSummary({
        setBreakdowns: [
          {
            exerciseName: 'barbell_squat',
            actualTutMs: 16000,
            expectedTutMs: 15000,
            tutDeltaMs: 1000,
            correctReps: 3,
            flawedReps: 5,
            dangerousReps: 2,
          },
        ],
      });

      const result = await advisor.generateFullResult(summary);
      const params = result.nextSessionParams[0] as NextSessionParams;

      expect(params.action).toBe('HOLD');
      expect(params.suggestedReps).toBe(8); // correctReps + flawedReps = 3 + 5
      expect(params.suggestedSets).toBe(3);
      expect(params.reason).toContain('Targets not met');
    });

    it('returns HOLD action when TUT delta < 0 even if correctness is high', async () => {
      const summary = makeSummary({
        setBreakdowns: [
          {
            exerciseName: 'deadlift',
            actualTutMs: 12000,
            expectedTutMs: 15000,
            tutDeltaMs: -3000,
            correctReps: 10,
            flawedReps: 0,
            dangerousReps: 0,
          },
        ],
      });

      const result = await advisor.generateFullResult(summary);
      const params = result.nextSessionParams[0] as NextSessionParams;

      expect(params.action).toBe('HOLD');
      expect(params.exerciseName).toBe('deadlift');
    });

    it('caps suggestedReps at 30 when UP', async () => {
      const summary = makeSummary({
        setBreakdowns: [
          {
            exerciseName: 'bicep_curl',
            actualTutMs: 60000,
            expectedTutMs: 55000,
            tutDeltaMs: 5000,
            correctReps: 30,
            flawedReps: 0,
            dangerousReps: 0,
          },
        ],
      });

      const result = await advisor.generateFullResult(summary);
      const params = result.nextSessionParams[0] as NextSessionParams;

      expect(params.action).toBe('UP');
      expect(params.suggestedReps).toBe(30); // min(30 + 1, 30) = 30
    });

    it('returns HOLD when total reps is zero (avoids division by zero)', async () => {
      const summary = makeSummary({
        setBreakdowns: [
          {
            exerciseName: 'empty_set',
            actualTutMs: 0,
            expectedTutMs: 15000,
            tutDeltaMs: -15000,
            correctReps: 0,
            flawedReps: 0,
            dangerousReps: 0,
          },
        ],
      });

      const result = await advisor.generateFullResult(summary);
      const params = result.nextSessionParams[0] as NextSessionParams;

      expect(params.action).toBe('HOLD');
      expect(params.suggestedReps).toBe(0);
    });

    it('produces one NextSessionParams per set breakdown', async () => {
      const summary = makeSummary({
        setBreakdowns: [
          {
            exerciseName: 'barbell_squat',
            actualTutMs: 15000,
            expectedTutMs: 15000,
            tutDeltaMs: 0,
            correctReps: 8,
            flawedReps: 2,
            dangerousReps: 0,
          },
          {
            exerciseName: 'bench_press',
            actualTutMs: 20000,
            expectedTutMs: 18000,
            tutDeltaMs: 2000,
            correctReps: 10,
            flawedReps: 0,
            dangerousReps: 0,
          },
        ],
      });

      const result = await advisor.generateFullResult(summary);

      expect(result.nextSessionParams).toHaveLength(2);
      expect(result.nextSessionParams[0]?.exerciseName).toBe('barbell_squat');
      expect(result.nextSessionParams[0]?.action).toBe('UP'); // 8/10 = 80% meets threshold + TUT delta = 0
      expect(result.nextSessionParams[1]?.exerciseName).toBe('bench_press');
      expect(result.nextSessionParams[1]?.action).toBe('UP'); // 10/10 = 100% + positive TUT delta
    });

    it('exactly 80% correctness with TUT delta = 0 results in UP', async () => {
      const summary = makeSummary({
        setBreakdowns: [
          {
            exerciseName: 'squat',
            actualTutMs: 15000,
            expectedTutMs: 15000,
            tutDeltaMs: 0,
            correctReps: 8,
            flawedReps: 2,
            dangerousReps: 0,
          },
        ],
      });

      const result = await advisor.generateFullResult(summary);
      const params = result.nextSessionParams[0] as NextSessionParams;

      // 8/10 = 0.8, which is >= 0.8, and tutDelta = 0, which is >= 0
      expect(params.action).toBe('UP');
    });
  });
});
