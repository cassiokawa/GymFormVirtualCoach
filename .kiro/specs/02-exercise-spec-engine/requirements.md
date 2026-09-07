# Requirements Document

## Introduction

The Exercise Spec Engine is the canonical Analysis bounded context for Form Coach. An exercise
is expressed entirely as a JSON document (an ExerciseSpec); three generic, exercise-agnostic
components interpret that document: a total expression evaluator that turns landmark frames into
a scalar signal, a generic phase-machine interpreter that turns the signal into phase and rep
events, and a phase-scoped fault evaluator that turns guards into fault events. No exercise id,
name, or alias may appear in any TypeScript source. The engine consumes `LandmarkFrame` and
publishes `RepCompleted`, `FaultDetected`, `HoldProgressed`, and `AnalysisStalled`. These
requirements are derived from the approved design document.

## Glossary

- **Exercise_Spec_Engine**: The Analysis-context system that compiles and interprets exercise
  specifications. Referred to as "THE Engine" below.
- **Expression_Evaluator**: The total, non-Turing-complete evaluator that compiles a signal
  expression and evaluates it per frame.
- **Phase_Machine**: The generic FSM interpreter that produces phase transitions and rep events
  from the smoothed signal.
- **Fault_Evaluator**: The component that evaluates phase-scoped fault guards.
- **Spec_Validator**: The combination of the JSON schema check and the semantic validator.
- **Spec_CLI**: The `formcoach-spec` command-line tool exposing `validate` and `replay`.
- **Build_Scan**: The build-time check that no exercise id, name, or alias appears in TypeScript.
- **ExerciseSpec**: A JSON document describing one exercise, located under
  `src/domain/exercises/**/*.json`.
- **LandmarkFrame**: `{ t, points (33×xyz), visibility (33), presence (33) }`.
- **UNAVAILABLE**: The sentinel result meaning a value could not be computed with confidence.
- **CompiledSpec**: The load-time compilation of an ExerciseSpec into closure trees and a
  phase machine.
- **Fixture**: An annotated landmark timeline used to replay and verify rep counts and faults.
- **Calibration**: Per-user ROM percentiles and relative velocity thresholds.

## Requirements

### Requirement 1: Exercise document contract

**User Story:** As an exercise author, I want each exercise defined as a validated JSON
document, so that adding an exercise requires no TypeScript change.

#### Acceptance Criteria

1. THE Engine SHALL load exercise definitions exclusively from JSON documents located under `src/domain/exercises`.
2. WHEN an ExerciseSpec is loaded, THE Engine SHALL parse its `id`, `version`, `displayName`, `aliases`, `facets`, `mode`, `bilateral`, `landmarkPairs`, `requiredLandmarks`, `optionalLandmarks`, `camera`, `signal`, `rom`, `phases`, and `faults` fields into a CompiledSpec.
3. WHERE `mode` is `hold`, THE Engine SHALL treat the ExerciseSpec as a timed hold rather than a counted-rep exercise.
4. WHEN an expression contains an unprefixed joint reference, THE Expression_Evaluator SHALL resolve that reference to the bilateral midpoint of the corresponding left and right landmarks.
5. WHEN an expression contains a `left_` or `right_` prefixed joint reference, THE Expression_Evaluator SHALL resolve that reference to the named side-specific landmark.

### Requirement 2: Total expression evaluator with UNAVAILABLE propagation

**User Story:** As the Analysis context, I want a total, allocation-free per-frame evaluator,
so that the signal computation stays inside the hot-path budget and never throws.

#### Acceptance Criteria

1. WHEN an ExerciseSpec is loaded, THE Expression_Evaluator SHALL tokenise and parse the signal expression into an abstract syntax tree and compile that tree into a closure tree exactly once.
2. WHEN evaluating a compiled expression for a frame, THE Expression_Evaluator SHALL perform no parsing, no string operations, and no heap allocation.
3. THE Expression_Evaluator SHALL support the calls `angle`, `distance`, `axis`, `midpoint`, `normalize`, and `delta` and the comparators `<`, `>`, `<=`, `>=`, `inside`, and `outside`.
4. THE Expression_Evaluator SHALL return a result of type `number` or `UNAVAILABLE` for every evaluation.
5. IF any operand of an arithmetic operation is `UNAVAILABLE`, THEN THE Expression_Evaluator SHALL return `UNAVAILABLE`.
6. IF either operand of a comparison is `UNAVAILABLE`, THEN THE Expression_Evaluator SHALL return `false`.

### Requirement 3: Generic phase-machine interpreter

**User Story:** As the Analysis context, I want a generic FSM interpreter driven by the spec,
so that reps, phases, and holds are produced without exercise-specific code.

#### Acceptance Criteria

1. WHEN the evaluated signal for a frame is `UNAVAILABLE`, THE Phase_Machine SHALL increment the low-confidence counter and emit no events for that frame.
2. WHEN a valid signal is produced, THE Phase_Machine SHALL smooth the signal with the configured filter and compute `dSignal` over a 3-frame window.
3. WHEN evaluating outgoing transitions, THE Phase_Machine SHALL evaluate them in declaration order and require the signal to cross the boundary by `hysteresisPct` times the observed range before transitioning.
4. IF the current phase has been active for less than `minPhaseDurationMs`, THEN THE Phase_Machine SHALL reject any outgoing transition for that frame.
5. WHEN the transition marked `emits: RepCompleted` fires, THE Phase_Machine SHALL assemble a rep record and evaluate the ROM gate using `romFloor` and `gateTolerance`.
6. WHILE `mode` is `hold`, THE Phase_Machine SHALL accumulate time in the target phase and emit `HoldProgressed` at 1 Hz.
7. IF the current phase remains unchanged for more than 30 seconds while `mode` is `reps`, THEN THE Phase_Machine SHALL emit `AnalysisStalled`.
8. WHEN the evaluated signal is `UNAVAILABLE` for more than 20 percent of a set, THE Engine SHALL mark the set `lowConfidence` and suppress velocity figures for that set.

### Requirement 4: Phase-scoped fault evaluation

**User Story:** As the Analysis context, I want faults evaluated only within their declared
phase, so that guards fire in the correct movement context and stay silent when uncertain.

#### Acceptance Criteria

1. WHEN the phase update for a frame completes, THE Fault_Evaluator SHALL evaluate only the faults whose declared `phase` equals the current phase.
2. IF the confidence for a fault's referenced landmarks is below threshold, THEN THE Fault_Evaluator SHALL suppress that fault.
3. IF a fault guard evaluates to `UNAVAILABLE`, THEN THE Fault_Evaluator SHALL suppress that fault.
4. WHEN a fault guard evaluates to `true`, THE Fault_Evaluator SHALL emit a `FaultDetected` event carrying the fault `id`, `severity`, and `cue` without applying cue rationing.

### Requirement 5: Schema and semantic validation with fixtures

**User Story:** As a maintainer, I want every ExerciseSpec structurally and semantically
validated at build time, so that a malformed or unsafe spec cannot ship.

#### Acceptance Criteria

1. THE Spec_Validator SHALL validate every ExerciseSpec against `exercise-spec.schema.json`.
2. IF an ExerciseSpec fails schema validation, THEN THE Spec_Validator SHALL fail the build and report the offending path and the violated constraint.
3. THE Spec_Validator SHALL verify that every landmark used in any expression appears in `requiredLandmarks`, that every phase named in a transition or fault exists in `phases.states`, and that the phase graph is strongly connected from `initial`.
4. WHERE `mode` is `reps`, THE Spec_Validator SHALL verify that exactly one transition carries `emits: RepCompleted`.
5. THE Spec_Validator SHALL verify that every `cue` is at most 4 words and contains no word from the banned-word list defined in coaching-safety guidance.
6. THE Spec_Validator SHALL verify that `hysteresisPct` is at least 0.05 and `minPhaseDurationMs` is at least 250.
7. IF no fixture exists for a spec `id`, THEN THE Spec_Validator SHALL fail the build.
8. IF an ExerciseSpec names an unknown smoothing filter, THEN THE Spec_Validator SHALL fail the build.

### Requirement 6: CLI validate and replay tooling

**User Story:** As an exercise author, I want command-line tools to validate and replay a spec,
so that I can verify rep counts and fault detection before merging.

#### Acceptance Criteria

1. WHEN `formcoach-spec validate <file>` is invoked, THE Spec_CLI SHALL run the schema and semantic checks against the named file and report each violation.
2. WHEN `formcoach-spec replay <file> --fixture <id>` is invoked, THE Spec_CLI SHALL replay the fixture through the CompiledSpec and produce the expected-versus-actual rep timeline.
3. WHEN a replay completes, THE Spec_CLI SHALL produce a per-fault confusion matrix comparing detected faults against the fixture annotations.
4. IF a spec `version` mismatches the stored Calibration version, THEN THE Engine SHALL invalidate that calibration and prompt recalibration.

### Requirement 7: No exercise names in TypeScript data boundary

**User Story:** As a maintainer, I want the exercises-are-data boundary enforced automatically,
so that no exercise identity can leak into code.

#### Acceptance Criteria

1. THE Build_Scan SHALL scan all files matching `src/**/*.ts` for occurrences of any exercise `id` declared in the ExerciseSpec documents.
2. IF any exercise `id`, name, or alias appears in a file matching `src/**/*.ts`, THEN THE Build_Scan SHALL fail the build and report the offending file and identifier.
3. THE Engine SHALL implement the Expression_Evaluator, Phase_Machine, and Fault_Evaluator without referencing any exercise `id`, name, or alias in TypeScript source.
