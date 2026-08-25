# Implementation Plan: CV Algorithm Lab

## Overview

Build an in-browser ML research platform for exercise computer vision layered on the existing app. It provides swappable pose estimation backends (MediaPipe, MoveNet, YOLOv8-Pose, RTMPose), benchmarking with OKS accuracy, side-by-side comparison, LSTM exercise classification, ST-GCN/Transformer form quality assessment, a training-data recorder, in-browser TFJS training, and a downloadable pre-trained adapter catalog. All inference runs in Web Workers; all state persists to IndexedDB. Lab Mode isolates the platform from the live workout pipeline.

## Tasks

- [x] 1. Foundations: types, dependencies, registry, normalizer, store
  - [x] 1.1 Add lab types and dependencies
    - Create `src/lab/types.ts` with `RuntimeBackend`, `AdapterMetadata`, `RawPose`, `PoseAdapter`, `BenchmarkResult`, `LatencyStats`, `AccuracyStats`, `GroundTruthFrame`, `RecordingSession`, `RecordingLabels`, `RecordedFrame`, `TrainedModelRecord`, `ClassificationResult`, `FormAssessment`, `FormDeviationML`, `Recommendation`, `CatalogEntry`, worker message types (`WorkerRequest`, `WorkerResponse`)
    - Add exact-pinned dependencies to `package.json`: `@tensorflow/tfjs`, `@tensorflow-models/pose-detection`, `onnxruntime-web`, and dev dep `fake-indexeddb`
    - _Requirements: 1.3, 1.5, 2.1, 3.1, 4.1, 6.1, 8.1, 11.1, 12.1, 13.1, 14.1_

  - [x] 1.2 Implement ModelRegistry in `src/lab/registry/ModelRegistry.ts`
    - `register(factory, metadata)`, `get(id)` synchronous lookup (<50ms), `list()`, `has(id)`
    - Throw `UnknownModelError(id)` on unknown id
    - Lazily instantiate adapters via factory; cache instances
    - _Requirements: 1.2, 1.4, 1.5_

  - [x] 1.3 Implement KeypointNormalizer in `src/lab/normalize/`
    - Create `keypointMap.ts` with `COCO_TO_MEDIAPIPE` mapping table (17 pairs)
    - Create `KeypointNormalizer.ts` with `normalize(keypoints)`: 17→33 zero-fill, 33→pass-through, else throw `UnsupportedKeypointCountError`
    - Set `index` field to target position; zero-fill unmapped with confidence 0
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.7_

  - [x] 1.4 Write unit + property tests for ModelRegistry and KeypointNormalizer
    - Registry: registration, lookup, unknown-id error, metadata listing
    - Normalizer round-trip property with fast-check (mapped indices survive unchanged)
    - Normalizer output shape (always 33, correct index fields), unsupported count throws
    - _Requirements: 1.4, 2.1, 2.5, 2.6, 2.7_

  - [x] 1.5 Implement ResultStore in `src/lab/store/`
    - Create `schema.ts` (DB name/version, object stores: benchmarks, annotations, recordings, trainedModels with indexes)
    - Create `ResultStore.ts` with `open()`, benchmark CRUD (`saveBenchmark`, `getBenchmark`, `queryBenchmarks`, `deleteBenchmark`, `deleteBenchmarksForModel`), annotation save/get, recording save/query, trained-model save/list
    - Wrap all IndexedDB errors in typed `StoreError{op,cause}`; deletion returns removed count
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 7.3, 12.4, 12.6, 13.3_

  - [x] 1.6 Write unit tests for ResultStore
    - Use `fake-indexeddb`; test round-trip identity, query by index, deletion count, StoreError on failure
    - _Requirements: 4.3, 4.5, 7.4_

- [x] 2. Pose adapters and Web Worker pool
  - [x] 2.1 Implement PoseAdapter base and worker protocol
    - Create `src/lab/registry/adapters/PoseAdapter.ts` (interface + abstract base with load-guard)
    - Create `src/lab/workers/pose.worker.ts` generic inference host handling `init`/`detect`/`dispose`, posting `ready`/`result`/`error`
    - _Requirements: 1.3, 8.1, 8.3, 8.5_

  - [x] 2.2 Implement pose adapters
    - `MediaPipeAdapter.ts` (33-kp, reuse `@mediapipe/tasks-vision`)
    - `MoveNetAdapter.ts` (17-kp Lightning + Thunder via TFJS pose-detection)
    - `YoloPoseAdapter.ts` (17-kp via onnxruntime-web)
    - `RtmPoseAdapter.ts` (17-kp via onnxruntime-web)
    - Each returns native `RawPose`; declares correct `AdapterMetadata`
    - _Requirements: 1.1, 1.3, 1.5_

  - [x] 2.3 Implement PoseWorkerPool in `src/lab/workers/PoseWorkerPool.ts`
    - `spawn(modelId, backend, modelUrl?)` resolves on `ready`; `terminate(handle)` discards in-flight via generation counter; support 2 concurrent handles
    - Transfer `ImageBitmap` into worker (zero-copy)
    - _Requirements: 8.1, 8.2, 8.4, 8.5_

  - [x] 2.4 Write unit tests for worker pool and adapters
    - Mock `Worker` (per existing WorkoutSession.test pattern): init handshake, result routing, terminate discards in-flight results
    - Stub adapter with deterministic keypoints; verify metadata + detect contract
    - _Requirements: 8.2, 8.5_

- [x] 3. Benchmarking, recommender, and Lab Mode wiring
  - [x] 3.1 Implement OKS in `src/lab/benchmark/oks.ts`
    - `computeOks(pred, gt, sigmas)` with COCO per-keypoint constants; scale from GT bbox; clamp to [0,1]
    - _Requirements: 3.3_

  - [x] 3.2 Implement BenchmarkRunner in `src/lab/benchmark/BenchmarkRunner.ts`
    - Process frames via worker pool, discard warm-up (default 5), record per-frame latency
    - Compute meanFps/median/p95/stdDev; OKS accuracy + recall@0.5 when GT present
    - Skip failed frames; mark invalid if >50% fail; partial if <50 successful
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 11.5_

  - [x] 3.3 Implement Recommender in `src/lab/compare/Recommender.ts`
    - `analyze(results)`: composite 0.6·latency + 0.4·accuracy; <=300-char summary; per-region notes; use-case categorization with thresholds (≤33ms, ≥0.75 OKS)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.6, 9.7_

  - [x] 3.4 Implement AlgorithmLab orchestrator + LabModePanel
    - `src/lab/AlgorithmLab.ts`: `activate`/`deactivate` (disable/restore workout pipeline <500ms), `setActiveModel`, `startBenchmark`, `getRecommendation`, error if no adapters
    - `src/lab/ui/LabModePanel.ts`: model dropdown, benchmark controls, dashboard, live FPS/latency (≥1/sec), recommender panel when ≥2 results
    - Add `labActive` guard in `src/demo/main.ts` `processFrame()` to route frames to lab pool
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 9.5_

  - [x] 3.5 Write unit tests for benchmark, OKS, recommender
    - OKS numeric correctness vs hand-computed vectors; identical pose = 1.0
    - BenchmarkRunner with stub adapter: warm-up exclusion, invalid threshold, stats shape, persistence round-trip
    - Recommender determinism + categorization
    - _Requirements: 3.3, 3.7, 3.8, 9.4, 9.6_

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Comparison view and ground-truth annotation
  - [x] 5.1 Implement ComparisonView in `src/lab/compare/ComparisonView.ts`
    - Up to 4 panels; synchronized frame stepping; metric table (N/A when unavailable); highlight keypoints with max pairwise distance > 0.05; per-panel error indicator on frame failure
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 5.2 Implement AnnotationTool in `src/lab/annotate/AnnotationTool.ts`
    - Click-to-place 33 markers with normalized coords; not-visible flags; frame navigation; index+name labels; edit saved; require all 33 before save; persist via ResultStore
    - _Requirements: 7.1, 7.2, 7.3, 7.5, 7.6, 7.7, 7.8_

  - [x] 5.3 Write unit tests for ComparisonView and AnnotationTool
    - jsdom + canvas mock (per FramingGuide.test pattern): divergence highlight, N/A cells; annotation placement, validation error, GroundTruthFrame round-trip
    - _Requirements: 5.4, 7.4, 7.8_

- [x] 6. Exercise classification and form quality assessment
  - [x] 6.1 Implement ExerciseClassifier in `src/lab/classify/ExerciseClassifier.ts`
    - Sliding window 30 / stride 15; buffer until full; emit label+confidence; "unknown" below threshold (default 0.7); run in `classify.worker.ts`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [x] 6.2 Implement FormQualityModel in `src/lab/classify/FormQualityModel.ts`
    - Support `stgcn` and `transformer` architectures; `assess(window)` → qualityScore + deviations (confidence > 0.6) with joints/severity/suggestion; ONNX Runtime Web in worker; bundle Fitness-AQA ST-GCN model in `public/models/`
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.6_

  - [x] 6.3 Write unit tests for classifier and form model
    - Windowing/buffering property; unknown-below-threshold; form deviation emission with stub ONNX session; form benchmark accuracy/FP rate
    - _Requirements: 6.1, 6.3, 6.5, 11.3, 11.5_

- [x] 7. Data recording and in-browser training
  - [x] 7.1 Implement Recorder in `src/lab/record/Recorder.ts`
    - `start`/`capture`/`stop`; labels (rep boundaries, quality 1-5, per-frame errors); `exportJson`/`importJson` with documented schema v1; ~18k frame cap; persist via ResultStore
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

  - [x] 7.2 Implement Trainer + model export
    - `src/lab/train/train.worker.ts` + `Trainer.ts`: TFJS MLP/LSTM training with configurable hyperparameters, streamed progress
    - `src/lab/train/modelExport.ts`: serialize to TFJS LayersModel + ONNX; store via ResultStore; register trained models into ModelRegistry
    - `src/lab/ui/TrainingPanel.ts`: hyperparameter controls + live progress
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

  - [x] 7.3 Write unit tests for Recorder and Trainer
    - Recorder export/import schema round-trip, frame cap, query; Trainer progress callback + export shape with tiny synthetic dataset
    - _Requirements: 12.3, 12.5, 13.2, 13.3_

- [x] 8. Pre-trained adapter catalog
  - [x] 8.1 Implement PretrainedCatalog in `src/lab/catalog/PretrainedCatalog.ts`
    - Catalog entries (repnet-counter, exercise-classifier, form-assessor, dtw-matcher) with metadata; `download` with progress + registry registration; `validateSchema` vs normalizer output; `sideload` from File; versioning + update notification
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6_

  - [x] 8.2 Write unit tests for PretrainedCatalog
    - Catalog listing/metadata; schema validation pass/fail; sideload registration; version comparison
    - _Requirements: 14.3, 14.4, 14.5, 14.6_

- [x] 9. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Each task references specific requirements for traceability.
- Model-dependent tests use deterministic stub adapters so CI needs no real weights or GPU.
- New runtime deps (`@tensorflow/tfjs`, `@tensorflow-models/pose-detection`, `onnxruntime-web`) are pinned to exact versions.
- Lab Mode integrates via a `labActive` guard in `main.ts`, mirroring the existing `preTrackingActive` gate.
- The bundled Fitness-AQA ST-GCN model and any downloaded weights are treated as untrusted data (never eval'd), handed directly to ONNX Runtime / TFJS loaders.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.5"] },
    { "id": 2, "tasks": ["1.4", "1.6", "2.1"] },
    { "id": 3, "tasks": ["2.2", "2.3"] },
    { "id": 4, "tasks": ["2.4", "3.1"] },
    { "id": 5, "tasks": ["3.2", "3.3"] },
    { "id": 6, "tasks": ["3.4"] },
    { "id": 7, "tasks": ["3.5"] },
    { "id": 8, "tasks": ["5.1", "5.2", "6.1", "6.2", "7.1"] },
    { "id": 9, "tasks": ["5.3", "6.3", "7.2", "8.1"] },
    { "id": 10, "tasks": ["7.3", "8.2"] }
  ]
}
```
