# Requirements Document

## Introduction

The Training Report feature displays a post-workout report card overlaid on the 640px video container area after the user presses Stop. It aggregates session performance data from the AnalyticsEngine and coaching recommendations from the CoachingAdvisor, presenting a summary of reps, form quality, time-under-tension metrics, tips, recurring-form warnings, and progress compared to previous sessions. A "Done" button dismisses the report and returns the user to the exercise menu.

## Glossary

- **Training_Report**: The DOM-rendered report card component overlaid on the video container after a workout ends.
- **Video_Container**: The 640px-wide HTML element that hosts the camera feed during a workout and the report overlay post-workout.
- **AnalyticsEngine**: The existing module that categorizes reps and computes TUT metrics, exposing `assembleSessionSummary()`.
- **CoachingAdvisor**: The existing module that produces coaching recommendations via `generateFullResult()`, with a rule-based fallback.
- **Storage**: The IndexedDB-backed persistence layer that stores and retrieves past session data.
- **Session_Summary**: The `SessionSummary` object produced by the AnalyticsEngine containing per-set breakdowns and deviation events.
- **Full_Coaching_Result**: The `FullCoachingResult` object produced by the CoachingAdvisor containing recommendations and next-session parameters.
- **Exercise_Menu**: The application view where the user selects an exercise to begin a new session.

## Requirements

### Requirement 1: Report Trigger

**User Story:** As a user, I want the training report to appear automatically when I stop my workout, so that I can immediately review my performance.

#### Acceptance Criteria

1. WHEN the user presses the Stop button, THE Training_Report SHALL retrieve the Session_Summary by calling `AnalyticsEngine.assembleSessionSummary()` with the current session data.
2. WHEN the Session_Summary is available, THE Training_Report SHALL retrieve the Full_Coaching_Result by calling `CoachingAdvisor.generateFullResult()` with the Session_Summary.
3. WHEN the Full_Coaching_Result is available, THE Training_Report SHALL render the report card as a DOM overlay on the Video_Container.
4. THE Training_Report SHALL render the overlay within 500 milliseconds of the Stop button press, excluding network latency for LLM calls.

### Requirement 2: Performance Summary Display

**User Story:** As a user, I want to see my key workout metrics at a glance, so that I understand how my session went.

#### Acceptance Criteria

1. THE Training_Report SHALL display the total number of completed repetitions, broken down by category: correct, flawed, and dangerous.
2. THE Training_Report SHALL display a form quality percentage calculated as (total correct reps / total reps) × 100, rounded to the nearest integer.
3. THE Training_Report SHALL display time-under-tension metrics including actual TUT, expected TUT, and TUT delta for each set performed.
4. THE Training_Report SHALL display the exercise name for each set in the breakdown.

### Requirement 3: Coaching Tips and Recommendations

**User Story:** As a user, I want actionable coaching tips after my workout, so that I can improve my form in the next session.

#### Acceptance Criteria

1. THE Training_Report SHALL display all recommendations from the Full_Coaching_Result, grouped by category: form_correction, volume_adjustment, technique_tip, and safety_warning.
2. WHEN the CoachingAdvisor LLM is unavailable, THE Training_Report SHALL display rule-based fallback recommendations without indicating degraded quality to the user beyond the technique_tip message added by CoachingAdvisor.
3. THE Training_Report SHALL display each recommendation message as a readable text item within its category group.

### Requirement 4: Recurring Form Warnings

**User Story:** As a user, I want to be warned about form problems that keep recurring, so that I can prioritize fixing them.

#### Acceptance Criteria

1. WHEN the Session_Summary contains two or more deviation events for the same joint, THE Training_Report SHALL display a recurring-form warning identifying that joint.
2. THE Training_Report SHALL display the count of deviation occurrences for each recurring joint warning.
3. THE Training_Report SHALL display recurring-form warnings with visual emphasis distinct from general recommendations.

### Requirement 5: Progress Indicators

**User Story:** As a user, I want to see how my current session compares to previous ones, so that I can track my improvement over time.

#### Acceptance Criteria

1. WHEN previous session data exists in Storage for the same exercise, THE Training_Report SHALL display a comparison of form quality percentage between the current session and the most recent previous session.
2. WHEN the current form quality percentage is higher than the previous session, THE Training_Report SHALL display a positive progress indicator.
3. WHEN the current form quality percentage is lower than the previous session, THE Training_Report SHALL display a negative progress indicator.
4. IF no previous session data exists in Storage for the same exercise, THEN THE Training_Report SHALL display a message indicating this is the first recorded session for that exercise.

### Requirement 6: Report Layout and Rendering

**User Story:** As a user, I want the report to fit within the video area and be easy to read, so that I can review it without navigating elsewhere.

#### Acceptance Criteria

1. THE Training_Report SHALL render within the 640px-wide Video_Container boundaries using vanilla TypeScript DOM manipulation.
2. THE Training_Report SHALL be scrollable vertically when content exceeds the Video_Container height.
3. THE Training_Report SHALL use semantic HTML elements for accessibility, including headings for sections and lists for grouped items.
4. THE Training_Report SHALL display a "Done" button at the bottom of the report content.

### Requirement 7: Report Dismissal

**User Story:** As a user, I want to dismiss the report and return to exercise selection, so that I can start a new workout or leave.

#### Acceptance Criteria

1. WHEN the user clicks the "Done" button, THE Training_Report SHALL remove the report overlay from the Video_Container.
2. WHEN the report overlay is removed, THE Training_Report SHALL navigate the user to the Exercise_Menu view.
3. THE Training_Report SHALL remove all DOM elements created by the report overlay upon dismissal, leaving no residual nodes in the Video_Container.
