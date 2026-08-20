# Implementation Plan: CV Fitness & Form Assistant

## Overview

Implementation follows the three-phase architecture — pre-workout, workout execution, post-workout — plus shared infrastructure. The real-time execution path (Pose_Detector → Form_Evaluator → Rep_Counter → Safety_Monitor → Alert_System → Session_Logger) is built first to establish the latency-critical core. Storage, LLM boundary enforcement, and the pre/post-workout phases are layered on top. All components are TypeScript.

---

## Tasks

- [x] 1. Set up project structure, shared types, and storage layer
  - [x] 1.1 Define all shared TypeScript interfaces and types
    - Create `src/types/index.ts` with: `Keypoint`, `JointAngle`, `Rep`, `DeviationEvent`, `SetRecord`, `Session`, `SessionSummary`, `KeypointMessage`, `ErrorMessage`, `ExerciseFSMConfig`, `AngleThreshold`
    - Export all types from a barrel file
    - _Requirements: 1.1, 2.6, 3.1, 3.3, 4.2, 4.3, 8.1–8.4_

  - [x] 1.2 Implement the Storage layer (IndexedDB)
    - Create `src/storage/Storage.ts`
    - Define `workout_sessions` table schema (id, started_at, ended_at, duration_ms, routine_id)
    - Define `session_exercise_logs` table schema (id, session_id, exercise_name, set_number, correct_reps, flawed_reps, dangerous_reps, actual_tut_ms, expected_tut_ms, deviation_events JSON)
    - Implement async `persist(session: Session): Promise<void>` with 2 s SLA and in-memory retry buffer
    - Implement `query(dateRange: { from: Date; to: Date }): Promise<Session[]>` returning results in ascending chronological order
    - Emit descriptive error events on write failure; retain in-memory telemetry for retry
    - _Requirements: 9.1–9.5_

  - [ ]* 1.3 Write unit tests for Storage layer
    - Test persist confirmation within 2 s
    - Test query returns results in ascending order
    - Test error event emitted and telemetry retained on write failure
    - _Requirements: 9.3, 9.4, 9.5_

- [x] 2. Implement joint angle calculation
  - [x] 2.1 Implement `calculateJointAngle` utility
    - Create `src/utils/jointAngle.ts`
    - Compute interior angle at keypoint B using `θ = arccos((BA·BC) / (|BA|×|BC|))`
    - Clamp result to `[0°, 180°]`
    - Return `JointAngle` with `available: false` when `|BA|` or `|BC|` is zero, or fewer than 3 valid keypoints exist (confidence ≥ 0.5, x/y within [0,1])
    - _Requirements: 3.1, 3.3, 3.4_

  - [ ]* 2.2 Write property test for joint angle calculation
    - **Property 1: Output is always in [0°, 180°] for any valid input triple**
    - **Property 2: Collinear keypoints produce 180°; coincident keypoints produce `available: false`**
    - **Validates: Requirements 3.3, 3.4**

  - [ ]* 2.3 Write unit tests for `calculateJointAngle`
    - Test known angles (90°, 45°, 180°, 0°)
    - Test unavailability when confidence < 0.5 or coordinates out of bounds
    - Test clamping at boundaries
    - _Requirements: 3.3, 3.4_

- [x] 3. Implement Pose_Detector (Web Worker + MediaPipe)
  - [x] 3.1 Scaffold the WebAssembly Web Worker
    - Create `src/workers/poseDetector.worker.ts`
    - Load and initialize MediaPipe Pose WASM inside the worker
    - Emit `ErrorMessage` with code `INIT_FAILED` if initialization fails
    - _Requirements: 1.3, 1.4_

  - [x] 3.2 Implement frame processing and keypoint extraction
    - Accept camera frames via `postMessage`
    - Extract 33 keypoints (x, y, z, confidence) per frame
    - Post `KeypointMessage` (type, frameId, timestampMs, keypoints[]) to main thread
    - Emit `ErrorMessage` with code `CAMERA_LOST` or `DETECTION_FAILED` on runtime errors
    - Target ≤33 ms per frame (Requirement 1.2 / 12.1)
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 12.1_

  - [ ]* 3.3 Write unit tests for worker message contract
    - Test that valid frames produce a `KeypointMessage` with 33 keypoints
    - Test that error conditions produce the correct `ErrorMessage` codes
    - _Requirements: 1.4_

- [x] 4. Implement ExerciseFSMConfig system
  - [x] 4.1 Define `ExerciseFSMConfig` schema and validation
    - Create `src/config/exerciseConfigs.ts`
    - Define `ExerciseFSMConfig` type with fields: exerciseName, joints, startThreshold, inflectionThreshold, completeThreshold, warningThreshold, criticalThreshold
    - Implement a `validateFSMConfig(config: ExerciseFSMConfig): boolean` guard
    - _Requirements: 2.1, 2.2, 4.1_

  - [x] 4.2 Implement squat and core exercise configurations
    - Add `squatConfig` matching the design example (barbell_squat thresholds)
    - Add at least one core exercise config (e.g., plank or deadlift) with lumbar extension criticalThreshold
    - Export all configs from a barrel file
    - _Requirements: 5.5, 5.6_

  - [ ]* 4.3 Write unit tests for config validation
    - Test that valid configs pass `validateFSMConfig`
    - Test that configs with inverted min/max fail validation
    - _Requirements: 2.1_

- [x] 5. Implement Rep_Counter FSM
  - [x] 5.1 Implement FSM state transitions
    - Create `src/repCounter/RepCounter.ts`
    - Implement states: `START`, `INFLECTION`, `COMPLETE`
    - On each `KeypointMessage`, compute relevant `JointAngle`s via `calculateJointAngle`
    - Transition `START → INFLECTION` when all tracked joints enter inflection range
    - Transition `INFLECTION → COMPLETE` when all tracked joints enter complete range
    - Transition `COMPLETE → START` when joints return to start range; increment rep count; record TUT
    - Hold current state if any required angle is `available: false`
    - _Requirements: 2.1–2.4, 2.6_

  - [x] 5.2 Implement TUT recording and FSM reset
    - Record TUT from first `START` entry to `COMPLETE → START` transition in milliseconds
    - Expose `reset(): void` that sets FSM state to `START` and rep count to 0 for new set
    - _Requirements: 2.5, 2.6_

  - [ ]* 5.3 Write property test for FSM transitions
    - **Property 3: Rep count is monotonically non-decreasing within a set**
    - **Property 4: TUT is always positive when a rep completes**
    - **Property 5: FSM state never skips states (START → COMPLETE without INFLECTION)**
    - **Validates: Requirements 2.1, 2.3, 2.6**

  - [ ]* 5.4 Write unit tests for Rep_Counter
    - Test full rep cycle increments count by 1
    - Test partial cycle does not increment
    - Test reset clears count and state
    - Test hold behavior when angles unavailable
    - _Requirements: 2.3, 2.4, 2.5_

- [x] 6. Implement Form_Evaluator
  - [x] 6.1 Implement `evaluateFrame` with dual-threshold classification
    - Create `src/formEvaluator/FormEvaluator.ts`
    - On each keypoint frame, calculate all `JointAngle`s for the active exercise using `calculateJointAngle`
    - Compare each angle against `warningThreshold` and `criticalThreshold` from `ExerciseFSMConfig`
    - On warning: create `DeviationEvent` (jointName, angleValue, severity: 'warning', timestampMs, repNumber); log once at onset
    - On critical: create `DeviationEvent` (severity: 'critical') and immediately notify Safety_Monitor (≤10 ms)
    - Skip joints with `available: false`
    - Complete entire frame evaluation within 10 ms (budget enforced via performance.now)
    - _Requirements: 3.1, 3.2, 4.1–4.5, 12.2_

  - [ ]* 6.2 Write property test for Form_Evaluator latency
    - **Property 6: `evaluateFrame` completes within 10 ms for any valid keypoint frame**
    - **Validates: Requirements 4.5, 12.2**

  - [ ]* 6.3 Write unit tests for Form_Evaluator
    - Test warning deviation logs `DeviationEvent` with correct severity
    - Test critical deviation calls Safety_Monitor
    - Test unavailable angles are skipped
    - _Requirements: 4.2, 4.3, 4.4_

- [x] 7. Implement Safety_Monitor and Alert_System
  - [x] 7.1 Implement Safety_Monitor deviation detection
    - Create `src/safetyMonitor/SafetyMonitor.ts`
    - Accept critical `DeviationEvent` notifications from Form_Evaluator
    - Detect Valgus_Cave: medial knee `JointAngle` < per-exercise threshold
    - Detect excessive lumbar extension: lumbar spine `JointAngle` > per-exercise threshold
    - Trigger Alert_System within 10 ms of receiving critical notification
    - _Requirements: 5.1, 5.5, 5.6_

  - [x] 7.2 Implement Alert_System audio and visual overlay
    - Create `src/alertSystem/AlertSystem.ts`
    - Play warning tone via Web Audio API on critical deviation
    - Render visual overlay banner on the video feed canvas
    - Maintain overlay while critical deviation persists across ≥2 consecutive frames
    - Dismiss audio + visual overlay when angles return to safe range
    - _Requirements: 5.2, 5.3, 5.4_

  - [ ]* 7.3 Write property test for Safety_Monitor latency
    - **Property 7: Alert_System is triggered within 10 ms of Safety_Monitor receiving a critical notification**
    - **Validates: Requirements 5.1, 12.3**

  - [ ]* 7.4 Write unit tests for Safety_Monitor and Alert_System
    - Test Valgus_Cave detection triggers alert
    - Test lumbar extension detection triggers alert
    - Test overlay dismissed when angles return to safe range
    - Test overlay persists across consecutive critical frames
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 8. Implement Session_Logger
  - [x] 8.1 Implement rep categorization and telemetry recording
    - Create `src/sessionLogger/SessionLogger.ts`
    - Record each `Rep` with: repNumber, tutMs, category (correct | flawed | dangerous_aborted), deviationEvents[]
    - Mark a Rep as `dangerous_aborted` when Safety_Monitor notifies of critical deviation during that rep
    - Assemble `SetRecord` (setNumber, exerciseName, reps[], actualTutMs, expectedTutMs, tutDeltaMs)
    - _Requirements: 5.7, 8.1, 8.2_

  - [x] 8.2 Implement session persistence via Storage
    - At session end, assemble `Session` object and call `Storage.persist(session)`
    - Pass `SessionSummary` to Analytics_Engine
    - _Requirements: 9.1, 9.2, 9.3, 8.5_

  - [ ]* 8.3 Write unit tests for Session_Logger
    - Test dangerous rep marked correctly on critical deviation
    - Test TUT delta computed correctly
    - Test session assembled and persisted on session end
    - _Requirements: 5.7, 9.1–9.3_

- [x] 9. Checkpoint — Ensure all execution-path tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Implement LlmGateway (phase enforcement)
  - [x] 10.1 Implement `LlmGateway` singleton with phase enforcement
    - Create `src/llmGateway/LlmGateway.ts`
    - Maintain `currentPhase: AppPhase` ('pre_workout' | 'session_active' | 'post_workout')
    - In `request(caller, payload)`: reject and log policy violation if caller/phase combination is not permitted
    - Allow only `Routine_Generator` during `pre_workout`; only `Coaching_Advisor` during `post_workout`; reject all during `session_active`
    - Implement `setPhase(phase: AppPhase)` for phase transitions
    - _Requirements: 11.1–11.4_

  - [x] 10.2 Implement phase transition wiring
    - Transition `pre_workout → session_active` when first Set starts
    - Transition `session_active → post_workout` when Session ends
    - Transition `post_workout → pre_workout` when next session is initiated
    - _Requirements: 11.1–11.3_

  - [ ]* 10.3 Write property test for LLM boundary enforcement
    - **Property 8: No LLM call succeeds when phase is `session_active`**
    - **Property 9: Only `Routine_Generator` succeeds during `pre_workout`; only `Coaching_Advisor` during `post_workout`**
    - **Validates: Requirements 11.1–11.4**

  - [ ]* 10.4 Write unit tests for LlmGateway
    - Test policy violation error thrown and logged for unauthorized caller
    - Test valid callers return LLM response
    - Test phase transitions update enforcement correctly
    - _Requirements: 11.1–11.4_

- [x] 11. Implement Routine_Generator (pre-workout)
  - [x] 11.1 Implement history query and routine assembly
    - Create `src/routineGenerator/RoutineGenerator.ts`
    - Query Storage for 10 most recent Sessions; extract form errors, fatigue indicators, target muscle groups
    - Build LLM prompt with history summary; call `LlmGateway` (caller: 'Routine_Generator')
    - Parse and return structured `Routine` (exercises with name, sequence, targetReps 1–30, expectedTutMs 10,000–120,000, primaryMuscles, secondaryMuscles) within 5 s
    - If form errors present in ≥2 of last 10 sessions for a muscle group, reduce volume 20–40% in generated routine
    - _Requirements: 6.1–6.4_

  - [x] 11.2 Implement first-session baseline
    - When Storage returns no prior sessions, generate baseline routine with ≥3 exercises covering chest, back, legs without error
    - _Requirements: 6.5_

  - [ ]* 11.3 Write unit tests for Routine_Generator
    - Test baseline generated when no session history
    - Test volume reduction when ≥2 sessions show form errors for a muscle group
    - Test routine returned within 5 s constraint
    - _Requirements: 6.3, 6.4, 6.5_

- [x] 12. Implement Form_Guide (pre-workout)
  - [x] 12.1 Implement step-by-step instruction display
    - Create `src/formGuide/FormGuide.ts` (and corresponding UI component)
    - Display step-by-step biomechanical instructions when user selects an exercise
    - Display ≥1 reference visual media item showing target range of motion
    - Display ≥1 reference visual media item highlighting common mistakes
    - _Requirements: 7.1, 7.2, 7.3_

  - [x] 12.2 Implement readiness confirmation and phase transition
    - On user confirming readiness, transition application to workout execution phase for that Set
    - _Requirements: 7.4_

  - [ ]* 12.3 Write unit tests for Form_Guide
    - Test instructions and media displayed for each configured exercise
    - Test readiness confirmation triggers execution phase
    - _Requirements: 7.1, 7.4_

- [x] 13. Implement Analytics_Engine (post-workout)
  - [x] 13.1 Implement rep categorization and TUT calculation
    - Create `src/analyticsEngine/AnalyticsEngine.ts`
    - Categorize every logged Rep into exactly one of: correct, flawed, dangerous_aborted
    - Sum Rep TUTs per Set → `actualTutMs`
    - Compute TUT delta (actual − expected) per Set
    - _Requirements: 8.1, 8.2, 8.3_

  - [x] 13.2 Implement SessionSummary assembly and downstream dispatch
    - Assemble `SessionSummary` (sessionId, totalCorrectReps, totalFlawedReps, totalDangerousReps, setBreakdowns, allDeviationEvents)
    - Pass summary to Coaching_Advisor and to Storage for persistence
    - _Requirements: 8.4, 8.5_

  - [ ]* 13.3 Write property test for Analytics_Engine
    - **Property 10: Every rep appears in exactly one category (correct | flawed | dangerous_aborted); sum of category counts equals total reps**
    - **Property 11: `actualTutMs` equals the sum of all rep TUTs in the set**
    - **Validates: Requirements 8.1, 8.2**

  - [ ]* 13.4 Write unit tests for Analytics_Engine
    - Test correct/flawed/dangerous categorization counts
    - Test TUT delta computation
    - Test SessionSummary passed to both Coaching_Advisor and Storage
    - _Requirements: 8.1–8.5_

- [x] 14. Implement Coaching_Advisor (post-workout)
  - [x] 14.1 Implement LLM-backed coaching advice generation
    - Create `src/coachingAdvisor/CoachingAdvisor.ts`
    - Receive `SessionSummary` from Analytics_Engine
    - Call `LlmGateway` (caller: 'Coaching_Advisor') with session summary payload
    - Produce ≥1 recommendation per deviation event / rep category
    - _Requirements: 10.1_

  - [x] 14.2 Implement next-session pre-population and offline fallback
    - Pre-populate next session params (weight, sets, reps): UP if performance targets met; HOLD otherwise
    - Return coaching advice + pre-populated next-session parameters to UI
    - If LLM unavailable, display raw SessionSummary with "AI coaching unavailable" message
    - _Requirements: 10.2, 10.3, 10.4_

  - [ ]* 14.3 Write unit tests for Coaching_Advisor
    - Test ≥1 recommendation returned per deviation event
    - Test next-session params incremented when targets met
    - Test offline fallback renders raw summary with correct message
    - _Requirements: 10.1–10.4_

- [x] 15. Checkpoint — Ensure all pre/post-workout tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. Integration wiring — connect all components end-to-end
  - [x] 16.1 Wire Pose_Detector worker to Form_Evaluator and Rep_Counter
    - In `src/app/WorkoutSession.ts`, subscribe to `KeypointMessage` from the Web Worker
    - Forward keypoints to `FormEvaluator.evaluateFrame()` and `RepCounter.update()`
    - Forward `ErrorMessage` events to UI error boundary
    - _Requirements: 1.3, 1.5_

  - [x] 16.2 Wire Form_Evaluator → Safety_Monitor → Alert_System → Session_Logger
    - Connect critical `DeviationEvent` from FormEvaluator to SafetyMonitor
    - Connect SafetyMonitor trigger to AlertSystem
    - Connect critical deviation during Rep to SessionLogger rep marking
    - _Requirements: 4.4, 5.1, 5.2, 5.7_

  - [x] 16.3 Wire Rep_Counter → Session_Logger → Analytics_Engine → Storage
    - On rep complete, pass `Rep` to SessionLogger
    - On session end, SessionLogger assembles Session, calls AnalyticsEngine and Storage
    - _Requirements: 2.3, 2.6, 8.4, 8.5, 9.1, 9.2_

  - [x] 16.4 Wire phase transitions through LlmGateway
    - Call `LlmGateway.setPhase('session_active')` when first Set starts
    - Call `LlmGateway.setPhase('post_workout')` when Session ends
    - Call `LlmGateway.setPhase('pre_workout')` when new session initiated
    - _Requirements: 11.1–11.3_

  - [x] 16.5 Wire Routine_Generator and Form_Guide into pre-workout phase
    - Render `Form_Guide` component when user selects an exercise
    - On readiness confirmation, start workout execution phase for that Set
    - On routine request, call `RoutineGenerator.generate()` and display result
    - _Requirements: 6.1–6.4, 7.1–7.4_

  - [x] 16.6 Wire Analytics_Engine and Coaching_Advisor into post-workout phase
    - After session ends, render SessionSummary from AnalyticsEngine
    - Render coaching advice and pre-populated next-session params from CoachingAdvisor when available
    - _Requirements: 8.4, 10.1–10.4_

  - [ ]* 16.7 Write end-to-end integration tests
    - Test full frame-to-alert pipeline under simulated critical deviation
    - Test full frame-to-rep-count pipeline for a complete rep cycle
    - Test LLM boundary: no LLM calls dispatched during session_active phase
    - _Requirements: 12.5, 11.3_

- [ ] 17. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- All TypeScript types are centralised in `src/types/index.ts` — every component imports from there
- Property tests (tasks 2.2, 5.3, 6.2, 7.3, 10.3, 13.3) validate universal correctness invariants and are especially important for the latency-budget and LLM boundary properties
- Checkpoints at tasks 9 and 15 provide incremental validation milestones before integration wiring
- The dependency graph below reflects that test tasks must follow implementation tasks, and that tasks writing to the same file are sequenced

---

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "4.1"] },
    { "id": 2, "tasks": ["1.3", "2.2", "2.3", "4.2", "4.3"] },
    { "id": 3, "tasks": ["3.1", "5.1", "10.1"] },
    { "id": 4, "tasks": ["3.2", "5.2", "10.2"] },
    { "id": 5, "tasks": ["3.3", "5.3", "5.4", "6.1", "10.3", "10.4"] },
    { "id": 6, "tasks": ["6.2", "6.3", "7.1", "11.1", "12.1"] },
    { "id": 7, "tasks": ["7.2", "7.3", "7.4", "11.2", "12.2", "13.1"] },
    { "id": 8, "tasks": ["8.1", "11.3", "12.3", "13.2"] },
    { "id": 9, "tasks": ["8.2", "13.3", "13.4", "14.1"] },
    { "id": 10, "tasks": ["8.3", "14.2"] },
    { "id": 11, "tasks": ["14.3", "16.1"] },
    { "id": 12, "tasks": ["16.2", "16.3", "16.4", "16.5", "16.6"] },
    { "id": 13, "tasks": ["16.7"] }
  ]
}
```
