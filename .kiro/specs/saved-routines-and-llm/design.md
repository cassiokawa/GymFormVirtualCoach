# Design Document: Saved Routines & LLM Integration

## Overview

This feature adds three major capabilities: (1) persisting named routines to IndexedDB for reuse, (2) detailed per-rep session log drill-downs, and (3) replacing the LLM stub with a real Ollama HTTP client for personalized coaching.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        UI LAYER                               │
│  SavedRoutinesPanel │ SessionDetailView │ AI Status Indicator │
└───────────┬─────────────────┬──────────────────┬─────────────┘
            │                 │                  │
┌───────────▼─────────────────▼──────────────────▼─────────────┐
│                      SERVICE LAYER                             │
│  RoutineStore   │  ExerciseLogPanel  │  CoachingAdvisor       │
│                 │  (updated)         │  (updated)             │
└───────────┬─────────────────┬──────────────────┬─────────────┘
            │                 │                  │
┌───────────▼─────────────────▼──────────────────▼─────────────┐
│                    INFRASTRUCTURE                              │
│  Storage (IndexedDB)  │  LlmGateway → OllamaClient           │
│  + saved_routines     │  (http://localhost:11434)             │
└──────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### 1. OllamaClient (`src/ollama/OllamaClient.ts`)

HTTP transport to the local Ollama REST API.

```typescript
export interface OllamaConfig {
  baseUrl: string;        // default: 'http://localhost:11434'
  model: string;          // default: 'qwen2.5:7b'
  timeoutMs: number;      // default: 30000
  healthCheckIntervalMs: number; // default: 60000
}

export class OllamaClient {
  private config: OllamaConfig;
  private available = false;
  private healthInterval: number | null = null;

  constructor(config?: Partial<OllamaConfig>);

  /** Send a prompt and get the full text response. */
  async generate(prompt: string): Promise<string>;

  /** Check connectivity by calling /api/tags. */
  async checkHealth(): Promise<boolean>;

  /** Start periodic health checks. */
  startHealthChecks(onStatusChange: (available: boolean) => void): void;

  /** Stop periodic health checks. */
  stopHealthChecks(): void;

  isAvailable(): boolean;
  getConfig(): OllamaConfig;
  setModel(model: string): void;
}
```

**Generate flow:**
1. POST to `{baseUrl}/api/generate` with `{ model, prompt, stream: false }`
2. Parse JSON response → extract `response` field
3. On timeout or network error → throw descriptive error

### 2. RoutineStore (`src/routineStore/RoutineStore.ts`)

CRUD operations for saved routines in IndexedDB.

```typescript
export interface SavedRoutine {
  id: string;
  name: string;
  exercises: Array<{ exerciseName: string; targetReps: number }>;
  createdAt: Date;
  updatedAt: Date;
}

export class RoutineStore {
  private db: IDBDatabase | null = null;

  async open(): Promise<void>;  // Creates saved_routines object store
  async save(routine: Omit<SavedRoutine, 'id' | 'createdAt' | 'updatedAt'>): Promise<SavedRoutine>;
  async getAll(): Promise<SavedRoutine[]>;
  async getById(id: string): Promise<SavedRoutine | null>;
  async delete(id: string): Promise<void>;
  async update(id: string, data: Partial<Pick<SavedRoutine, 'name' | 'exercises'>>): Promise<void>;
}
```

### 3. SessionDetailView (`src/exerciseLog/SessionDetailView.ts`)

Renders detailed per-set/per-rep drill-down for a session.

```typescript
export class SessionDetailView {
  constructor(private container: HTMLElement);

  show(session: Session): void;
  hide(): void;

  private renderSetBreakdown(session: Session): HTMLElement;
  private renderRepDetail(set: SetRecord): HTMLElement;
  private renderDeviationTimeline(session: Session): HTMLElement;
  private renderFormInsights(tips: string[]): HTMLElement;
}
```

### 4. SavedRoutinesPanel (`src/routineStore/SavedRoutinesPanel.ts`)

UI component for listing, loading, running, and deleting saved routines.

```typescript
export class SavedRoutinesPanel {
  constructor(options: {
    container: HTMLElement;
    routineStore: RoutineStore;
    onLoadRoutine: (routine: SavedRoutine) => void;
    onStartRoutine: (routine: SavedRoutine) => void;
  });

  mount(): void;
  refresh(): Promise<void>;
}
```

### 5. Updated LlmGateway

Replace `sendToLlm` stub with OllamaClient:

```typescript
private async sendToLlm(payload: LlmPayload): Promise<LlmResponse> {
  const client = OllamaClient.getInstance();
  if (!client.isAvailable()) {
    throw new Error('LLM unavailable — Ollama is offline');
  }
  const text = await client.generate(payload.prompt);
  return { text, model: client.getConfig().model };
}
```

### 6. AI Status Indicator

A small DOM badge in the UI showing "🟢 AI Connected" or "🔴 AI Offline" based on OllamaClient health checks.

## Data Models

### SavedRoutine (IndexedDB)

```typescript
interface SavedRoutine {
  id: string;           // UUID
  name: string;         // user-provided name
  exercises: Array<{
    exerciseName: string;
    targetReps: number;
  }>;
  createdAt: string;    // ISO 8601
  updatedAt: string;    // ISO 8601
}
```

### IndexedDB Schema Addition

New object store: `saved_routines`
- keyPath: `id`
- Index: `name_idx` on `name` (unique: false)
- Index: `updated_at_idx` on `updatedAt` (for sorting)

## Correctness Properties

### Property 1: Routine persistence round-trip
*For any* valid SavedRoutine, saving it to RoutineStore and then retrieving it by ID SHALL produce a structurally equivalent object.
**Validates: Requirements 1.1, 2.1**

### Property 2: OllamaClient timeout enforcement
*For any* request that exceeds the configured timeoutMs, the OllamaClient SHALL reject with a timeout error within timeoutMs + 100ms.
**Validates: Requirements 5.4, 5.5**

### Property 3: Health check determines availability
*For any* state of the Ollama server (reachable or unreachable), `isAvailable()` SHALL return true if and only if the most recent health check succeeded.
**Validates: Requirements 9.1, 9.2, 9.3**

### Property 4: LLM fallback guarantee
*For any* coaching request when `OllamaClient.isAvailable()` is false, the CoachingAdvisor SHALL produce rule-based recommendations without throwing.
**Validates: Requirements 6.3, 7.4, 8.5**

### Property 5: Session detail completeness
*For any* Session with N sets and M total reps, the SessionDetailView SHALL render exactly N set rows and M rep detail rows when fully expanded.
**Validates: Requirements 4.2, 4.3**

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Ollama not running | Health check fails → AI Offline indicator, rule-based fallback |
| Ollama timeout | Request aborted → error propagated → CoachingAdvisor uses fallback |
| Invalid model name | Ollama returns error → descriptive message shown to user |
| IndexedDB unavailable | RoutineStore methods reject → UI shows error inline |
| Empty routine save | Rejected before IndexedDB write → inline validation message |

## Testing Strategy

- **Unit tests**: OllamaClient (mocked fetch), RoutineStore (fake-indexeddb), SessionDetailView (jsdom)
- **Property tests**: Persistence round-trip, timeout enforcement, availability state
- **Integration tests**: Full flow from save → load → run → log → LLM coaching
- **Manual testing**: Verify Ollama connectivity with real local instance
