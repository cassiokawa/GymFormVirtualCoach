/**
 * Storage layer — IndexedDB implementation.
 *
 * Persists workout sessions and exercise logs locally in the browser using the
 * native IndexedDB API. No external libraries are required.
 *
 * Requirements covered: 9.1–9.5
 */

import type { Session, SetRecord, DeviationEvent } from '../types/index.js';

// ---------------------------------------------------------------------------
// Internal DB row shapes (persisted form)
// ---------------------------------------------------------------------------

/** Row stored in the `workout_sessions` object store. */
interface WorkoutSessionRow {
  id: string;
  started_at: string; // ISO 8601
  ended_at: string; // ISO 8601
  duration_ms: number;
  routine_id: string;
}

/** Row stored in the `session_exercise_logs` object store. */
interface SessionExerciseLogRow {
  id: string;
  session_id: string;
  exercise_name: string;
  set_number: number;
  correct_reps: number;
  flawed_reps: number;
  dangerous_reps: number;
  actual_tut_ms: number;
  expected_tut_ms: number;
  deviation_events: string; // JSON-serialized DeviationEvent[]
}

// ---------------------------------------------------------------------------
// Error event types
// ---------------------------------------------------------------------------

/** Custom event dispatched by Storage when a write operation fails. */
export class StorageWriteErrorEvent extends Event {
  /** Human-readable description of what went wrong. */
  readonly detail: string;
  /** The session that failed to persist (buffered for retry). */
  readonly session: Session;

  constructor(detail: string, session: Session) {
    super('write-error');
    this.detail = detail;
    this.session = session;
  }
}

// ---------------------------------------------------------------------------
// Storage singleton
// ---------------------------------------------------------------------------

const DB_NAME = 'gym-form-coach';
const DB_VERSION = 1;
const PERSIST_TIMEOUT_MS = 2_000;

/**
 * Singleton Storage class backed by IndexedDB.
 *
 * Usage:
 * ```ts
 * const storage = Storage.getInstance();
 * await storage.open();
 * await storage.persist(session);
 * const sessions = await storage.query({ from: startDate, to: endDate });
 * ```
 *
 * Requirement 9.1 — persist to `workout_sessions` table.
 * Requirement 9.2 — persist to `session_exercise_logs` table.
 * Requirement 9.3 — write must resolve within 2 seconds.
 * Requirement 9.4 — emit error event and buffer telemetry on write failure.
 * Requirement 9.5 — query returns sessions in ascending chronological order.
 */
export class Storage extends EventTarget {
  private static instance: Storage | undefined;

  private db: IDBDatabase | null = null;

  /** Sessions that failed to persist and are waiting for a retry. */
  private retryBuffer: Session[] = [];

  // Private constructor — use Storage.getInstance()
  private constructor() {
    super();
  }

  /** Return (or create) the process-wide singleton instance. */
  static getInstance(): Storage {
    if (Storage.instance === undefined) {
      Storage.instance = new Storage();
    }
    return Storage.instance;
  }

  /**
   * Reset the singleton — intended for use in tests only.
   * @internal
   */
  static _resetInstance(): void {
    if (Storage.instance !== undefined) {
      Storage.instance.db?.close();
    }
    Storage.instance = undefined;
  }

  // ---------------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------------

  /**
   * Open (or create) the IndexedDB database and apply the schema.
   * Must be called before `persist()` or `query()`.
   *
   * Requirements 9.1, 9.2
   */
  open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = (event.target as IDBOpenDBRequest).result;
        this.applySchema(db);
      };

      request.onsuccess = (event: Event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve();
      };

      request.onerror = (_event: Event) => {
        reject(new Error(`Failed to open IndexedDB: ${request.error?.message ?? 'unknown error'}`));
      };
    });
  }

  /**
   * Create object stores and indexes if they don't already exist.
   * Called inside `onupgradeneeded` so it is idempotent across DB versions.
   */
  private applySchema(db: IDBDatabase): void {
    // workout_sessions
    if (!db.objectStoreNames.contains('workout_sessions')) {
      const sessionStore = db.createObjectStore('workout_sessions', { keyPath: 'id' });
      // Index on started_at for chronological queries (requirement 9.5)
      sessionStore.createIndex('started_at_idx', 'started_at', { unique: false });
    }

    // session_exercise_logs
    if (!db.objectStoreNames.contains('session_exercise_logs')) {
      const logStore = db.createObjectStore('session_exercise_logs', { keyPath: 'id' });
      // Index on session_id for efficient lookup of logs by session
      logStore.createIndex('session_id_idx', 'session_id', { unique: false });
    }
  }

  // ---------------------------------------------------------------------------
  // persist()
  // ---------------------------------------------------------------------------

  /**
   * Persist a completed Session to IndexedDB.
   *
   * Writes both `workout_sessions` and `session_exercise_logs` inside a single
   * read-write transaction. Rejects (and buffers the session for retry) if the
   * write does not complete within 2 seconds.
   *
   * Requirement 9.3 — must resolve within 2 seconds.
   * Requirement 9.4 — on failure, emit 'write-error' event and buffer telemetry.
   */
  persist(session: Session): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.db === null) {
        const err = new Error('Storage is not open. Call open() before persist().');
        this._handleWriteFailure(err, session);
        reject(err);
        return;
      }

      let settled = false;

      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          const err = new Error(`Storage.persist() timed out after ${PERSIST_TIMEOUT_MS} ms for session ${session.id}`);
          this._handleWriteFailure(err, session);
          reject(err);
        }
      }, PERSIST_TIMEOUT_MS);

      let tx: IDBTransaction;
      try {
        tx = this.db.transaction(['workout_sessions', 'session_exercise_logs'], 'readwrite');
      } catch (e) {
        clearTimeout(timeoutId);
        const err = e instanceof Error ? e : new Error(String(e));
        this._handleWriteFailure(err, session);
        reject(err);
        return;
      }

      tx.oncomplete = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          resolve();
        }
      };

      tx.onerror = (_event: Event) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          const err = new Error(`Transaction error while persisting session ${session.id}: ${tx.error?.message ?? 'unknown'}`);
          this._handleWriteFailure(err, session);
          reject(err);
        }
      };

      tx.onabort = (_event: Event) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          const err = new Error(`Transaction aborted while persisting session ${session.id}: ${tx.error?.message ?? 'unknown'}`);
          this._handleWriteFailure(err, session);
          reject(err);
        }
      };

      // Write workout_sessions row
      const sessionStore = tx.objectStore('workout_sessions');
      const sessionRow: WorkoutSessionRow = {
        id: session.id,
        started_at: session.startedAt.toISOString(),
        ended_at: session.endedAt.toISOString(),
        duration_ms: session.durationMs,
        routine_id: session.routineId,
      };
      sessionStore.put(sessionRow);

      // Write session_exercise_logs rows (one per SetRecord)
      const logStore = tx.objectStore('session_exercise_logs');
      for (const setRecord of session.sets) {
        const row = this.setRecordToRow(session.id, setRecord);
        logStore.put(row);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // query()
  // ---------------------------------------------------------------------------

  /**
   * Return all Sessions whose `startedAt` falls within [from, to], inclusive,
   * ordered by ascending `startedAt`.
   *
   * Requirement 9.5 — ascending chronological order.
   */
  query(dateRange: { from: Date; to: Date }): Promise<Session[]> {
    return new Promise<Session[]>((resolve, reject) => {
      if (this.db === null) {
        reject(new Error('Storage is not open. Call open() before query().'));
        return;
      }

      // Convert dates to ISO strings for IDBKeyRange comparison
      const fromIso = dateRange.from.toISOString();
      const toIso = dateRange.to.toISOString();
      const range = IDBKeyRange.bound(fromIso, toIso, false, false);

      let tx: IDBTransaction;
      try {
        tx = this.db.transaction(['workout_sessions', 'session_exercise_logs'], 'readonly');
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      const sessionStore = tx.objectStore('workout_sessions');
      const sessionIndex = sessionStore.index('started_at_idx');
      const cursorRequest = sessionIndex.openCursor(range, 'next'); // ascending

      const sessionRows: WorkoutSessionRow[] = [];

      cursorRequest.onsuccess = (event: Event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (cursor !== null) {
          sessionRows.push(cursor.value as WorkoutSessionRow);
          cursor.continue();
        }
      };

      cursorRequest.onerror = (_event: Event) => {
        reject(new Error(`Cursor error while querying sessions: ${cursorRequest.error?.message ?? 'unknown'}`));
      };

      tx.oncomplete = () => {
        // If no sessions found, return early
        if (sessionRows.length === 0) {
          resolve([]);
          return;
        }

        // Collect all session IDs to fetch their exercise logs
        const sessionIds = new Set(sessionRows.map((r) => r.id));

        // Open a second transaction to fetch all logs for these sessions
        if (this.db === null) {
          resolve(sessionRows.map((r) => this.rowToSession(r, [])));
          return;
        }

        let logTx: IDBTransaction;
        try {
          logTx = this.db.transaction(['session_exercise_logs'], 'readonly');
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }

        const logStore = logTx.objectStore('session_exercise_logs');
        const logIndex = logStore.index('session_id_idx');

        // Map from session_id -> list of log rows
        const logsBySession = new Map<string, SessionExerciseLogRow[]>();
        for (const id of sessionIds) {
          logsBySession.set(id, []);
        }

        let pendingCursors = sessionIds.size;

        const finalize = (): void => {
          const sessions = sessionRows.map((row) => {
            const logs = logsBySession.get(row.id) ?? [];
            return this.rowToSession(row, logs);
          });
          resolve(sessions);
        };

        for (const sessionId of sessionIds) {
          const logCursorRequest = logIndex.openCursor(IDBKeyRange.only(sessionId));

          logCursorRequest.onsuccess = (event: Event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (cursor !== null) {
              const existing = logsBySession.get(sessionId);
              if (existing !== undefined) {
                existing.push(cursor.value as SessionExerciseLogRow);
              }
              cursor.continue();
            }
          };

          logCursorRequest.onerror = (_event: Event) => {
            // Non-fatal: resolve with whatever logs we have
            pendingCursors--;
            if (pendingCursors === 0) finalize();
          };

          logTx.oncomplete = () => {
            finalize();
          };

          logTx.onerror = (_event: Event) => {
            // Resolve with partial data rather than rejecting entirely
            finalize();
          };
        }
      };

      tx.onerror = (_event: Event) => {
        reject(new Error(`Transaction error while querying sessions: ${tx.error?.message ?? 'unknown'}`));
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Retry buffer
  // ---------------------------------------------------------------------------

  /**
   * Return the current in-memory retry buffer (sessions that failed to persist).
   *
   * Callers can inspect this buffer and re-attempt persistence at a later time.
   * Requirement 9.4
   */
  getRetryBuffer(): readonly Session[] {
    return this.retryBuffer;
  }

  /**
   * Attempt to re-persist all sessions currently in the retry buffer.
   * Successfully persisted sessions are removed from the buffer.
   *
   * Requirement 9.4
   */
  async flushRetryBuffer(): Promise<void> {
    if (this.retryBuffer.length === 0) return;

    const toRetry = [...this.retryBuffer];
    this.retryBuffer = [];

    const results = await Promise.allSettled(toRetry.map((s) => this.persist(s)));

    // Sessions that failed again will have been re-added to the buffer by
    // _handleWriteFailure inside persist(). No additional action needed.
    void results;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Called on any write failure: emits a descriptive 'write-error' event and
   * adds the session to the in-memory retry buffer.
   *
   * Requirement 9.4
   */
  private _handleWriteFailure(error: Error, session: Session): void {
    this.retryBuffer.push(session);
    this.dispatchEvent(new StorageWriteErrorEvent(error.message, session));
  }

  /** Convert a `SetRecord` (and its parent session ID) into a DB row. */
  private setRecordToRow(sessionId: string, set: SetRecord): SessionExerciseLogRow {
    const correctReps = set.reps.filter((r) => r.category === 'correct').length;
    const flawedReps = set.reps.filter((r) => r.category === 'flawed').length;
    const dangerousReps = set.reps.filter((r) => r.category === 'dangerous_aborted').length;

    // Collect all deviation events from all reps in this set
    const allDeviations: DeviationEvent[] = set.reps.flatMap((r) => r.deviationEvents);

    return {
      // Composite key: session_id + set_number ensures uniqueness
      id: `${sessionId}_set_${set.setNumber}`,
      session_id: sessionId,
      exercise_name: set.exerciseName,
      set_number: set.setNumber,
      correct_reps: correctReps,
      flawed_reps: flawedReps,
      dangerous_reps: dangerousReps,
      actual_tut_ms: set.actualTutMs,
      expected_tut_ms: set.expectedTutMs,
      deviation_events: JSON.stringify(allDeviations),
    };
  }

  /**
   * Reconstruct a `Session` from DB rows.
   *
   * Dates are deserialized from ISO 8601 strings.
   * `deviation_events` JSON is parsed back into `DeviationEvent[]`.
   */
  private rowToSession(sessionRow: WorkoutSessionRow, logRows: SessionExerciseLogRow[]): Session {
    // Sort log rows by set_number ascending to preserve set order
    const sortedLogs = [...logRows].sort((a, b) => a.set_number - b.set_number);

    const sets: SetRecord[] = sortedLogs.map((log) => {
      const deviationEvents: DeviationEvent[] = JSON.parse(log.deviation_events) as DeviationEvent[];

      // We reconstruct minimal SetRecord from the stored aggregates.
      // Individual rep detail is not stored (only counts + TUT) so reps[] is
      // rebuilt as synthetic records for downstream consumers that need counts.
      const reps = this.reconstructReps(
        log.correct_reps,
        log.flawed_reps,
        log.dangerous_reps,
        deviationEvents,
      );

      const set: SetRecord = {
        setNumber: log.set_number,
        exerciseName: log.exercise_name,
        reps,
        actualTutMs: log.actual_tut_ms,
        expectedTutMs: log.expected_tut_ms,
        tutDeltaMs: log.actual_tut_ms - log.expected_tut_ms,
      };
      return set;
    });

    return {
      id: sessionRow.id,
      startedAt: new Date(sessionRow.started_at),
      endedAt: new Date(sessionRow.ended_at),
      durationMs: sessionRow.duration_ms,
      routineId: sessionRow.routine_id,
      sets,
    };
  }

  /**
   * Reconstruct synthetic Rep records from stored aggregate counts.
   *
   * Since only counts (not per-rep detail) are stored in
   * `session_exercise_logs`, the reconstructed reps have a `tutMs` of 0 and
   * deviation events are only assigned to flawed/dangerous reps in aggregate.
   * This is sufficient for the Analytics_Engine and Routine_Generator which
   * only need counts and total TUT.
   */
  private reconstructReps(
    correctCount: number,
    flawedCount: number,
    dangerousCount: number,
    allDeviations: DeviationEvent[],
  ): import('../types/index.js').Rep[] {
    const reps: import('../types/index.js').Rep[] = [];
    let repNumber = 1;

    for (let i = 0; i < correctCount; i++) {
      reps.push({ repNumber: repNumber++, tutMs: 0, category: 'correct', deviationEvents: [] });
    }
    for (let i = 0; i < flawedCount; i++) {
      // Assign all deviation events to the first flawed rep for simplicity
      const events = i === 0 ? allDeviations.filter((d) => d.severity === 'warning') : [];
      reps.push({ repNumber: repNumber++, tutMs: 0, category: 'flawed', deviationEvents: events });
    }
    for (let i = 0; i < dangerousCount; i++) {
      const events = i === 0 ? allDeviations.filter((d) => d.severity === 'critical') : [];
      reps.push({ repNumber: repNumber++, tutMs: 0, category: 'dangerous_aborted', deviationEvents: events });
    }

    return reps;
  }
}
