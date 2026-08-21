# Requirements Document

## Introduction

This feature adds three capabilities to the GymForm Virtual Coach application: (1) persisting and managing named workout routines so they can be reloaded and executed across sessions, (2) detailed per-exercise and per-rep log views within the Workout History panel, and (3) replacing the LLM stub in LlmGateway with a real connection to the user's local Ollama instance to deliver personalized coaching advice, routine modification suggestions, and form improvement tips.

## Glossary

- **Routine_Store**: The IndexedDB object store (`saved_routines`) responsible for persisting named routine definitions.
- **Saved_Routine**: A named collection of exercises with target reps, stored in IndexedDB for later retrieval and execution.
- **Exercise_Log_Panel**: The collapsible Workout History UI component that displays session summaries and detailed logs.
- **Session_Detail_View**: A per-session drill-down view showing set breakdowns, per-rep details, and a timeline of form events.
- **LLM_Gateway**: The singleton that enforces phase-based access control and transports prompts to the LLM backend.
- **Ollama_Client**: The HTTP transport layer within LLM_Gateway that communicates with the local Ollama REST API at `http://localhost:11434`.
- **Coaching_Advisor**: The post-workout component that generates personalized coaching recommendations.
- **Routine_Generator**: The pre-workout component that generates routine suggestions using session history.

## Requirements

### Requirement 1: Save a Routine

**User Story:** As a user, I want to save a routine I have built in the routine builder with a custom name, so that I can reload and reuse it in future workouts.

#### Acceptance Criteria

1. WHEN the user clicks the "Save Routine" button and provides a non-empty name, THE Routine_Store SHALL persist the routine definition (name, ordered exercise list with target reps) to the `saved_routines` object store in IndexedDB.
2. WHEN the user attempts to save a routine with zero exercises, THE Routine_Store SHALL reject the save and display an inline error message stating that at least one exercise is required.
3. WHEN the user saves a routine with a name that already exists, THE Routine_Store SHALL overwrite the existing routine definition with the new one.
4. THE Routine_Store SHALL assign a UUID to each saved routine and record the creation timestamp.

### Requirement 2: List and Load Saved Routines

**User Story:** As a user, I want to see a list of my saved routines and load one into the routine builder, so that I can quickly start a familiar workout.

#### Acceptance Criteria

1. WHEN the Saved Routines panel is opened, THE Routine_Store SHALL retrieve all saved routines from IndexedDB and display them ordered by most recently saved first.
2. WHEN the user selects a saved routine from the list, THE Routine_Store SHALL populate the routine builder with the exercises and target reps from the selected routine.
3. WHEN the user clicks the "Delete" button on a saved routine, THE Routine_Store SHALL remove the routine from IndexedDB and update the displayed list.

### Requirement 3: Run a Saved Routine

**User Story:** As a user, I want to run a saved routine directly from the list, so that I can start my workout without re-adding exercises manually.

#### Acceptance Criteria

1. WHEN the user clicks "Start" on a saved routine, THE Routine_Store SHALL load the routine into the RoutineMode and begin the workout session.
2. WHEN a workout session completes that was started from a saved routine, THE Session_Detail_View SHALL associate the session log with the saved routine's ID.

### Requirement 4: Detailed Session Log View

**User Story:** As a user, I want to see detailed breakdowns of each workout session, so that I can review my form and performance at a per-set and per-rep level.

#### Acceptance Criteria

1. WHEN the Workout History panel is expanded, THE Exercise_Log_Panel SHALL display a "Details" button on each session row.
2. WHEN the user clicks the "Details" button for a session, THE Session_Detail_View SHALL display a per-set breakdown including exercise name, rep counts by category (correct, flawed, dangerous_aborted), total TUT, and deviation event count.
3. WHEN the user expands a set within the Session_Detail_View, THE Session_Detail_View SHALL display per-rep detail including rep number, measured angle values, category, and associated deviation events.
4. WHEN the Session_Detail_View is displayed, THE Session_Detail_View SHALL render a chronological timeline of all form warning and critical events that occurred during the session, ordered by timestamp.

### Requirement 5: Ollama LLM Connection

**User Story:** As a user, I want the application to connect to my local Ollama instance, so that the coaching features use a real LLM instead of a stub response.

#### Acceptance Criteria

1. THE Ollama_Client SHALL send HTTP POST requests to `http://localhost:11434/api/generate` with a JSON body containing the `model` and `prompt` fields.
2. WHEN Ollama returns a successful response, THE Ollama_Client SHALL parse the streamed JSON lines and concatenate the `response` field values into a complete text response.
3. IF Ollama is unreachable or returns a non-200 status code, THEN THE Ollama_Client SHALL throw a descriptive error that LLM_Gateway propagates to callers.
4. THE Ollama_Client SHALL enforce a configurable request timeout defaulting to 30 seconds.
5. WHEN a request exceeds the timeout, THE Ollama_Client SHALL abort the fetch and throw a timeout error.
6. THE LLM_Gateway SHALL expose a configuration method to set the model name (defaulting to `qwen2.5:7b`).

### Requirement 6: Post-Workout Coaching Advice via LLM

**User Story:** As a user, I want to receive personalized coaching advice after completing a workout, so that I can improve my form and training over time.

#### Acceptance Criteria

1. WHEN a workout session completes, THE Coaching_Advisor SHALL send a structured prompt containing the session summary (rep counts, TUT deltas, deviation events) to the LLM via LLM_Gateway.
2. WHEN the LLM returns a valid coaching response, THE Coaching_Advisor SHALL parse the response into structured CoachingRecommendation objects and display them to the user.
3. IF the LLM is unavailable or returns an unparseable response, THEN THE Coaching_Advisor SHALL fall back to the existing rule-based recommendation engine and indicate to the user that AI coaching is offline.

### Requirement 7: LLM-Based Routine Modification Suggestions

**User Story:** As a user, I want the LLM to suggest modifications to my saved routines based on my workout history, so that my training evolves with my progress.

#### Acceptance Criteria

1. WHEN the user requests routine suggestions from the Saved Routines panel, THE Routine_Generator SHALL build a prompt containing the current routine definition and the 10 most recent session summaries, then send the prompt to the LLM via LLM_Gateway.
2. WHEN the LLM returns a valid routine suggestion, THE Routine_Generator SHALL parse the response into structured ExerciseConfig objects and present modification suggestions (add, remove, or adjust exercises) to the user.
3. WHEN the user accepts a routine suggestion, THE Routine_Store SHALL update the saved routine in IndexedDB with the accepted modifications.
4. IF the LLM is unavailable, THEN THE Routine_Generator SHALL fall back to the existing volume-reduction heuristic and inform the user that AI suggestions are offline.

### Requirement 8: Form Improvement Tips from Recurring Deviations

**User Story:** As a user, I want the LLM to identify recurring form deviation patterns and provide tailored improvement tips, so that I can address my weakest points.

#### Acceptance Criteria

1. WHEN the user opens the Session_Detail_View, THE Coaching_Advisor SHALL analyse all deviation events across the 10 most recent sessions and identify recurring patterns (same joint, same severity, occurring in 3 or more sessions).
2. WHEN recurring deviation patterns are identified and the LLM is available, THE Coaching_Advisor SHALL send a prompt describing the recurring patterns and request targeted form improvement tips.
3. WHEN the LLM returns form tips, THE Session_Detail_View SHALL display the tips in a dedicated "Form Insights" section within the detail view.
4. IF no recurring patterns are identified, THEN THE Session_Detail_View SHALL display a message indicating that no recurring form issues were detected.
5. IF the LLM is unavailable, THEN THE Session_Detail_View SHALL display rule-based tips derived from the deviation event data without LLM augmentation.

### Requirement 9: Ollama Connection Health Check

**User Story:** As a user, I want to see whether my Ollama instance is reachable, so that I know if AI features are available before starting a workout.

#### Acceptance Criteria

1. WHEN the application starts, THE Ollama_Client SHALL send a GET request to `http://localhost:11434/api/tags` to verify connectivity.
2. WHEN the health check succeeds, THE LLM_Gateway SHALL set an internal `isAvailable` flag to true and display an "AI Connected" indicator in the UI.
3. IF the health check fails, THEN THE LLM_Gateway SHALL set the `isAvailable` flag to false and display an "AI Offline" indicator in the UI.
4. THE Ollama_Client SHALL re-check connectivity every 60 seconds while the application is open.
