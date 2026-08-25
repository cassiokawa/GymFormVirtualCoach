/**
 * Unit tests for validateFSMConfig.
 *
 * Requirements covered: 2.1, 4.3
 */

import { describe, it, expect } from 'vitest';
import { validateFSMConfig } from './exerciseConfigs.js';
import type { ExerciseFSMConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A known-valid config used as the baseline for mutation tests. */
const validConfig: ExerciseFSMConfig = {
  exerciseName: 'barbell_squat',
  joints: ['left_knee', 'right_knee'],
  startThreshold:      { min: 160, max: 180 },
  inflectionThreshold: { min: 100, max: 140 },
  completeThreshold:   { min: 60,  max: 95  },
  warningThreshold:    { min: 0,   max: 55  },
  criticalThreshold:   { min: 0,   max: 160 },
};

// ---------------------------------------------------------------------------
// Valid configs
// ---------------------------------------------------------------------------

describe('validateFSMConfig — valid configs', () => {
  it('returns true for a fully valid config', () => {
    expect(validateFSMConfig(validConfig)).toBe(true);
  });

  it('returns true when min === max (single-degree threshold)', () => {
    const config: ExerciseFSMConfig = {
      ...validConfig,
      startThreshold: { min: 170, max: 170 },
    };
    expect(validateFSMConfig(config)).toBe(true);
  });

  it('returns true when joints array has exactly one entry', () => {
    const config: ExerciseFSMConfig = {
      ...validConfig,
      joints: ['left_knee'],
    };
    expect(validateFSMConfig(config)).toBe(true);
  });

  it('returns true when joints array has many entries', () => {
    const config: ExerciseFSMConfig = {
      ...validConfig,
      joints: ['left_knee', 'right_knee', 'left_hip', 'right_hip'],
    };
    expect(validateFSMConfig(config)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid — empty exerciseName
// ---------------------------------------------------------------------------

describe('validateFSMConfig — invalid exerciseName', () => {
  it('returns false when exerciseName is an empty string', () => {
    const config: ExerciseFSMConfig = { ...validConfig, exerciseName: '' };
    expect(validateFSMConfig(config)).toBe(false);
  });

  it('returns false when exerciseName is whitespace-only', () => {
    const config: ExerciseFSMConfig = { ...validConfig, exerciseName: '   ' };
    expect(validateFSMConfig(config)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invalid — empty joints array
// ---------------------------------------------------------------------------

describe('validateFSMConfig — invalid joints', () => {
  it('returns false when joints array is empty', () => {
    const config: ExerciseFSMConfig = { ...validConfig, joints: [] };
    expect(validateFSMConfig(config)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invalid — inverted thresholds (min > max)
// ---------------------------------------------------------------------------

describe('validateFSMConfig — inverted thresholds', () => {
  it('returns false when startThreshold has min > max', () => {
    const config: ExerciseFSMConfig = {
      ...validConfig,
      startThreshold: { min: 180, max: 160 },
    };
    expect(validateFSMConfig(config)).toBe(false);
  });

  it('returns false when inflectionThreshold has min > max', () => {
    const config: ExerciseFSMConfig = {
      ...validConfig,
      inflectionThreshold: { min: 130, max: 90 },
    };
    expect(validateFSMConfig(config)).toBe(false);
  });

  it('returns false when completeThreshold has min > max', () => {
    const config: ExerciseFSMConfig = {
      ...validConfig,
      completeThreshold: { min: 95, max: 60 },
    };
    expect(validateFSMConfig(config)).toBe(false);
  });

  it('returns false when warningThreshold has min > max', () => {
    const config: ExerciseFSMConfig = {
      ...validConfig,
      warningThreshold: { min: 55, max: 0 },
    };
    expect(validateFSMConfig(config)).toBe(false);
  });

  it('returns false when criticalThreshold has min > max', () => {
    const config: ExerciseFSMConfig = {
      ...validConfig,
      criticalThreshold: { min: 160, max: 0 },
    };
    expect(validateFSMConfig(config)).toBe(false);
  });
});
