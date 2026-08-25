/**
 * Training-data recorder for the CV Algorithm Lab.
 *
 * {@link Recorder} captures normalized {@link Keypoint} sequences frame-by-frame
 * during a workout, lets a developer attach human labels (rep boundaries,
 * quality rating, per-frame errors), and serializes the result to a portable
 * JSON dataset. Recordings can be re-imported for re-labeling/merging and
 * persisted to IndexedDB via the injected {@link ResultStore}.
 *
 * Requirements covered: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 *
 * ## Frame-cap policy (Req 12.4)
 *
 * A recording supports at least 10 minutes of continuous capture at 30 FPS,
 * i.e. roughly 18,000 frames ({@link MAX_FRAMES}). Once the buffer reaches this
 * cap, {@link Recorder.capture} silently drops any further frames (a
 * "stop-appending" / tail-truncation policy) rather than rolling out earlier
 * frames. This keeps the recording anchored to its start so rep-boundary frame
 * indices assigned by the labeler stay stable; the earliest frames — which
 * define the session's temporal origin — are never discarded.
 *
 * ## Exported JSON schema (schemaVersion 1) (Req 12.3, 12.5)
 *
 * `exportJson` emits, and `importJson` accepts, a single JSON object matching
 * the {@link RecordingSession} shape:
 *
 * ```jsonc
 * {
 *   "id": "<uuid>",                     // string
 *   "schemaVersion": 1,                 // literal number 1
 *   "metadata": {
 *     "exerciseName": "BackSquat",      // string
 *     "durationMs": 12345,              // number (>= 0)
 *     "modelId": "movenet-thunder",     // string
 *     "createdMs": 1700000000000        // number (epoch ms)
 *   },
 *   "frames": [                         // RecordedFrame[]
 *     {
 *       "timestampMs": 0,               // number
 *       "keypoints": [                  // Keypoint[]
 *         { "index": 0, "x": 0.5, "y": 0.4, "z": 0.0, "confidence": 0.9 }
 *         // ... one entry per detected landmark
 *       ]
 *     }
 *     // ... one entry per captured frame
 *   ],
 *   "labels": {                         // RecordingLabels
 *     "exerciseName": "BackSquat",      // string
 *     "repBoundaries": [                // Array<{ startFrame, endFrame }>
 *       { "startFrame": 0, "endFrame": 59 }
 *     ],
 *     "qualityRating": 4,               // integer 1..5
 *     "frameErrors": {                  // optional Record<frameIndex, string[]>
 *       "12": ["knee_valgus"]
 *     }
 *   }
 * }
 * ```
 */

import type { Keypoint } from '../../types/index.js';
import type {
  RecordedFrame,
  RecordingLabels,
  RecordingSession,
} from '../types.js';
import type { ResultStore } from '../store/ResultStore.js';

/**
 * Maximum number of frames retained in a single recording: ~10 minutes at
 * 30 FPS (Req 12.4). Frames captured beyond this cap are dropped.
 */
export const MAX_FRAMES = 18_000;

/** Current export/persistence schema version. */
const SCHEMA_VERSION = 1 as const;

/** Optional dependencies injected into a {@link Recorder}. */
export interface RecorderDeps {
  /** Store used by {@link Recorder.persist}; when absent, persist is a no-op. */
  store?: ResultStore;
}

/**
 * Error thrown by {@link Recorder.importJson} when the supplied text is not a
 * valid, schema-version-1 recording session.
 */
export class InvalidRecordingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRecordingError';
  }
}

/**
 * Captures, labels, exports, imports, and persists keypoint recording
 * sessions. A single instance records one session at a time: {@link start}
 * resets state, {@link capture} appends frames, and {@link stop} finalizes.
 */
export class Recorder {
  private readonly store: ResultStore | undefined;

  private frames: RecordedFrame[] = [];
  private recording = false;
  private exerciseName = '';
  private modelId = '';
  private createdMs = 0;
  private capReached = false;

  /** Labels applied to the current/next session (defaults until overridden). */
  private labels: RecordingLabels = Recorder.defaultLabels('');

  constructor(deps?: RecorderDeps) {
    this.store = deps?.store;
  }

  /**
   * Begin a new recording session, discarding any previously buffered frames
   * and labels. Records the wall-clock start time used to derive `durationMs`.
   *
   * @param exerciseName Currently selected exercise label (Req 12.1).
   * @param modelId Pose model producing the captured keypoints.
   */
  start(exerciseName: string, modelId: string): void {
    this.frames = [];
    this.recording = true;
    this.capReached = false;
    this.exerciseName = exerciseName;
    this.modelId = modelId;
    this.createdMs = Date.now();
    this.labels = Recorder.defaultLabels(exerciseName);
  }

  /**
   * Append one frame of normalized keypoints to the current session (Req 12.1).
   *
   * No-op when not recording. Enforces the {@link MAX_FRAMES} cap by dropping
   * further frames once the buffer is full (see class-level frame-cap policy).
   * The keypoints array is defensively copied so later caller mutation cannot
   * corrupt the buffered frame.
   *
   * @param keypoints Normalized keypoints for the frame.
   * @param timestampMs Wall-clock timestamp of the frame in milliseconds.
   */
  capture(keypoints: Keypoint[], timestampMs: number): void {
    if (!this.recording) return;
    if (this.frames.length >= MAX_FRAMES) {
      this.capReached = true;
      return;
    }
    this.frames.push({
      timestampMs,
      keypoints: keypoints.map((k) => ({ ...k })),
    });
  }

  /**
   * Finalize the current session and return it as a {@link RecordingSession}.
   *
   * `durationMs` is derived from the first and last captured frame timestamps
   * (0 when fewer than two frames were captured). After `stop`, the recorder is
   * idle; call {@link start} again for a new session.
   *
   * @returns The finalized recording session.
   */
  stop(): RecordingSession {
    this.recording = false;

    const durationMs = this.computeDurationMs();

    return {
      id: crypto.randomUUID(),
      metadata: {
        exerciseName: this.exerciseName,
        durationMs,
        modelId: this.modelId,
        createdMs: this.createdMs,
      },
      frames: this.frames,
      labels: this.labels,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  /**
   * Attach human-provided labels to the current session (Req 12.2): exercise
   * name, rep boundaries, quality rating (1-5), and optional per-frame errors.
   * The labels are validated and defensively copied.
   *
   * @param labels Labels to apply to the recording.
   * @throws {InvalidRecordingError} When `labels` fail shape/range validation.
   */
  setLabels(labels: RecordingLabels): void {
    this.labels = Recorder.validateLabels(labels, 'setLabels');
  }

  /**
   * Serialize a session to a JSON {@link Blob} conforming to the documented
   * schemaVersion-1 shape (Req 12.3). Suitable for triggering a file download.
   *
   * @param session Session to serialize.
   * @returns A `application/json` blob containing the serialized session.
   */
  exportJson(session: RecordingSession): Blob {
    const text = JSON.stringify(session);
    return new Blob([text], { type: 'application/json' });
  }

  /**
   * Parse and validate previously exported JSON back into a
   * {@link RecordingSession} (Req 12.5). Validates `schemaVersion` and the full
   * object shape; unknown/malformed input is rejected.
   *
   * @param text JSON text produced by {@link exportJson} (or an equivalent).
   * @returns The parsed, validated recording session.
   * @throws {InvalidRecordingError} On malformed JSON or schema mismatch.
   */
  importJson(text: string): RecordingSession {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new InvalidRecordingError(
        `recording JSON is not valid JSON: ${(cause as Error).message}`,
      );
    }
    return Recorder.validateSession(parsed);
  }

  /**
   * Persist a session via the injected {@link ResultStore} (Req 12.6). When no
   * store was injected this resolves without side effects.
   *
   * @param session Session to save.
   */
  async persist(session: RecordingSession): Promise<void> {
    if (!this.store) return;
    await this.store.saveRecording(session);
  }

  /** Number of frames captured in the current session. */
  getFrameCount(): number {
    return this.frames.length;
  }

  /** Whether a recording session is currently active. */
  isRecording(): boolean {
    return this.recording;
  }

  /** Whether the {@link MAX_FRAMES} cap was hit during the current session. */
  isCapReached(): boolean {
    return this.capReached;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Duration between the first and last captured frame timestamps (ms). */
  private computeDurationMs(): number {
    if (this.frames.length < 2) return 0;
    const first = this.frames[0];
    const last = this.frames[this.frames.length - 1];
    if (!first || !last) return 0;
    const delta = last.timestampMs - first.timestampMs;
    return delta > 0 ? delta : 0;
  }

  /** Default (empty) labels for a session with the given exercise name. */
  private static defaultLabels(exerciseName: string): RecordingLabels {
    return {
      exerciseName,
      repBoundaries: [],
      qualityRating: 3,
    };
  }

  /**
   * Validate and defensively copy a {@link RecordingLabels} object.
   *
   * @param value Candidate labels.
   * @param context Label used in thrown error messages.
   * @throws {InvalidRecordingError} On any shape/range violation.
   */
  private static validateLabels(
    value: unknown,
    context: string,
  ): RecordingLabels {
    if (typeof value !== 'object' || value === null) {
      throw new InvalidRecordingError(`${context}: labels must be an object`);
    }
    const l = value as Record<string, unknown>;

    const exerciseName = l['exerciseName'];
    if (typeof exerciseName !== 'string') {
      throw new InvalidRecordingError(
        `${context}: labels.exerciseName must be a string`,
      );
    }

    const rawBoundaries = l['repBoundaries'];
    if (!Array.isArray(rawBoundaries)) {
      throw new InvalidRecordingError(
        `${context}: labels.repBoundaries must be an array`,
      );
    }
    const repBoundaries = rawBoundaries.map((b, i) => {
      if (typeof b !== 'object' || b === null) {
        throw new InvalidRecordingError(
          `${context}: repBoundaries[${i}] must be an object`,
        );
      }
      const bo = b as Record<string, unknown>;
      const startFrame = bo['startFrame'];
      const endFrame = bo['endFrame'];
      if (typeof startFrame !== 'number' || typeof endFrame !== 'number') {
        throw new InvalidRecordingError(
          `${context}: repBoundaries[${i}] must have numeric startFrame/endFrame`,
        );
      }
      return { startFrame, endFrame };
    });

    const rating = l['qualityRating'];
    if (
      typeof rating !== 'number' ||
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5
    ) {
      throw new InvalidRecordingError(
        `${context}: labels.qualityRating must be an integer 1..5`,
      );
    }

    const result: RecordingLabels = {
      exerciseName,
      repBoundaries,
      qualityRating: rating as 1 | 2 | 3 | 4 | 5,
    };

    const rawFrameErrors = l['frameErrors'];
    if (rawFrameErrors !== undefined) {
      if (typeof rawFrameErrors !== 'object' || rawFrameErrors === null) {
        throw new InvalidRecordingError(
          `${context}: labels.frameErrors must be an object when present`,
        );
      }
      const frameErrors: Record<number, string[]> = {};
      for (const [key, errs] of Object.entries(
        rawFrameErrors as Record<string, unknown>,
      )) {
        const frameIndex = Number(key);
        if (!Number.isInteger(frameIndex)) {
          throw new InvalidRecordingError(
            `${context}: frameErrors key "${key}" is not an integer index`,
          );
        }
        if (
          !Array.isArray(errs) ||
          !errs.every((e) => typeof e === 'string')
        ) {
          throw new InvalidRecordingError(
            `${context}: frameErrors["${key}"] must be a string array`,
          );
        }
        frameErrors[frameIndex] = [...(errs as string[])];
      }
      result.frameErrors = frameErrors;
    }

    return result;
  }

  /**
   * Validate and normalize a parsed object into a {@link RecordingSession}.
   *
   * @param value Parsed JSON value.
   * @throws {InvalidRecordingError} On any shape/schema violation.
   */
  private static validateSession(value: unknown): RecordingSession {
    if (typeof value !== 'object' || value === null) {
      throw new InvalidRecordingError('recording must be an object');
    }
    const s = value as Record<string, unknown>;

    if (s['schemaVersion'] !== SCHEMA_VERSION) {
      throw new InvalidRecordingError(
        `unsupported schemaVersion: expected ${SCHEMA_VERSION}, got ${String(
          s['schemaVersion'],
        )}`,
      );
    }

    const id = s['id'];
    if (typeof id !== 'string' || id.length === 0) {
      throw new InvalidRecordingError('recording.id must be a non-empty string');
    }

    const metadata = Recorder.validateMetadata(s['metadata']);
    const frames = Recorder.validateFrames(s['frames']);
    const labels = Recorder.validateLabels(s['labels'], 'import');

    return {
      id,
      metadata,
      frames,
      labels,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  /** Validate the metadata sub-object of an imported session. */
  private static validateMetadata(
    value: unknown,
  ): RecordingSession['metadata'] {
    if (typeof value !== 'object' || value === null) {
      throw new InvalidRecordingError('recording.metadata must be an object');
    }
    const m = value as Record<string, unknown>;
    const exerciseName = m['exerciseName'];
    const durationMs = m['durationMs'];
    const modelId = m['modelId'];
    const createdMs = m['createdMs'];
    if (typeof exerciseName !== 'string') {
      throw new InvalidRecordingError(
        'metadata.exerciseName must be a string',
      );
    }
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
      throw new InvalidRecordingError('metadata.durationMs must be a number');
    }
    if (typeof modelId !== 'string') {
      throw new InvalidRecordingError('metadata.modelId must be a string');
    }
    if (typeof createdMs !== 'number' || !Number.isFinite(createdMs)) {
      throw new InvalidRecordingError('metadata.createdMs must be a number');
    }
    return {
      exerciseName,
      durationMs,
      modelId,
      createdMs,
    };
  }

  /** Validate the frames array of an imported session. */
  private static validateFrames(value: unknown): RecordedFrame[] {
    if (!Array.isArray(value)) {
      throw new InvalidRecordingError('recording.frames must be an array');
    }
    return value.map((f, i) => {
      if (typeof f !== 'object' || f === null) {
        throw new InvalidRecordingError(`frames[${i}] must be an object`);
      }
      const fo = f as Record<string, unknown>;
      const timestampMs = fo['timestampMs'];
      const rawKeypoints = fo['keypoints'];
      if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) {
        throw new InvalidRecordingError(
          `frames[${i}].timestampMs must be a number`,
        );
      }
      if (!Array.isArray(rawKeypoints)) {
        throw new InvalidRecordingError(
          `frames[${i}].keypoints must be an array`,
        );
      }
      const keypoints = rawKeypoints.map((k, j) =>
        Recorder.validateKeypoint(k, i, j),
      );
      return { timestampMs, keypoints };
    });
  }

  /** Validate a single keypoint within an imported frame. */
  private static validateKeypoint(
    value: unknown,
    frameIdx: number,
    kpIdx: number,
  ): Keypoint {
    if (typeof value !== 'object' || value === null) {
      throw new InvalidRecordingError(
        `frames[${frameIdx}].keypoints[${kpIdx}] must be an object`,
      );
    }
    const k = value as Record<string, unknown>;
    for (const field of ['index', 'x', 'y', 'z', 'confidence'] as const) {
      const v = k[field];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new InvalidRecordingError(
          `frames[${frameIdx}].keypoints[${kpIdx}].${field} must be a number`,
        );
      }
    }
    return {
      index: k['index'] as number,
      x: k['x'] as number,
      y: k['y'] as number,
      z: k['z'] as number,
      confidence: k['confidence'] as number,
    };
  }
}
