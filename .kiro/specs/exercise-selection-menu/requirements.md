# Requirements Document

## Introduction

The Exercise Selection Menu replaces the current hardcoded `squatConfig` startup flow with an interactive card-grid menu that lets users browse and select any exercise from the existing `EXERCISE_CATALOG`. After selection, a form guide screen (steps and common mistakes) is displayed as an intermediate step before the camera and tracking pipeline begin. The flow is one-way: the menu disappears after selection and the user must press Stop to return to the menu.

## Glossary

- **Exercise_Selection_Menu**: A vanilla DOM component that renders a grid of exercise cards sourced from `EXERCISE_CATALOG`, enabling the user to choose an exercise before starting a workout session.
- **Exercise_Card**: A single interactive card within the Exercise_Selection_Menu displaying the exercise name, muscle groups, and camera angle badge.
- **Form_Guide_Screen**: An intermediate full-screen overlay displayed after exercise selection that shows the step-by-step form instructions and common mistakes for the selected exercise, with a confirmation button to proceed.
- **EXERCISE_CATALOG**: The existing array of `ExerciseCatalogEntry` objects defined in `src/config/exerciseCatalog.ts` that provides exercise metadata (display name, description, camera angle, muscle groups, steps, common mistakes, and FSM config).
- **Camera_Angle_Badge**: A visual indicator on each Exercise_Card showing the recommended camera placement (side, front, or either).
- **Tracking_Pipeline**: The existing combination of camera initialization, PreTrackingController, RepCounter, FormEvaluator, SafetyMonitor, and AlertSystem that processes pose data during active workout tracking.

## Requirements

### Requirement 1: Exercise Card Grid Display

**User Story:** As a user, I want to see all available exercises in a visual grid so that I can quickly browse and choose what to train.

#### Acceptance Criteria

1. WHEN the application starts, THE Exercise_Selection_Menu SHALL render a card grid layout with 2 columns on viewports narrower than 640px and 3 columns on viewports 640px or wider.
2. THE Exercise_Selection_Menu SHALL render one Exercise_Card for each entry in the EXERCISE_CATALOG array.
3. THE Exercise_Card SHALL display the exercise display name, the list of muscle groups, and the Camera_Angle_Badge.
4. THE Camera_Angle_Badge SHALL display the text "Side", "Front", or "Either" corresponding to the `cameraAngle` property of the catalog entry.

### Requirement 2: Exercise Selection Interaction

**User Story:** As a user, I want to tap an exercise card to select it so that I can begin my workout session for that exercise.

#### Acceptance Criteria

1. WHEN the user clicks an Exercise_Card, THE Exercise_Selection_Menu SHALL hide the entire menu grid from the viewport.
2. WHEN the user clicks an Exercise_Card, THE Exercise_Selection_Menu SHALL emit the selected `ExerciseCatalogEntry` to the application flow controller.
3. THE Exercise_Card SHALL be focusable and activatable via keyboard (Enter or Space key) for accessibility compliance.

### Requirement 3: Form Guide Intermediate Screen

**User Story:** As a user, I want to review the proper form steps and common mistakes before my camera session starts so that I can perform the exercise correctly.

#### Acceptance Criteria

1. WHEN an exercise is selected, THE Form_Guide_Screen SHALL display a heading with the exercise display name.
2. WHEN an exercise is selected, THE Form_Guide_Screen SHALL display an ordered list of the step-by-step form instructions from the selected catalog entry's `steps` array.
3. WHEN an exercise is selected, THE Form_Guide_Screen SHALL display the common mistakes from the selected catalog entry's `commonMistakes` array.
4. THE Form_Guide_Screen SHALL display a "Start" confirmation button that the user activates to proceed to camera initialization.
5. WHEN the user activates the "Start" button, THE Form_Guide_Screen SHALL hide itself and trigger the camera and Tracking_Pipeline initialization with the selected exercise's `config`.

### Requirement 4: One-Way Navigation Flow

**User Story:** As a user, I want a simple linear flow from selection to tracking so that I am not confused by navigation options during my workout.

#### Acceptance Criteria

1. WHILE the Tracking_Pipeline is active, THE Exercise_Selection_Menu SHALL remain hidden and provide no back-navigation to the menu.
2. WHEN the user activates the Stop button, THE application SHALL terminate the Tracking_Pipeline, release the camera, and display the Exercise_Selection_Menu again.
3. WHILE the Form_Guide_Screen is visible, THE Exercise_Selection_Menu SHALL remain hidden.

### Requirement 5: Dynamic Config Integration

**User Story:** As a developer, I want the selected exercise config to flow into the existing pipeline so that all downstream components (RepCounter, FormEvaluator, SafetyMonitor) use the correct exercise parameters.

#### Acceptance Criteria

1. WHEN the camera and Tracking_Pipeline initialize after exercise selection, THE application SHALL pass the selected catalog entry's `config` (ExerciseFSMConfig) to the `initPipeline` function.
2. THE application SHALL remove the hardcoded `squatConfig` import from the demo entry point and derive the exercise config from the user's menu selection.
3. WHEN the Stop button is activated and the Exercise_Selection_Menu redisplays, THE application SHALL allow the user to select a different exercise for the next session.

### Requirement 6: Vanilla DOM Implementation

**User Story:** As a developer, I want the menu built with vanilla DOM manipulation (no UI framework) so that it remains consistent with the project's existing architecture.

#### Acceptance Criteria

1. THE Exercise_Selection_Menu SHALL be implemented using vanilla TypeScript DOM APIs (document.createElement, classList, addEventListener) without introducing any external UI framework dependency.
2. THE Exercise_Selection_Menu SHALL inject its rendered elements into the existing page structure without requiring changes to the HTML template beyond a mount-point container.
