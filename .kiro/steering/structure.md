---
inclusion: always
---

# Structure — bounded contexts and the dependency rule

> Authoring note: reconstructed from the spec-bundle summary.

## Six bounded contexts

| Context | Owns | Must not know about |
|---------|------|---------------------|
| **Capture** | camera, frames, pose inference, ring buffer | exercises, cues, UI |
| **Analysis** | signal eval, phase FSM, fault eval (`ingest`) | UI, audio, storage, exercise *names* |
| **Coaching** | cue rationing (one/rep), audio bus, speech | pose internals, storage schema |
| **Session UX** | 4-state machine, framing validator, review | analysis internals, crypto |
| **Calibration & Autoregulation** | ROM percentiles, relative velocity, set termination | UI widgets, audio |
| **Privacy & Sync** | classification types, envelope encryption, scoped erasure | exercise logic, coaching |

## Dependency rule

Domain (Analysis, Calibration, Autoregulation) depends on nothing outward. UX/Coaching/Privacy
depend inward on domain contracts, never the reverse. Spec 02 defines the data contracts that
03, 04, and 05 consume — it must land first.

## Publish / subscribe matrix

| Event | Published by | Consumed by |
|-------|--------------|-------------|
| `LandmarkFrame` | Capture | Analysis |
| `RepCompleted` | Analysis | Coaching (tone), Session UX (count), Autoregulation |
| `FaultDetected` | Analysis | Coaching (rationed cue), Session UX (review evidence) |
| `HoldProgressed` | Analysis | Session UX |
| `AnalysisStalled` | Analysis | Session UX |
| `SetTerminationSuggested` | Autoregulation | Session UX |

## Ubiquitous language

signal, phase, rep, ROM floor/top, relative velocity loss, cue, fault, set, hold, framing,
calibration, evidence clip, asymmetry (p75 divergence). Exercise *names* live only in data.

## Fixture harness

Every exercise spec has a fixture (annotated landmark timeline). `ingest` is replayed over
fixtures for rep-count parity and fault confusion matrices. No fixture → build error.
