# Design Document: Exercise Selection Menu

## Overview

The Exercise Selection Menu is a vanilla DOM component that introduces a state-driven UI layer between application startup and the existing tracking pipeline. It replaces the hardcoded `squatConfig` flow in `src/demo/main.ts` with a user-driven selection flow, presenting all available exercises from `EXERCISE_CATALOG` as interactive cards and showing form instructions before tracking begins.

## Architecture

The system operates as a finite state machine with three visible screens:

```
menu_visible → form_guide_visible → tracking_active → (stop) → menu_visible
```

All state transitions are managed by a central `ExerciseMenuController` class that coordinates visibility of the two new UI components (card grid and form guide screen) and the existing tracking pipeline.

## Components and Interfaces

### 1. ExerciseMenuController (`src/exerciseMenu/ExerciseMenuController.ts`)

The top-level orchestrator that manages the application state machine and wires child components to the existing pipeline.

```typescript
import type { ExerciseCatalogEntry } from '../config/exerciseCatalog.js';
import type { ExerciseFSMConfig } from '../types/index.js';

export type MenuState = 'menu_visible' | 'form_guide_visible' | 'tracking_active';

export interface ExerciseMenuControllerOptions {
  mountPoint: HTMLElement;
  onStartTracking: (config: ExerciseFSMConfig) => void;
  onStopTracking: () => void;
}

export class ExerciseMenuController {
  private state: MenuState = 'menu_visible';
  private selectedEntry: ExerciseCatalogEntry | null = null;
  private readonly cardGrid: ExerciseCardGrid;
  private readonly formGuideScreen: FormGuideScreen;
  private readonly options: ExerciseMenuControllerOptions;

  constructor(options: ExerciseMenuControllerOptions);

  /** Returns current state for external inspection. */
  getState(): MenuState;

  /** Returns the currently selected catalog entry, or null. */
  getSelectedEntry(): ExerciseCatalogEntry | null;

  /** Transition: menu_visible → form_guide_visible */
  selectExercise(entry: ExerciseCatalogEntry): void;

  /** Transition: form_guide_visible → tracking_active */
  startTracking(): void;

  /** Transition: tracking_active → menu_visible */
  stopTracking(): void;

  /** Renders the initial menu into the mount point. */
  mount(): void;

  /** Removes all rendered DOM and resets state. */
  destroy(): void;
}
```

### 2. ExerciseCardGrid (`src/exerciseMenu/ExerciseCardGrid.ts`)

Renders a responsive grid of exercise cards sourced from `EXERCISE_CATALOG`.

```typescript
import type { ExerciseCatalogEntry } from '../config/exerciseCatalog.js';

export interface ExerciseCardGridOptions {
  catalog: ExerciseCatalogEntry[];
  onSelect: (entry: ExerciseCatalogEntry) => void;
}

export class ExerciseCardGrid {
  private containerEl: HTMLElement | null = null;

  constructor(options: ExerciseCardGridOptions);

  /** Creates the grid DOM and appends it to parent. */
  render(parent: HTMLElement): void;

  /** Shows the grid container. */
  show(): void;

  /** Hides the grid container. */
  hide(): void;

  /** Removes the grid from the DOM. */
  destroy(): void;
}
```

**Card DOM structure:**

```html
<div class="exercise-grid" role="list">
  <button class="exercise-card" role="listitem" aria-label="Barbell Squat">
    <h3 class="exercise-card__name">Barbell Squat</h3>
    <div class="exercise-card__muscles">
      <span class="exercise-card__muscle-tag">quads</span>
      <span class="exercise-card__muscle-tag">glutes</span>
      <!-- ... -->
    </div>
    <span class="exercise-card__badge exercise-card__badge--either">Either</span>
  </button>
  <!-- ... one per catalog entry -->
</div>
```

**Responsive grid CSS (injected via JS or inline styles):**
- Viewport < 640px: `grid-template-columns: repeat(2, 1fr)`
- Viewport ≥ 640px: `grid-template-columns: repeat(3, 1fr)`

Cards use `<button>` elements, making them inherently focusable and activatable via keyboard (Enter/Space).

### 3. FormGuideScreen (`src/exerciseMenu/FormGuideScreen.ts`)

Full-screen overlay showing exercise form instructions and common mistakes.

```typescript
import type { ExerciseCatalogEntry } from '../config/exerciseCatalog.js';

export interface FormGuideScreenOptions {
  onStart: () => void;
}

export class FormGuideScreen {
  private containerEl: HTMLElement | null = null;

  constructor(options: FormGuideScreenOptions);

  /** Renders the form guide for the given entry. */
  show(entry: ExerciseCatalogEntry, parent: HTMLElement): void;

  /** Hides and clears the form guide. */
  hide(): void;

  /** Removes the form guide from the DOM. */
  destroy(): void;
}
```

**Form guide DOM structure:**

```html
<section class="form-guide-screen" aria-label="Form guide for Barbell Squat">
  <h2 class="form-guide-screen__heading">Barbell Squat</h2>

  <div class="form-guide-screen__steps">
    <h3>Steps</h3>
    <ol>
      <li>Stand with feet shoulder-width apart</li>
      <li>Brace core, push hips back</li>
      <!-- ... -->
    </ol>
  </div>

  <div class="form-guide-screen__mistakes">
    <h3>Common Mistakes</h3>
    <ul>
      <li>Knees caving inward (valgus)</li>
      <li>Rounding lower back</li>
      <!-- ... -->
    </ul>
  </div>

  <button class="form-guide-screen__start-btn" type="button">
    ▶ Start
  </button>
</section>
```

### 4. Updated Demo Entry Point (`src/demo/main.ts`)

The existing `main.ts` is refactored to:
1. Remove the hardcoded `squatConfig` import
2. Create an `ExerciseMenuController` instance at the mount point
3. Wire `onStartTracking` to the existing `initCamera()` + `initPipeline(config)` flow
4. Wire `onStopTracking` (the existing Stop button handler) to call `controller.stopTracking()`

```typescript
// Before: import { squatConfig } from '../config/exerciseConfigs.js';
// After:  no direct config import — config comes from menu selection

import { ExerciseMenuController } from '../exerciseMenu/ExerciseMenuController.js';

const menuMount = document.getElementById('menu-container')!;

const controller = new ExerciseMenuController({
  mountPoint: menuMount,
  onStartTracking: async (config) => {
    if (!poseLandmarker) await initMediaPipe();
    await initCamera();
    initPipeline(config);
    isRunning = true;
    lastTimestamp = -1;
    processFrame();
  },
  onStopTracking: () => {
    // existing stop logic
  },
});

controller.mount();
```

The HTML template gains a single `<div id="menu-container"></div>` mount point before the video container.

## Data Flow

```
EXERCISE_CATALOG (static array)
       │
       ▼
ExerciseCardGrid ──(click)──► ExerciseMenuController.selectExercise(entry)
                                       │
                                       ▼
                              FormGuideScreen.show(entry)
                                       │
                                  (Start click)
                                       │
                                       ▼
                              ExerciseMenuController.startTracking()
                                       │
                                       ▼
                              onStartTracking(entry.config)
                                       │
                                       ▼
                              initPipeline(config) ─► RepCounter, FormEvaluator, SafetyMonitor
                                       │
                                  (Stop click)
                                       │
                                       ▼
                              ExerciseMenuController.stopTracking()
                                       │
                                       ▼
                              ExerciseCardGrid.show() (menu reappears)
```

## State Machine

| Current State        | Trigger              | Next State           | Side Effects                                    |
|---------------------|---------------------|---------------------|------------------------------------------------|
| `menu_visible`      | Card click          | `form_guide_visible` | Hide grid, show form guide for entry           |
| `form_guide_visible`| Start button click  | `tracking_active`    | Hide form guide, call `onStartTracking(config)` |
| `tracking_active`   | Stop button click   | `menu_visible`       | Call `onStopTracking()`, show grid again        |

## Data Models

The feature reuses the existing `ExerciseCatalogEntry` interface (no new data types needed). The only new types are:

```typescript
/** Possible UI states for the exercise menu flow */
export type MenuState = 'menu_visible' | 'form_guide_visible' | 'tracking_active';
```

The `ExerciseFSMConfig` flows unchanged from `entry.config` into the existing `initPipeline` function.

## Error Handling

| Scenario                        | Handling                                                      |
|--------------------------------|--------------------------------------------------------------|
| Empty EXERCISE_CATALOG         | Render a "No exercises available" message in the grid area    |
| Camera initialization failure  | Show error in status element, transition back to menu_visible |
| Missing steps/commonMistakes   | Render empty lists (graceful degradation, no crash)           |

## Styling Strategy

All styles are injected programmatically via a `<style>` element appended to `document.head` on first render. This avoids requiring CSS file imports or build-tool integration beyond what Vite already provides. Class names use BEM convention (`exercise-card__name`, `exercise-card__badge--side`).

Badge color coding:
- `side` → blue accent
- `front` → green accent  
- `either` → neutral/gray accent

## Testing Strategy

**Unit tests** (vitest + jsdom):
- ExerciseCardGrid rendering (specific catalog entries, badge text mapping)
- FormGuideScreen rendering (specific exercise with known steps/mistakes)
- ExerciseMenuController state transitions (specific sequences)
- Keyboard accessibility (Enter/Space activation)
- Empty catalog edge case

**Property-based tests** (fast-check + vitest + jsdom):
- Card count invariant across arbitrary catalog sizes
- Card content completeness for arbitrary catalog entries
- Badge text mapping for all cameraAngle values
- Form guide content completeness for arbitrary entries
- State machine visibility invariant across all states
- Round-trip navigation for arbitrary exercise pairs

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Card count equals catalog size

*For any* `EXERCISE_CATALOG` array of length N, the rendered `ExerciseCardGrid` SHALL produce exactly N card elements in the DOM.

**Validates: Requirements 1.2**

### Property 2: Card renders all exercise metadata

*For any* `ExerciseCatalogEntry`, the rendered card SHALL contain the `displayName` text, all `muscleGroups` as visible tags, and a badge whose text is the capitalized form of the `cameraAngle` value ("Side", "Front", or "Either").

**Validates: Requirements 1.3, 1.4**

### Property 3: Card click emits correct catalog entry

*For any* card in the rendered grid corresponding to catalog entry E, clicking that card SHALL invoke the `onSelect` callback with E as its argument, such that `emittedEntry === E`.

**Validates: Requirements 2.1, 2.2**

### Property 4: Cards are keyboard accessible

*For any* rendered exercise card, the element SHALL be focusable (`tabIndex >= 0`) and SHALL respond to both Enter and Space key events identically to a click event.

**Validates: Requirements 2.3**

### Property 5: Form guide renders complete exercise content

*For any* `ExerciseCatalogEntry` with a non-empty `steps` array and `commonMistakes` array, the `FormGuideScreen` SHALL render a heading containing `displayName`, an ordered list with one item per step in order, and a list with one item per common mistake.

**Validates: Requirements 3.1, 3.2, 3.3**

### Property 6: Start button triggers pipeline with selected config

*For any* exercise selected from the menu, activating the "Start" button on the form guide screen SHALL call `onStartTracking` with the `config` property of the selected `ExerciseCatalogEntry`.

**Validates: Requirements 3.5, 5.1**

### Property 7: Menu visibility state invariant

*For any* state S of the `ExerciseMenuController`, the exercise card grid SHALL be visible if and only if S equals `menu_visible`. When S is `form_guide_visible` or `tracking_active`, the grid SHALL be hidden.

**Validates: Requirements 4.1, 4.3**

### Property 8: Full navigation round-trip

*For any* two distinct exercises A and B in the catalog, selecting A, starting tracking, then stopping SHALL return the controller to `menu_visible` state where selecting B is possible and yields B's config on the next Start.

**Validates: Requirements 4.2, 5.3**
