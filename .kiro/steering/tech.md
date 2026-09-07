---
inclusion: always
---

# Tech — stack, budgets, hard rules

> Authoring note: reconstructed from the spec-bundle summary. Restore from the archive if
> the canonical wording is available.

## Stack

- TypeScript, strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `noPropertyAccessFromIndexSignature`).
- Vite (app) + Vitest (tests). Pose inference on-device (MediaPipe / MoveNet / ONNX worker).
- Zero required backend. Optional zero-knowledge sync server (Node + SQLite) for account + blob.

## Six hard rules

1. **Exercises are data, not code.** No exercise id, name, or alias appears in `src/**/*.ts`.
   A build scan enforces this (spec 02, task 13).
2. **No absolute velocity units in user-facing output.** The scale factor `k` cancels in
   *relative* loss and nowhere else. Report relative velocity loss (%) only. Exposing m/s
   invites comparison to published load-velocity tables where the number is meaningless.
3. **The device-only boundary is a compile-time type error, not a runtime check.** Sensitive
   data carries a classification type that cannot be passed to a network sink. A runtime guard
   gets bypassed under deadline pressure; a type error does not.
4. **One cue per rep, highest severity wins.** Rationed in the Coaching context, not the engine.
5. **`ingest` is pure and synchronous.** No I/O, no allocation in the per-frame hot path.
6. **Silence when uncertain.** Below landmark-confidence threshold, emit nothing.

## Per-stage latency budgets (per frame, p95)

| Stage | Budget |
|-------|--------|
| Pose inference | model-dependent, measured on Lab surface |
| `ingest` (signal + phase + faults, all 22 specs loaded) | ≤ 3 ms |
| Rep tone from `RepCompleted` | ≤ 120 ms |
| Frame retained beyond `ingest` | never (ring buffer, transferable) |

## Degradation ladder (four steps)

1. Full: pose + phase + faults + velocity + cues.
2. Confidence dip: suppress faults/velocity for affected joints; keep rep counting.
3. Sustained low confidence (> 20% of set): mark set `lowConfidence`, suppress velocity figures.
4. No motion 8 s / stuck phase 30 s: surface "not detecting movement", transition to review.
