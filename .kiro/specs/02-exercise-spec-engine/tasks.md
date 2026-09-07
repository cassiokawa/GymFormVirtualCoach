# Implementation Plan: Exercise Spec Engine

## Overview

Build the Analysis bounded context as the exercise-agnostic Exercise Spec Engine in TypeScript.
Work proceeds inward-out: shared types and the JSON document contract first, then the total
expression evaluator, the generic phase machine, the fault evaluator, validation and CLI
tooling, the data-boundary build scan, and finally the hot-path benchmark and migration parity
gate. Exercise definitions live only in `src/domain/exercises/**/*.json`; no exercise `id`,
name, or alias appears in any `src/**/*.ts` file.

## Tasks

- [x] 1. Establish Analysis-context types and directory layout
  - Create `src/domain/analysis/` for the engine and `src/domain/exercises/` for JSON specs
  - Define `LandmarkFrame`, `Signal` (`number | UNAVAILABLE`), `DomainEvent`
    (`RepCompleted`, `FaultDetected`, `HoldProgressed`, `AnalysisStalled`), `EvalContext`,
    and `Calibration` types; reuse `Keypoint` from `src/types/index.ts` where applicable
  - No exercise names in any of these types
  - _Requirements: 1.1, 4.4, 3.6, 3.7_

- [x] 2. Define the ExerciseSpec document contract and loader
  - [x] 2.1 Author `exercise-spec.schema.json` and the `ExerciseSpec` TypeScript shape
    - Encode `id`, `version`, `displayName`, `aliases`, `facets`, `mode`, `bilateral`,
      `landmarkPairs`, `requiredLandmarks`, `optionalLandmarks`, `camera`, `signal`, `rom`,
      `phases`, `velocity`, `faults`
    - _Requirements: 1.2, 1.3_
  - [x] 2.2 Implement the JSON loader that reads specs from `src/domain/exercises`
    - Parse each document into an in-memory `ExerciseSpec`; compile happens in later tasks
    - _Requirements: 1.1, 1.2_
  - [ ]* 2.3 Write unit test for loader source boundary
    - Assert the loader reads only from the exercises directory
    - _Requirements: 1.1_

- [x] 3. Implement joint reference resolution
  - [x] 3.1 Resolve unprefixed joints to bilateral midpoint and prefixed joints to side landmark
    - Use `landmarkPairs` to map unprefixed names to left/right indices
    - _Requirements: 1.4, 1.5_
  - [ ]* 3.2 Write property test for joint reference resolution
    - **Property 2: Joint reference resolution**
    - **Validates: Requirements 1.4, 1.5**

- [x] 4. Implement the expression tokeniser and parser
  - Tokenise the grammar (`expr`/`term`/`factor`/`call`/`compare`) and parse to an AST
  - Support calls `angle`, `distance`, `axis`, `midpoint`, `normalize`, `delta` and comparators
    `<`, `>`, `<=`, `>=`, `inside`, `outside`; bind `signal`, `dSignal`, `romFloor`, `romTop`,
    `velocityThreshold`, `repMinSignal`, `repMaxSignal`, `phaseElapsedMs`
  - _Requirements: 2.1, 2.3_

- [x] 5. Compile the AST to a closure tree and implement UNAVAILABLE semantics
  - [x] 5.1 Compile each AST once into a closure tree evaluated per frame with no parse/alloc
    - Every node returns `number | UNAVAILABLE`; arithmetic with `UNAVAILABLE` yields
      `UNAVAILABLE`; comparison with `UNAVAILABLE` yields `false`
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 2.6_
  - [ ]* 5.2 Write property test for evaluator totality
    - **Property 3: Evaluator totality**
    - **Validates: Requirements 2.4**
  - [ ]* 5.3 Write property test for UNAVAILABLE propagation
    - **Property 4: UNAVAILABLE propagation**
    - **Validates: Requirements 2.5, 2.6**
  - [ ]* 5.4 Write golden unit tests per call and comparator
    - Cover `angle`, `distance`, `axis`, `midpoint`, `normalize`, `delta` and each comparator
    - _Requirements: 2.3_

- [x] 6. Implement smoothing and dSignal computation
  - Implement the One Euro filter (default) driven by `minCutoff`/`beta`; compute `dSignal` over
    a 3-frame window
  - _Requirements: 3.2_

- [x] 7. Implement the generic phase-machine interpreter
  - [x] 7.1 Interpret transitions with declaration order, hysteresis band, and min phase duration
    - On `UNAVAILABLE` signal, increment low-confidence counter and emit no events; apply
      `hysteresisPct` × observed range past boundary; reject transitions younger than
      `minPhaseDurationMs`
    - _Requirements: 3.1, 3.3, 3.4_
  - [x] 7.2 Assemble rep records and evaluate the ROM gate on RepCompleted
    - On the `emits: RepCompleted` transition, build the rep record and evaluate `romFloor`
      and `gateTolerance`
    - _Requirements: 3.5_
  - [x] 7.3 Implement hold-mode HoldProgressed and stall/low-confidence handling
    - Accumulate target-phase time and emit `HoldProgressed` at 1 Hz; emit `AnalysisStalled`
      after 30 s stuck in `reps`; mark set `lowConfidence` and suppress velocity when
      `UNAVAILABLE` exceeds 20% of the set
    - _Requirements: 3.6, 3.7, 3.8_
  - [ ]* 7.4 Write property test for silence on unavailable signal
    - **Property 5: Silence on unavailable signal**
    - **Validates: Requirements 3.1**
  - [ ]* 7.5 Write property test for hysteresis and minimum phase duration
    - **Property 6: Hysteresis prevents premature transition**
    - **Property 7: Minimum phase duration respected**
    - **Validates: Requirements 3.3, 3.4**
  - [ ]* 7.6 Write property test for exact rep counting under tempo and noise
    - **Property 8: Exact rep counting**
    - **Validates: Requirements 3.5**
  - [ ]* 7.7 Write property tests for hold cadence and low-confidence suppression
    - **Property 9: Hold progress cadence**
    - **Property 10: Low-confidence set suppresses velocity**
    - **Validates: Requirements 3.6, 3.8**

- [x] 8. Checkpoint — evaluator and phase machine
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement phase-scoped fault evaluation
  - [x] 9.1 Evaluate current-phase faults with precomputed confidence gates
    - Scope evaluation to the current phase; suppress a fault when its landmark confidence is
      below threshold or its guard is `UNAVAILABLE`; emit `FaultDetected` (`id`, `severity`,
      `cue`) with no cue rationing when a guard is confidently true
    - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - [ ]* 9.2 Write property test for phase-scoped faults
    - **Property 11: Faults are phase-scoped**
    - **Validates: Requirements 4.1**
  - [ ]* 9.3 Write property test for fault suppression when uncertain
    - **Property 12: Faults suppressed when uncertain**
    - **Validates: Requirements 4.2, 4.3**
  - [ ]* 9.4 Write property test for confident true guard emission
    - **Property 13: Confident true guard emits fault unrationed**
    - **Validates: Requirements 4.4**

- [x] 10. Assemble the CompiledSpec and AnalysisEngine
  - Wire loader, resolution, evaluator, phase machine, and fault evaluator into `CompiledSpec`
    and `AnalysisEngine` (`load`, `ingest` pure/synchronous, `reset`); never retain a frame
    beyond `ingest`; invalidate calibration on spec `version` mismatch and prompt recalibrate
  - _Requirements: 1.2, 3.5, 4.4, 6.4_

- [x] 11. Implement the JSON schema and semantic validator
  - [x] 11.1 Validate structure against the schema and report path + constraint on failure
    - Fail on schema violation naming the offending path; fail on unknown smoothing filter
    - _Requirements: 5.1, 5.2, 5.8_
  - [x] 11.2 Implement semantic checks
    - Verify expression landmarks in `requiredLandmarks`, named phases exist, phase graph
      strongly connected from `initial`, exactly one `RepCompleted` transition for `reps`,
      every `cue` ≤ 4 words and free of banned words, `hysteresisPct` ≥ 0.05,
      `minPhaseDurationMs` ≥ 250, and a fixture exists per spec `id`
    - _Requirements: 5.3, 5.4, 5.5, 5.6, 5.7_
  - [ ]* 11.3 Write property tests for schema and semantic invariants
    - **Property 14: Malformed specs are rejected**
    - **Property 15: Semantic invariants enforced**
    - **Validates: Requirements 5.2, 5.3, 5.4**
  - [ ]* 11.4 Write property tests for cue safety and threshold bounds
    - **Property 16: Cue safety**
    - **Property 17: Threshold bounds enforced**
    - **Validates: Requirements 5.5, 5.6**
  - [ ]* 11.5 Write unit tests for missing-fixture and unknown-filter build failures
    - Cover missing fixture per id and unknown smoothing filter edge cases
    - _Requirements: 5.7, 5.8_

- [x] 12. Implement the fixture harness and formcoach-spec CLI
  - [x] 12.1 Build the fixture harness that replays an annotated landmark timeline through a spec
    - Produce the expected-vs-actual rep timeline and a per-fault confusion matrix
    - _Requirements: 6.2, 6.3_
  - [x] 12.2 Implement `formcoach-spec validate <file>` and `replay <file> --fixture <id>`
    - `validate` runs schema + semantic checks and reports violations; `replay` uses the harness
    - _Requirements: 6.1, 6.2, 6.3_
  - [ ]* 12.3 Write property test for replay rep-timeline parity
    - **Property 18: Replay rep-timeline parity**
    - **Validates: Requirements 6.2**
  - [ ]* 12.4 Write unit test for calibration version-mismatch handling
    - Assert calibration invalidated and recalibrate prompt on version mismatch
    - _Requirements: 6.4_

- [x] 13. Implement the exercises-are-data build scan
  - Add a build-time scan that collects every exercise `id`, name, and alias from
    `src/domain/exercises/**/*.json` and fails the build if any appears in a file matching
    `src/**/*.ts`, naming the offending file and identifier; wire it into the build/CI step
  - _Requirements: 7.1, 7.2, 7.3_
  - [ ]* 13.1 Write property test for the data-boundary scan
    - **Property 19: No exercise identity in TypeScript**
    - **Validates: Requirements 7.1, 7.2, 7.3**

- [~] 14. Implement the hot-path ingest benchmark
  - Benchmark `AnalysisEngine.ingest` with all 22 specs loaded; assert ≤ 3 ms p95 per frame and
    probe that no parsing or heap allocation occurs on the per-frame path
  - _Requirements: 2.2_

- [x] 15. Implement the migration parity gate
  - Run the existing rep-counting logic and the new engine over all fixtures; block on any
    rep-count regression relative to human-annotated fixtures
  - _Requirements: 3.5, 6.2_

- [x] 16. Final checkpoint — full engine wired and gated
  - Ensure all tests, the build scan, the hot-path benchmark, and the parity gate pass; ask the
    user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP.
- Each task references specific requirement clauses for traceability.
- Property tests validate the design's Correctness Properties; run each at ≥ 100 iterations and
  tag them `Feature: 02-exercise-spec-engine, Property {n}: {property text}`.
- No exercise `id`, name, or alias may appear in any `src/**/*.ts`; task 13 enforces this.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "4"] },
    { "id": 2, "tasks": ["2.2", "3.1", "5.1"] },
    { "id": 3, "tasks": ["2.3", "3.2", "5.2", "5.3", "5.4", "6"] },
    { "id": 4, "tasks": ["7.1"] },
    { "id": 5, "tasks": ["7.2", "7.3"] },
    { "id": 6, "tasks": ["7.4", "7.5", "7.6", "7.7", "9.1"] },
    { "id": 7, "tasks": ["9.2", "9.3", "9.4", "10"] },
    { "id": 8, "tasks": ["11.1", "11.2"] },
    { "id": 9, "tasks": ["11.3", "11.4", "11.5", "12.1"] },
    { "id": 10, "tasks": ["12.2", "13"] },
    { "id": 11, "tasks": ["12.3", "12.4", "13.1", "14", "15"] }
  ]
}
```
