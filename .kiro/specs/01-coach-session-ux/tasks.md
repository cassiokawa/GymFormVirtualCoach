# Implementation Plan: Coach Session UX

## Overview

This plan builds the Session UX bounded context and the Coaching audio/rationing seam described
in `design.md`, in dependency order. It starts with the pure data contracts and the pure state
machine (no DOM, no I/O), then the audio bus and cue rationer, then each surface (SETUP → ARMED
→ WORKING → REVIEW), and finally wires the machine to Analysis events (spec 02) and to
persistence.

Analysis events (`RepCompleted`, `FaultDetected`, `HoldProgressed`, `AnalysisStalled`) are
consumed as an inbound contract. Until spec 02 lands, they are fed from a fixture/mock replay.
Exercise metadata is read as data (`ExerciseSpecMeta`); no exercise id, name, or alias appears in
any `src/**/*.ts` file. Feedback is audio-first because the user is 3 metres from the screen; the
audio bus targets a rep tone within 120 ms p95 of `RepCompleted`; only one spoken cue fires per
rep (highest severity wins); velocity is reported as relative loss only, with no absolute units;
and no grades, scores, or streaks appear on any surface.

## Tasks

- [x] 1. Define Session UX and Coaching contracts
  - [x] 1.1 Create context directory structure and the shared types module
    - Define `SessionState`, `SessionEvent`, `SessionContext`, the `Surface` lifecycle
      interface, the inbound Analysis event shapes (`RepCompleted`, `FaultDetected`,
      `HoldProgressed`, `AnalysisStalled`), and the domain records (`RepRecord`, `SetRecord`,
      `SessionSnapshot`, `ExerciseSpecMeta`, `FramingVerdict`, `AngleCorrection`, `RationedCue`,
      `MuteState`, `ExerciseFilter`)
    - No exercise id/name/alias literals in TypeScript; ids are opaque strings from data
    - _Requirements: 1.1, 6.4_

- [x] 2. Implement the session state machine
  - [x] 2.1 Implement the pure `transition(ctx, ev)` function
    - Cover all legal edges (SETUP→ARMED gated on `framingValid`, ARMED→WORKING, ARMED→SETUP,
      WORKING→REVIEW via SET_ENDED and STALLED, REVIEW→ARMED, REVIEW→SETUP); illegal
      `(state, event)` pairs return the context unchanged
    - _Requirements: 1.1, 1.5, 4.5_
  - [ ]* 2.2 Write property test for reachable-state closure
    - **Property 1: Only the four states SETUP/ARMED/WORKING/REVIEW are reachable**
    - **Validates: Requirements 1.1**
  - [ ]* 2.3 Write property test for start gating
    - **Property 2: START_REQUESTED transitions to ARMED iff framingValid is true**
    - **Validates: Requirements 4.5**
  - [x] 2.4 Implement the SessionMachine runtime with single-surface mounting
    - Build `send`, `subscribe`, and a mount/unmount step that unmounts the outgoing surface and
      mounts exactly one incoming surface per transition
    - _Requirements: 1.1, 1.2_
  - [ ]* 2.5 Write property test for the single-surface invariant
    - **Property 3: After any transition exactly one surface is mounted**
    - **Validates: Requirements 1.2**

- [x] 3. Implement session persistence and the 120s restore window
  - [x] 3.1 Implement snapshot write/read and mute-flag persistence
    - Persist `SessionSnapshot` on every transition; on load honour it only when
      `now - savedAt <= 120_000`, else start at SETUP; persist tone and speech mute flags under
      separate keys
    - _Requirements: 1.7, 3.8_
  - [ ]* 3.2 Write property test for the restore window boundary
    - **Property 4: Snapshot is restored iff its age <= 120s, otherwise the machine starts at SETUP**
    - **Validates: Requirements 1.7**

- [x] 4. Implement the Coaching audio seam
  - [x] 4.1 Implement the AudioBus (Web Audio) with distinct sounds and haptics
    - Synthesise `repTone`, `cueTone`, `terminalChord`, `countdownTick`, `readinessTone` with
      disjoint frequency/duration profiles; emit `haptic()` via the vibration API where
      available; `setToneMute`/`isToneMuted` backed by the persisted flag; rep tone path targets
      <=120 ms from `RepCompleted` at p95
    - _Requirements: 3.1, 3.2, 3.3, 3.7, 3.8_
  - [ ]* 4.2 Write unit tests for tone distinctness and mute persistence
    - Assert the three sounds use disjoint profiles; muting tones is persisted and reloaded
    - _Requirements: 3.1, 3.2, 3.3, 3.8_
  - [x] 4.3 Implement the SpeechChannel adapter over VoiceCoach
    - Wrap the existing `VoiceCoach` behind a Coaching-owned `SpeechChannel` with independent,
      persisted speech mute; drop a spoken cue while speech is already in progress
    - _Requirements: 3.6, 3.8_

- [x] 5. Implement the CueRationer
  - [x] 5.1 Implement one-cue-per-rep rationing with cooldown
    - `offer(fault)` keeps only the highest-severity fault within the current rep window;
      `flush(repIndex)` selects the survivor, suppresses any `cueId` fired within the last 3
      reps, routes it to `cueTone()` then `SpeechChannel.speak()`, and resets the window; spoken
      cue suppression never blocks `repTone()`
    - _Requirements: 3.2, 3.4, 3.5, 3.6_
  - [ ]* 5.2 Write property test for highest-severity selection
    - **Property 5: flush emits at most one cue per rep and it is the highest-severity non-cooled-down fault**
    - **Validates: Requirements 3.4, 3.5**
  - [ ]* 5.3 Write property test for cue cooldown
    - **Property 6: the same cueId is not re-emitted within 3 reps**
    - **Validates: Requirements 3.4**

- [x] 6. Implement exercise selection
  - [x] 6.1 Implement pure `filterExercises` and `recentFive`
    - `filterExercises(all, filter)` over equipment, muscle group, position, and free-text on
      name + aliases; `recentFive(history)` returns the five most recent distinct ids
    - _Requirements: 7.2, 7.3, 7.4_
  - [ ]* 6.2 Write property test for filter soundness
    - **Property 7: every result of filterExercises matches all active filter facets**
    - **Validates: Requirements 7.2, 7.3**
  - [ ]* 6.3 Write property test for recents
    - **Property 8: recentFive returns at most five distinct ids, most-recent-first**
    - **Validates: Requirements 7.4**
  - [x] 6.4 Implement the ExerciseGrid component
    - Render exercises as a filterable grid (not a native select) with filter controls and
      free-text search, surface the five recents above the grid, and expose `onSelect`
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 7. Implement framing and angle validation
  - [x] 7.1 Implement the FramingValidator verdict
    - Extend the existing `FramingGuide` to return a `FramingVerdict`: name missing required
      landmarks in plain language, compute angle-correction direction against `toleranceDeg`,
      classify distance from frame-height occupancy (40–90%) with an approximate metres hint;
      `ok` is the conjunction of all sub-checks
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [ ]* 7.2 Write property test for verdict conjunction
    - **Property 9: verdict.ok is true iff no missing landmarks AND angle within tolerance AND distance in range**
    - **Validates: Requirements 4.5**
  - [ ]* 7.3 Write unit tests for distance boundaries and angle direction
    - Cover <40% (move closer), >90% (move further), and left/right correction
    - _Requirements: 4.3, 4.4_

- [x] 8. Implement the distance-legible working components
  - [x] 8.1 Implement PhaseArc and RepCountDisplay
    - `PhaseArc.render(signalNorm)` sweeps continuously from ROM floor (0) to top (1) with no
      text label; `RepCountDisplay` renders at >=25% viewport height with no text below 5%; both
      preserve full-bleed and legibility in portrait and landscape, with a mirrored-display mode
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 2.6_

- [x] 9. Implement the session surfaces
  - [x] 9.1 Implement the SetupSurface
    - Full-bleed camera, mounted `ExerciseGrid`, `FramingValidator` overlay,
      required-camera-angle readout on selection, and a single primary action whose `disabled`
      binds to `!framingValid`; fire `readinessTone()` once on the false→true framing edge
    - _Requirements: 1.3, 2.3, 4.1, 4.5, 5.5, 7.5_
  - [x] 9.2 Implement the ArmedSurface with 5-second audible countdown
    - Full-bleed camera plus a 5-second countdown driven by `AudioBus.countdownTick()`, then send
      `COUNTDOWN_ELAPSED`; support cancel back to SETUP
    - _Requirements: 2.3, 4.6_
  - [x] 9.3 Implement the WorkingSurface (three-child allowlist)
    - Render only `RepCountDisplay`, `PhaseArc`, and one cue line over full-bleed camera; provide
      no slot for panels, metrics, telemetry, or nav-duplicating destinations; surface "not
      detecting movement" on `AnalysisStalled`
    - _Requirements: 1.4, 2.3, 5.1, 5.3, 5.5_
  - [ ]* 9.4 Write unit test that the WORKING surface exposes no telemetry or duplicated nav
    - Assert no FPS/ms readouts, no third-party library names, no nav-destination panels
    - _Requirements: 5.1, 5.3, 5.4_

- [x] 10. Implement the post-set review surface
  - [x] 10.1 Implement ReviewSurface, SetSummary, and VelocityChart
    - Show rep count, total time under tension, mean concentric relative velocity, and
      flagged-rep count; render per-rep relative velocity as a sequential chart with the best rep
      marked and flagged reps marked with evidence-clip access in one interaction; when >20% of
      the set was low-confidence, state low confidence and suppress velocity figures; render no
      grade, score, percentage, star, or streak; expose exactly two actions (repeat set / return
      to setup)
    - _Requirements: 1.6, 6.1, 6.2, 6.3, 6.4, 6.5_
  - [ ]* 10.2 Write property test that no absolute velocity units are rendered
    - **Property 10: for any SetRecord, review output contains relative velocity only (no m/s) and no grade/score/streak**
    - **Validates: Requirements 6.5**
  - [ ]* 10.3 Write property test for low-confidence suppression
    - **Property 11: when >20% of the set is low-confidence, velocity figures are suppressed and the set is marked low confidence**
    - **Validates: Requirements 6.4**

- [x] 11. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Wire the machine to Analysis events and mount the app entry
  - [x] 12.1 Subscribe the machine to the Analysis event stream and replace the scrolling page
    - Route `RepCompleted` to `AudioBus.repTone()` + `haptic()` + `CueRationer.flush()` + set
      accumulation + rep count; `FaultDetected` to `CueRationer.offer()` and REVIEW evidence;
      `HoldProgressed` to the active surface; `AnalysisStalled(no_motion)` to REVIEW after 8 s;
      feed events from a fixture/mock replay until spec 02 lands; replace the scrolling Coach page
      (`src/demo/main.ts`) with the mounted machine
    - _Requirements: 1.2, 1.4, 1.5, 3.1, 5.3_
  - [ ]* 12.2 Write integration test for the end-to-end event loop over a fixture replay
    - Replay a fixture set and assert rep count, one cue per rep, terminal chord, and REVIEW
      contents
    - _Requirements: 1.5, 3.1, 3.4, 6.1_

- [x] 13. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP.
- Each task references specific requirement clauses for traceability.
- Property tests validate universal correctness properties from `design.md`; unit tests cover
  specific examples and edge cases.
- Property tests run a minimum of 100 iterations and are tagged
  `Feature: 01-coach-session-ux, Property {number}: {property_text}`.
- Analysis events are an inbound contract from spec 02; before 02 lands they are fed from a
  fixture/mock replay so this spec can build and test in isolation.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1", "5.1", "6.1", "7.1", "8.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "3.2", "4.2", "4.3", "5.2", "5.3", "6.2", "6.3", "6.4", "7.2", "7.3"] },
    { "id": 3, "tasks": ["2.5", "9.1", "9.2", "9.3", "10.1"] },
    { "id": 4, "tasks": ["9.4", "10.2", "10.3"] },
    { "id": 5, "tasks": ["12.1"] },
    { "id": 6, "tasks": ["12.2"] }
  ]
}
```
