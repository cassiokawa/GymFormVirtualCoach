# Requirements — Coach Session UX

## Introduction
The Coach surface is currently a single scrolling page that renders live state, developer telemetry, configuration, routine building, body scanning and history simultaneously. It is readable at 50 cm and unusable at 3 m, which is the only distance at which it is actually used. This spec replaces the page with a four-state session machine, makes the camera full-bleed, moves all feedback to an audio-first channel, and removes the navigation duplication between the top nav and the in-page accordions. Out of scope: exercise detection logic (spec 02), threshold derivation (spec 03), set-termination logic (spec 04).

## Requirement 1 — Session state machine
1.1 THE SYSTEM SHALL model the coach session as exactly four states: SETUP, ARMED, WORKING, REVIEW.
1.2 WHEN the session state changes THE SYSTEM SHALL render only the surface bound to that state, and unmount the others.
1.3 WHEN state is SETUP THE SYSTEM SHALL display the live camera preview, the exercise selector, framing guidance, and a single primary action.
1.4 WHEN state is WORKING THE SYSTEM SHALL display only the rep count, the phase indicator, and the current cue line. No other control, metric, panel, or accordion SHALL be present.
1.5 WHEN the user has been in WORKING with no detected motion for 8 consecutive seconds THE SYSTEM SHALL transition to REVIEW.
1.6 WHEN state is REVIEW THE SYSTEM SHALL display set summary, per-rep detail, and exactly two actions: repeat set, or return to SETUP.
1.7 IF the user navigates away and returns within 120 seconds THE SYSTEM SHALL restore the prior session state rather than resetting to SETUP.

## Requirement 2 — Distance-legible presentation
2.1 WHEN state is WORKING THE SYSTEM SHALL render the rep count at a minimum of 25% of viewport height.
2.2 WHEN state is WORKING THE SYSTEM SHALL render no text below 5% of viewport height.
2.3 THE SYSTEM SHALL render the camera feed full-bleed in SETUP, ARMED and WORKING, with all overlays composited above it.
2.4 THE SYSTEM SHALL indicate movement phase by a continuous arc whose sweep maps to signal position between the ROM floor and top, not by a text label.
2.5 WHEN the device is held in portrait or landscape THE SYSTEM SHALL preserve full-bleed camera and rep-count legibility in both.
2.6 THE SYSTEM SHALL support a mirrored-display mode for use with the device screen facing a mirror.

## Requirement 3 — Audio-first feedback
3.1 WHEN a rep is counted THE SYSTEM SHALL emit a distinct short tone within 120 ms of the RepCompleted event at p95.
3.2 WHEN a fault is issued as a cue THE SYSTEM SHALL emit a distinct lower tone, acoustically distinguishable from the rep tone, followed by the spoken cue.
3.3 WHEN a set ends THE SYSTEM SHALL emit a distinct terminal chord, distinguishable from both prior tones.
3.4 THE SYSTEM SHALL issue at most one spoken cue per rep.
3.5 IF two or more faults occur in one rep THE SYSTEM SHALL speak only the highest-severity cue and discard the rest.
3.6 WHILE a spoken cue is in progress THE SYSTEM SHALL suppress any subsequent spoken cue but SHALL NOT suppress rep tones.
3.7 WHEN the capture device exposes a vibration API THE SYSTEM SHALL emit a haptic pulse on rep count.
3.8 THE SYSTEM SHALL allow independent muting of tones and speech, persisted across sessions.

## Requirement 4 — Framing and angle validation before start
4.1 WHILE state is SETUP THE SYSTEM SHALL run pose detection continuously and display a silhouette guide for the selected exercise.
4.2 IF any landmark required by the selected exercise spec is outside the frame THE SYSTEM SHALL name the missing body part in plain language and SHALL disable the start action.
4.3 IF the estimated camera view angle deviates from the exercise's preferred angle by more than its stated tolerance THE SYSTEM SHALL state the required correction as a direction, and SHALL disable the start action.
4.4 IF the subject occupies less than 40% or more than 90% of frame height THE SYSTEM SHALL instruct the user to move closer or further, expressed in approximate metres.
4.5 WHEN all framing conditions are satisfied THE SYSTEM SHALL enable the start action and confirm readiness with a tone.
4.6 WHEN the start action is taken THE SYSTEM SHALL enter ARMED and run a 5-second audible countdown before entering WORKING.

## Requirement 5 — Removal of developer telemetry and navigation duplication
5.1 THE SYSTEM SHALL NOT display frames-per-second or per-rep millisecond timings on any Coach surface state.
5.2 THE SYSTEM SHALL expose frames-per-second, inference latency, landmark confidence and raw signal traces on the Lab surface only.
5.3 THE SYSTEM SHALL NOT render any panel on the Coach surface that duplicates a top-level navigation destination.
5.4 THE SYSTEM SHALL NOT display third-party library names in user-facing copy.
5.5 WHEN the pose pipeline is ready THE SYSTEM SHALL communicate readiness in terms of the camera, not the model.

## Requirement 6 — Post-set review
6.1 WHEN state is REVIEW THE SYSTEM SHALL display rep count, total time under tension, mean concentric velocity per rep, and the count of flagged reps.
6.2 THE SYSTEM SHALL render per-rep velocity as a sequential chart with the set's best rep marked.
6.3 WHEN a rep has one or more faults THE SYSTEM SHALL mark it in the chart and make its evidence clip reachable in one interaction.
6.4 IF landmark confidence was below threshold for more than 20% of the set THE SYSTEM SHALL state that the set's data is low confidence and SHALL NOT display velocity figures.
6.5 THE SYSTEM SHALL NOT display a grade, score, percentage, star rating, or streak on the review surface.

## Requirement 7 — Exercise selection
7.1 THE SYSTEM SHALL present exercises as a filterable grid, not a native select element.
7.2 THE SYSTEM SHALL support filtering by equipment, primary muscle group, and body position.
7.3 THE SYSTEM SHALL support free-text search over exercise names and aliases.
7.4 THE SYSTEM SHALL surface the five most recently performed exercises above the grid.
7.5 WHEN an exercise is selected THE SYSTEM SHALL display its required camera angle before start.
