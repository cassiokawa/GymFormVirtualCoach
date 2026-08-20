import type { LockConfig } from '../types/index.js';

export const DEFAULT_LOCK_CONFIG: LockConfig = {
  lockThreshold: 0.4,
  lockDuration: 8,
  pauseAfterFrames: 20,
  pauseThreshold: 0.3,
};
