/**
 * Safety_Monitor for the CV Fitness & Form Assistant.
 *
 * Receives critical-severity `DeviationEvent` notifications from Form_Evaluator
 * and determines the specific safety alert type before triggering Alert_System.
 *
 * Detections (Requirements 5.5, 5.6):
 *   - Valgus_Cave: medial knee JointAngle below per-exercise threshold
 *   - Excessive lumbar extension: lumbar spine JointAngle above per-exercise threshold
 *
 * Must trigger Alert_System within 10 ms of receiving a critical notification
 * (Requirements 5.1, 12.3).
 */

import type { DeviationEvent, ExerciseFSMConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Classifies the type of safety alert so Alert_System can display
 * contextually meaningful overlay text.
 *
 * Requirements 5.5, 5.6
 */
export type SafetyAlertType =
  | 'valgus_cave'          // Knee caving inward (Requirement 5.5)
  | 'lumbar_extension'     // Excessive lower-back extension (Requirement 5.6)
  | 'critical_deviation';  // Generic critical deviation fallback

/**
 * Callback invoked synchronously when the Safety_Monitor decides to trigger
 * the Alert_System.  Must be called within ≤10 ms of receiving the
 * critical deviation notification (Requirements 5.1, 12.3).
 */
export type AlertCallback = (
  event: DeviationEvent,
  alertType: SafetyAlertType,
) => void;

// ---------------------------------------------------------------------------
// SafetyMonitor class
// ---------------------------------------------------------------------------

/**
 * Evaluates incoming critical `DeviationEvent`s, classifies them as a
 * `SafetyAlertType`, and calls the Alert_System trigger callback.
 *
 * Requirements: 5.1, 5.5, 5.6
 */
export class SafetyMonitor {
  private readonly alertCallback: AlertCallback;
  private readonly config: ExerciseFSMConfig;

  /**
   * @param config  The active exercise configuration providing per-exercise
   *                critical thresholds for Valgus_Cave and lumbar extension.
   * @param alertCallback Callback invoked immediately when a critical deviation
   *                      is classified. This is typically `AlertSystem.trigger`.
   */
  constructor(config: ExerciseFSMConfig, alertCallback: AlertCallback) {
    this.config = config;
    this.alertCallback = alertCallback;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Receive a critical-severity `DeviationEvent` from Form_Evaluator,
   * classify the alert type, and trigger Alert_System within ≤10 ms.
   *
   * Requirements: 5.1, 12.3
   */
  onCriticalDeviation(event: DeviationEvent): void {
    const t0 = performance.now();
    const alertType = this.classifyAlert(event);
    this.alertCallback(event, alertType);
    const elapsed = performance.now() - t0;
    if (elapsed > 10) {
      console.warn(
        `[SafetyMonitor] Alert dispatch exceeded 10ms: ${elapsed.toFixed(2)}ms`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Derive the `SafetyAlertType` from the deviation event using per-exercise
   * critical thresholds.
   *
   * Classification rules (Requirements 5.5, 5.6):
   * - Joint name contains "knee" AND angleValue < criticalThreshold.min
   *   → Valgus_Cave (knee caving inward)
   * - Joint name contains "hip", "lumbar", or "spine" AND angleValue > criticalThreshold.max
   *   → lumbar_extension (excessive lower-back extension)
   * - Anything else → generic critical_deviation
   */
  private classifyAlert(event: DeviationEvent): SafetyAlertType {
    const joint = event.jointName.toLowerCase();

    if (joint.includes('knee') && event.angleValue < this.config.criticalThreshold.min) {
      return 'valgus_cave';
    }

    if (
      (joint.includes('hip') || joint.includes('lumbar') || joint.includes('spine')) &&
      event.angleValue > this.config.criticalThreshold.max
    ) {
      return 'lumbar_extension';
    }

    return 'critical_deviation';
  }
}
