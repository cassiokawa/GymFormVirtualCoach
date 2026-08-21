# Requirements Document

## Introduction

The Exercise Log feature provides a summary-level workout history panel displayed below the live tracking area on the same page. Each row represents one completed session showing date, exercises performed, total reps, and form quality percentage. The panel is collapsible and supports on-demand export of all visible sessions as JSON or CSV. The feature leverages the existing `Storage.query()` method for data retrieval and operates on persisted `Session`, `SetRecord`, and `Rep` types using vanilla DOM (no UI framework).

## Glossary

- **Exercise_Log_Panel**: The collapsible DOM panel rendered below the live tracking section that displays the workout history table and export controls.
- **Session_Row**: A single row in the Exercise_Log_Panel representing one completed workout session.
- **Form_Quality_Percentage**: The ratio of correct reps to total reps in a session, expressed as a percentage value rounded to the nearest integer.
- **Export_Controller**: The component responsible for serializing visible session data into JSON or CSV format and triggering a file download.
- **Storage**: The existing IndexedDB-backed singleton that persists and retrieves workout sessions via `Storage.query()`.
- **Session**: A complete workout session object containing id, timestamps, duration, routineId, and an ordered list of SetRecords.
- **SetRecord**: A telemetry record for a single set containing exercise name, reps array, and TUT metrics.
- **Rep**: A single completed repetition with repNumber, tutMs, category (correct, flawed, dangerous_aborted), and deviationEvents.

## Requirements

### Requirement 1: Session History Display

**User Story:** As a user, I want to see a summary of my past workout sessions so that I can track my progress over time.

#### Acceptance Criteria

1. WHEN the Exercise_Log_Panel is opened, THE Exercise_Log_Panel SHALL retrieve all sessions from Storage using `Storage.query()` with a date range covering all persisted data.
2. THE Exercise_Log_Panel SHALL display one Session_Row per session in descending chronological order (most recent first).
3. THE Session_Row SHALL display the session date formatted as YYYY-MM-DD.
4. THE Session_Row SHALL display a comma-separated list of unique exercise names performed in that session.
5. THE Session_Row SHALL display the total number of reps across all sets in that session.
6. THE Session_Row SHALL display the Form_Quality_Percentage calculated as (total correct reps / total reps) × 100, rounded to the nearest integer.
7. IF a session contains zero total reps, THEN THE Session_Row SHALL display 0 as the total reps and "N/A" as the Form_Quality_Percentage.

### Requirement 2: Collapsible Panel Behavior

**User Story:** As a user, I want the workout history to be collapsible so that it does not obscure the live tracking area when I do not need it.

#### Acceptance Criteria

1. THE Exercise_Log_Panel SHALL render in a collapsed state by default when the page loads.
2. WHEN the user clicks the Exercise_Log_Panel toggle control, THE Exercise_Log_Panel SHALL expand to show the session history table.
3. WHEN the user clicks the Exercise_Log_Panel toggle control while the panel is expanded, THE Exercise_Log_Panel SHALL collapse to hide the session history table.
4. WHILE the Exercise_Log_Panel is collapsed, THE Exercise_Log_Panel SHALL display only the toggle control with a descriptive label.
5. THE Exercise_Log_Panel SHALL be positioned below the live tracking section in the DOM layout.

### Requirement 3: Export Functionality

**User Story:** As a user, I want to export my workout history as JSON or CSV so that I can analyze my data externally or keep a backup.

#### Acceptance Criteria

1. THE Exercise_Log_Panel SHALL display a single export button when the panel is expanded.
2. WHEN the user clicks the export button, THE Export_Controller SHALL present a format selection allowing the user to choose between JSON and CSV.
3. WHEN the user selects JSON format, THE Export_Controller SHALL serialize all visible sessions into a JSON array and trigger a file download with a `.json` extension.
4. WHEN the user selects CSV format, THE Export_Controller SHALL serialize all visible sessions into CSV with headers (date, exercises, total_reps, form_quality_percent) and trigger a file download with a `.csv` extension.
5. THE Export_Controller SHALL name the downloaded file using the pattern `workout-history-YYYY-MM-DD` where the date is the current date.
6. IF no sessions are visible in the Exercise_Log_Panel, THEN THE Export_Controller SHALL disable the export button.

### Requirement 4: Data Computation

**User Story:** As a user, I want accurate summary metrics for each session so that I can trust the displayed workout data.

#### Acceptance Criteria

1. THE Exercise_Log_Panel SHALL compute total reps for a session by summing the length of the `reps` array across all SetRecords in that Session.
2. THE Exercise_Log_Panel SHALL compute the count of correct reps by counting reps with category equal to "correct" across all SetRecords in a Session.
3. THE Exercise_Log_Panel SHALL derive unique exercise names from the `exerciseName` field of each SetRecord in a Session.
4. THE Exercise_Log_Panel SHALL compute Form_Quality_Percentage using the formula: (correct rep count / total rep count) × 100.

### Requirement 5: Vanilla DOM Rendering

**User Story:** As a developer, I want the exercise log to use vanilla DOM manipulation so that it integrates with the existing architecture without introducing a UI framework dependency.

#### Acceptance Criteria

1. THE Exercise_Log_Panel SHALL render all UI elements using `document.createElement` and direct DOM manipulation.
2. THE Exercise_Log_Panel SHALL not depend on any external UI framework or templating library.
3. THE Exercise_Log_Panel SHALL provide a `mount(container: HTMLElement)` method that appends the panel to the specified container element.
