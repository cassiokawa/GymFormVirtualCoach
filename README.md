# GymFormVirtualCoach

Client-side computer-vision fitness coach. Pose estimation runs entirely in the
browser — the webcam feed never leaves your machine. The app counts reps,
evaluates exercise form against per-exercise angle thresholds, and gates
tracking behind a framing -> positioning -> lock pre-tracking pipeline.

It also ships a **CV Algorithm Lab**: an in-browser research mode for swapping
pose-estimation backends, benchmarking them (FPS, latency, OKS accuracy),
comparing them side by side, and recording/annotating data.

## Getting started

```bash
npm install
npm run dev
```

Then open the URL Vite prints. Grant camera access, pick an exercise, and click
**Start**. Hard-refresh (Cmd/Ctrl+Shift+R) if a previously-open tab shows a
stale page.

### Scripts

| Command                | What it does                                     |
| ---------------------- | ------------------------------------------------ |
| `npm run dev`          | Vite dev server                                  |
| `npm test`             | Run the vitest suite once                        |
| `npm run test:watch`   | Vitest in watch mode                             |
| `npm run build`        | Type-check the project (`tsc --noEmit`)          |
| `npm run fetch-models` | Download optional ONNX model weights (see below) |

## CV Algorithm Lab

Click the Lab Mode button in the controls. Lab Mode takes over the camera and
pauses the live workout pipeline so inference does not contend. In the Lab you
can:

- Select a pose model and Benchmark it — the app captures ~120 frames from the
  webcam and reports mean FPS, median / P95 latency, and (when ground-truth
  annotations exist) OKS accuracy.
- Compare models and read a plain-language recommendation.
- Record keypoint sequences, annotate ground-truth frames, and train
  lightweight classifiers in-browser.

Click Exit Lab to return to normal operation.

### Pose models

| Model                    | Backend          | Weights                  |
| ------------------------ | ---------------- | ------------------------ |
| MediaPipe BlazePose (33) | MediaPipe WASM   | streamed from Google CDN |
| MoveNet Lightning (17)   | TensorFlow.js    | streamed from Google CDN |
| MoveNet Thunder (17)     | TensorFlow.js    | streamed from Google CDN |
| YOLOv8-Pose (17)         | ONNX Runtime Web | local file required      |
| RTMPose-M (17)           | ONNX Runtime Web | local file required      |

MediaPipe and MoveNet work out of the box. YOLOv8-Pose and RTMPose need local
ONNX weights in `public/models/` before they can be benchmarked.

### Getting the ONNX weights

Run the fetch helper (reads URLs from env vars or `scripts/models.config.json`):

```bash
YOLO_POSE_URL=https://.../yolov8n-pose.onnx RTMPOSE_URL=https://.../rtmpose-m.onnx npm run fetch-models
```

Or export them yourself and drop the files in `public/models/`. Full export
instructions, expected input sizes, and the exact output-tensor contracts each
decoder assumes are documented in `public/models/README.md`.

Weight files are git-ignored (large binaries).

## Architecture notes

- **Pose detection** streams keypoints; adapters normalize 17-keypoint COCO
  output to the internal 33-keypoint MediaPipe schema so downstream form
  evaluation is model-agnostic.
- **All inference runs in Web Workers**; heavy model runtimes are pulled in via
  dynamic `import()` only when a model is actually selected.
- **Persistence** (benchmark results, recordings, annotations, trained models)
  lives in IndexedDB.
- `vite.config.ts` aliases the unused, broken `@mediapipe/pose` transitive
  dependency to a shim so the worker bundle builds. Tests use a separate
  `vitest.config.ts`.

## Known limitations

- The exercise classifier, form-quality model, and in-browser trainer currently
  use deterministic heuristic stubs, not trained weights.
- RTMPose decoding assumes a square 256x256 export; a 192x256 export needs
  `INPUT_SIZE` adjusted in `src/lab/registry/adapters/RtmPoseAdapter.ts`.
