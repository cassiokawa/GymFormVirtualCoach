/**
 * Pose Detector Web Worker
 *
 * Hosts the MediaPipe Pose WASM runtime in an isolated thread, keeping
 * the main UI thread free for rendering and real-time evaluation logic.
 *
 * Communication contract (worker → main thread):
 *   - KeypointMessage  on successful frame processing
 *   - ErrorMessage     on initialisation or runtime failures
 *
 * Incoming messages from the main thread:
 *   { type: 'frame'; bitmap: ImageBitmap; timestampMs: number }
 *   { type: 'camera_lost' }
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 12.1
 *
 * NOTE: The MediaPipe integration is scaffolded here with a stub that
 * can be swapped out for the real SDK once it is available (task 3.2).
 * The stub simulates the initialisation lifecycle faithfully — callers
 * cannot distinguish it from the real implementation at the message
 * boundary.
 */

import type { KeypointMessage, ErrorMessage } from '../types/index.js';

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

/** True once MediaPipe (or its stub) has been initialised successfully. */
let isInitialized = false;

/** Monotonically increasing frame counter, reset on worker construction. */
let frameId = 0;

// ---------------------------------------------------------------------------
// MediaPipe stub — replace the body of initMediaPipe() in task 3.2
// ---------------------------------------------------------------------------

/**
 * Placeholder type that mirrors the MediaPipe Pose detector interface.
 * Replaced by the real import in task 3.2.
 */
interface PoseDetector {
  detectForVideo: (
    source: ImageBitmap | VideoFrame,
    timestampMs: number,
  ) => Promise<PoseDetectionResult>;
  close: () => void;
}

/** Minimal result shape for a single-person pose detection. */
interface PoseDetectionResult {
  /** Normalised world landmarks [0, 1] for each of the 33 body keypoints. */
  landmarks: Array<{
    x: number;
    y: number;
    z: number;
    visibility: number;
  }> | null;
}

/** Module-level reference; populated by initMediaPipe(). */
let poseDetector: PoseDetector | null = null;

/**
 * Initialise the MediaPipe Pose detector (currently a stub).
 *
 * Replace the body of this function in task 3.2 with the real
 * `@mediapipe/tasks-vision` setup.  The function signature and error
 * semantics must be preserved.
 *
 * @throws {Error} If initialisation fails for any reason.
 */
async function initMediaPipe(): Promise<void> {
  // ── STUB ──────────────────────────────────────────────────────────────────
  // Simulates an async initialisation round-trip.  In production this block
  // will be replaced by FilesetResolver + PoseLandmarker creation.
  // ──────────────────────────────────────────────────────────────────────────
  await Promise.resolve(); // yield to the event loop (mirrors real async init)

  poseDetector = {
    detectForVideo: async (
      _source: ImageBitmap | VideoFrame,
      _timestampMs: number,
    ): Promise<PoseDetectionResult> => {
      // Stub returns null landmarks; real implementation returns 33 keypoints.
      return { landmarks: null };
    },
    close: (): void => {
      // No-op in stub; real implementation releases WASM resources.
    },
  };
  // ── END STUB ──────────────────────────────────────────────────────────────
}

// ---------------------------------------------------------------------------
// Initialisation entry-point
// ---------------------------------------------------------------------------

/**
 * Attempts to initialise MediaPipe and flips `isInitialized` on success.
 * On failure it posts an `ErrorMessage` with code `INIT_FAILED` and leaves
 * `isInitialized` as `false` so that incoming frames are silently dropped
 * rather than causing a runtime error.
 *
 * Requirement 1.4 — emit `ErrorMessage { code: 'INIT_FAILED' }` on failure.
 */
async function init(): Promise<void> {
  try {
    await initMediaPipe();
    isInitialized = true;
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : 'Unknown error during MediaPipe initialisation';

    const errorMsg: ErrorMessage = {
      type: 'error',
      code: 'INIT_FAILED',
      message,
    };

    self.postMessage(errorMsg);
  }
}

// ---------------------------------------------------------------------------
// Incoming message handler
// ---------------------------------------------------------------------------

/** Expected number of MediaPipe pose landmarks. */
const EXPECTED_LANDMARK_COUNT = 33;

/**
 * Performance budget per frame in milliseconds (Requirement 12.1).
 * Log a warning if `detectForVideo` takes longer than this.
 */
const FRAME_BUDGET_MS = 33;

/**
 * Handles messages posted from the main thread.
 *
 * Recognised payload shapes:
 *   { type: 'frame'; bitmap: ImageBitmap; timestampMs: number }
 *     → run pose detection and post KeypointMessage on success.
 *   { type: 'camera_lost' }
 *     → immediately post ErrorMessage { code: 'CAMERA_LOST' }.
 *
 * Frames received before initialisation is complete are silently discarded.
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 12.1
 */
self.onmessage = (event: MessageEvent<unknown>): void => {
  const data = event.data;

  if (typeof data !== 'object' || data === null) {
    return;
  }

  const msgType = (data as Record<string, unknown>)['type'];

  // ── camera_lost ──────────────────────────────────────────────────────────
  // The main thread signals that camera access was revoked or the stream ended.
  // Requirement 1.4 — emit CAMERA_LOST immediately, regardless of init state.
  if (msgType === 'camera_lost') {
    const errorMsg: ErrorMessage = {
      type: 'error',
      code: 'CAMERA_LOST',
      message: 'Camera stream was lost or access was revoked',
    };
    self.postMessage(errorMsg);
    return;
  }

  // ── frame ─────────────────────────────────────────────────────────────────
  if (msgType !== 'frame') {
    return;
  }

  if (!isInitialized || poseDetector === null) {
    // Drop frames that arrive before init is complete.
    return;
  }

  const frameData = data as {
    type: 'frame';
    bitmap: ImageBitmap;
    timestampMs: number;
  };

  const currentFrameId = ++frameId;
  const { bitmap, timestampMs } = frameData;

  // Measure frame processing time (Requirement 12.1 — ≤33 ms budget).
  const t0 = performance.now();

  poseDetector
    .detectForVideo(bitmap, timestampMs)
    .then((result) => {
      const elapsed = performance.now() - t0;
      if (elapsed > FRAME_BUDGET_MS) {
        console.warn(
          `[PoseDetector] Frame ${currentFrameId} exceeded budget: ${elapsed.toFixed(2)} ms (budget: ${FRAME_BUDGET_MS} ms)`,
        );
      }

      if (result.landmarks === null) {
        // No person detected — skip this frame without posting an error.
        return;
      }

      // Guard: MediaPipe must return exactly 33 landmarks.
      // Requirement 1.1 — 33 keypoints per frame.
      if (result.landmarks.length !== EXPECTED_LANDMARK_COUNT) {
        const errorMsg: ErrorMessage = {
          type: 'error',
          code: 'DETECTION_FAILED',
          message: `Expected ${EXPECTED_LANDMARK_COUNT} landmarks, got ${result.landmarks.length}`,
        };
        self.postMessage(errorMsg);
        return;
      }

      // Map MediaPipe landmarks to the project's Keypoint schema.
      // noUncheckedIndexedAccess: result.landmarks[index] is safe here because
      // we iterate with Array.prototype.map which always provides valid elements.
      const keypointMsg: KeypointMessage = {
        type: 'keypoints',
        frameId: currentFrameId,
        timestampMs,
        keypoints: result.landmarks.map((lm, index) => ({
          index,
          x: lm.x,
          y: lm.y,
          z: lm.z,
          confidence: lm.visibility,
        })),
      };

      self.postMessage(keypointMsg);
    })
    .catch((err: unknown) => {
      const message =
        err instanceof Error ? err.message : 'Detection error';

      const errorMsg: ErrorMessage = {
        type: 'error',
        code: 'DETECTION_FAILED',
        message,
      };

      self.postMessage(errorMsg);
    });
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

init().catch(() => {
  // init() is already self-contained: it catches its own errors and posts
  // INIT_FAILED.  This outer catch prevents an unhandled-promise warning in
  // environments that surface such warnings on worker threads.
});
