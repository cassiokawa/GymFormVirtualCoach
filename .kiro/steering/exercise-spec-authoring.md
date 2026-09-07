---
inclusion: fileMatch
fileMatchPattern: "src/domain/exercises/**/*.json"
---

# Exercise spec authoring

Loads only when editing an exercise definition JSON. See spec 02 (`exercise-spec-engine`)
for the full document, expression grammar, and interpreter.

## Rules an author must follow

- The document is validated by `exercise-spec.schema.json` (structure) **and** a semantic
  validator (below). Both must pass or the build fails.
- Every landmark used in any expression MUST appear in `requiredLandmarks`.
- Every phase named in a transition or fault MUST exist in `phases.states`.
- For `mode: "reps"`, **exactly one** transition carries `emits: "RepCompleted"`.
- The phase graph MUST be strongly connected from `initial`.
- Every `cue` is ≤ 4 words and passes the banned-word list in `coaching-safety.md`.
- `hysteresisPct` ≥ 0.05 and `minPhaseDurationMs` ≥ 250.
- A fixture MUST exist for the spec `id`.

## Reference resolution

- Unprefixed joints (`hip`, `knee`, `ankle`) resolve to the **bilateral midpoint**.
- Side-specific references use explicit `left_` / `right_` names.
- Every expression returns `number | UNAVAILABLE`; `UNAVAILABLE` propagates and suppresses
  the dependent fault/transition. Silence when uncertain.

## Tooling

- `npx formcoach-spec validate <file>` — schema + semantic checks.
- `npx formcoach-spec replay <file> --fixture <id>` — expected vs actual rep timeline and a
  per-fault confusion matrix.

## Constraints you cannot express here

- No absolute velocity units. `velocity` config yields relative loss only.
- No exercise id/name/alias may leak into `src/**/*.ts` — this file governs JSON only.
