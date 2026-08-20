/**
 * Unit tests for SafetyMonitor.
 *
 * Requirements covered: 5.1, 5.5, 5.6
 */

import { describe, it, expect, vi } from 'vitest';
import { SafetyMonitor } from './SafetyMonitor.js';
import type { AlertCallback, SafetyAlertType } from './SafetyMonitor.js';
import type { DeviationEvent, ExerciseFSMConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Squat config — criticalThreshold.min = 0, max = 160 for Valgus_Cave detection */
const squatConfig: ExerciseFSMConfig = {
  exerciseName: 'barbell_squat',
  joints: ['left_knee', 'right_knee', 'left_hip', 'right_hip'],
  startThreshold: { min: 160, max: 180 },
  inflectionThreshold: { min: 90, max: 130 },
  completeThreshold: { min: 60, max: 95 },
  warningThreshold: { min: 0, max: 55 },
  criticalThreshold: { min: 0, max: 160 },
};

/** Deadlift config — criticalThreshold.min = 185, max = 220 for lumbar extension */
const deadliftConfig: ExerciseFSMConfig = {
  exerciseName: 'conventional_deadlift',
  joints: ['left_hip', 'right_hip', 'left_knee', 'right_knee'],
  startThreshold: { min: 160, max: 180 },
  inflectionThreshold: { min: 100, max: 140 },
  completeThreshold: { min: 60, max: 100 },
  warningThreshold: { min: 0, max: 50 },
  criticalThreshold: { min: 185, max: 220 },
};

function makeDeviationEvent(overrides: Partial<DeviationEvent> = {}): DeviationEvent {
  return {
    jointName: 'left_knee',
    angleValue: 140,
    severity: 'critical',
    timestampMs: Date.now(),
    repNumber: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Valgus_Cave detection (Requirement 5.5)
// ---------------------------------------------------------------------------

describe('SafetyMonitor — Valgus_Cave detection', () => {
  it('classifies knee deviation below criticalThreshold.min as valgus_cave', () => {
    const alerts: Array<{ event: DeviationEvent; alertType: SafetyAlertType }> = [];
    const callback: AlertCallback = (event, alertType) => {
      alerts.push({ event, alertType });
    };

    // For squat config, criticalThreshold.min = 0
    // A knee angle below 0 is physically impossible, so let's use a config
    // where min is meaningful. The squat config has min=0, so any negative
    // value would trigger. Let's test with a config where min > 0 wouldn't
    // apply here. Instead, note the task says "below per-exercise threshold"
    // — for squat the knee caving threshold is actually checked by the
    // Form_Evaluator sending critical events. The SafetyMonitor classifies
    // based on joint name containing 'knee' AND angleValue < min.
    // With min=0, no angle will be below it in normal cases.
    // Let's use a custom config with a meaningful min threshold.
    const customConfig: ExerciseFSMConfig = {
      ...squatConfig,
      criticalThreshold: { min: 160, max: 200 },
    };

    const monitor = new SafetyMonitor(customConfig, callback);
    const event = makeDeviationEvent({ jointName: 'left_knee', angleValue: 150 });

    monitor.onCriticalDeviation(event);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.alertType).toBe('valgus_cave');
    expect(alerts[0]!.event).toBe(event);
  });

  it('classifies right_knee deviation below threshold as valgus_cave', () => {
    const alerts: Array<{ event: DeviationEvent; alertType: SafetyAlertType }> = [];
    const callback: AlertCallback = (event, alertType) => {
      alerts.push({ event, alertType });
    };

    const customConfig: ExerciseFSMConfig = {
      ...squatConfig,
      criticalThreshold: { min: 160, max: 200 },
    };

    const monitor = new SafetyMonitor(customConfig, callback);
    const event = makeDeviationEvent({ jointName: 'right_knee', angleValue: 155 });

    monitor.onCriticalDeviation(event);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.alertType).toBe('valgus_cave');
  });

  it('does NOT classify knee deviation at or above threshold as valgus_cave', () => {
    const alerts: Array<{ event: DeviationEvent; alertType: SafetyAlertType }> = [];
    const callback: AlertCallback = (event, alertType) => {
      alerts.push({ event, alertType });
    };

    const customConfig: ExerciseFSMConfig = {
      ...squatConfig,
      criticalThreshold: { min: 160, max: 200 },
    };

    const monitor = new SafetyMonitor(customConfig, callback);
    const event = makeDeviationEvent({ jointName: 'left_knee', angleValue: 160 });

    monitor.onCriticalDeviation(event);

    expect(alerts).toHaveLength(1);
    // Angle is at threshold (not below), so it falls through to generic
    expect(alerts[0]!.alertType).toBe('critical_deviation');
  });
});

// ---------------------------------------------------------------------------
// Lumbar extension detection (Requirement 5.6)
// ---------------------------------------------------------------------------

describe('SafetyMonitor — Lumbar extension detection', () => {
  it('classifies lumbar deviation above criticalThreshold.max as lumbar_extension', () => {
    const alerts: Array<{ event: DeviationEvent; alertType: SafetyAlertType }> = [];
    const callback: AlertCallback = (event, alertType) => {
      alerts.push({ event, alertType });
    };

    const monitor = new SafetyMonitor(deadliftConfig, callback);
    const event = makeDeviationEvent({ jointName: 'lumbar_spine', angleValue: 225 });

    monitor.onCriticalDeviation(event);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.alertType).toBe('lumbar_extension');
  });

  it('classifies spine deviation above threshold as lumbar_extension', () => {
    const alerts: Array<{ event: DeviationEvent; alertType: SafetyAlertType }> = [];
    const callback: AlertCallback = (event, alertType) => {
      alerts.push({ event, alertType });
    };

    const monitor = new SafetyMonitor(deadliftConfig, callback);
    const event = makeDeviationEvent({ jointName: 'lower_spine', angleValue: 221 });

    monitor.onCriticalDeviation(event);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.alertType).toBe('lumbar_extension');
  });

  it('classifies hip deviation above threshold as lumbar_extension', () => {
    const alerts: Array<{ event: DeviationEvent; alertType: SafetyAlertType }> = [];
    const callback: AlertCallback = (event, alertType) => {
      alerts.push({ event, alertType });
    };

    const monitor = new SafetyMonitor(deadliftConfig, callback);
    const event = makeDeviationEvent({ jointName: 'left_hip', angleValue: 225 });

    monitor.onCriticalDeviation(event);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.alertType).toBe('lumbar_extension');
  });

  it('does NOT classify lumbar deviation at or below threshold as lumbar_extension', () => {
    const alerts: Array<{ event: DeviationEvent; alertType: SafetyAlertType }> = [];
    const callback: AlertCallback = (event, alertType) => {
      alerts.push({ event, alertType });
    };

    const monitor = new SafetyMonitor(deadliftConfig, callback);
    const event = makeDeviationEvent({ jointName: 'lumbar_spine', angleValue: 220 });

    monitor.onCriticalDeviation(event);

    expect(alerts).toHaveLength(1);
    // Angle is at threshold (not above), so falls through
    expect(alerts[0]!.alertType).toBe('critical_deviation');
  });
});

// ---------------------------------------------------------------------------
// Generic critical deviation fallback
// ---------------------------------------------------------------------------

describe('SafetyMonitor — Generic critical deviation', () => {
  it('classifies unrecognized joint deviations as critical_deviation', () => {
    const alerts: Array<{ event: DeviationEvent; alertType: SafetyAlertType }> = [];
    const callback: AlertCallback = (event, alertType) => {
      alerts.push({ event, alertType });
    };

    const monitor = new SafetyMonitor(squatConfig, callback);
    const event = makeDeviationEvent({ jointName: 'left_shoulder', angleValue: 45 });

    monitor.onCriticalDeviation(event);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.alertType).toBe('critical_deviation');
  });
});

// ---------------------------------------------------------------------------
// Alert timing (Requirement 5.1)
// ---------------------------------------------------------------------------

describe('SafetyMonitor — Alert timing', () => {
  it('triggers alertCallback synchronously on onCriticalDeviation', () => {
    let callbackInvoked = false;
    const callback: AlertCallback = () => {
      callbackInvoked = true;
    };

    const monitor = new SafetyMonitor(squatConfig, callback);
    const event = makeDeviationEvent();

    monitor.onCriticalDeviation(event);

    expect(callbackInvoked).toBe(true);
  });

  it('logs a warning when alert dispatch exceeds 10ms', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Create a callback that artificially delays
    const slowCallback: AlertCallback = () => {
      const end = performance.now() + 15;
      while (performance.now() < end) {
        // busy-wait to simulate slow callback
      }
    };

    const monitor = new SafetyMonitor(squatConfig, slowCallback);
    const event = makeDeviationEvent();

    monitor.onCriticalDeviation(event);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[SafetyMonitor] Alert dispatch exceeded 10ms'),
    );

    warnSpy.mockRestore();
  });

  it('does NOT log a warning when alert dispatch is fast', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const fastCallback: AlertCallback = () => {
      // intentionally empty — instant return
    };

    const monitor = new SafetyMonitor(squatConfig, fastCallback);
    const event = makeDeviationEvent();

    monitor.onCriticalDeviation(event);

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
