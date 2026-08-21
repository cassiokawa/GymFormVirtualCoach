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
 * warningThreshold = safe range for knee/hip angles during the movement.
 *   Outside this range = form warning (e.g., too deep, knees too far forward)
 * criticalThreshold = absolute safety bounds.
 *   Outside this range = dangerous, stop immediately.
 */
export const squatConfig: ExerciseFSMConfig = {
  exerciseName: 'barbell_squat',
  joints: ['left_knee', 'right_knee', 'left_hip', 'right_hip'],
  startThreshold:      { min: 140, max: 180 }, // standing upright
  inflectionThreshold: { min: 70,  max: 145 }, // mid-descent
  completeThreshold:   { min: 40,  max: 110 }, // bottom position
  warningThreshold:    { min: 50,  max: 175 }, // safe zone: 50–175°. Below 50° = too deep. Above 175° = hyperextension
  criticalThreshold:   { min: 35,  max: 180 }, // critical: below 35° = dangerous over-depth
};

/**
 * Conventional deadlift configuration.
 */
export const deadliftConfig: ExerciseFSMConfig = {
  exerciseName: 'conventional_deadlift',
  joints: ['left_hip', 'right_hip', 'left_knee', 'right_knee'],
  startThreshold:      { min: 140, max: 180 },
  inflectionThreshold: { min: 80,  max: 145 },
  completeThreshold:   { min: 50,  max: 100 },
  warningThreshold:    { min: 45,  max: 175 }, // safe zone: below 45° hip = rounding back risk
  criticalThreshold:   { min: 30,  max: 180 }, // critical: extreme hip flexion
};

// ---------------------------------------------------------------------------
// Push-ups (side view — track elbow angle cycle)
// ---------------------------------------------------------------------------

export const pushupConfig: ExerciseFSMConfig = {
  exerciseName: 'push_up',
  joints: ['left_elbow', 'right_elbow'],
  startThreshold:      { min: 150, max: 180 }, // arms extended
  inflectionThreshold: { min: 80,  max: 155 }, // lowering
  completeThreshold:   { min: 50,  max: 100 }, // bottom
  warningThreshold:    { min: 45,  max: 175 }, // safe zone: below 45° = too deep. Above 175° = hyperextension
  criticalThreshold:   { min: 30,  max: 180 }, // critical: extreme depth = shoulder injury risk
};

// ---------------------------------------------------------------------------
// Bicep curls (front/side view — track elbow flexion)
// ---------------------------------------------------------------------------

export const bicepCurlConfig: ExerciseFSMConfig = {
  exerciseName: 'bicep_curl',
  joints: ['left_elbow', 'right_elbow'],
  startThreshold:      { min: 150, max: 180 }, // arms straight
  inflectionThreshold: { min: 70,  max: 155 }, // curling up
  completeThreshold:   { min: 30,  max: 80  }, // fully flexed
  warningThreshold:    { min: 20,  max: 170 }, // safe zone: below 20° = over-curl. Above 170° = not curling
  criticalThreshold:   { min: 10,  max: 180 }, // critical: extreme flexion
};

// ---------------------------------------------------------------------------
// Shoulder press (front view — track elbow/shoulder extension)
// ---------------------------------------------------------------------------

export const shoulderPressConfig: ExerciseFSMConfig = {
  exerciseName: 'shoulder_press',
  joints: ['left_elbow', 'right_elbow', 'left_shoulder', 'right_shoulder'],
  startThreshold:      { min: 60,  max: 100 }, // elbows bent at shoulders
  inflectionThreshold: { min: 100, max: 155 }, // pressing up
  completeThreshold:   { min: 150, max: 180 }, // arms locked out
  warningThreshold:    { min: 40,  max: 175 }, // safe zone: below 40° = too much back arch. Above 175° = hyperextension
  criticalThreshold:   { min: 25,  max: 180 }, // critical: extreme positions
};

// ---------------------------------------------------------------------------
// Lunges (front/side view — track knee + hip)
// ---------------------------------------------------------------------------

export const lungeConfig: ExerciseFSMConfig = {
  exerciseName: 'lunge',
  joints: ['left_knee', 'right_knee', 'left_hip', 'right_hip'],
  startThreshold:      { min: 150, max: 180 }, // standing upright
  inflectionThreshold: { min: 80,  max: 155 }, // stepping down
  completeThreshold:   { min: 50,  max: 100 }, // front knee at ~90°
  warningThreshold:    { min: 45,  max: 175 }, // safe zone: below 45° = knee too far forward / too deep
  criticalThreshold:   { min: 30,  max: 180 }, // critical: extreme depth
};

// ---------------------------------------------------------------------------
// Lateral raises (front view — track shoulder abduction)
// ---------------------------------------------------------------------------

export const lateralRaiseConfig: ExerciseFSMConfig = {
  exerciseName: 'lateral_raise',
  joints: ['left_shoulder', 'right_shoulder'],
  startThreshold:      { min: 10,  max: 40  }, // arms at sides
  inflectionThreshold: { min: 40,  max: 80  }, // raising
  completeThreshold:   { min: 75,  max: 120 }, // arms parallel (~90°)
  warningThreshold:    { min: 5,   max: 110 }, // safe zone: above 110° = shoulder impingement risk
  criticalThreshold:   { min: 0,   max: 130 }, // critical: above 130° = definite impingement
};

// ---------------------------------------------------------------------------
// Calf raises (side view — track knee angle for stability)
// ---------------------------------------------------------------------------

export const calfRaiseConfig: ExerciseFSMConfig = {
  exerciseName: 'calf_raise',
  joints: ['left_knee', 'right_knee'],
  startThreshold:      { min: 160, max: 180 }, // standing flat
  inflectionThreshold: { min: 155, max: 175 }, // slight transition
  completeThreshold:   { min: 170, max: 180 }, // on toes
  warningThreshold:    { min: 140, max: 180 }, // safe zone: below 140° = bending knees too much
  criticalThreshold:   { min: 120, max: 180 }, // critical: very bent knees during calf raise
};

// ---------------------------------------------------------------------------
// Tricep dips (side view — track elbow flexion/extension)
// ---------------------------------------------------------------------------

export const tricepDipConfig: ExerciseFSMConfig = {
  exerciseName: 'tricep_dip',
  joints: ['left_elbow', 'right_elbow'],
  startThreshold:      { min: 150, max: 180 },
  inflectionThreshold: { min: 80,  max: 155 },
  completeThreshold:   { min: 50,  max: 100 },
  warningThreshold:    { min: 40,  max: 175 },
  criticalThreshold:   { min: 25,  max: 180 },
};

// ---------------------------------------------------------------------------
// Jumping jacks (front view — track shoulder abduction cycle)
// ---------------------------------------------------------------------------

export const jumpingJackConfig: ExerciseFSMConfig = {
  exerciseName: 'jumping_jack',
  joints: ['left_shoulder', 'right_shoulder'],
  startThreshold:      { min: 5,   max: 35  },
  inflectionThreshold: { min: 35,  max: 90  },
  completeThreshold:   { min: 85,  max: 160 },
  warningThreshold:    { min: 0,   max: 170 },
  criticalThreshold:   { min: 0,   max: 180 },
};

// ---------------------------------------------------------------------------
// Wall sit (isometric — track knee angle hold)
// ---------------------------------------------------------------------------

export const wallSitConfig: ExerciseFSMConfig = {
  exerciseName: 'wall_sit',
  joints: ['left_knee', 'right_knee', 'left_hip', 'right_hip'],
  startThreshold:      { min: 150, max: 180 },
  inflectionThreshold: { min: 85,  max: 155 },
  completeThreshold:   { min: 70,  max: 100 },
  warningThreshold:    { min: 50,  max: 170 },
  criticalThreshold:   { min: 35,  max: 180 },
};

// ---------------------------------------------------------------------------
// Glute bridge (side view — track hip extension)
// ---------------------------------------------------------------------------

export const gluteBridgeConfig: ExerciseFSMConfig = {
  exerciseName: 'glute_bridge',
  joints: ['left_hip', 'right_hip', 'left_knee', 'right_knee'],
  startThreshold:      { min: 60,  max: 100 },
  inflectionThreshold: { min: 100, max: 145 },
  completeThreshold:   { min: 140, max: 180 },
  warningThreshold:    { min: 40,  max: 180 },
  criticalThreshold:   { min: 30,  max: 180 },
};

// ---------------------------------------------------------------------------
// High knees (front view — track hip flexion cycle)
// ---------------------------------------------------------------------------

export const highKneesConfig: ExerciseFSMConfig = {
  exerciseName: 'high_knees',
  joints: ['left_hip', 'right_hip'],
  startThreshold:      { min: 140, max: 180 },
  inflectionThreshold: { min: 80,  max: 145 },
  completeThreshold:   { min: 50,  max: 95  },
  warningThreshold:    { min: 30,  max: 180 },
  criticalThreshold:   { min: 20,  max: 180 },
};

// ---------------------------------------------------------------------------
// Sit-ups / crunches (side view — track hip flexion)
// ---------------------------------------------------------------------------

export const sitUpConfig: ExerciseFSMConfig = {
  exerciseName: 'sit_up',
  joints: ['left_hip', 'right_hip'],
  startThreshold:      { min: 120, max: 180 },
  inflectionThreshold: { min: 70,  max: 125 },
  completeThreshold:   { min: 40,  max: 80  },
  warningThreshold:    { min: 25,  max: 180 },
  criticalThreshold:   { min: 15,  max: 180 },
};

// ---------------------------------------------------------------------------
// Overhead tricep extension (front/side — elbow behind head)
// ---------------------------------------------------------------------------

export const overheadTricepConfig: ExerciseFSMConfig = {
  exerciseName: 'overhead_tricep_extension',
  joints: ['left_elbow', 'right_elbow'],
  startThreshold:      { min: 140, max: 180 },
  inflectionThreshold: { min: 60,  max: 145 },
  completeThreshold:   { min: 30,  max: 70  },
  warningThreshold:    { min: 20,  max: 175 },
  criticalThreshold:   { min: 10,  max: 180 },
};

// ---------------------------------------------------------------------------
// Bent-over row (side view — track elbow pulling)
// ---------------------------------------------------------------------------

export const bentOverRowConfig: ExerciseFSMConfig = {
  exerciseName: 'bent_over_row',
  joints: ['left_elbow', 'right_elbow'],
  startThreshold:      { min: 140, max: 180 },
  inflectionThreshold: { min: 80,  max: 145 },
  completeThreshold:   { min: 40,  max: 90  },
  warningThreshold:    { min: 25,  max: 175 },
  criticalThreshold:   { min: 15,  max: 180 },
};

// ---------------------------------------------------------------------------
// Pull-up (front view — track elbow flexion pulling body up)
// ---------------------------------------------------------------------------

export const pullUpConfig: ExerciseFSMConfig = {
  exerciseName: 'pull_up',
  joints: ['left_elbow', 'right_elbow'],
  startThreshold:      { min: 150, max: 180 }, // arms extended (hanging)
  inflectionThreshold: { min: 80,  max: 155 }, // pulling up
  completeThreshold:   { min: 40,  max: 90  }, // chin over bar (elbows fully bent)
  warningThreshold:    { min: 25,  max: 175 }, // too extreme
  criticalThreshold:   { min: 15,  max: 180 }, // dangerous position
};

// ---------------------------------------------------------------------------
// Band-assisted pull-up (same mechanics, same config — separate entry for UX)
// ---------------------------------------------------------------------------

export const bandPullUpConfig: ExerciseFSMConfig = {
  exerciseName: 'band_assisted_pull_up',
  joints: ['left_elbow', 'right_elbow'],
  startThreshold:      { min: 145, max: 180 }, // slightly more forgiving (band helps)
  inflectionThreshold: { min: 75,  max: 155 }, // wider window (band makes middle easier)
  completeThreshold:   { min: 35,  max: 95  }, // wider at top
  warningThreshold:    { min: 20,  max: 175 },
  criticalThreshold:   { min: 10,  max: 180 },
};

// ---------------------------------------------------------------------------
// Diamond push-up (chest emphasis — close hand position)
// ---------------------------------------------------------------------------

export const diamondPushupConfig: ExerciseFSMConfig = {
  exerciseName: 'diamond_push_up',
  joints: ['left_elbow', 'right_elbow'],
  startThreshold:      { min: 150, max: 180 },
  inflectionThreshold: { min: 70,  max: 155 },
  completeThreshold:   { min: 40,  max: 85  },
  warningThreshold:    { min: 30,  max: 175 },
  criticalThreshold:   { min: 20,  max: 180 },
};

// ---------------------------------------------------------------------------
// Wide push-up (chest + shoulders emphasis)
// ---------------------------------------------------------------------------

export const widePushupConfig: ExerciseFSMConfig = {
  exerciseName: 'wide_push_up',
  joints: ['left_elbow', 'right_elbow'],
  startThreshold:      { min: 150, max: 180 },
  inflectionThreshold: { min: 85,  max: 155 },
  completeThreshold:   { min: 60,  max: 110 },
  warningThreshold:    { min: 40,  max: 175 },
  criticalThreshold:   { min: 25,  max: 180 },
};

// ---------------------------------------------------------------------------
// Plank (core isometric hold — track hip angle)
// ---------------------------------------------------------------------------

export const plankConfig: ExerciseFSMConfig = {
  exerciseName: 'plank',
  joints: ['left_hip', 'right_hip'],
  startThreshold:      { min: 155, max: 180 },
  inflectionThreshold: { min: 150, max: 175 },
  completeThreshold:   { min: 160, max: 180 },
  warningThreshold:    { min: 140, max: 180 },
  criticalThreshold:   { min: 120, max: 180 },
};

// ---------------------------------------------------------------------------
// Mountain climbers (core + cardio — track hip flexion)
// ---------------------------------------------------------------------------

export const mountainClimberConfig: ExerciseFSMConfig = {
  exerciseName: 'mountain_climber',
  joints: ['left_hip', 'right_hip'],
  startThreshold:      { min: 140, max: 180 },
  inflectionThreshold: { min: 70,  max: 145 },
  completeThreshold:   { min: 40,  max: 80  },
  warningThreshold:    { min: 25,  max: 180 },
  criticalThreshold:   { min: 15,  max: 180 },
};

/**
 * Barrel export of all built-in exercise configs for bulk registration.
 */
export const allConfigs: ExerciseFSMConfig[] = [
  squatConfig,
  deadliftConfig,
  pushupConfig,
  bicepCurlConfig,
  shoulderPressConfig,
  lungeConfig,
  lateralRaiseConfig,
  calfRaiseConfig,
  tricepDipConfig,
  jumpingJackConfig,
  wallSitConfig,
  gluteBridgeConfig,
  highKneesConfig,
  sitUpConfig,
  overheadTricepConfig,
  bentOverRowConfig,
  pullUpConfig,
  bandPullUpConfig,
  diamondPushupConfig,
  widePushupConfig,
  plankConfig,
  mountainClimberConfig,
];
