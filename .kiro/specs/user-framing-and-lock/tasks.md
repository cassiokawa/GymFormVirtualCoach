# Implementation Plan: User Framing & Lock

## Overview

Implement a pre-tracking pipeline that gates RepCounter and FormEvaluator behind three sequential stages: Framing → Position → Lock. The pipeline uses FramingGuide, PositionAdvisor, and PoseLock components orchestrated by a PreTrackingController, integrated into WorkoutSession and the demo UI. Only after all three stages pass does the system enter Active_Tracking and begin counting reps.

## Tasks

- [x] 1. Add new types and default configuration
  - [x] 1.1 Add pre-tracking types to `src/types/index.ts`
    - Add `LockConfig` interface with `lockThreshold`, `lockDuration`, `pauseAfterFrames`, `pauseThreshold`
    - Add `PreTrackingState` type: `'framing' | 'positioning' | 'locking' | 'active'`
    - Add `PreTrackingStatus` interface with `state`, `framingScore`, `startingPositionScore`, `lockProgress`, `positionCues`, `isLocked`
    - Add `PositionCue` interface with `jointName`, `message`, `currentAngle`, `targetMin`, `targetMax`
    - Add `BoundingBox` interface with `x`, `y`, `width`, `height` (all normalised [0, 1])
    - Export all new types from the barrel file
    - _Requirements: 3.6, 1.4, 2.1, 2.2, 3.4_

  - [x] 1.2 Create default lock configuration in `src/config/lockConfig.ts`
    - Export `DEFAULT_LOCK_CONFIG: LockConfig` with lockThreshold=0.7, lockDuration=15, pauseAfterFrames=10, pauseThreshold=0.5
    - _Requirements: 3.6_

- [x] 2. Implement FramingGuide component
  - [x] 2.1 Create `src/framingGuide/FramingGuide.ts`
    - Implement `FramingGuide` class with constructor accepting `HTMLCanvasElement`
    - Define `targetZone` as centred rectangle: 40–80% of canvas width, 60–90% of canvas height
    - Implement `evaluate(keypoints: Keypoint[]): number` that computes and returns framingScore
    - Formula: `framingScore = 0.6 * visibilityRatio + 0.4 * overlapRatio`
    - `visibilityRatio = countVisible(confidence >= 0.5) / 33`
    - `overlapRatio = IoU(userBoundingBox, targetZone)`
    - Implement `computeBoundingBox(keypoints)` — derive min/max x,y from visible keypoints
    - Implement `computeOverlap(userBox)` — intersection over union with targetZone
    - Implement `renderTargetZone(color)` — dashed rounded rectangle with simplified body silhouette
    - Implement `renderPrompt(message)` — text overlay when fewer than 25 keypoints visible
    - Implement `clear()` — remove framing overlay from canvas
    - Color logic: red (score < 0.5), yellow (0.5 ≤ score < 0.7), green (score ≥ 0.7)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 2.2 Write unit tests for FramingGuide
    - Test framingScore formula with mock keypoints (all visible = high score)
    - Test bounding box computation with various keypoint distributions
    - Test colour transitions at threshold boundaries (0.5, 0.7)
    - Test edge case: no visible keypoints returns score 0
    - Test prompt displayed when fewer than 25 keypoints visible
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 3. Implement PositionAdvisor component
  - [x] 3.1 Create `src/positionAdvisor/PositionAdvisor.ts`
    - Implement `PositionAdvisor` class with constructor accepting `ExerciseFSMConfig`
    - Define `jointKeypointMap: Record<string, [number, number, number]>` mapping joint names to MediaPipe landmark triplets
    - Implement `evaluate(keypoints: Keypoint[], frameId: number, timestampMs: number): { score: number; cues: PositionCue[] }`
    - Score formula: `jointsInRange / totalTrackedJoints` (yields 0–1)
    - Use existing `calculateJointAngle` from `src/utils/jointAngle.ts` to compute current angles
    - Compare each joint angle against `config.startThreshold` range
    - Implement `generateCue(jointName, currentAngle, threshold): PositionCue`
    - Cue logic: if `currentAngle < threshold.min` → "Extend more" / if `currentAngle > threshold.max` → "Bend less"
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.2 Write unit tests for PositionAdvisor
    - Test score = 1.0 when all tracked joints are within startThreshold range
    - Test score < 1.0 with partial joints in range
    - Test directional cue: below-min angle produces "Extend" cue
    - Test directional cue: above-max angle produces "Bend" cue
    - Test that unavailable joints (low confidence) are excluded from score
    - _Requirements: 2.1, 2.2, 2.3_

- [x] 4. Implement PoseLock component
  - [x] 4.1 Create `src/poseLock/PoseLock.ts`
    - Implement `PoseLock` class with constructor accepting `LockConfig` and `requiredJointIndices: number[]`
    - Track `consecutiveGoodFrames` and `consecutiveBadFrames` counters
    - Track internal `state: PreTrackingState` initialised to `'framing'`
    - Implement `evaluateFrame(keypoints: Keypoint[]): boolean`
      - Check `requiredJointIndices.every(i => keypoints[i].confidence >= lockThreshold)`
      - Increment `consecutiveGoodFrames` if all good, else reset to 0
      - Return whether threshold met this frame
    - Implement `getLockProgress(): number` — returns `consecutiveGoodFrames / lockDuration` clamped to [0, 1]
    - Implement `advanceState(framingScore, positionScore): PreTrackingState` — transition logic between states
    - Implement `shouldPause(keypoints: Keypoint[]): boolean`
      - Compute avg confidence of required keypoints
      - If avg < pauseThreshold: increment `consecutiveBadFrames`, else reset
      - Return `consecutiveBadFrames >= pauseAfterFrames`
    - Implement `reset()` — zero all counters, return to framing state
    - Implement `forceActive()` — immediately set state to 'active'
    - Implement `getState(): PreTrackingState` accessor
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 4.2 Write unit tests for PoseLock
    - Test lock acquired after exactly `lockDuration` consecutive good frames
    - Test counter resets to 0 when any required keypoint drops below threshold
    - Test `getLockProgress()` returns correct fraction during countdown
    - Test pause detection after `pauseAfterFrames` consecutive low-confidence frames
    - Test `forceActive()` immediately sets state to 'active'
    - Test `reset()` zeroes all counters and returns to framing state
    - _Requirements: 3.1, 3.3, 3.4, 3.5_

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement PreTrackingController orchestrator
  - [x] 6.1 Create `src/preTracking/PreTrackingController.ts`
    - Implement `PreTrackingController` class composing FramingGuide, PositionAdvisor, and PoseLock
    - Constructor accepts `{ canvas: HTMLCanvasElement, config: ExerciseFSMConfig, lockConfig?: LockConfig }`
    - Use `DEFAULT_LOCK_CONFIG` as fallback when `lockConfig` not provided
    - Derive `requiredJointIndices` from `config.joints` for PoseLock
    - Implement `processFrame(message: KeypointMessage): PreTrackingStatus` with state machine:
      1. Compute `framingScore = framingGuide.evaluate(keypoints)`
      2. If state is 'framing' and framingScore ≥ 0.7 → transition to 'positioning'
      3. If state is 'positioning' → evaluate positionAdvisor; if score = 1.0 → transition to 'locking'
      4. If state is 'locking' → evaluate poseLock; if lockProgress ≥ 1.0 → transition to 'active', fire callback
      5. If state is 'active' → check shouldPause; if true → reset to 'framing'
    - Return `PreTrackingStatus` object with all current values
    - Implement `onLockAchieved(callback: () => void)` — register lock callback
    - Implement `skipLock()` — call poseLock.forceActive(), fire callback
    - Implement `resetToFraming()` — reset all components
    - Implement `getState(): PreTrackingState` accessor
    - _Requirements: 1.1, 2.1, 2.4, 3.1, 3.2, 4.1, 4.4_

  - [x] 6.2 Write unit tests for PreTrackingController
    - Test full state transition pipeline: framing → positioning → locking → active
    - Test regression from active → framing when pause condition triggers
    - Test skipLock() immediately sets state to active and fires callback
    - Test position advisor feedback suppressed while in framing state (framingScore < 0.7)
    - Test onLockAchieved callback fires exactly once on successful lock
    - _Requirements: 2.4, 3.2, 3.5, 4.4_

- [x] 7. Integrate with WorkoutSession
  - [x] 7.1 Modify `src/app/WorkoutSession.ts` to gate frames through PreTrackingController
    - Add `preTrackingController: PreTrackingController` private member
    - Add `trackingState: 'pre_tracking' | 'active'` member initialised to `'pre_tracking'`
    - Add optional `onPreTrackingStatus?: (status: PreTrackingStatus) => void` callback in constructor options
    - Add optional `canvas: HTMLCanvasElement` parameter in constructor options
    - Instantiate PreTrackingController in constructor with canvas and config
    - Register `onLockAchieved` to set `trackingState = 'active'`
    - Modify `handleKeypoints()`:
      - If `trackingState === 'pre_tracking'`: route through PreTrackingController, emit status, return early
      - If `trackingState === 'active'`: proceed with existing RepCounter/FormEvaluator logic
    - Add public `skipLock(): void` method delegating to PreTrackingController.skipLock()
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 7.2 Write unit tests for WorkoutSession pre-tracking integration
    - Test that KeypointMessages are NOT forwarded to RepCounter during pre_tracking state
    - Test that KeypointMessages ARE forwarded to RepCounter once active
    - Test skipLock() transitions immediately to active tracking
    - Test onPreTrackingStatus callback receives status updates during pre-tracking
    - _Requirements: 4.1, 4.2, 4.4_

- [x] 8. Integrate with demo UI
  - [x] 8.1 Modify `src/demo/main.ts` to render pre-tracking UI
    - Add pre-tracking state variable and PreTrackingController instantiation with overlay canvas
    - Route keypoint messages through PreTrackingController before RepCounter in processFrame loop
    - Render pre-tracking status HUD: framingScore bar, positionScore bar, lockProgress indicator
    - Render PositionCue messages as directional text overlays during positioning stage
    - Render circular/arc progress indicator on canvas during locking stage
    - Add "Skip" button (visible during framing/positioning/locking, hidden during active)
    - Hide rep counter, FSM state, and TUT display until active tracking begins
    - Clear FramingGuide overlay when transitioning to active stage
    - _Requirements: 1.1, 1.2, 2.1, 3.4, 4.4_

- [x] 9. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- The design uses TypeScript throughout — all components use the existing `Keypoint`/`KeypointMessage` contracts
- The existing `calculateJointAngle` utility from `src/utils/jointAngle.ts` is reused by PositionAdvisor
- FramingGuide renders directly to the same canvas overlay used in the demo skeleton drawing
- PoseLock's `requiredJointIndices` are derived from the exercise config's `joints` array mapped to MediaPipe indices

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "4.2"] },
    { "id": 3, "tasks": ["6.1"] },
    { "id": 4, "tasks": ["6.2"] },
    { "id": 5, "tasks": ["7.1"] },
    { "id": 6, "tasks": ["7.2", "8.1"] }
  ]
}
```
