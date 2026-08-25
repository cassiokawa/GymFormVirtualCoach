# Design Document: CV Algorithm Lab

## Overview

The CV Algorithm Lab is a self-contained, in-browser ML research platform layered on top of the existing CV Fitness & Form Assistant. It lets developers swap pose estimation backends, benchmark them against ground truth, compare outputs side-by-side, classify exercises and assess form with specialized neural models, record and label training data, train custom classifiers in-browser, and download pre-trained exercise adapters.

The lab is designed as an **isolated mode**: when active, it takes over the frame source and disables the live workout pipeline (RepCounter, FormEvaluator, SafetyMonitor) to prevent inference contention. All model inference runs in Web Workers. All persistent state (benchmark results, recordings, trained models, annotations) lives in IndexedDB.

### Design Goals

- **Uniform adapter contract** — every model (pose, classifier, form assessor) is accessed through a small set of interfaces so downstream code is model-agnostic.
- **Normalization to 33-keypoint MediaPipe schema** — 17-keypoint COCO models are mapped up so the existing FormEvaluator/RepCounter work unchanged.
- **Worker isolation** — heavy inference and training never block the UI thread.
- **Offline-first** — everything runs client-side; the only network calls are optional model-weight downloads.

### System Context

```
┌────────────────────────────────────────────────────────────────────┐
│                          Main Thread (UI)                            │
│                                                                      │
│   ┌──────────────┐   ┌──────────────┐   ┌────────────────────────┐  │
│   │ LabModePanel │   │ Comparison   │   │ TrainingPanel /         │  │
│   │ (controls)   │   │ View         │   │ AnnotationTool          │  │
│   └──────┬───────┘   └──────┬───────┘   └───────────┬────────────┘  │
│          │                  │                       │               │
│          ▼                  ▼                       ▼               │
│   ┌──────────────────────────────────────────────────────────────┐ │
│   │                       AlgorithmLab (orchestrator)             │ │
│   └───┬───────────┬───────────┬────────────┬───────────┬─────────┘ │
│       │           │           │            │           │           │
│       ▼           ▼           ▼            ▼           ▼           │
│  ModelRegistry BenchmarkRunner ResultStore Recorder  Recommender   │
│       │           │             │(IndexedDB)                        │
└───────┼───────────┼─────────────────────────────────────────────────┘
        │ postMessage│
        ▼           ▼
┌────────────────────────────────────────────────────────────────────┐
│                         Web Workers                                  │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌──────────┐ │
│  │ pose-worker   │ │ pose-worker#2 │ │ classify-     │ │ train-   │ │
│  │ (adapter A)   │ │ (adapter B)   │ │ worker        │ │ worker   │ │
│  └───────────────┘ └───────────────┘ └───────────────┘ └──────────┘ │
│   MediaPipe WASM / TFJS / ONNX Runtime Web backends                  │
└────────────────────────────────────────────────────────────────────┘
```

---

## Architecture

### Module Layout

```
src/lab/
  AlgorithmLab.ts            # top-level orchestrator (Req 8, 10)
  registry/
    ModelRegistry.ts         # adapter registration + metadata (Req 1, 14)
    adapters/
      PoseAdapter.ts         # interface + base class
      MediaPipeAdapter.ts    # 33-kp BlazePose (Req 1)
      MoveNetAdapter.ts      # 17-kp Lightning/Thunder via TFJS (Req 1)
      YoloPoseAdapter.ts     # 17-kp via ONNX Runtime Web (Req 1)
      RtmPoseAdapter.ts      # 17-kp via ONNX Runtime Web (Req 1)
  normalize/
    KeypointNormalizer.ts    # COCO17 -> MediaPipe33 (Req 2)
    keypointMap.ts           # static mapping table
  benchmark/
    BenchmarkRunner.ts       # timed passes + metrics (Req 3)
    oks.ts                   # OKS computation (Req 3)
  store/
    ResultStore.ts           # IndexedDB persistence (Req 4, 12)
    schema.ts                # object store definitions
  compare/
    ComparisonView.ts        # side-by-side overlays (Req 5)
    Recommender.ts           # explanation + recommendation (Req 9)
  classify/
    ExerciseClassifier.ts    # LSTM classifier (Req 6)
    FormQualityModel.ts      # ST-GCN / Transformer form assessor (Req 11)
  annotate/
    AnnotationTool.ts        # ground-truth labeling (Req 7)
  record/
    Recorder.ts              # keypoint sequence capture + export (Req 12)
  train/
    Trainer.ts               # in-browser TFJS training (Req 13)
    modelExport.ts           # TFJS <-> ONNX export helpers
  catalog/
    PretrainedCatalog.ts     # downloadable adapter registry (Req 14)
  ui/
    LabModePanel.ts          # controls + dashboard (Req 10)
    TrainingPanel.ts
  workers/
    pose.worker.ts           # generic pose inference host (Req 8)
    classify.worker.ts       # classifier/form-model host
    train.worker.ts          # training host
  types.ts                   # lab-specific shared types
```

### Runtime Backends

| Backend | Library | Used by |
|---|---|---|
| MediaPipe WASM | `@mediapipe/tasks-vision` (already a dep) | MediaPipeAdapter |
| TensorFlow.js | `@tensorflow/tfjs` + `@tensorflow-models/pose-detection` | MoveNetAdapter, Trainer, TFJS classifiers |
| ONNX Runtime Web | `onnxruntime-web` (WASM + WebGPU EP) | YoloPoseAdapter, RtmPoseAdapter, FormQualityModel, ONNX classifiers |

New dependencies to add: `@tensorflow/tfjs`, `@tensorflow-models/pose-detection`, `onnxruntime-web`. All pinned to exact versions.

---

## Components and Interfaces

### 1. PoseAdapter and ModelRegistry (Req 1, 14)

Every pose model implements a uniform contract. The adapter returns keypoints in its **native** format; normalization happens downstream so adapters stay simple.

```typescript
export type RuntimeBackend = 'mediapipe-wasm' | 'tfjs' | 'onnx-web';

export interface AdapterMetadata {
  id: string;                 // e.g. "movenet-thunder"
  displayName: string;        // e.g. "MoveNet Thunder"
  keypointCount: 17 | 33;
  backend: RuntimeBackend;
  modelSizeMb: number;
  license: string;
  version: string;
}

export interface RawPose {
  keypoints: Keypoint[];      // native format (17 or 33)
  timestampMs: number;
}

export interface PoseAdapter {
  readonly metadata: AdapterMetadata;
  /** Load model weights. Idempotent. Rejects with descriptive error on failure. */
  load(): Promise<void>;
  /** Run inference on a single frame. Requires load() to have resolved. */
  detect(frame: ImageBitmap, timestampMs: number): Promise<RawPose>;
  /** Release GPU/WASM resources. */
  dispose(): Promise<void>;
}

export class ModelRegistry {
  register(factory: () => PoseAdapter, metadata: AdapterMetadata): void;
  /** Returns adapter instance in <50ms (excluding load()). Throws on unknown id. */
  get(id: string): PoseAdapter;
  list(): AdapterMetadata[];
  has(id: string): boolean;
}
```

**Design decisions:**
- `detect` takes `ImageBitmap` (transferable to workers, works with `OffscreenCanvas`).
- Adapters are lazily instantiated; `get()` returns synchronously (Req 1.2) but the caller must `await adapter.load()` before `detect()` (which may download weights).
- Unknown id throws `UnknownModelError` with the requested id (Req 1.4).

### 2. KeypointNormalizer (Req 2)

COCO-17 → MediaPipe-33 mapping. Unmapped MediaPipe indices are zero-filled with `confidence: 0`.

```typescript
// keypointMap.ts — COCO index -> MediaPipe index
export const COCO_TO_MEDIAPIPE: ReadonlyArray<[number, number]> = [
  [0, 0],   // nose
  [1, 2],   // left_eye
  [2, 5],   // right_eye
  [3, 7],   // left_ear
  [4, 8],   // right_ear
  [5, 11],  // left_shoulder
  [6, 12],  // right_shoulder
  [7, 13],  // left_elbow
  [8, 14],  // right_elbow
  [9, 15],  // left_wrist
  [10, 16], // right_wrist
  [11, 23], // left_hip
  [12, 24], // right_hip
  [13, 25], // left_knee
  [14, 26], // right_knee
  [15, 27], // left_ankle
  [16, 28], // right_ankle
];

export class KeypointNormalizer {
  /**
   * 17-kp COCO -> 33-kp MediaPipe (zero-fill unmapped).
   * 33-kp -> pass-through unchanged.
   * Any other count -> throws UnsupportedKeypointCountError.
   */
  normalize(keypoints: Keypoint[]): Keypoint[];
}
```

Round-trip property (Req 2.6): for any 17-kp input, `extractCoco(normalize(input))` yields values bitwise-equal to `input` at mapped indices. This is verified with a property-based test using fast-check (already a dev dependency).

### 3. BenchmarkRunner + OKS (Req 3, 11.5)

```typescript
export interface LatencyStats {
  meanFps: number;
  medianMs: number;
  p95Ms: number;
  stdDevMs: number;
}

export interface AccuracyStats {
  meanOks: number;
  recallAt050: number;             // fraction of GT keypoints with OKS >= 0.5
  perKeypointOks: number[];        // length 33
}

export interface BenchmarkResult {
  id: string;                      // uuid
  modelId: string;
  timestampMs: number;
  frameCount: number;
  successCount: number;
  failedCount: number;
  latency: LatencyStats;
  accuracy: AccuracyStats | null;  // null when no ground truth
  perFrameLatencyMs: number[];
  valid: boolean;                  // false if >50% frames failed
  warning?: string;                // e.g. "insufficient successful frames"
}

export interface BenchmarkOptions {
  frames: ImageBitmap[];           // >=100 recommended
  groundTruth?: GroundTruthFrame[];
  warmupFrames?: number;           // default 5
}

export class BenchmarkRunner {
  constructor(private workerPool: PoseWorkerPool) {}
  run(modelId: string, opts: BenchmarkOptions): Promise<BenchmarkResult>;
}
```

**OKS algorithm** (`oks.ts`):

```
OKS = Σ_i [ exp( -d_i² / (2 · s² · k_i²) ) · δ(v_i > 0) ] / Σ_i δ(v_i > 0)

  d_i = euclidean distance between predicted and GT keypoint i (normalized coords)
  s   = object scale = sqrt(bbox_area) of the GT pose
  k_i = per-keypoint COCO constant (falloff)
  v_i = GT visibility flag for keypoint i
```

Per-keypoint constants `k_i` use COCO's standard sigmas for the 17 body keypoints; MediaPipe-only indices reuse the nearest anatomical sigma.

**Failure handling:** failed frames are skipped and counted (Req 3.6). If `failedCount / frameCount > 0.5`, the run is marked `valid: false` (Req 3.7). Warm-up frames are excluded from stats (Req 3.1).

### 4. ResultStore (Req 4, 12)

IndexedDB wrapper. Single database `cv-algo-lab` with versioned object stores.

```typescript
// schema.ts
export const DB_NAME = 'cv-algo-lab';
export const DB_VERSION = 1;

export const STORES = {
  benchmarks: 'benchmarks',        // key: id; indexes: modelId, timestampMs
  annotations: 'annotations',      // key: id; index: sourceVideoId
  recordings: 'recordings',        // key: id; indexes: exerciseName, timestampMs, qualityRating
  models: 'trainedModels',         // key: id; index: exerciseName
} as const;

export class ResultStore {
  open(): Promise<void>;

  // Benchmarks (Req 4)
  saveBenchmark(r: BenchmarkResult): Promise<void>;
  getBenchmark(id: string): Promise<BenchmarkResult | undefined>;
  queryBenchmarks(f: { modelId?: string; from?: number; to?: number }): Promise<BenchmarkResult[]>;
  deleteBenchmark(id: string): Promise<number>;          // returns count removed
  deleteBenchmarksForModel(modelId: string): Promise<number>;

  // Annotations (Req 7)
  saveAnnotation(a: GroundTruthFrame): Promise<void>;
  getAnnotation(id: string): Promise<GroundTruthFrame | undefined>;

  // Recordings (Req 12)
  saveRecording(r: RecordingSession): Promise<void>;
  queryRecordings(f: { exerciseName?: string; from?: number; to?: number; minQuality?: number }): Promise<RecordingSession[]>;

  // Trained models (Req 13)
  saveTrainedModel(m: TrainedModelRecord): Promise<void>;
  listTrainedModels(): Promise<TrainedModelRecord[]>;
}
```

All write/read/delete paths wrap IndexedDB request errors and reject with a typed `StoreError { op, cause }` (Req 4.4) rather than throwing raw DOM exceptions. Round-trip identity (Req 4.3) is preserved by storing plain structured-cloneable objects (no class instances).

### 5. Web Worker Protocol (Req 8)

A generic message protocol shared by pose, classify, and train workers. The main thread never calls model libraries directly.

```typescript
// Main -> Worker
type WorkerRequest =
  | { type: 'init'; modelId: string; modelUrl?: string; backend: RuntimeBackend }
  | { type: 'detect'; frameId: number; frame: ImageBitmap; timestampMs: number }
  | { type: 'dispose' };

// Worker -> Main
type WorkerResponse =
  | { type: 'ready'; modelId: string }                    // Req 8.5 handshake
  | { type: 'result'; frameId: number; keypoints: Keypoint[]; timestampMs: number }
  | { type: 'error'; category: 'load' | 'inference' | 'oom'; message: string };
```

**PoseWorkerPool** manages worker lifecycle:

```typescript
export class PoseWorkerPool {
  /** Spawns worker, sends init, resolves on 'ready'. */
  spawn(modelId: string, backend: RuntimeBackend, modelUrl?: string): Promise<WorkerHandle>;
  /** Terminates a worker; discards in-flight results (Req 8.2). */
  terminate(handle: WorkerHandle): void;
  /** Comparison mode runs two handles concurrently (Req 8.4). */
}
```

- `ImageBitmap` is transferred (not copied) into the worker for zero-copy performance.
- Model switch = `terminate(old)` then `spawn(new)`, targeted at <200ms excluding weight load (Req 8.2). In-flight `result` messages from a terminated worker are dropped by checking a generation counter.
- Worker readiness handshake (`ready`) gates the first `detect` (Req 8.5).

### 6. ComparisonView + Recommender (Req 5, 9)

```typescript
export interface ComparisonFrame {
  frameIndex: number;
  perModel: Map<string /*modelId*/, Keypoint[]>;
}

export class ComparisonView {
  /** Up to 4 models; one panel each (Req 5.1). */
  setModels(modelIds: string[]): void;
  /** Renders synchronized frame across all panels (Req 5.3). */
  showFrame(frame: ComparisonFrame, source: ImageBitmap): void;
  /** Highlights keypoints whose max pairwise distance > 0.05 (Req 5.4). */
}

export interface Recommendation {
  bestOverallModelId: string;
  summary: string;                          // <=300 chars (Req 9.1)
  perRegionNotes: string[];                 // head/upper/torso/lower (Req 9.2)
  useCaseCategory: Record<string, 'real-time coaching' | 'accuracy-critical' | 'balanced'>;
}

export class Recommender {
  /** composite = 0.6*latencyScore + 0.4*accuracyScore (Req 9.4). */
  analyze(results: BenchmarkResult[]): Recommendation;
}
```

Category thresholds (Req 9.6): median latency ≤ 33ms → "real-time coaching"; mean OKS ≥ 0.75 → "accuracy-critical"; else "balanced".

### 7. ExerciseClassifier + FormQualityModel (Req 6, 11)

```typescript
export interface ClassificationResult {
  label: string;          // exercise name or "unknown"
  confidence: number;     // [0,1]
}

export class ExerciseClassifier {
  constructor(opts: { windowSize?: number; stride?: number; threshold?: number });
  /** Buffers frames; emits only when window full. */
  pushFrame(keypoints: Keypoint[]): ClassificationResult | null;
  reset(): void;
}

export interface FormDeviationML {
  errorLabel: string;
  affectedJoints: number[];
  severity: number;        // [0,1]
  suggestion: string;
}

export interface FormAssessment {
  qualityScore: number;    // [0,1]
  deviations: FormDeviationML[];
}

export type FormArchitecture = 'stgcn' | 'transformer';

export class FormQualityModel {
  constructor(opts: { architecture: FormArchitecture; windowSize?: number });
  load(modelUrl: string): Promise<void>;
  /** Requires >=30 frames. Emits deviations with confidence > 0.6 (Req 11.3). */
  assess(window: Keypoint[][]): Promise<FormAssessment>;
}
```

- Window size 30, stride 15 (Req 6.1). Below-threshold predictions → `"unknown"` with actual confidence (Req 6.3).
- Inference runs in `classify.worker.ts`; each pass targeted <100ms (Req 6.4).
- One pre-bundled ST-GCN form model trained on Fitness-AQA (BackSquat, BarbellRow, OverheadPress) ships in `public/models/` (Req 11.6).

### 8. Recorder + Trainer (Req 12, 13)

```typescript
export interface RecordedFrame { timestampMs: number; keypoints: Keypoint[]; }

export interface RecordingLabels {
  exerciseName: string;
  repBoundaries: Array<{ startFrame: number; endFrame: number }>;
  qualityRating: 1 | 2 | 3 | 4 | 5;
  frameErrors?: Record<number /*frameIndex*/, string[]>;
}

export interface RecordingSession {
  id: string;
  metadata: { exerciseName: string; durationMs: number; modelId: string; createdMs: number };
  frames: RecordedFrame[];
  labels: RecordingLabels;
  schemaVersion: 1;
}

export class Recorder {
  start(exerciseName: string, modelId: string): void;
  capture(keypoints: Keypoint[], timestampMs: number): void;  // ~18k frames cap
  stop(): RecordingSession;
  exportJson(session: RecordingSession): Blob;                 // Req 12.3
  importJson(text: string): RecordingSession;                  // Req 12.5
}

export interface TrainingConfig {
  architecture: 'mlp' | 'lstm';
  learningRate: number; batchSize: number; epochs: number;
  windowSize: number; valSplit: number;
}

export interface TrainingProgress { epoch: number; loss: number; valAccuracy: number; }

export interface TrainedModelRecord {
  id: string; exerciseName: string;
  tfjsArtifacts: unknown;      // serialized LayersModel
  onnxBytes: ArrayBuffer;      // exported ONNX
  metadata: { datasetSize: number; finalAccuracy: number; exercises: string[]; createdMs: number };
}

export class Trainer {
  /** Runs in train.worker.ts; streams progress (Req 13.2). */
  train(dataset: RecordingSession[], cfg: TrainingConfig,
        onProgress: (p: TrainingProgress) => void): Promise<TrainedModelRecord>;
}
```

Training uses TFJS in a worker. On completion the model is serialized to both TFJS and ONNX (via `tfjs-to-onnx` conversion path documented in `modelExport.ts`) and stored (Req 13.3). Loaded custom models register into `ModelRegistry` as adapters (Req 13.4).

### 9. PretrainedCatalog (Req 14)

```typescript
export interface CatalogEntry {
  id: string; displayName: string;
  kind: 'repnet-counter' | 'exercise-classifier' | 'form-assessor' | 'dtw-matcher';
  url: string; format: 'onnx' | 'tfjs';
  sizeMb: number; supportedExercises: string[];
  expectedAccuracy: number; windowSize: number;
  keypointFormat: 17 | 33; license: string; version: string;
}

export class PretrainedCatalog {
  list(): CatalogEntry[];
  /** Downloads + registers within ~30s on broadband (Req 14.2). */
  download(id: string, onProgress?: (pct: number) => void): Promise<void>;
  /** Validates input schema vs normalizer output before enabling (Req 14.4). */
  validateSchema(entry: CatalogEntry): boolean;
  /** Sideload user file (Req 14.6). */
  sideload(file: File, metadata: Partial<CatalogEntry>): Promise<void>;
}
```

### 10. AlgorithmLab Orchestrator + LabModePanel (Req 10)

```typescript
export class AlgorithmLab {
  activate(): void;      // disables workout pipeline, shows panel (Req 10.1, 10.2)
  deactivate(): void;    // restores previous model, resumes app <500ms (Req 10.3)
  isActive(): boolean;
  setActiveModel(id: string): Promise<void>;
  startBenchmark(opts: BenchmarkOptions): Promise<BenchmarkResult>;
  getRecommendation(): Recommendation | null;
}
```

The `LabModePanel` binds to the existing `index.html` via a collapsible panel (mirroring the existing "Sensitivity Settings" / "Build a Routine" `<details>` sections). When Lab Mode is active, the panel:
- lists all registered adapters in a dropdown (Req 10.1),
- exposes benchmark start/stop and a results dashboard,
- shows a live FPS/latency indicator updating ≥1×/sec (Req 10.4),
- rejects frames to the workout pipeline while active (Req 10.2),
- renders the Recommender panel when ≥2 model results exist (Req 10.5).

Integration point: `main.ts` currently owns the frame loop. A `labActive` guard is added to `processFrame()` so that when the lab is active, frames route to the lab's worker pool instead of the RepCounter/FormEvaluator path — analogous to how `preTrackingActive` already gates the pipeline.

---

## Data Models

### GroundTruthFrame (Req 7)

```typescript
export interface GroundTruthFrame {
  id: string;
  sourceVideoId: string;
  frameIndex: number;
  imageRef: Blob;                       // captured frame image
  keypoints: Array<{ x: number; y: number }>;   // 33, normalized [0,1]
  visibility: boolean[];                // 33 flags
  createdMs: number;
}
```

Save requires all 33 positions placed or explicitly flagged not-visible (Req 7.8). Round-trip identity preserved via structured clone (Req 7.4).

---

## Error Handling

| Failure | Component | Behavior |
|---|---|---|
| Unknown model id | ModelRegistry | throw `UnknownModelError(id)` (Req 1.4) |
| Model weight download fails | PoseAdapter.load | reject with descriptive error; catalog surfaces to UI |
| Wrong keypoint count | KeypointNormalizer | throw `UnsupportedKeypointCountError` (Req 2.7) |
| >50% frames fail | BenchmarkRunner | mark result `valid:false` (Req 3.7) |
| IndexedDB unavailable / write fail | ResultStore | reject with `StoreError{op,cause}` (Req 4.4) |
| Worker load/inference/oom | Worker | post `{type:'error',category,...}` (Req 8.3) |
| Classifier model load fail | ExerciseClassifier/FormQualityModel | emit error, stop predicting (Req 11) |
| No adapters registered on activate | AlgorithmLab | show error, stay in normal mode (Req 10.6) |
| Schema mismatch on pretrained load | PretrainedCatalog | reject validation, do not enable (Req 14.4) |

Untrusted inputs: downloaded/sideloaded model bytes are treated as data only (never eval'd); they are handed directly to ONNX Runtime / TFJS loaders.

---

## Testing Strategy

- **Unit tests (vitest)** for every component: ModelRegistry lookup/errors, KeypointNormalizer mapping + zero-fill, OKS numeric correctness against hand-computed vectors, ResultStore CRUD with `fake-indexeddb`, Recommender scoring/categorization, ExerciseClassifier windowing/buffering, Recorder export/import schema.
- **Property-based tests (fast-check)** for the normalizer round-trip (Req 2.6): generate arbitrary 17-kp arrays, assert mapped indices survive `normalize` unchanged.
- **Worker protocol tests**: mock `Worker` (as done in existing `WorkoutSession.test.ts`) to verify init handshake, result routing, terminate discards in-flight results.
- **jsdom + canvas mock** for ComparisonView and AnnotationTool rendering (following existing `FramingGuide.test.ts` pattern).
- **Integration test**: benchmark a stub adapter over synthetic frames end-to-end, assert `BenchmarkResult` shape and persistence round-trip.

Model-dependent tests use tiny stub adapters (deterministic keypoints) so CI needs no real model weights or GPU.

---

## Implementation Phases

1. **Foundations** — types, ModelRegistry, KeypointNormalizer (+ property tests), ResultStore (+ fake-indexeddb tests).
2. **Pose adapters + workers** — PoseAdapter contract, MediaPipe/MoveNet/YOLO/RTMPose adapters, PoseWorkerPool, protocol tests.
3. **Benchmarking** — BenchmarkRunner, OKS, Recommender, LabModePanel wiring + `main.ts` guard.
4. **Comparison + annotation** — ComparisonView, AnnotationTool, GroundTruthFrame persistence.
5. **Classification + form** — ExerciseClassifier, FormQualityModel, bundled Fitness-AQA ST-GCN model.
6. **Data + training** — Recorder, Trainer, modelExport, TrainingPanel.
7. **Catalog** — PretrainedCatalog download/sideload/validation/versioning.

---

## Correctness Properties

These invariants hold across all inputs and are the basis for property-based and unit tests.

### Property 1: Normalizer round-trip

For any valid 17-keypoint COCO input `kp`, extracting the mapped MediaPipe indices from `normalize(kp)` yields x/y/z/confidence values bitwise-equal to `kp`. Unmapped indices always have `confidence === 0`.

**Validates: Requirements 2.5, 2.6**

### Property 2: Normalizer output shape

`normalize()` always returns exactly 33 elements whose `index` fields equal their array position `0..32`, or throws for any input length other than 17 or 33.

**Validates: Requirements 2.1, 2.7**

### Property 3: OKS bounds

For any prediction/ground-truth pair, `0 <= OKS <= 1`. Identical poses yield `OKS === 1`. The object scale `s` is always taken from the ground-truth pose.

**Validates: Requirements 3.3**

### Property 4: Benchmark validity

`result.valid === (failedCount / frameCount <= 0.5)` and `successCount + failedCount <= frameCount`. Warm-up frames never appear in `perFrameLatencyMs`.

**Validates: Requirements 3.1, 3.7, 3.8**

### Property 5: Store round-trip

For any record `r`, `get(save(r).id)` deep-equals `r`. Deletion returns the exact count of removed records and a subsequent `get` returns `undefined`.

**Validates: Requirements 4.3, 4.5, 7.4**

### Property 6: Classifier windowing

`pushFrame` returns `null` until at least `windowSize` frames are buffered; every emitted result has `confidence` within `[0,1]` and `label === "unknown"` whenever `confidence < threshold`.

**Validates: Requirements 6.1, 6.3, 6.5**

### Property 7: Worker generation safety

After `terminate(handle)`, no `result` message from that handle's generation is ever delivered to callers.

**Validates: Requirements 8.2**

### Property 8: Recommendation determinism

For a fixed set of `BenchmarkResult`s, `analyze()` returns a stable `bestOverallModelId` computed as `argmax(0.6*latencyScore + 0.4*accuracyScore)`, with ties broken by lexicographic model id.

**Validates: Requirements 9.4**

### Property 9: Concurrency isolation

While `isActive()` is true, zero frames reach the RepCounter/FormEvaluator path; on `deactivate()` the previously active model reference is restored exactly.

**Validates: Requirements 10.2, 10.3**
