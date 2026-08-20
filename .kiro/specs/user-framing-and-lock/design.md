# Design Document: User Framing & Lock

## Overview

This feature introduces a **pre-tracking pipeline** that gates the existing RepCounter and FormEvaluator behind three sequential stages: Framing → Position → Lock. Only after all three stages pass does the system enter Active_Tracking and begin counting reps.

```
┌─────────────────────────────────────────────────────────────┐
│                   PRE-TRACKING PIPELINE                       │
│                                                              │
│  KeypointMessage                                             │
│       │                                                      │
│       ▼                                                      │
│  ┌─────────────┐    ┌──────────────────┐    ┌───────────┐   │
│  │ Framing     │───▶│ Position         │───▶│ Pose      │   │
│  │ Guide       │    │ Advisor          │    │ Lock      │   │
│  │             │    │                  │    │           │   │
│  │ score ≥ 0.7 │    │ score = 1.0      │    │ 15 frames │   │
│  └─────────────┘    └──────────────────┘    └─────┬─────┘   │
│                                                    │         │
└────────────────────────────────────────────────────┼─────────┘
                                                     │
                                                     ▼
                                            ACTIVE_TRACKING
                                        (RepCounter + FormEvaluator)
```

---

## State Machine

```
                    ┌──────────────┐
          start()   │   FRAMING    │  Framing_Score < 0.7
           ──────▶  │   (stage 1)  │◀─────────────────┐
                    └──────┬───────┘                   │
                           │ Framing_Score ≥ 0.7       │
                           ▼                           │
                    ┌──────────────┐                   │
                    │  POSITIONING │  StartScore < 1.0 │
                    │   (stage 2)  │◀──────────┐       │
                    └──────┬───────┘           │       │
                           │ StartScore = 1.0  │       │
                           ▼                   │       │
                    ┌──────────────┐           │       │
                    │   LOCKING    │  reset if │       │
                    │   (stage 3)  │──conf drop┘       │
                    └──────┬───────┘                   │
                           │ Lock_Duration met         │
                           ▼                           │
                    ┌──────────────┐                   │
                    │   ACTIVE     │  avg conf < 0.5   │
                    │  TRACKING    │──for 10 frames────┘
                    └──────────────┘
```

States: `'framing' | 'positioning' | 'locking' | 'active'`

---

## New Types

```typescript
/** Configuration for the Pose_Lock gating mechanism. */
export interface LockConfig {
  /** Minimum confidence per required keypoint. Default: 0.7 */
  lockThreshold: number;
  /** Consecutive frames required at lockThreshold. Default: 15 */
  lockDuration: number;
  /** Frames of low confidence before pausing active tracking. Default: 10 */
  pauseAfterFrames: number;
  /** Minimum average confidence during active tracking. Default: 0.5 */
  pauseThreshold: number;
}

/** The current state of the pre-tracking pipeline. */
export type PreTrackingState = 'framing' | 'positioning' | 'locking' | 'active';

/** Status snapshot emitted each frame for UI rendering. */
export interface PreTrackingStatus {
  state: PreTrackingState;
  framingScore: number;           // [0, 1]
  startingPositionScore: number;  // [0, 1]
  lockProgress: number;           // [0, 1] — fraction of lockDuration completed
  positionCues: PositionCue[];    // directional correction messages
  isLocked: boolean;
}

/** A single directional correction cue for the user. */
export interface PositionCue {
  jointName: string;
  message: string;
  currentAngle: number;
  targetMin: number;
  targetMax: number;
}

/** Bounding box derived from keypoints. */
export interface BoundingBox {
  x: number;      // normalised left edge [0, 1]
  y: number;      // normalised top edge [0, 1]
  width: number;  // normalised width [0, 1]
  height: number; // normalised height [0, 1]
}
```

---

## Component Designs

### 1. Framing_Guide

**File:** `src/framingGuide/FramingGuide.ts`

```typescript
export class FramingGuide {
  private readonly targetZone: BoundingBox;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement);

  /**
   * Process a keypoint frame and return the framing score.
   * Draws the silhouette overlay and status text on the canvas.
   */
  evaluate(keypoints: Keypoint[]): number;

  /** Compute bounding box from visible keypoints. */
  private computeBoundingBox(keypoints: Keypoint[]): BoundingBox | null;

  /** Compute IoU between user bounding box and target zone. */
  private computeOverlap(userBox: BoundingBox): number;

  /** Render the target silhouette zone on canvas. */
  private renderTargetZone(color: string): void;

  /** Render text prompt (e.g., "Step back"). */
  private renderPrompt(message: string): void;

  /** Clear the framing overlay from canvas. */
  clear(): void;
}
```

**Framing Score formula:**
```
visibilityRatio = countVisible(keypoints) / 33
overlapRatio = IoU(userBoundingBox, targetZone)
framingScore = 0.6 * visibilityRatio + 0.4 * overlapRatio
```

**Target zone:** Centred rectangle occupying 40–80% of canvas width, 60–90% of canvas height, with margins from edges.

---

### 2. Position_Advisor

**File:** `src/positionAdvisor/PositionAdvisor.ts`

```typescript
export class PositionAdvisor {
  private readonly config: ExerciseFSMConfig;
  private readonly jointKeypointMap: Record<string, [number, number, number]>;

  constructor(config: ExerciseFSMConfig);

  /**
   * Evaluate current keypoints against the exercise start threshold.
   * Returns a score [0, 1] and an array of directional cues.
   */
  evaluate(keypoints: Keypoint[], frameId: number, timestampMs: number): {
    score: number;
    cues: PositionCue[];
  };

  /** Generate a human-readable cue for a joint that's out of range. */
  private generateCue(jointName: string, currentAngle: number, threshold: AngleThreshold): PositionCue;
}
```

**Starting Position Score formula:**
```
jointsInRange = count(joints where angle is within startThreshold)
score = jointsInRange / totalTrackedJoints
```

**Directional cue logic:**
- If `currentAngle < threshold.min` → "Extend more" / "Stand taller"
- If `currentAngle > threshold.max` → "Bend less" / "Straighten up"
- Uses `calculateJointAngle` from existing utils

---

### 3. Pose_Lock

**File:** `src/poseLock/PoseLock.ts`

```typescript
export class PoseLock {
  private readonly config: LockConfig;
  private readonly requiredJointIndices: number[];
  private consecutiveGoodFrames: number = 0;
  private consecutiveBadFrames: number = 0;
  private state: PreTrackingState = 'framing';

  constructor(config: LockConfig, requiredJointIndices: number[]);

  /**
   * Evaluate a keypoint frame for lock conditions.
   * Returns true when all required keypoints meet the threshold.
   */
  evaluateFrame(keypoints: Keypoint[]): boolean;

  /** Get current progress toward lock (0–1). */
  getLockProgress(): number;

  /** Advance state when pre-conditions are met. */
  advanceState(framingScore: number, positionScore: number): PreTrackingState;

  /** Check if active tracking should be paused due to confidence drop. */
  shouldPause(keypoints: Keypoint[]): boolean;

  /** Reset lock countdown (on confidence drop). */
  reset(): void;

  /** Force transition to active (skip lock). */
  forceActive(): void;

  getState(): PreTrackingState;
}
```

**Lock evaluation per frame:**
```
allGood = requiredJointIndices.every(i => keypoints[i].confidence >= lockThreshold)
if (allGood) consecutiveGoodFrames++
else consecutiveGoodFrames = 0

isLocked = consecutiveGoodFrames >= lockDuration
```

**Pause logic during active tracking:**
```
avgConfidence = mean(requiredJointIndices.map(i => keypoints[i].confidence))
if (avgConfidence < pauseThreshold) consecutiveBadFrames++
else consecutiveBadFrames = 0

shouldPause = consecutiveBadFrames >= pauseAfterFrames
```

---

### 4. PreTrackingController

**File:** `src/preTracking/PreTrackingController.ts`

Orchestrates the three components and provides a single `processFrame()` entry point.

```typescript
export class PreTrackingController {
  private readonly framingGuide: FramingGuide;
  private readonly positionAdvisor: PositionAdvisor;
  private readonly poseLock: PoseLock;
  private onLocked: (() => void) | null = null;

  constructor(options: {
    canvas: HTMLCanvasElement;
    config: ExerciseFSMConfig;
    lockConfig?: LockConfig;
  });

  /**
   * Process a keypoint frame through the pre-tracking pipeline.
   * Returns the current status for UI rendering.
   */
  processFrame(message: KeypointMessage): PreTrackingStatus;

  /** Register callback when lock is achieved. */
  onLockAchieved(callback: () => void): void;

  /** Skip the lock and force active tracking. */
  skipLock(): void;

  /** Reset to framing state (e.g., after pause). */
  resetToFraming(): void;

  /** Get current pipeline state. */
  getState(): PreTrackingState;
}
```

**processFrame logic:**
```
1. framingScore = framingGuide.evaluate(keypoints)
2. if state === 'framing' && framingScore >= 0.7:
     state = 'positioning'
3. if state === 'positioning':
     { score, cues } = positionAdvisor.evaluate(keypoints)
     if score === 1.0: state = 'locking'
4. if state === 'locking':
     meetsLock = poseLock.evaluateFrame(keypoints)
     if poseLock.getLockProgress() >= 1.0:
       state = 'active'
       onLocked?.()
5. if state === 'active':
     if poseLock.shouldPause(keypoints):
       state = 'framing'
       poseLock.reset()
```

---

## Integration with WorkoutSession

The existing `WorkoutSession.handleKeypoints()` is modified to gate frames through the `PreTrackingController`:

```typescript
// In WorkoutSession constructor, add:
private readonly preTrackingController: PreTrackingController;
private trackingState: 'pre_tracking' | 'active' = 'pre_tracking';

// Modified handleKeypoints:
private handleKeypoints(message: KeypointMessage): void {
  if (!this.isActive) return;

  if (this.trackingState === 'pre_tracking') {
    const status = this.preTrackingController.processFrame(message);
    this.onPreTrackingStatus?.(status); // UI callback
    if (status.state === 'active') {
      this.trackingState = 'active';
    }
    return; // Don't forward to RepCounter/FormEvaluator yet
  }

  // Active tracking — existing logic (unchanged)
  // ... RepCounter, FormEvaluator, etc.
}
```

---

## Demo UI Integration

The demo `main.ts` renders additional UI during pre-tracking:

1. **Framing stage:** Green/red silhouette on canvas + "Step into frame" text
2. **Positioning stage:** Per-joint correction text overlay (e.g., "↑ Stand taller")
3. **Locking stage:** Circular progress indicator filling as frames accumulate
4. **Active stage:** Existing skeleton + stats UI (no change)

A "Skip" button is visible during stages 1–3 to bypass the lock.

---

## Default Lock Configuration

```typescript
export const DEFAULT_LOCK_CONFIG: LockConfig = {
  lockThreshold: 0.7,
  lockDuration: 15,
  pauseAfterFrames: 10,
  pauseThreshold: 0.5,
};
```

---

## Canvas Rendering for Framing Guide

The target zone is drawn as a rounded rectangle with a dashed border. Inside it, a simplified human silhouette (SVG path rendered to canvas) indicates where to stand:

```
┌─────────────────────────────────────────┐
│                                         │
│     ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐      │
│     │                           │      │
│     │        ○  (head)          │      │
│     │       /|\  (torso)        │      │
│     │       / \  (legs)         │      │
│     │                           │      │
│     └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘      │
│                                         │
│    TARGET ZONE (dashed, green/red)      │
└─────────────────────────────────────────┘
```

Color logic:
- `framingScore < 0.5` → Red dashed border + red silhouette
- `0.5 ≤ framingScore < 0.7` → Yellow dashed border
- `framingScore ≥ 0.7` → Green dashed border + green silhouette

---

## File Summary

| File | Component | New/Modified |
|------|-----------|--------------|
| `src/framingGuide/FramingGuide.ts` | Framing_Guide | New |
| `src/positionAdvisor/PositionAdvisor.ts` | Position_Advisor | New |
| `src/poseLock/PoseLock.ts` | Pose_Lock | New |
| `src/preTracking/PreTrackingController.ts` | Orchestrator | New |
| `src/types/index.ts` | New types | Modified |
| `src/app/WorkoutSession.ts` | Pre-tracking gate | Modified |
| `src/demo/main.ts` | UI rendering | Modified |
