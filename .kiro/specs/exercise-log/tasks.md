# Implementation Plan: Exercise Log

## Overview

Implement a collapsible Exercise Log panel below the live tracking area that displays session history (date, exercises, total reps, form quality %) and supports JSON/CSV export. The feature introduces two new classes — `ExerciseLogPanel` and `ExportController` — using vanilla DOM and the existing `Storage.query()` API.

## Tasks

- [ ] 1. Create ExportController with serialization logic
  - [ ] 1.1 Create `src/exerciseLog/ExportController.ts` with `exportJSON`, `exportCSV`, `download`, and `generateFilename` methods
    - Implement `exportJSON(rows)` to serialize `SessionRowData[]` to a pretty-printed JSON array
    - Implement `exportCSV(rows)` to serialize with header row `date,exercises,total_reps,form_quality_percent` and double-quote exercise names containing commas
    - Implement `download(content, filename, mimeType)` using Blob + createObjectURL + hidden anchor click pattern
    - Implement static `generateFilename(extension)` using pattern `workout-history-YYYY-MM-DD`
    - _Requirements: 3.3, 3.4, 3.5_

  - [ ]* 1.2 Write property test for JSON export round-trip
    - **Property 7: JSON Export Round-Trip**
    - Test that for any array of `SessionRowData`, `JSON.parse(exportJSON(rows))` is structurally equal to the input
    - **Validates: Requirements 3.3**

  - [ ]* 1.3 Write property test for CSV export structure
    - **Property 8: CSV Export Structure**
    - Test that for any non-empty array of `SessionRowData` of length N, `exportCSV(rows)` produces exactly N+1 lines with the correct header
    - **Validates: Requirements 3.4**

- [ ] 2. Implement ExerciseLogPanel data computation methods
  - [ ] 2.1 Create `src/exerciseLog/ExerciseLogPanel.ts` with static computation methods and the `SessionRowData` interface
    - Implement `computeTotalReps(session)` — sum of `set.reps.length` across all SetRecords
    - Implement `computeCorrectReps(session)` — count reps where `category === 'correct'`
    - Implement `computeUniqueExercises(session)` — sorted distinct `exerciseName` values
    - Implement `computeFormQuality(session)` — `Math.round((correct / total) * 100)` as string, or `"N/A"` for zero reps
    - Implement `formatDate(date)` — returns `YYYY-MM-DD` zero-padded string
    - Implement `sessionToRowData(session)` — combines all above into a `SessionRowData`
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.7, 4.1, 4.2, 4.3, 4.4_

  - [ ]* 2.2 Write property test for total reps computation
    - **Property 3: Total Reps Computation**
    - Test that `computeTotalReps` returns the sum of all `reps.length` across all SetRecords for any generated Session
    - **Validates: Requirements 1.5, 4.1**

  - [ ]* 2.3 Write property test for form quality percentage
    - **Property 4: Form Quality Percentage Computation**
    - Test that `computeFormQuality` returns correct rounded percentage for sessions with reps, and `"N/A"` for zero-rep sessions
    - **Validates: Requirements 1.6, 1.7, 4.2, 4.4**

  - [ ]* 2.4 Write property test for unique exercise names
    - **Property 5: Unique Exercise Names Derivation**
    - Test that `computeUniqueExercises` returns exactly the distinct `exerciseName` values with no duplicates or missing entries
    - **Validates: Requirements 1.4, 4.3**

  - [ ]* 2.5 Write property test for date formatting
    - **Property 2: Date Formatting**
    - Test that `formatDate` produces a string matching `YYYY-MM-DD` for any valid Date
    - **Validates: Requirements 1.3**

- [ ] 3. Implement ExerciseLogPanel DOM rendering and toggle behavior
  - [ ] 3.1 Add `mount(container)`, `toggle()`, and `render()` methods to `ExerciseLogPanel`
    - `mount` creates the panel DOM structure (section, toggle button, content div, table, export button) and appends to container
    - Panel renders collapsed by default with `aria-expanded="false"` on toggle button
    - `toggle()` flips expanded state, shows/hides content, updates `aria-expanded`
    - `render()` calls `Storage.query()`, computes `SessionRowData[]`, sorts descending by date, and rebuilds table tbody
    - Export button is disabled when no sessions are visible
    - Display error message "Unable to load workout history" if `Storage.query()` rejects
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.6, 5.1, 5.2, 5.3_

  - [ ]* 3.2 Write property test for descending chronological order
    - **Property 1: Descending Chronological Order**
    - Test that for any list of sessions, the rendered row data array is in descending order by date
    - **Validates: Requirements 1.2**

  - [ ]* 3.3 Write property test for toggle round-trip
    - **Property 6: Toggle Round-Trip**
    - Test that invoking `toggle()` twice returns the panel to its original state
    - **Validates: Requirements 2.2, 2.3**

- [ ] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Wire export functionality and integrate panel into the app
  - [ ] 5.1 Connect ExportController to ExerciseLogPanel export button
    - On export button click, present format selection (JSON / CSV) via a small inline menu or dropdown
    - On format selection, call `exportJSON` or `exportCSV` with current `rowData`, then call `download` with appropriate mime type and generated filename
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ] 5.2 Mount ExerciseLogPanel in the application entry point
    - Import `ExerciseLogPanel` in the app initialization code
    - Instantiate with `Storage.getInstance()` and call `mount()` on the container element below the live tracking section
    - _Requirements: 2.5, 5.3_

  - [ ]* 5.3 Write unit tests for DOM rendering behavior
    - Test initial collapsed state, toggle interactions, export button disable logic, error message display
    - Use vitest + jsdom environment
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.6_

- [ ] 6. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document using fast-check
- Unit tests validate specific DOM behavior and edge cases using vitest + jsdom
- The project already has `fast-check`, `vitest`, and `jsdom` as devDependencies — no new packages needed

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.2", "2.3", "2.4", "2.5"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["3.2", "3.3"] },
    { "id": 4, "tasks": ["5.1", "5.2"] },
    { "id": 5, "tasks": ["5.3"] }
  ]
}
```
