# Requirements Document

## Introduction

The CV Fitness & Form Assistant is an AI-driven personal trainer application that uses client-side Computer Vision (MediaPipe Pose) to provide near real-time exercise form analysis, rep counting, and safety monitoring. An asynchronous LLM backend handles intelligent workout planning and post-workout performance analytics. The system is split across three distinct phases: pre-workout planning, real-time workout execution, and post-workout analytics.

---

## Glossary

- **Pose_Detector**: The client-side MediaPipe Pose module running in a WebAssembly/Web Worker that extracts skeletal keypoints from camera frames.
- **FSM**: Finite State Machine — the component that tracks exercise state transitions to count valid repetitions.
- **Rep_Counter**: The FSM-based component that increments valid repetition counts based on joint angle state transitions.
- **Form_Evaluator**: The client-side component that assesses joint angles per frame against exercise-specific thresholds.
- **Safety_Monitor**: The component that detects dangerous joint angle conditions and triggers immediate alerts.
- **Alert_System**: The component responsible for delivering audio and visual overlay safety warnings to the user.
- **Session_Logger**: The component that records telemetry data (reps, angles, TUT, errors) during workout execution.
- **Routine_Generator**: The LLM-backed service that produces structured pre-workout routines based on historical session data.
- **Form_Guide**: The component that displays step-by-step biomechanical instructions and reference media before a set begins.
- **Analytics_Engine**: The post-workout component that categorizes rep quality and calculates performance metrics.
- **Coaching_Advisor**: The LLM-backed service that produces targeted coaching advice based on session summaries.
- **Storage**: The local structured storage layer (e.g., IndexedDB or SQLite) that persists workout sessions and exercise logs.
- **Keypoint**: A 3D spatial coordinate (x, y, z) for one of 33 body landmarks extracted by the Pose_Detector.
- **Joint_Angle**: The interior angle in degrees calculated from three Keypoints using dot product vector math.
- **TUT**: Time-Under-Tension — the elapsed time in seconds during which a muscle group is under mechanical load within a set.
- **Valgus_Cave**: A dangerous knee inward-collapse deviation detected by medial knee Joint_Angle thresholds.
- **Session**: A single workout event containing one or more sets of exercises.
- **Set**: A sequence of repetitions performed without rest for a given exercise.
- **Rep**: A single complete execution of an exercise movement cycle tracked by the FSM.

---

## Requirements

### Requirement 1: Client-Side Pose Detection

**User Story:** As a user, I want my body pose to be detected locally on my device during exercise, so that form analysis is available in real time without relying on a network connection.

#### Acceptance Criteria

1. WHEN a camera frame is available, THE Pose_Detector SHALL extract 33 Keypoints per frame including x, y, and z coordinates.
2. THE Pose_Detector SHALL process frames at a rate of 30 frames per second or greater under normal operating conditions.
3. THE Pose_Detector SHALL execute within a WebAssembly Web Worker to prevent blocking the main UI thread.
4. IF the Pose_Detector fails to initialize or loses camera access, THEN THE Pose_Detector SHALL emit a descriptive error event to the application.
5. WHILE a workout session is active, THE Pose_Detector SHALL deliver Keypoint data to the Form_Evaluator and Rep_Counter within 50 milliseconds of frame capture.

---

### Requirement 2: Repetition Counting via Finite State Machine

**User Story:** As a user, I want the system to automatically count my valid repetitions, so that I can focus on my form without manually tracking my reps.

#### Acceptance Criteria

1. THE Rep_Counter SHALL model each exercise as a FSM with a minimum of three states: START, INFLECTION, and COMPLETE.
2. WHEN a Keypoint update is received, THE Rep_Counter SHALL compute the relevant Joint_Angles for the active exercise.
3. WHEN the FSM transitions from COMPLETE back to START, THE Rep_Counter SHALL increment the valid repetition count by one.
4. IF the required Joint_Angles fall outside the valid state-transition threshold for the active exercise, THEN THE Rep_Counter SHALL hold the current FSM state without incrementing the rep count.
5. THE Rep_Counter SHALL reset the FSM state and repetition count to zero at the start of each new Set.
6. WHEN a Rep is completed, THE Rep_Counter SHALL record the elapsed TUT for that Rep in milliseconds.

---

### Requirement 3: Joint Angle Calculation

**User Story:** As a user, I want the system to calculate my joint angles precisely, so that form analysis and rep counting reflect my actual movement.

#### Acceptance Criteria

1. WHEN three Keypoints defining a joint are provided, THE Form_Evaluator SHALL calculate the interior Joint_Angle using dot product vector math.
2. THE Form_Evaluator SHALL calculate Joint_Angles for all joints relevant to the active exercise per frame.
3. THE Form_Evaluator SHALL express all Joint_Angles in degrees within the range of 0 to 180 inclusive.
4. IF fewer than three valid Keypoints are available for a joint calculation, THEN THE Form_Evaluator SHALL mark that Joint_Angle as unavailable for that frame and exclude it from evaluation.

---

### Requirement 4: Real-Time Form Evaluation

**User Story:** As a user, I want immediate feedback on my exercise form during each rep, so that I can correct errors before they become injurious habits.

#### Acceptance Criteria

1. WHILE a workout session is active, THE Form_Evaluator SHALL evaluate each received Keypoint frame against the exercise-specific Joint_Angle thresholds.
2. WHEN a Joint_Angle deviation from acceptable threshold is detected, THE Form_Evaluator SHALL classify the deviation by severity: warning or critical.
3. WHEN a warning-severity deviation is detected, THE Form_Evaluator SHALL log the deviation event with the Joint_Angle value, timestamp, and rep number.
4. WHEN a critical-severity deviation is detected, THE Form_Evaluator SHALL immediately notify the Safety_Monitor.
5. THE Form_Evaluator SHALL complete per-frame evaluation within 50 milliseconds of receiving Keypoint data.

---

### Requirement 5: Safety Monitoring and Alerts

**User Story:** As a user, I want to be immediately warned if I am performing a movement that could cause injury, so that I can stop and correct my position before harm occurs.

#### Acceptance Criteria

1. WHEN the Safety_Monitor receives a critical-severity deviation notification, THE Safety_Monitor SHALL trigger the Alert_System within 50 milliseconds.
2. THE Alert_System SHALL deliver a simultaneous audio alert and a visual overlay alert when a critical deviation is active.
3. WHILE a critical-severity deviation persists across consecutive frames, THE Alert_System SHALL maintain the visual overlay alert continuously.
4. WHEN the Joint_Angles return within safe thresholds, THE Alert_System SHALL dismiss the active critical alert.
5. THE Safety_Monitor SHALL detect Valgus_Cave conditions by evaluating medial knee Joint_Angle against a per-exercise threshold.
6. THE Safety_Monitor SHALL detect excessive lumbar extension by evaluating the lumbar spine Joint_Angle against a per-exercise threshold.
7. IF the Safety_Monitor detects a critical deviation during a Rep, THEN THE Session_Logger SHALL mark that Rep as a Dangerous/Aborted Rep.

---

### Requirement 6: Adaptive Pre-Workout Routine Generation

**User Story:** As a user, I want the system to generate a personalized workout routine before I begin, so that my session is optimized for my current fitness state and goals.

#### Acceptance Criteria

1. WHEN a user initiates routine generation, THE Routine_Generator SHALL query the Storage for previous Session records, including logged form errors, fatigue indicators, and target muscle groups.
2. THE Routine_Generator SHALL produce a structured workout containing exercise sequence, target rep count, expected TUT per set, and primary and secondary muscle groups for each exercise.
3. WHEN historical form degradation is present in previous Sessions, THE Routine_Generator SHALL reduce volume or weight recommendations for the affected muscle groups in the generated routine.
4. THE Routine_Generator SHALL complete routine generation and return results to the application before the user begins the first Set.
5. IF the Storage contains no prior Session records, THEN THE Routine_Generator SHALL generate a baseline routine appropriate for a first-time session without error.

---

### Requirement 7: Interactive Form Instruction

**User Story:** As a user, I want to see step-by-step form guidance before each exercise, so that I understand correct biomechanics before I start moving.

#### Acceptance Criteria

1. WHEN a user selects an exercise to begin, THE Form_Guide SHALL display the step-by-step biomechanical form instructions for that exercise before the Set starts.
2. THE Form_Guide SHALL display at least one reference visual media item (animated GIF or video link) per exercise that illustrates the target range of motion.
3. THE Form_Guide SHALL display at least one reference visual media item per exercise that highlights common mistakes to avoid.
4. WHEN the user confirms readiness, THE Form_Guide SHALL transition the application to the workout execution phase for that Set.

---

### Requirement 8: Post-Workout Session Breakdown

**User Story:** As a user, I want a clear breakdown of my performance after a workout, so that I can understand exactly where my form succeeded or failed.

#### Acceptance Criteria

1. WHEN a Session ends, THE Analytics_Engine SHALL categorize every logged Rep into exactly one of: Correct Rep, Flawed Form Rep, or Dangerous/Aborted Rep.
2. THE Analytics_Engine SHALL calculate the actual TUT for each Set by summing the TUT values of all Reps in that Set.
3. THE Analytics_Engine SHALL compare actual TUT per Set against the expected TUT from the pre-workout routine and record the delta.
4. THE Analytics_Engine SHALL produce a Session summary containing rep category totals, actual vs. expected TUT per Set, and all logged deviation events.
5. WHEN the Session summary is produced, THE Analytics_Engine SHALL pass the summary to the Coaching_Advisor and to the Storage for persistence.

---

### Requirement 9: Data Persistence

**User Story:** As a user, I want my workout history to be saved locally on my device, so that my progress and session data persist across sessions without requiring a server.

#### Acceptance Criteria

1. THE Storage SHALL persist each completed Session as a record in a `workout_sessions` table containing session date, duration, and the linked routine.
2. THE Storage SHALL persist each Set's telemetry as a record in a `session_exercise_logs` table containing exercise name, rep category counts, actual TUT, and all deviation events.
3. WHEN a Session record is written, THE Storage SHALL return a confirmation to the Session_Logger within 2 seconds.
4. IF a write operation fails, THEN THE Storage SHALL emit a descriptive error event and retain any in-memory telemetry for retry.
5. THE Storage SHALL expose a query interface that returns all Session records for a given date range in ascending chronological order.

---

### Requirement 10: Post-Workout Coaching and Next-Session Pre-Population

**User Story:** As a user, I want actionable coaching advice after my workout and auto-populated parameters for my next session, so that I improve progressively without manual planning.

#### Acceptance Criteria

1. WHEN the Coaching_Advisor receives a Session summary, THE Coaching_Advisor SHALL produce targeted coaching advice that references specific deviation events and rep categories from the summary.
2. THE Coaching_Advisor SHALL pre-populate the parameters for the next Session's routine based on the current Session's performance metrics.
3. WHEN the Coaching_Advisor completes analysis, THE Coaching_Advisor SHALL return coaching advice and pre-populated next-session parameters to the application.
4. IF the LLM service is unavailable, THEN THE Coaching_Advisor SHALL present the raw Session summary to the user and indicate that AI coaching is temporarily unavailable.

---

### Requirement 11: LLM Request Boundaries

**User Story:** As a system architect, I want LLM calls strictly limited to pre-workout planning and post-workout analysis, so that real-time exercise execution remains fully local and low-latency.

#### Acceptance Criteria

1. THE Routine_Generator SHALL be the only component permitted to issue LLM requests during the pre-workout phase.
2. THE Coaching_Advisor SHALL be the only component permitted to issue LLM requests during the post-workout phase.
3. WHILE a workout session is active, THE system SHALL issue no LLM requests.
4. IF any component other than Routine_Generator or Coaching_Advisor attempts to issue an LLM request, THEN THE system SHALL reject the request and log a policy violation error.

---

### Requirement 12: Performance and Latency Budget

**User Story:** As a user, I want the real-time feedback loop to feel instantaneous during exercise, so that alerts and rep counts are always current and never lag behind my movement.

#### Acceptance Criteria

1. THE Pose_Detector SHALL complete Keypoint extraction for a single frame within 33 milliseconds.
2. THE Form_Evaluator SHALL complete Joint_Angle evaluation for a single frame within 10 milliseconds of receiving Keypoint data.
3. THE Safety_Monitor SHALL trigger the Alert_System within 10 milliseconds of receiving a critical deviation notification.
4. THE Rep_Counter SHALL update the repetition count within 5 milliseconds of a valid FSM state transition.
5. WHILE a workout session is active, THE total end-to-end latency from frame capture to alert or rep count update SHALL remain below 50 milliseconds.
