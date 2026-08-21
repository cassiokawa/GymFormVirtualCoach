# Requirements Document

## Introduction

The Training Sequence feature allows users to build ordered multi-exercise workout sequences from the EXERCISE_CATALOG, execute them with automatic progression between exercises, and log the combined session at completion. A new TrainingSequence orchestrator class wraps individual WorkoutSession instances for each exercise in the sequence, advancing automatically when rep targets are hit or countdown timers expire. The UI provides a sequence builder for selecting and ordering exercises, and a progress display during execution showing current position within the sequence.

## Glossary

- **Training_Sequence_Orchestrator**: The TypeScript class responsible for managing the ordered list of exercises, creating and tearing down WorkoutSession instances for each exercise, and coordinating auto-advance logic.
- **Sequence_Builder_UI**: The vanilla TypeScript DOM component that allows users to select exercises from the EXERCISE_CATALOG, set per-exercise targets, and reorder or remove exercises before starting.
- **EXERCISE_CATALOG**: The existing array of ExerciseCatalogEntry objects containing all available exercises with their FSM configs, display names, and metadata.
- **WorkoutSession**: The existing class that orchestrates real-time pose detection, rep counting, form evaluation, and safety monitoring for a single exercise.
- **Rep_Counter**: The existing FSM-based class that counts repetitions by observing keypoint frames and detecting state transitions through angle thresholds.
- **Session_Logger**: The existing class that accumulates per-rep telemetry and assembles SetRecord and Session objects for persistence.
- **Sequence_Progress_Display**: The DOM element showing current exercise index, total exercises remaining, and per-exercise progress during sequence execution.
- **Exercise_Entry**: A single item in a training sequence consisting of an exercise reference from EXERCISE_CATALOG and a completion target (rep count or time limit).
- **Auto_Advance**: The mechanism that detects target completion for the current exercise and transitions to the next exercise without user intervention and without a rest period.
- **Countdown_Timer**: A per-exercise timer used for time-based exercises that counts down from the configured time limit and triggers auto-advance at zero.

## Requirements

### Requirement 1: Sequence Builder

**User Story:** As a user, I want to select exercises from the catalog, set targets for each, and arrange them in order, so that I can plan a multi-exercise training sequence before starting.

#### Acceptance Criteria

1. THE Sequence_Builder_UI SHALL display all exercises from the EXERCISE_CATALOG as selectable items with their display names and muscle group labels.
2. WHEN the user selects an exercise, THE Sequence_Builder_UI SHALL add the exercise to the end of the sequence list as a new Exercise_Entry.
3. WHEN the user sets a rep target on an Exercise_Entry, THE Sequence_Builder_UI SHALL store the target rep count as a positive integer on that Exercise_Entry.
4. WHEN the user sets a time limit on an Exercise_Entry, THE Sequence_Builder_UI SHALL store the time limit in seconds as a positive integer on that Exercise_Entry.
5. THE Sequence_Builder_UI SHALL allow the user to reorder Exercise_Entries using drag-to-reorder interaction.
6. WHEN the user removes an Exercise_Entry, THE Sequence_Builder_UI SHALL remove that entry from the sequence list and update the displayed order.
7. THE Sequence_Builder_UI SHALL require each Exercise_Entry to have exactly one completion target: either a rep count or a time limit.
8. IF the sequence list contains zero Exercise_Entries, THEN THE Sequence_Builder_UI SHALL disable the start button.

### Requirement 2: Sequence Execution and Auto-Advance

**User Story:** As a user, I want the system to automatically progress through my exercise sequence so that I can focus on my workout without manually switching exercises.

#### Acceptance Criteria

1. WHEN the user starts the training sequence, THE Training_Sequence_Orchestrator SHALL create a WorkoutSession for the first Exercise_Entry in the sequence.
2. WHILE a rep-based Exercise_Entry is active, THE Training_Sequence_Orchestrator SHALL monitor the Rep_Counter rep count and compare it to the target rep count.
3. WHEN the Rep_Counter rep count reaches the target rep count for the current Exercise_Entry, THE Training_Sequence_Orchestrator SHALL stop the current WorkoutSession and create a new WorkoutSession for the next Exercise_Entry within 500 milliseconds.
4. WHILE a time-based Exercise_Entry is active, THE Training_Sequence_Orchestrator SHALL run a Countdown_Timer from the configured time limit toward zero.
5. WHEN the Countdown_Timer reaches zero for the current Exercise_Entry, THE Training_Sequence_Orchestrator SHALL stop the current WorkoutSession and create a new WorkoutSession for the next Exercise_Entry within 500 milliseconds.
6. WHEN the final Exercise_Entry in the sequence completes, THE Training_Sequence_Orchestrator SHALL end the entire training sequence and trigger session logging.
7. THE Training_Sequence_Orchestrator SHALL advance to the next exercise without inserting a rest period between exercises.

### Requirement 3: Progress Display

**User Story:** As a user, I want to see my current position in the sequence and per-exercise progress so that I know how much of my workout remains.

#### Acceptance Criteria

1. WHILE a training sequence is active, THE Sequence_Progress_Display SHALL show the current exercise index as a 1-based number and the total number of exercises in the sequence.
2. WHILE a rep-based Exercise_Entry is active, THE Sequence_Progress_Display SHALL show the current rep count and the target rep count for that exercise.
3. WHILE a time-based Exercise_Entry is active, THE Sequence_Progress_Display SHALL show the remaining seconds on the Countdown_Timer.
4. WHEN the Training_Sequence_Orchestrator advances to the next exercise, THE Sequence_Progress_Display SHALL update the current exercise index and reset the per-exercise progress indicator.
5. THE Sequence_Progress_Display SHALL show the display name of the currently active exercise.

### Requirement 4: Session Logging

**User Story:** As a user, I want my entire multi-exercise sequence logged as a single session so that I can review my performance across all exercises.

#### Acceptance Criteria

1. THE Training_Sequence_Orchestrator SHALL use a single Session_Logger instance across all exercises in the sequence.
2. WHEN the Training_Sequence_Orchestrator advances to a new Exercise_Entry, THE Session_Logger SHALL call startSet with the new exercise name and expected TUT.
3. WHEN a rep is completed during any Exercise_Entry, THE Session_Logger SHALL record the Rep using recordRep.
4. WHEN the entire training sequence completes, THE Training_Sequence_Orchestrator SHALL call endSession on the Session_Logger and persist the resulting Session object.
5. THE Session_Logger SHALL produce a Session object containing SetRecords for every exercise completed during the sequence, ordered by execution sequence.

### Requirement 5: Error Handling

**User Story:** As a user, I want the system to handle errors gracefully during sequence execution so that my workout data is preserved.

#### Acceptance Criteria

1. IF the WorkoutSession for the current exercise encounters an error, THEN THE Training_Sequence_Orchestrator SHALL stop the current WorkoutSession and advance to the next Exercise_Entry.
2. IF an error occurs on the final Exercise_Entry, THEN THE Training_Sequence_Orchestrator SHALL end the training sequence and persist any session data collected up to that point.
3. IF the user manually stops the training sequence before completion, THEN THE Training_Sequence_Orchestrator SHALL stop the active WorkoutSession, call endSession on the Session_Logger, and persist the partial session data.
