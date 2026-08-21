# Implementation Plan: Exercise Selection Menu

## Overview

Replace the hardcoded `squatConfig` startup flow in `src/demo/main.ts` with an interactive exercise selection menu. The implementation adds three new files under `src/exerciseMenu/` (controller, card grid, form guide screen), updates the demo entry point to wire the menu into the existing tracking pipeline, and adds a mount-point to the HTML template. All components use vanilla TypeScript DOM APIs consistent with the project architecture.

## Tasks

- [ ] 1. Create ExerciseCardGrid component
  - [ ] 1.1 Implement ExerciseCardGrid class in `src/exerciseMenu/ExerciseCardGrid.ts`
    - Create the `ExerciseCardGrid` class with `render`, `show`, `hide`, and `destroy` methods
    - Render a responsive grid container (`exercise-grid`) with `role="list"`
    - Render one `<button>` card per catalog entry with `role="listitem"` and `aria-label` set to the display name
    - Each card contains: heading with `displayName`, muscle group tags, and a camera angle badge ("Side", "Front", or "Either")
    - Wire click handler on each card to invoke `onSelect(entry)`
    - Cards are inherently keyboard-accessible via `<button>` elements (Enter/Space activation)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 6.1_

  - [ ] 1.2 Inject responsive grid styles programmatically
    - Append a `<style>` element to `document.head` on first render
    - Apply 2-column grid for viewports < 640px, 3-column grid for ≥ 640px using CSS media query
    - Apply BEM class names for cards, muscle tags, and badge color coding (blue=side, green=front, gray=either)
    - _Requirements: 1.1, 6.1_

  - [ ]* 1.3 Write property test for card count invariant
    - **Property 1: Card count equals catalog size**
    - **Validates: Requirements 1.2**

  - [ ]* 1.4 Write property test for card metadata rendering
    - **Property 2: Card renders all exercise metadata**
    - **Validates: Requirements 1.3, 1.4**

  - [ ]* 1.5 Write property test for card click emits correct entry
    - **Property 3: Card click emits correct catalog entry**
    - **Validates: Requirements 2.1, 2.2**

  - [ ]* 1.6 Write property test for keyboard accessibility
    - **Property 4: Cards are keyboard accessible**
    - **Validates: Requirements 2.3**

- [ ] 2. Create FormGuideScreen component
  - [ ] 2.1 Implement FormGuideScreen class in `src/exerciseMenu/FormGuideScreen.ts`
    - Create the `FormGuideScreen` class with `show`, `hide`, and `destroy` methods
    - `show(entry, parent)` renders a full-screen overlay section with `aria-label`
    - Display heading with `displayName`, ordered list of `steps`, unordered list of `commonMistakes`
    - Display a "Start" button that invokes the `onStart` callback
    - Gracefully handle empty `steps` or `commonMistakes` arrays (render empty lists)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 6.1_

  - [ ]* 2.2 Write property test for form guide content completeness
    - **Property 5: Form guide renders complete exercise content**
    - **Validates: Requirements 3.1, 3.2, 3.3**

  - [ ]* 2.3 Write property test for start button triggering pipeline
    - **Property 6: Start button triggers pipeline with selected config**
    - **Validates: Requirements 3.5, 5.1**

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Create ExerciseMenuController and wire state machine
  - [ ] 4.1 Implement ExerciseMenuController class in `src/exerciseMenu/ExerciseMenuController.ts`
    - Create the controller with `mount`, `destroy`, `selectExercise`, `startTracking`, and `stopTracking` methods
    - Manage `MenuState` transitions: `menu_visible` → `form_guide_visible` → `tracking_active` → `menu_visible`
    - `selectExercise(entry)`: hide grid, show form guide for entry
    - `startTracking()`: hide form guide, call `onStartTracking(entry.config)`
    - `stopTracking()`: call `onStopTracking()`, show grid, clear selected entry
    - Expose `getState()` and `getSelectedEntry()` for external inspection
    - Handle empty catalog by rendering a "No exercises available" message
    - _Requirements: 2.1, 2.2, 3.5, 4.1, 4.2, 4.3, 5.1, 5.3_

  - [ ]* 4.2 Write property test for menu visibility state invariant
    - **Property 7: Menu visibility state invariant**
    - **Validates: Requirements 4.1, 4.3**

  - [ ]* 4.3 Write property test for full navigation round-trip
    - **Property 8: Full navigation round-trip**
    - **Validates: Requirements 4.2, 5.3**

- [ ] 5. Integrate with demo entry point and HTML
  - [ ] 5.1 Add mount-point container to `index.html`
    - Add `<div id="menu-container"></div>` before the video container element
    - _Requirements: 6.2_

  - [ ] 5.2 Refactor `src/demo/main.ts` to use ExerciseMenuController
    - Remove the hardcoded `import { squatConfig }` line
    - Import `ExerciseMenuController` from `../exerciseMenu/ExerciseMenuController.js`
    - Create controller instance with mount point, `onStartTracking`, and `onStopTracking` callbacks
    - Wire `onStartTracking` to existing `initMediaPipe()`, `initCamera()`, `initPipeline(config)` flow
    - Wire `onStopTracking` to existing stop logic (cancel animation frame, release camera, reset state)
    - Update the Stop button handler to call `controller.stopTracking()` instead of directly resetting
    - Remove or hide the existing Start button (menu replaces it)
    - Call `controller.mount()` on page load
    - _Requirements: 5.1, 5.2, 5.3, 4.2_

  - [ ] 5.3 Handle camera initialization failure
    - If `initCamera()` or `initMediaPipe()` throws, display error in status element and transition controller back to `menu_visible`
    - _Requirements: (Error handling from design)_

- [ ] 6. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All components use vanilla TypeScript DOM APIs — no framework dependencies introduced
- The `fast-check` and `jsdom` packages are already available in devDependencies

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5", "1.6", "2.2", "2.3"] },
    { "id": 2, "tasks": ["4.1", "5.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "5.2"] },
    { "id": 4, "tasks": ["5.3"] }
  ]
}
```
