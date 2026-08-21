# Requirements Document

## Introduction

The CV Algorithm Lab is an in-browser development and benchmarking tool that enables switching between multiple pose estimation models, measuring their accuracy and performance, comparing results side-by-side, and classifying exercises via an LSTM layer on keypoint sequences. It integrates with the existing TypeScript/Vite application and its Web Worker–based pose detector pipeline, providing a keypoint normalization layer to map 17-keypoint models to the internal 33-keypoint format. A ground-truth annotation mode supports measuring real accuracy against labeled data. All benchmark results persist to IndexedDB for longitudinal comparison.

## Glossary

- **Algorithm_Lab**: The top-level module that orchestrates model switching, benchmarking, comparison, and annotation workflows.
- **Model_Registry**: The component that manages available pose estimation model adapters and their metadata (name, keypoint count, runtime backend).
- **Pose_Adapter**: A model-specific wrapper that loads a pose estimation model, runs inference on an image frame, and returns raw keypoints in that model's native format.
- **Keypoint_Normalizer**: The component that maps keypoints from any supported model format (17-keypoint or 33-keypoint) to the internal 33-keypoint Keypoint[] schema.
- **Benchmark_Runner**: The component that executes timed inference passes over a set of frames and records accuracy, recall, FPS, and per-frame latency metrics.
- **Result_Store**: The IndexedDB-backed persistence layer that stores benchmark results, comparison sessions, and ground-truth annotations.
- **Comparison_View**: The UI component that renders side-by-side pose overlays and metric tables for two or more models on the same input frames.
- **Exercise_Classifier**: The LSTM-based neural network that receives a windowed sequence of normalized keypoints and outputs an exercise class label with confidence.
- **Annotation_Tool**: The ground-truth labeling interface where users mark correct keypoint positions on video frames to produce reference data for accuracy measurement.
- **Ground_Truth_Frame**: A single video frame with user-annotated keypoint positions used as the reference for computing accuracy and recall.
- **OKS**: Object Keypoint Similarity — the standard metric (from COCO evaluation) used to compute per-keypoint accuracy against ground-truth annotations.

## Requirements

### Requirement 1: Model Registry and Adapter Loading

**User Story:** As a developer, I want to register and load multiple pose estimation models through a unified interface, so that I can switch between algorithms without modifying downstream pipeline code.

#### Acceptance Criteria

1. THE Model_Registry SHALL support registration of at least the following adapters: MediaPipe BlazePose (33 keypoints), MoveNet Lightning (17 keypoints via TFJS), MoveNet Thunder (17 keypoints via TFJS), YOLOv8-Pose (17 keypoints via ONNX Runtime Web), and RTMPose (17 keypoints via ONNX Runtime Web).
2. WHEN a Pose_Adapter is requested by model identifier, THE Model_Registry SHALL return the corresponding adapter instance within 50 ms excluding model weight download time.
3. WHEN a Pose_Adapter is loaded, THE Pose_Adapter SHALL expose a uniform `detect(frame: ImageBitmap, timestampMs: number)` interface that returns raw keypoints in the model's native format.
4. WHEN a model identifier is not found in the registry, THE Model_Registry SHALL return a descriptive error indicating the unrecognized model name.
5. THE Model_Registry SHALL report each registered adapter's metadata including model name, keypoint count, and runtime backend (TFJS or ONNX Runtime Web or MediaPipe WASM).

### Requirement 2: Keypoint Normalization

**User Story:** As a developer, I want 17-keypoint model outputs mapped to the internal 33-keypoint schema, so that downstream form evaluation and rep counting work identically regardless of the source model.

#### Acceptance Criteria

1. WHEN the Keypoint_Normalizer receives 17 keypoints from a COCO-format model (MoveNet, YOLOv8-Pose, RTMPose), THE Keypoint_Normalizer SHALL produce a 33-element Keypoint[] array conforming to the existing MediaPipe landmark indexing.
2. WHEN the Keypoint_Normalizer receives 33 keypoints from MediaPipe BlazePose, THE Keypoint_Normalizer SHALL pass them through unmodified.
3. FOR ALL mapped keypoints where a direct correspondence exists between the 17-keypoint COCO format and the 33-keypoint MediaPipe format, THE Keypoint_Normalizer SHALL copy x, y, z, and confidence values from the source keypoint to the target index.
4. FOR ALL target indices that have no corresponding source keypoint in the 17-keypoint format, THE Keypoint_Normalizer SHALL set x, y, and z to 0 and confidence to 0, indicating the keypoint is unavailable.
5. FOR ALL valid normalized Keypoint[] arrays, normalizing then extracting the original 17 indices SHALL yield values equal to the original 17-keypoint input (round-trip property for mapped indices).

### Requirement 3: Benchmark Execution

**User Story:** As a developer, I want to run controlled benchmarks measuring FPS, per-frame latency, accuracy (OKS), and recall for each model, so that I can make data-driven model selection decisions.

#### Acceptance Criteria

1. WHEN a benchmark is initiated for a given Pose_Adapter, THE Benchmark_Runner SHALL process a minimum of 100 frames sequentially and record per-frame inference latency in milliseconds.
2. WHEN the benchmark completes, THE Benchmark_Runner SHALL compute and report: mean FPS, median latency, P95 latency, and standard deviation of latency.
3. WHEN ground-truth annotations are available for the benchmark frame set, THE Benchmark_Runner SHALL compute per-keypoint OKS accuracy and recall at OKS threshold 0.5.
4. WHEN ground-truth annotations are not available, THE Benchmark_Runner SHALL report latency and FPS metrics only and indicate that accuracy metrics are unavailable.
5. THE Benchmark_Runner SHALL execute inference in a Web Worker to avoid blocking the main UI thread during benchmarking.
6. IF a Pose_Adapter throws an error during benchmark execution, THEN THE Benchmark_Runner SHALL record the error, skip the failed frame, and continue processing remaining frames.

### Requirement 4: Result Persistence

**User Story:** As a developer, I want benchmark results persisted to IndexedDB, so that I can compare performance across sessions and track improvements over time.

#### Acceptance Criteria

1. WHEN a benchmark run completes, THE Result_Store SHALL persist the full result record (model name, timestamp, frame count, all computed metrics, per-frame latency array) to IndexedDB.
2. THE Result_Store SHALL support querying stored results by model name, by date range, and by benchmark run identifier.
3. WHEN a result record is stored and then retrieved by its identifier, THE Result_Store SHALL return a record identical to the one that was stored (round-trip property).
4. WHEN IndexedDB is unavailable or a write fails, THE Result_Store SHALL surface a descriptive error to the caller without crashing the application.
5. THE Result_Store SHALL support deletion of individual benchmark records and bulk deletion of all records for a given model.

### Requirement 5: Side-by-Side Comparison

**User Story:** As a developer, I want to visually compare pose estimation outputs from two or more models on the same input frames, so that I can identify qualitative differences in keypoint placement.

#### Acceptance Criteria

1. WHEN the user selects two or more models for comparison, THE Comparison_View SHALL render the pose skeleton overlays side-by-side on the same source video frame.
2. THE Comparison_View SHALL display a metric summary table showing FPS, median latency, and accuracy (when available) for each model in the comparison.
3. WHEN the user steps through frames, THE Comparison_View SHALL synchronize the displayed frame across all model panels.
4. THE Comparison_View SHALL highlight keypoints where model outputs diverge by more than 0.05 in normalized coordinate distance.

### Requirement 6: Exercise Classification (LSTM)

**User Story:** As a developer, I want an LSTM-based classifier that identifies the current exercise from a sequence of normalized keypoints, so that the system can auto-detect which exercise the user is performing.

#### Acceptance Criteria

1. THE Exercise_Classifier SHALL accept a sliding window of normalized Keypoint[] frames (minimum window size of 30 frames) and output a predicted exercise class label with a confidence score between 0 and 1.
2. WHEN the confidence score exceeds a configurable threshold (default 0.7), THE Exercise_Classifier SHALL emit the classification result to the main application.
3. WHEN the confidence score is below the threshold, THE Exercise_Classifier SHALL emit an "unknown" classification rather than a low-confidence guess.
4. THE Exercise_Classifier SHALL run inference using ONNX Runtime Web or TensorFlow.js within a Web Worker to avoid blocking the UI thread.
5. WHEN the Exercise_Classifier receives fewer frames than the minimum window size, THE Exercise_Classifier SHALL buffer frames without emitting a prediction until the window is full.
6. THE Exercise_Classifier SHALL support at least the exercises defined in the application's existing exercise catalog configuration.

### Requirement 7: Ground-Truth Annotation

**User Story:** As a developer, I want to annotate keypoint positions on video frames to create ground-truth data, so that I can measure real model accuracy instead of relying only on timing metrics.

#### Acceptance Criteria

1. WHEN the user enters annotation mode, THE Annotation_Tool SHALL display a video frame and allow the user to click to place keypoint markers at correct body landmark positions.
2. THE Annotation_Tool SHALL support annotating all 33 MediaPipe landmark positions, with the option to mark individual keypoints as "not visible" when occluded.
3. WHEN the user saves an annotated frame, THE Annotation_Tool SHALL persist the Ground_Truth_Frame (frame image reference, annotated keypoint coordinates, visibility flags) to IndexedDB via the Result_Store.
4. WHEN a Ground_Truth_Frame is stored and then retrieved, THE Annotation_Tool SHALL return coordinates and visibility flags identical to what was saved (round-trip property).
5. THE Annotation_Tool SHALL support editing previously saved annotations by loading the Ground_Truth_Frame and allowing keypoint position adjustments.
6. THE Annotation_Tool SHALL display the keypoint index and name label next to each placed marker for disambiguation.

### Requirement 8: Web Worker Integration

**User Story:** As a developer, I want all model inference to run in Web Workers, so that the UI remains responsive during benchmarking and live model switching.

#### Acceptance Criteria

1. WHEN a Pose_Adapter is loaded for inference, THE Algorithm_Lab SHALL execute the adapter's detect method inside a Web Worker.
2. WHEN the user switches the active model, THE Algorithm_Lab SHALL terminate the current model's Web Worker and spawn a new worker for the selected model within 200 ms excluding model weight load time.
3. WHEN a Web Worker encounters an unrecoverable error, THE Algorithm_Lab SHALL post an ErrorMessage to the main thread with an appropriate error code and human-readable description.
4. THE Algorithm_Lab SHALL support running two Web Workers concurrently during side-by-side comparison mode.

### Requirement 9: Algorithm Explanation and Recommendation

**User Story:** As a user, I want to understand why one pose estimation algorithm performs better than another for my use case, so that I can make informed decisions about which model to use.

#### Acceptance Criteria

1. WHEN a comparison between two or more models is available, THE Algorithm_Lab SHALL generate a plain-language summary explaining which model performed better and why, referencing specific metrics (FPS, latency, accuracy).
2. WHEN accuracy metrics are available, THE Algorithm_Lab SHALL explain per-body-region differences (e.g., "Model A tracks lower limbs more accurately due to higher OKS on knee and ankle keypoints").
3. WHEN only latency metrics are available, THE Algorithm_Lab SHALL explain the trade-off between speed and model complexity (e.g., Lightning is faster but Thunder has higher keypoint stability).
4. THE Algorithm_Lab SHALL provide a recommendation indicating which model is best suited for real-time workout tracking based on the combined benchmark results (weighting latency and accuracy).
5. WHEN the user hovers over or selects a specific metric in the comparison table, THE Algorithm_Lab SHALL display a tooltip or inline explanation describing what the metric measures and how to interpret the value.
6. THE Algorithm_Lab SHALL categorize model suitability by use case: "real-time coaching" (prioritizes low latency), "accuracy-critical" (prioritizes OKS), and "balanced" (weighted combination).

### Requirement 10: Lab Mode UI Controls

**User Story:** As a developer, I want a dedicated Lab Mode UI panel with model selection, benchmark controls, and result visualization, so that I can operate the lab without interfering with the main workout flow.

#### Acceptance Criteria

1. WHEN the user activates Lab Mode, THE Algorithm_Lab SHALL display a panel with model selection dropdown, benchmark start/stop controls, and a results dashboard.
2. WHILE Lab Mode is active, THE Algorithm_Lab SHALL disable the main workout session pipeline to prevent interference between lab inference and live workout inference.
3. WHEN the user deactivates Lab Mode, THE Algorithm_Lab SHALL restore the previously active model and resume normal application operation within 500 ms.
4. THE Algorithm_Lab SHALL display real-time FPS and latency indicators while a model is actively processing frames in Lab Mode.
5. WHEN benchmark results are available for multiple models, THE Algorithm_Lab SHALL display the algorithm explanation and recommendation panel alongside the results dashboard.
