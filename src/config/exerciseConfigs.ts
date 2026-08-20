/**
 * ExerciseFSMConfig schema validation for the CV Fitness & Form Assistant.
 *
 * Provides a guard function to validate ExerciseFSMConfig objects before
 * they are used by the Rep_Counter FSM and Form_Evaluator.
 *
 * Requirements covered: 2.1, 2.2, 4.1
 */

import type { ExerciseFSMConfig, AngleThreshold } from '../types/index.js';

/**
 * Returns `true` when an `AngleThreshold` has a valid (non-inverted) range.
 * An inverted range (min > max) is always invalid.
 */
function isValidThreshold(threshold: AngleThreshold): boolean {
  return threshold.min <= threshold.max;
}

/**
 * Validates an `ExerciseFSMConfig` object.
 *
 * Returns `true` when all of the following hold:
 * - `exerciseName` is a non-empty string
 * - `joints` is a non-empty array
 * - Every `AngleThreshold` field has `min <= max`
 *
 * Returns `false` otherwise.
 *
 * Requirement 2.1 — Exercise configs must define valid angle thresholds.
 * Requirement 2.2 — Each config must identify at least one joint to track.
 * Requirement 4.1 — Config must have a non-empty exercise name.
 */
export function validateFSMConfig(config: ExerciseFSMConfig): boolean {
  if (config.exerciseName.trim().length === 0) {
    return false;
  }

  if (config.joints.length === 0) {
    return false;
  }

  if (!isValidThreshold(config.startThreshold)) {
    return false;
  }

  if (!isValidThreshold(config.inflectionThreshold)) {
    return false;
  }

  if (!isValidThreshold(config.completeThreshold)) {
    return false;
  }

  if (!isValidThreshold(config.warningThreshold)) {
    return false;
  }

  if (!isValidThreshold(config.criticalThreshold)) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Concrete Exercise Configurations
// ---------------------------------------------------------------------------

/**
 * Barbell squat configuration.
 *
 * Tracks knee and hip angles to detect standing start, mid-descent inflection,
 * bottom position, over-depth warning, and Valgus_Cave critical safety alert.
 *
 * Requirement 5.5
 */
export const squatConfig: ExerciseFSMConfig = {
  exerciseName: 'barbell_squat',
  joints: ['left_knee', 'right_knee', 'left_hip', 'right_hip'],
  startThreshold:      { min: 140, max: 180 }, // standing upright (very forgiving)
  inflectionThreshold: { min: 70,  max: 145 }, // mid-descent (wide window)
  completeThreshold:   { min: 40,  max: 110 }, // bottom position (wide window)
  warningThreshold:    { min: 30,  max: 180 }, // safe zone — only extreme depth warns
  criticalThreshold:   { min: 20,  max: 180 }, // critical — only extremely dangerous depth
};

/**
 * Conventional deadlift configuration.
 *
 * Tracks hip and knee angles to detect standing start, hip-hinge mid-pull,
 * bar-near-floor complete, excessive forward lean warning, and lumbar
 * hyperextension critical safety alert (angles > 180° indicate extension
 * past neutral).
 *
 * Requirement 5.6
 */
export const deadliftConfig: ExerciseFSMConfig = {
  exerciseName: 'conventional_deadlift',
  joints: ['left_hip', 'right_hip', 'left_knee', 'right_knee'],
  startThreshold:      { min: 160, max: 180 }, // standing upright
  inflectionThreshold: { min: 100, max: 140 }, // hip hinge mid-pull
  completeThreshold:   { min: 60,  max: 100 }, // bar near floor
  warningThreshold:    { min: 0,   max: 50  }, // excessive forward lean
  criticalThreshold:   { min: 185, max: 220 }, // lumbar hyperextension (> 180° = extension past neutral)
};

/**
 * Barrel export of all built-in exercise configs for bulk registration.
 *
 * Requirements 5.5, 5.6
 */
export const allConfigs: ExerciseFSMConfig[] = [squatConfig, deadliftConfig];
