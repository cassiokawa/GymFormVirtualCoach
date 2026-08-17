# Design Document: CV Fitness & Form Assistant

## Overview

The CV Fitness & Form Assistant is structured around three sequential phases — pre-workout, workout execution, and post-workout — each with distinct responsibilities and latency constraints. The real-time execution phase runs entirely client-side with no network dependency. LLM services are confined to the pre-workout and post-workout phases.

```
┌─────────────────────────────────────────────────────────────────┐
│                        APPLICATION                              │
│                                                                 │
│  ┌──────────────┐  ┌──────────────────────┐  ┌──────────────┐  │
│  │  PRE-WORKOUT │  │  WORKOUT EXECUTION   │  │ POST-WORKOUT │  │
│  │              │  │   (local, <60ms)     │  │              │  │
│  │ Routine_     │  │ Pose_Detector        │  │ Analytics_   │  │
│  │ Generator    │  │ Form_Evaluator       │  │ Engine       │  │
│  │ (LLM)        │  │ Rep_Counter          │  │ Coaching_    │  │
│  │ Form_Guide   │  │ Safety_Monitor       │  │ Advisor      │  │
│  │              │  │ Alert_System         │  │ (LLM)        │  │
│  │              │  │ Session_Logger       │  │              │  │
│  └──────┬───────┘  └──────────┬───────────┘  └──────┬───────┘  │
│         │                     │                      │          │
│         └─────────────────────┴──────────────────────┘          │
│                               │                                 │
│                           Storage                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Threading Architecture

The Pose_Detector runs inside a **WebAssembly Web Worker** to avoid blocking the main UI thread. All other client-side components run on the main thread, communicating with the worker via message passing.

```
Main Thread                          Web Worker (WASM)
──────────────────────────────       ──────────────────────────────
UI / React rendering                 MediaPipe Pose (WASM)
Form_Evaluator                       Camera frame capture
Rep_Counter                          Keypoint extraction
Safety_Monitor          ◄──────────  postMessage({ keypoints })
Alert_System
Session_Logger
Storage (IndexedDB)
```

Message format from worker to main thread:

```typescript
interface KeypointMessage {
  type: 'keypoints';
  frameId: number;
  timestampMs: number;
  keypoints: Keypoint[];  // 33 landmarks
}

interface ErrorMessage {
  type: 'error';
  code: 'INIT_FAILED' | 'CAMERA_LOST' | 'DETECTION_FAILED';
  message: string;
}
```

---

## Data Models

### Keypoint
```typescript
interface Keypoint {
  index: number;          // 0–32 (MediaPipe landmark index)
  x: number;              // normalized [0, 1]
  y: number;              // normalized [0, 1]
  z: number;              // depth, normalized
  confidence: number;     // visibility score [0, 1]
}

// A keypoint is "valid" when:
// confidence >= 0.5 AND x/y within [0, 1] bounds
```

### JointAngle
```typescript
interface JointAngle {
  jointName: string;      // e.g. "left_knee", "right_hip"
  degrees: number;        // [0, 180]
  available: boolean;     // false if fewer than 3 valid keypoints
  frameId: number;
  timestampMs: number;
}
```

### Rep
```typescript
interface Rep {
  repNumber: number;
  tutMs: number;          // Time-Under-Tension in milliseconds
  category: 'correct' | 'flawed' | 'dangerous_aborted';
  deviationEvents: DeviationEvent[];
}
```

### DeviationEvent
```typescript
interface DeviationEvent {
  jointName: string;
  angleValue: number;
  severity: 'warning' | 'critical';
  timestampMs: number;
  repNumber: number;
}
```

### Set
```typescript
interface SetRecord {
  setNumber: number;
  exerciseName: string;
  reps: Rep[];
  actualTutMs: number;    // sum of rep TUTs
  expectedTutMs: number;  // from pre-workout routine
  tutDeltaMs: number;     // actual - expected
}
```

### Session
```typescript
interface Session {
  id: string;             // uuid
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  routineId: string;
  sets: SetRecord[];
}
```

### SessionSummary
```typescript
interface SessionSummary {
  sessionId: string;
  totalCorrectReps: number;
  totalFlawedReps: number;
  totalDangerousReps: number;
  setBreakdowns: Array<{
    exerciseName: string;
    actualTutMs: number;
    expectedTutMs: number;
    tutDeltaMs: number;
    correctReps: number;
    flawedReps: number;
    dangerousReps: number;
  }>;
  allDeviationEvents: DeviationEvent[];
}
```

---

## Storage Schema

### `workout_sessions` table
| Column | Type | Description |
|---|---|---|
| id | TEXT PRIMARY KEY | UUID |
| started_at | TEXT | ISO 8601 timestamp |
| ended_at | TEXT | ISO 8601 timestamp |
| duration_ms | INTEGER | Session duration |
| routine_id | TEXT | FK to routines |

### `session_exercise_logs` table
| Column | Type | Description |
|---|---|---|
| id | TEXT PRIMARY KEY | UUID |
| session_id | TEXT | FK to workout_sessions |
| exercise_name | TEXT | Exercise identifier |
| set_number | INTEGER | Set index within session |
| correct_reps | INTEGER | Count of correct reps |
| flawed_reps | INTEGER | Count of flawed reps |
| dangerous_reps | INTEGER | Count of dangerous/aborted reps |
| actual_tut_ms | INTEGER | Actual time under tension |
| expected_tut_ms | INTEGER | Expected TUT from routine |
| deviation_events | TEXT | JSON-serialized DeviationEvent[] |

Storage is implemented via **IndexedDB** in the browser or **SQLite** in a native runtime. All writes are async; the Storage layer retains in-memory telemetry if a write fails and exposes a retry mechanism.

---

## FSM Design (Rep Counter)

Each exercise has a configuration object defining which joints to evaluate and the angle thresholds for each state transition.

```
            ┌─────────────────────────────────────┐
            │                                     │
            ▼                                     │
         START ──── angles meet inflection ──► INFLECTION
                         threshold
                                                  │
                                         angles meet complete
                                              threshold
                                                  │
                                                  ▼
                                             COMPLETE
                                                  │
                                         angles return to
                                           start threshold
                                                  │
                                                  ▼
                                            START (+1 rep)
```

### ExerciseFSMConfig
```typescript
interface ExerciseFSMConfig {
  exerciseName: string;
  joints: string[];                   // e.g. ["left_knee", "right_knee"]
  startThreshold: AngleThreshold;     // angle range for START state
  inflectionThreshold: AngleThreshold;
  completeThreshold: AngleThreshold;
  warningThreshold: AngleThreshold;   // form evaluation
  criticalThreshold: AngleThreshold;  // safety monitoring
}

interface AngleThreshold {
  min: number;   // degrees
  max: number;   // degrees
}
```

**State transition rules:**
- `START → INFLECTION`: all tracked joint angles enter the inflection range
- `INFLECTION → COMPLETE`: all tracked joint angles enter the complete range
- `COMPLETE → START`: all tracked joint angles return to the start range → rep count +1, TUT recorded
- If any required angle is unavailable, hold current FSM state
- TUT is measured from when FSM first enters START to when it transitions COMPLETE → START

---

## Joint Angle Calculation

The interior angle at the **middle keypoint** B, formed by vectors BA and BC:

```
θ = arccos( (BA · BC) / (|BA| × |BC|) )
```

Where:
- `A`, `B`, `C` are three Keypoints (A = proximal, B = joint center, C = distal)
- `BA = A - B`, `BC = C - B`
- Result is clamped to `[0°, 180°]`
- If `|BA|` or `|BC|` is zero, or fewer than 3 valid keypoints exist, the angle is marked `available: false`

---

## Form Evaluation Pipeline

```
Keypoint Frame
     │
     ▼
Form_Evaluator.evaluateFrame(keypoints, exerciseConfig)
     │
     ├── calculate all JointAngles for active exercise
     │
     ├── for each JointAngle:
     │     ├── within safe range?  → no action
     │     ├── outside warning threshold? → log DeviationEvent (once at onset)
     │     └── outside critical threshold? → notify Safety_Monitor (≤10ms)
     │
     └── complete within 10ms of receiving keypoints
```

**Dual-threshold classification per joint:**
- `warningThreshold`: angle outside acceptable range but not immediately dangerous
- `criticalThreshold`: angle indicating potential injury risk

Both thresholds are defined per exercise in `ExerciseFSMConfig`.

---

## Alert Pipeline

```
Form_Evaluator
     │  critical deviation (≤10ms)
     ▼
Safety_Monitor
     │  triggers (≤10ms)
     ▼
Alert_System
     ├── Audio: play warning tone via Web Audio API
     └── Visual: render overlay banner on video feed

     WHILE critical deviation persists (≥2 consecutive frames):
       └── maintain visual overlay

     WHEN angles return to safe range:
       └── dismiss audio + visual overlay

     WHEN critical deviation during Rep:
       └── Session_Logger marks Rep as 'dangerous_aborted'
```

**Specific detections:**
- **Valgus_Cave**: medial knee Joint_Angle < per-exercise threshold (knee caving inward)
- **Excessive lumbar extension**: lumbar spine Joint_Angle > per-exercise threshold

---

## LLM Boundary Enforcement

A `LlmGateway` singleton enforces which components can issue LLM requests and when.

```typescript
type AppPhase = 'pre_workout' | 'session_active' | 'post_workout';

class LlmGateway {
  private currentPhase: AppPhase;

  async request(caller: string, payload: LlmPayload): Promise<LlmResponse> {
    if (this.currentPhase === 'session_active') {
      this.logPolicyViolation(caller, 'attempted LLM call during active session');
      throw new PolicyViolationError(caller);
    }
    if (this.currentPhase === 'pre_workout' && caller !== 'Routine_Generator') {
      this.logPolicyViolation(caller, 'unauthorized pre-workout LLM call');
      throw new PolicyViolationError(caller);
    }
    if (this.currentPhase === 'post_workout' && caller !== 'Coaching_Advisor') {
      this.logPolicyViolation(caller, 'unauthorized post-workout LLM call');
      throw new PolicyViolationError(caller);
    }
    return this.sendToLlm(payload);
  }
}
```

Phase transitions:
- `pre_workout → session_active`: when user starts first Set
- `session_active → post_workout`: when user ends Session
- `post_workout → pre_workout`: when next session is initiated

---

## Component Responsibilities Summary

| Component | Phase | Runs On | Latency Budget |
|---|---|---|---|
| Pose_Detector | Execution | Web Worker (WASM) | ≤33ms/frame |
| Form_Evaluator | Execution | Main thread | ≤10ms/frame |
| Rep_Counter | Execution | Main thread | ≤5ms/transition |
| Safety_Monitor | Execution | Main thread | ≤10ms/notification |
| Alert_System | Execution | Main thread | immediate |
| Session_Logger | Execution | Main thread | async |
| Form_Guide | Pre-workout | Main thread | N/A |
| Routine_Generator | Pre-workout | Main thread + LLM | ≤5s total |
| Analytics_Engine | Post-workout | Main thread | N/A |
| Coaching_Advisor | Post-workout | Main thread + LLM | async |
| Storage | All | Main thread (IndexedDB) | ≤2s write |

**End-to-end latency budget (frame → alert or rep count):**

```
Pose_Detector (≤33ms)
  + Form_Evaluator (≤10ms)
  + Safety_Monitor → Alert_System (≤10ms)  OR  Rep_Counter (≤5ms)
= ≤53ms worst case (alert path) / ≤48ms (rep path)
Target: ≤60ms at 95th percentile over 10s rolling window
```

---

## Pre-Workout Routine Generation Flow

```
User requests routine
     │
     ▼
Routine_Generator
  ├── query Storage: 10 most recent Sessions
  ├── extract: form errors, fatigue indicators, target muscle groups
  ├── build LLM prompt with history summary
  ├── call LlmGateway (caller: 'Routine_Generator')
  └── return structured Routine within 5s:
        {
          exercises: [
            {
              name, sequence, targetReps (1–30),
              expectedTutMs (10,000–120,000),
              primaryMuscles, secondaryMuscles
            }
          ]
        }

IF form errors in ≥2 of last 10 Sessions for a muscle group:
  └── reduce volume 20–40% for that muscle group
IF no prior Sessions:
  └── generate baseline: ≥3 exercises (chest, back, legs)
```

---

## Post-Workout Analytics Flow

```
Session ends
     │
     ▼
Analytics_Engine
  ├── categorize each Rep: correct / flawed / dangerous_aborted
  ├── sum Rep TUTs per Set → actual TUT
  ├── compute TUT delta (actual - expected)
  ├── assemble SessionSummary
  ├── pass summary → Coaching_Advisor (async, LLM)
  └── pass summary → Storage.persist()

Coaching_Advisor
  ├── call LlmGateway (caller: 'Coaching_Advisor')
  ├── produce ≥1 recommendation per deviation event / rep category
  ├── pre-populate next session params (weight, sets, reps)
  │     ├── UP if performance targets met
  │     └── HOLD if targets not met
  └── return coaching advice + next session params to UI

IF LLM unavailable:
  └── display raw SessionSummary + "AI coaching unavailable" message
```

---

## Exercise Configuration Example (Squat)

```typescript
const squatConfig: ExerciseFSMConfig = {
  exerciseName: 'barbell_squat',
  joints: ['left_knee', 'right_knee', 'left_hip', 'right_hip'],
  startThreshold:      { min: 160, max: 180 },  // standing upright
  inflectionThreshold: { min: 90,  max: 130 },  // mid-descent
  completeThreshold:   { min: 60,  max: 95  },  // bottom position
  warningThreshold:    { min: 0,   max: 55  },  // too deep / form break
  criticalThreshold: {                           // Valgus_Cave
    kneeMedialAngle: { min: 0, max: 160 }        // < 160° = knee caving
  }
};
```
