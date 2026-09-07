---
inclusion: always
---

# Product — Form Coach

## What this is

A camera-based movement coach used **from 3 metres away** while the user is under load.
It counts reps, tracks movement phase, flags form faults as audio cues, and reviews the set
afterward. It runs entirely on the user's device.

> Authoring note: this file was reconstructed from the spec-bundle summary. The canonical
> wording lives in the original bundle; adjust to match if the archive is restored.

## The one constraint that shapes everything

**The user is 3 metres from the screen and cannot touch it mid-set.**

Every UX decision derives from this. Text that is readable at desk distance is invisible at
3 m. Feedback that requires looking at the screen breaks position. Controls that require a tap
mid-set do not exist. This is why feedback is audio-first and why the Coach surface collapses
to rep count + phase + one cue line while working.

## Target loop

1. Pick an exercise (grid, filterable, recents surfaced).
2. Frame the camera; the system validates angle and landmark coverage before allowing start.
3. Lift. Reps are counted by tone; at most one spoken cue per rep; a haptic pulse where available.
4. Review the set: reps, time under tension, per-rep velocity, flagged reps with evidence.

## Non-goals (the cut list)

- No social features, no leaderboards, no sharing.
- No absolute body-composition numbers (body-fat %, circumference). Ratios with confidence bands only.
- No grades, scores, stars, streaks, or progress bars — anywhere.
- No medical, diagnostic, or rehabilitation claims (see `coaching-safety.md`).
- No cloud requirement. Sync is optional and zero-knowledge.
- No absolute bar-velocity units exposed to the user (see `tech.md`, hard rules).
- No developer telemetry (FPS, latency, model names) on the Coach surface.

## Success metrics

- Rep-count accuracy against human-annotated fixtures (no regressions gate merges).
- Rep tone latency ≤ 120 ms p95 from `RepCompleted`.
- Legibility: rep count readable at 3 m (≥ 25% viewport height while working).
- Adding a new exercise requires **no TypeScript change** — data only.
