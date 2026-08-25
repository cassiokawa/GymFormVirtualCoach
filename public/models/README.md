# Model weights

The CV Algorithm Lab's ONNX-backed pose adapters load their weights from this
directory. Files here are **not committed** (see `.gitignore`) because they are
large binaries. Drop the exported files here, or run `npm run fetch-models`.

Vite serves `public/` at the site root, so a file at
`public/models/yolov8n-pose.onnx` is fetched by the app as `/models/yolov8n-pose.onnx`.

## Expected files

| Adapter (model id)     | File this repo expects              | Input | Output contract the decoder assumes |
| ---------------------- | ----------------------------------- | ----- | ----------------------------------- |
| `yolov8-pose`          | `models/yolov8n-pose.onnx`          | 640×640 RGB, letterboxed, pixels /255 | Single tensor `[1, 56, N]` = `[cx, cy, w, h, score, 17×(x, y, conf)]`, coords in input pixels |
| `rtmpose`              | `models/rtmpose-m.onnx`             | 256×256 RGB, letterboxed, pixels /255 | Two SimCC tensors `[1, 17, Wx]` and `[1, 17, Wy]`; split ratio 2.0 |

MediaPipe BlazePose and MoveNet (Lightning/Thunder) do **not** use this
directory — they stream their own weights from Google's CDN at runtime.

## Producing the files

### YOLOv8-Pose (Ultralytics, AGPL-3.0)

```bash
pip install ultralytics
# Export the nano pose model to ONNX at 640×640 (opset 12 works with ORT Web).
yolo export model=yolov8n-pose.pt format=onnx imgsz=640 opset=12
# Move the result here:
mv yolov8n-pose.onnx public/models/yolov8n-pose.onnx
```

### RTMPose-M (OpenMMLab / MMPose, Apache-2.0)

Export a **square 256×256** variant so it matches this repo's `INPUT_SIZE`
(the decoder's letterbox math handles rectangular input, but the ONNX tensor
shape must match the model). Using MMDeploy:

```bash
# See https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose
# Export with a 256×256 input and SimCC head, then:
mv end2end.onnx public/models/rtmpose-m.onnx
```

If your RTMPose export uses the common **192×256** input instead, change
`INPUT_SIZE` in `src/lab/registry/adapters/RtmPoseAdapter.ts` to match and adjust
the preprocessing tensor dims accordingly.

## Verifying

1. Place the file(s) here.
2. `npm run dev`, open the app, click **🔬 Lab Mode**.
3. Select `YOLOv8-Pose` or `RTMPose-M` and click **Benchmark**.
4. A missing/incompatible file surfaces a "failed to load" status in the panel.
