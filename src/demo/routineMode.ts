/**
 * Routine Mode — manages a training sequence (multiple exercises with target reps)
 * and auto-advance logic.
 *
 * When the target rep count is hit for the current exercise, automatically
 * switches to the next exercise in the queue.
 */

import type { ExerciseFSMConfig } from '../types/index.js';
import { allConfigs } from '../config/exerciseConfigs.js';

export interface RoutineEntry {
  config: ExerciseFSMConfig;
  targetReps: number;
  displayName: string;
}

export class RoutineMode {
  private entries: RoutineEntry[] = [];
  private currentIndex = 0;
  private active = false;
  private advanceCallback: ((entry: RoutineEntry, index: number, total: number) => void) | null = null;
  private completeCallback: (() => void) | null = null;

  addExercise(exerciseName: string, targetReps: number): void {
    const config = allConfigs.find((c) => c.exerciseName === exerciseName);
    if (!config) return;
    const displayName = exerciseName
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    this.entries.push({ config, targetReps, displayName });
  }

  removeExercise(index: number): void {
    this.entries.splice(index, 1);
  }

  getEntries(): readonly RoutineEntry[] {
    return this.entries;
  }

  getLength(): number {
    return this.entries.length;
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  getCurrentEntry(): RoutineEntry | null {
    return this.entries[this.currentIndex] ?? null;
  }

  isRoutineActive(): boolean {
    return this.active;
  }

  start(): RoutineEntry | null {
    if (this.entries.length === 0) return null;
    this.currentIndex = 0;
    this.active = true;
    return this.entries[0] ?? null;
  }

  /**
   * Called when rep count is updated.
   * Returns true if auto-advanced (or routine complete).
   */
  checkAdvance(currentReps: number): boolean {
    if (!this.active) return false;
    const entry = this.entries[this.currentIndex];
    if (!entry) return false;

    if (currentReps >= entry.targetReps) {
      this.currentIndex++;
      if (this.currentIndex >= this.entries.length) {
        // Routine complete
        this.active = false;
        this.completeCallback?.();
        return true;
      }
      // Advance to next exercise
      const next = this.entries[this.currentIndex];
      if (next) {
        this.advanceCallback?.(next, this.currentIndex, this.entries.length);
      }
      return true;
    }
    return false;
  }

  onExerciseAdvance(cb: (entry: RoutineEntry, index: number, total: number) => void): void {
    this.advanceCallback = cb;
  }

  onRoutineComplete(cb: () => void): void {
    this.completeCallback = cb;
  }

  stop(): void {
    this.active = false;
    this.currentIndex = 0;
  }

  reset(): void {
    this.entries = [];
    this.currentIndex = 0;
    this.active = false;
  }
}
