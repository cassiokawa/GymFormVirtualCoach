# Design Document — Exercise Log

## Overview

The Exercise Log feature adds a collapsible summary panel below the live tracking area, showing past workout sessions with date, exercises, reps, and form quality metrics. Users can export their history as JSON or CSV. The feature uses vanilla DOM rendering and the existing `Storage.query()` API — no new schema or frameworks required.

## Architecture

The Exercise Log feature adds a collapsible summary panel below the live tracking area. It reads persisted workout data via the existing `Storage.query()` method and renders session rows using vanilla DOM manipulation. An export controller serializes visible sessions to JSON or CSV and triggers browser file downloads.

The feature introduces two new classes:
- **ExerciseLogPanel** — owns the DOM lifecycle (mount, toggle, render) and data computation
- **ExportController** — serializes session summary data and triggers file downloads

No new database schema or external dependencies are required.

```
┌──────────────────────────────────────────────┐
│  index.html                                  │
│  ┌────────────────────────────────────────┐  │
│  │  Live Tracking Area (existing)         │  │
│  └────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────┐  │
│  │  ExerciseLogPanel                      │  │
│  │  ┌──────────────────────────────────┐  │  │
│  │  │ Toggle Header [▶ Workout History]│  │  │
│  │  └──────────────────────────────────┘  │  │
│  │  ┌──────────────────────────────────┐  │  │
│  │  │ Session Table (collapsible)      │  │  │
│  │  │  Row: date | exercises | reps | %│  │  │
│  │  └──────────────────────────────────┘  │  │
│  │  ┌──────────────────────────────────┐  │  │
│  │  │ Export Button → ExportController │  │  │
│  │  └──────────────────────────────────┘  │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

## Components and Interfaces

### ExerciseLogPanel

**File:** `src/exerciseLog/ExerciseLogPanel.ts`

Responsibilities:
- Mount into a provided container element
- Fetch sessions from Storage on panel open
- Compute summary metrics per session (total reps, correct reps, form quality %, unique exercises)
- Render a session table with one row per session in descending chronological order
- Manage collapsed/expanded state via toggle control

```typescript
import type { Session, SetRecord } from '../types/index.js';
import { Storage } from '../storage/Storage.js';
import { ExportController } from './ExportController.js';

export interface SessionRowData {
  date: string;              // YYYY-MM-DD
  exercises: string;         // comma-separated unique names
  totalReps: number;
  formQualityPercent: string; // integer string or "N/A"
}

export class ExerciseLogPanel {
  private containerEl: HTMLElement | null = null;
  private panelEl: HTMLElement | null = null;
  private expanded = false;
  private sessions: Session[] = [];
  private rowData: SessionRowData[] = [];
  private readonly storage: Storage;
  private readonly exportController: ExportController;

  constructor(storage: Storage) {
    this.storage = storage;
    this.exportController = new ExportController();
  }

  /** Append the panel DOM to the given container. */
  mount(container: HTMLElement): void;

  /** Toggle between collapsed and expanded states. */
  toggle(): void;

  /** Fetch sessions and re-render the table content. */
  async render(): Promise<void>;

  // --- Data computation (pure, testable) ---

  /** Compute total reps across all sets in a session. */
  static computeTotalReps(session: Session): number;

  /** Count reps with category === 'correct' across all sets. */
  static computeCorrectReps(session: Session): number;

  /** Derive sorted unique exercise names from a session's sets. */
  static computeUniqueExercises(session: Session): string[];

  /** Compute form quality percentage: (correct / total) * 100, rounded. */
  static computeFormQuality(session: Session): string;

  /** Format a Date as YYYY-MM-DD. */
  static formatDate(date: Date): string;

  /** Convert a Session into a SessionRowData for display. */
  static sessionToRowData(session: Session): SessionRowData;
}
```

### ExportController

**File:** `src/exerciseLog/ExportController.ts`

Responsibilities:
- Serialize an array of `SessionRowData` to JSON string
- Serialize an array of `SessionRowData` to CSV string with headers
- Trigger a browser file download using Blob + URL.createObjectURL + hidden anchor click
- Generate filename in the pattern `workout-history-YYYY-MM-DD`

```typescript
import type { SessionRowData } from './ExerciseLogPanel.js';

export class ExportController {
  /** Serialize row data to a JSON string (pretty-printed array). */
  exportJSON(rows: SessionRowData[]): string;

  /** Serialize row data to CSV with headers: date,exercises,total_reps,form_quality_percent */
  exportCSV(rows: SessionRowData[]): string;

  /** Trigger a file download in the browser. */
  download(content: string, filename: string, mimeType: string): void;

  /** Generate filename: workout-history-YYYY-MM-DD */
  static generateFilename(extension: string): string;
}
```

## Data Models

### SessionRowData

The intermediate data structure between raw `Session` objects and rendered table rows:

```typescript
interface SessionRowData {
  /** Session date formatted as YYYY-MM-DD */
  date: string;
  /** Comma-separated unique exercise names */
  exercises: string;
  /** Total reps across all sets */
  totalReps: number;
  /** Form quality as integer percentage string, or "N/A" for zero-rep sessions */
  formQualityPercent: string;
}
```

### Storage Integration

The panel uses the existing `Storage.query()` method:

```typescript
// Retrieve all sessions (earliest possible date to far future)
const sessions = await this.storage.query({
  from: new Date(0),
  to: new Date('2100-01-01'),
});
```

`Storage.query()` returns sessions in ascending chronological order; the panel reverses the array to display most-recent-first.

## DOM Structure

When expanded, the panel renders:

```html
<section class="exercise-log-panel" aria-label="Workout History">
  <button class="exercise-log-panel__toggle" aria-expanded="true">
    ▼ Workout History
  </button>
  <div class="exercise-log-panel__content">
    <table class="exercise-log-panel__table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Exercises</th>
          <th>Total Reps</th>
          <th>Form Quality</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>2025-01-15</td>
          <td>Barbell Squat, Deadlift</td>
          <td>45</td>
          <td>87%</td>
        </tr>
        <!-- ... -->
      </tbody>
    </table>
    <button class="exercise-log-panel__export-btn" aria-label="Export workout history">
      Export
    </button>
  </div>
</section>
```

When collapsed, only the toggle button is visible with `aria-expanded="false"`.

## File Download Mechanism

```typescript
download(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `Storage.query()` rejects | Panel displays "Unable to load workout history" message in the content area |
| Session has zero sets | Renders row with 0 total reps and "N/A" form quality |
| Session has zero total reps | Renders row with 0 total reps and "N/A" form quality |
| Export with empty session list | Export button is disabled (no-op) |
| Blob/URL API unavailable | Logs error to console; no download triggered |

## CSV Format Specification

```
date,exercises,total_reps,form_quality_percent
2025-01-15,"Barbell Squat, Deadlift",45,87
2025-01-14,"Bench Press",30,93
```

- Header row is always present
- Exercise names containing commas are wrapped in double quotes
- `form_quality_percent` column contains the integer value or `N/A`

## JSON Format Specification

```json
[
  {
    "date": "2025-01-15",
    "exercises": "Barbell Squat, Deadlift",
    "totalReps": 45,
    "formQualityPercent": "87"
  }
]
```

## Testing Strategy

- **Property-based tests** (fast-check + vitest): Cover all data computation functions (`computeTotalReps`, `computeCorrectReps`, `computeFormQuality`, `computeUniqueExercises`, `formatDate`) and export serialization (`exportJSON`, `exportCSV`) with randomly generated `Session` and `SessionRowData` inputs. Minimum 100 iterations per property.
- **Unit tests** (vitest + jsdom): Verify DOM rendering behavior — initial collapsed state, toggle interactions, mount API, export button enable/disable logic, and error display.
- **Edge case coverage**: Zero-rep sessions, sessions with duplicate exercise names, empty session arrays, and sessions with all reps in a single category are handled by property test generators.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Descending Chronological Order

*For any* list of sessions returned by Storage, the rendered Session_Rows SHALL appear in descending order by `startedAt` timestamp — that is, for every adjacent pair of rows, the row above has a date greater than or equal to the row below.

**Validates: Requirements 1.2**

### Property 2: Date Formatting

*For any* valid Date object, `formatDate(date)` SHALL produce a string matching the pattern `YYYY-MM-DD` where YYYY is the four-digit year, MM is the zero-padded month (01–12), and DD is the zero-padded day (01–31).

**Validates: Requirements 1.3**

### Property 3: Total Reps Computation

*For any* Session containing zero or more SetRecords, `computeTotalReps(session)` SHALL return the sum of `set.reps.length` across all SetRecords — equivalently, the count of all Rep objects in the session.

**Validates: Requirements 1.5, 4.1**

### Property 4: Form Quality Percentage Computation

*For any* Session with at least one rep, `computeFormQuality(session)` SHALL return `Math.round((correctCount / totalCount) * 100)` as a string, where `correctCount` is the number of reps with `category === 'correct'` and `totalCount` is the total number of reps. For sessions with zero reps, it SHALL return `"N/A"`.

**Validates: Requirements 1.6, 1.7, 4.2, 4.4**

### Property 5: Unique Exercise Names Derivation

*For any* Session, `computeUniqueExercises(session)` SHALL return exactly the set of distinct `exerciseName` values from the session's SetRecords — no duplicates and no missing entries.

**Validates: Requirements 1.4, 4.3**

### Property 6: Toggle Round-Trip

*For any* ExerciseLogPanel in either collapsed or expanded state, invoking `toggle()` twice SHALL return the panel to its original expanded/collapsed state.

**Validates: Requirements 2.2, 2.3**

### Property 7: JSON Export Round-Trip

*For any* array of SessionRowData, calling `exportJSON(rows)` and then `JSON.parse()` on the result SHALL produce an array structurally equal to the input — the serialization is lossless and reversible.

**Validates: Requirements 3.3**

### Property 8: CSV Export Structure

*For any* non-empty array of SessionRowData of length N, `exportCSV(rows)` SHALL produce a string with exactly N+1 lines (1 header + N data rows), where the header line equals `date,exercises,total_reps,form_quality_percent`.

**Validates: Requirements 3.4**
