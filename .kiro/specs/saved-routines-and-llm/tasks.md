# Implementation Plan: Saved Routines & LLM Integration

## Overview

Implements three capabilities: (1) OllamaClient HTTP transport with health checks, (2) RoutineStore IndexedDB persistence with SavedRoutinesPanel UI, (3) SessionDetailView per-set/per-rep drill-down, and (4) wiring everything into the existing demo. TypeScript throughout, using vitest + fast-check for testing.

## Tasks

- [ ] 1. Create OllamaClient HTTP transport
  - [ ] 1.1 Implement OllamaClient class with generate, health check, and config
    - Create `src/ollama/OllamaClient.ts`
    - Implement `OllamaConfig` interface with `baseUrl`, `model`, `timeoutMs`, `healthCheckIntervalMs` defaults
    - Implement `generate(prompt)` — POST to `/api/generate` with `{ model, prompt, stream: false }`, parse JSON response
    - Implement `checkHealth()` — GET `/api/tags`, return boolean
    - Implement `startHealthChecks(onStatusChange)` and `stopHealthChecks()` with configurable interval
    - Implement `isAvailable()`, `getConfig()`, `setModel(model)`
    - Use AbortController for timeout enforcement
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 9.1, 9.4_

  - [ ]* 1.2 Write unit tests for OllamaClient
    - Test generate success path with mocked fetch
    - Test timeout enforcement aborts within configured timeoutMs
    - Test health check sets availability flag correctly
    - Test error handling for non-200 responses
    - _Requirements: 5.1, 5.3, 5.4, 5.5_

  - [ ]* 1.3 Write property test for timeout enforcement
    - **Property 2: OllamaClient timeout enforcement**
    - **Validates: Requirements 5.4, 5.5**

  - [ ]* 1.4 Write property test for health check availability
    - **Property 3: Health check determines availability**
    - **Validates: Requirements 9.1, 9.2, 9.3**

- [ ] 2. Implement RoutineStore with IndexedDB CRUD
  - [ ] 2.1 Implement RoutineStore class
    - Create `src/routineStore/RoutineStore.ts`
    - Define `SavedRoutine` interface with `id`, `name`, `exercises`, `createdAt`, `updatedAt`
    - Implement `open()` — create/upgrade `saved_routines` object store with `name_idx` and `updated_at_idx` indexes
    - Implement `save(routine)` — validate non-empty exercises, assign UUID, timestamp, put in store; overwrite if name exists
    - Implement `getAll()` — retrieve all routines sorted by `updatedAt` descending
    - Implement `getById(id)` — single routine lookup
    - Implement `delete(id)` — remove from store
    - Implement `update(id, data)` — partial update with new `updatedAt`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.3_

  - [ ]* 2.2 Write unit tests for RoutineStore (fake-indexeddb)
    - Test save/retrieve round-trip
    - Test save with zero exercises rejects
    - Test save with duplicate name overwrites
    - Test delete removes from store
    - Test getAll returns sorted by updatedAt descending
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.3_

  - [ ]* 2.3 Write property test for routine persistence round-trip
    - **Property 1: Routine persistence round-trip**
    - **Validates: Requirements 1.1, 2.1**

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Update LlmGateway to use OllamaClient
  - [ ] 4.1 Wire OllamaClient into LlmGateway sendToLlm
    - Replace the stub `sendToLlm` in `src/llmGateway/LlmGateway.ts` with OllamaClient call
    - Import OllamaClient, check `isAvailable()` before calling `generate()`
    - Throw descriptive error when Ollama is offline
    - Expose `configureModel(model: string)` on LlmGateway delegating to OllamaClient
    - Add `initOllama()` method to start health checks and bind status callback
    - _Requirements: 5.1, 5.6, 6.3, 9.2, 9.3_

  - [ ]* 4.2 Write unit tests for updated LlmGateway
    - Test that request succeeds when OllamaClient is available
    - Test that request throws when OllamaClient is unavailable
    - Test phase enforcement still works with real transport
    - _Requirements: 5.1, 5.3, 6.3_

- [ ] 5. Implement CoachingAdvisor LLM fallback
  - [ ] 5.1 Update CoachingAdvisor with LLM-first, rule-based fallback pattern
    - Modify `src/coachingAdvisor/CoachingAdvisor.ts`
    - On session complete: build structured prompt from session summary (rep counts, TUT deltas, deviation events)
    - Send prompt via LlmGateway; parse response into CoachingRecommendation objects
    - On LLM failure or unavailability: fall back to existing rule-based engine, flag AI offline
    - _Requirements: 6.1, 6.2, 6.3_

  - [ ] 5.2 Update RoutineGenerator with LLM suggestions and fallback
    - Modify `src/routineGenerator/RoutineGenerator.ts`
    - Build prompt with current routine definition + 10 most recent session summaries
    - Parse LLM response into ExerciseConfig modification suggestions
    - Fall back to volume-reduction heuristic when LLM unavailable
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ]* 5.3 Write property test for LLM fallback guarantee
    - **Property 4: LLM fallback guarantee**
    - **Validates: Requirements 6.3, 7.4, 8.5**

- [ ] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Implement SessionDetailView
  - [ ] 7.1 Create SessionDetailView component
    - Create `src/exerciseLog/SessionDetailView.ts`
    - Implement `show(session)` and `hide()` methods
    - Implement `renderSetBreakdown(session)` — per-set rows with exercise name, rep counts by category (correct/flawed/dangerous_aborted), total TUT, deviation event count
    - Implement `renderRepDetail(set)` — per-rep detail with rep number, angle values, category, deviation events
    - Implement `renderDeviationTimeline(session)` — chronological form warning/critical events
    - Implement `renderFormInsights(tips)` — display LLM or rule-based tips
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 8.3, 8.4, 8.5_

  - [ ] 7.2 Add recurring deviation analysis to SessionDetailView
    - Analyse deviation events across 10 most recent sessions
    - Identify recurring patterns (same joint, same severity, 3+ sessions)
    - When LLM available: send prompt for targeted form tips
    - When LLM unavailable or no patterns: display appropriate fallback message
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ]* 7.3 Write unit tests for SessionDetailView (jsdom)
    - Test set breakdown renders correct number of set rows
    - Test rep detail renders correct per-rep information
    - Test deviation timeline orders events chronologically
    - _Requirements: 4.2, 4.3, 4.4_

  - [ ]* 7.4 Write property test for session detail completeness
    - **Property 5: Session detail completeness**
    - **Validates: Requirements 4.2, 4.3**

- [ ] 8. Implement SavedRoutinesPanel UI
  - [ ] 8.1 Create SavedRoutinesPanel component
    - Create `src/routineStore/SavedRoutinesPanel.ts`
    - Accept `container`, `routineStore`, `onLoadRoutine`, `onStartRoutine` options
    - Implement `mount()` — render panel with routine list, action buttons
    - Implement `refresh()` — re-fetch and re-render routine list from RoutineStore
    - Render each routine with "Load", "Start", "Delete", and "Suggest" buttons
    - Wire "Delete" to RoutineStore.delete + refresh
    - Wire "Load" to onLoadRoutine callback (populate routine builder)
    - Wire "Start" to onStartRoutine callback (start workout)
    - Wire "Suggest" to RoutineGenerator for LLM modification suggestions
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 7.1_

  - [ ] 8.2 Add "Save Routine" button to routine builder UI
    - Add save button + name input to existing routine builder section
    - On click: validate name non-empty, validate exercises non-empty, call RoutineStore.save
    - Show inline error for empty name or zero exercises
    - Refresh SavedRoutinesPanel after save
    - _Requirements: 1.1, 1.2, 1.3_

- [ ] 9. Add AI Status Indicator
  - [ ] 9.1 Create AI status indicator badge
    - Create `src/ollama/AiStatusIndicator.ts`
    - Render a DOM badge showing "🟢 AI Connected" or "🔴 AI Offline"
    - Accept a mount container and expose `update(available: boolean)` method
    - Wire to OllamaClient health check status callback
    - _Requirements: 9.1, 9.2, 9.3_

- [ ] 10. Integrate into demo main.ts
  - [ ] 10.1 Wire all new components into demo/main.ts
    - Import and initialize OllamaClient with default config, start health checks
    - Import and mount AiStatusIndicator in the header area
    - Import and initialize RoutineStore, open database
    - Import and mount SavedRoutinesPanel with callbacks to routineMode
    - Wire "Save Routine" button to persist current routineMode entries
    - Update stop handler to associate sessions with saved routine ID (Requirement 3.2)
    - Add "Details" button to ExerciseLogPanel session rows, wire to SessionDetailView
    - Initialize LlmGateway with OllamaClient
    - _Requirements: 2.2, 3.1, 3.2, 4.1, 9.1, 9.2, 9.3_

  - [ ] 10.2 Add HTML structure for new UI components
    - Add saved-routines panel container to `index.html`
    - Add AI status indicator container to header
    - Add session-detail modal/panel container
    - Add save-routine name input and button to routine builder section
    - _Requirements: 2.1, 4.1, 9.2, 9.3_

- [ ] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The project uses vitest for testing and fast-check for property-based tests
- fake-indexeddb should be used for RoutineStore unit tests

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "2.2", "2.3"] },
    { "id": 2, "tasks": ["4.1", "7.1"] },
    { "id": 3, "tasks": ["4.2", "5.1", "5.2", "7.2"] },
    { "id": 4, "tasks": ["5.3", "7.3", "7.4", "8.1"] },
    { "id": 5, "tasks": ["8.2", "9.1"] },
    { "id": 6, "tasks": ["10.1", "10.2"] }
  ]
}
```
