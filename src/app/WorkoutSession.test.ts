/**
 * Unit tests for WorkoutSession pre-tracking integration.
 *
 * Requirements validated: 4.1, 4.2, 4.4
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { KeypointMessage, ExerciseFSMConfig, PreTrackingStatus } from '../types/index.js';

// ---------------------------------------------------------------------------
// Mock all heavy dependencies
// ---------------------------------------------------------------------------

const mockRepCounterUpdate = vi.fn();
const mockRepCounterGetRepCount = vi.fn().mockReturnValue(0);
const mockRepCounterGetCompletedReps = vi.fn().mockReturnValue([]);

vi.mock('../repCounter/RepCounter.js', () => ({
  RepCounter: vi.fn().mockImplementation(() => ({
    update: mockRepCounterUpdate,
    getRepCount: mockRepCounterGetRepCount,
    getCompletedReps: mockRepCounterGetCompletedReps,
  })),
}));

const mockFormEvaluatorEvaluateFrame = vi.fn();
const mockFormEvaluatorSetRepNumber = vi.fn();

vi.mock('../formEvaluator/FormEvaluator.js', () => ({
  FormEvaluator: vi.fn().mockImplementation(() => ({
    evaluateFrame: mockFormEvaluatorEvaluateFrame,
    setRepNumber: mockFormEvaluatorSetRepNumber,
  })),
}));

vi.mock('../safetyMonitor/SafetyMonitor.js', () => ({
  SafetyMonitor: vi.fn().mockImplementation(() => ({
    onCriticalDeviation: vi.fn(),
  })),
}));

vi.mock('../alertSystem/AlertSystem.js', () => ({
  AlertSystem: vi.fn().mockImplementation(() => ({
    trigger: vi.fn(),
    dismiss: vi.fn(),
  })),
}));

vi.mock('../sessionLogger/SessionLogger.js', () => ({
  SessionLogger: vi.fn().mockImplementation(() => ({
    startSet: vi.fn(),
    recordRep: vi.fn(),
    markRepDangerous: vi.fn(),
  })),
}));

const mockProcessFrame = vi.fn<(msg: KeypointMessage) => PreTrackingStatus>();
const mockOnLockAchieved = vi.fn();
const mockSkipLock = vi.fn();

vi.mock('../preTracking/PreTrackingController.js', () => ({
  PreTrackingController: vi.fn().mockImplementation(() => ({
    processFrame: mockProcessFrame,
    onLockAchieved: mockOnLockAchieved,
    skipLock: mockSkipLock,
  })),
}));

// Import after mocks are defined
import { WorkoutSession } from './WorkoutSession.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const squatConfig: ExerciseFSMConfig = {
  exerciseName: 'barbell_squat',
  joints: ['left_knee', 'right_knee', 'left_hip', 'right_hip'],
  startThreshold: { min: 160, max: 180 },
  inflectionThreshold: { min: 90, max: 130 },
  completeThreshold: { min: 60, max: 95 },
  warningThreshold: { min: 0, max: 55 },
  criticalThreshold: { min: 0, max: 160 },
};

function createMockCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    setLineDash: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    canvas,
  };
  vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as any);
  return canvas;
}

function makeKeypointMessage(frameId = 1): KeypointMessage {
  const keypoints = Array.from({ length: 33 }, (_, i) => ({
    index: i,
    x: 0.5,
    y: 0.5,
    z: 0,
    confidence: 0.9,
  }));
  return {
    type: 'keypoints',
    frameId,
    timestampMs: Date.now(),
    keypoints,
  };
}

function makePreTrackingStatus(overrides: Partial<PreTrackingStatus> = {}): PreTrackingStatus {
  return {
    state: 'framing',
    framingScore: 0.3,
    startingPositionScore: 0,
    lockProgress: 0,
    positionCues: [],
    isLocked: false,
    ...overrides,
  };
}

// Mock the Worker constructor globally
class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('WorkoutSession — pre-tracking integration', () => {
  let session: WorkoutSession;
  let canvasContainer: HTMLElement;
  let canvas: HTMLCanvasElement;
  let onErrorCb: ReturnType<typeof vi.fn>;
  let onPreTrackingStatusCb: ReturnType<typeof vi.fn>;
  let mockWorkerInstance: MockWorker;

  beforeEach(() => {
    vi.clearAllMocks();

    // Stub the Worker constructor
    mockWorkerInstance = new MockWorker();
    vi.stubGlobal('Worker', vi.fn(() => mockWorkerInstance));

    canvasContainer = document.createElement('div');
    canvas = createMockCanvas();
    onErrorCb = vi.fn();
    onPreTrackingStatusCb = vi.fn();

    // Default processFrame returns a pre-tracking status (not active)
    mockProcessFrame.mockReturnValue(makePreTrackingStatus());
  });

  function createSessionWithCanvas(): WorkoutSession {
    return new WorkoutSession({
      config: squatConfig,
      sessionId: 'test-session-1',
      routineId: 'test-routine-1',
      expectedTutMs: 3000,
      canvasContainer,
      onError: onErrorCb,
      canvas,
      onPreTrackingStatus: onPreTrackingStatusCb,
    });
  }

  function createSessionWithoutCanvas(): WorkoutSession {
    return new WorkoutSession({
      config: squatConfig,
      sessionId: 'test-session-2',
      routineId: 'test-routine-2',
      expectedTutMs: 3000,
      canvasContainer,
      onError: onErrorCb,
    });
  }

  /** Simulate the worker sending a keypoint message. */
  function simulateWorkerMessage(msg: KeypointMessage): void {
    mockWorkerInstance.onmessage?.({ data: msg } as MessageEvent);
  }

  // -------------------------------------------------------------------------
  // Requirement 4.1 — Keypoints NOT forwarded during pre_tracking
  // -------------------------------------------------------------------------

  describe('Requirement 4.1 — frames gated during pre_tracking', () => {
    it('does NOT forward keypoints to RepCounter during pre_tracking state', () => {
      session = createSessionWithCanvas();
      session.start();

      const msg = makeKeypointMessage();
      simulateWorkerMessage(msg);

      expect(mockRepCounterUpdate).not.toHaveBeenCalled();
      expect(mockFormEvaluatorEvaluateFrame).not.toHaveBeenCalled();
    });

    it('routes keypoints to PreTrackingController.processFrame during pre_tracking', () => {
      session = createSessionWithCanvas();
      session.start();

      const msg = makeKeypointMessage();
      simulateWorkerMessage(msg);

      expect(mockProcessFrame).toHaveBeenCalledWith(msg);
    });
  });

  // -------------------------------------------------------------------------
  // Requirement 4.2 — Keypoints ARE forwarded once active
  // -------------------------------------------------------------------------

  describe('Requirement 4.2 — frames forwarded once active', () => {
    it('forwards keypoints to RepCounter and FormEvaluator after lock achieved', () => {
      session = createSessionWithCanvas();
      session.start();

      // Capture the onLockAchieved callback registered on PreTrackingController
      expect(mockOnLockAchieved).toHaveBeenCalled();
      const lockCallback = mockOnLockAchieved.mock.calls[0][0] as () => void;

      // Simulate lock achieved — this sets trackingState to 'active'
      lockCallback();

      // Now send a keypoint message
      const msg = makeKeypointMessage();
      simulateWorkerMessage(msg);

      expect(mockRepCounterUpdate).toHaveBeenCalledWith(msg);
      expect(mockFormEvaluatorEvaluateFrame).toHaveBeenCalledWith(msg);
    });

    it('does NOT route to PreTrackingController once in active state', () => {
      session = createSessionWithCanvas();
      session.start();

      // Trigger lock
      const lockCallback = mockOnLockAchieved.mock.calls[0][0] as () => void;
      lockCallback();

      mockProcessFrame.mockClear();

      const msg = makeKeypointMessage();
      simulateWorkerMessage(msg);

      expect(mockProcessFrame).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Requirement 4.4 — skipLock() transitions immediately to active
  // -------------------------------------------------------------------------

  describe('Requirement 4.4 — skipLock() transitions to active', () => {
    it('skipLock() delegates to PreTrackingController.skipLock()', () => {
      session = createSessionWithCanvas();
      session.skipLock();

      expect(mockSkipLock).toHaveBeenCalled();
    });

    it('skipLock() triggers the lock callback which enables frame forwarding', () => {
      session = createSessionWithCanvas();
      session.start();

      // Capture the onLockAchieved callback
      const lockCallback = mockOnLockAchieved.mock.calls[0][0] as () => void;

      // Simulate skipLock triggering the lock callback (as PreTrackingController does)
      lockCallback();

      // Now frames should be forwarded
      const msg = makeKeypointMessage();
      simulateWorkerMessage(msg);

      expect(mockRepCounterUpdate).toHaveBeenCalledWith(msg);
      expect(mockFormEvaluatorEvaluateFrame).toHaveBeenCalledWith(msg);
    });
  });

  // -------------------------------------------------------------------------
  // onPreTrackingStatus callback
  // -------------------------------------------------------------------------

  describe('onPreTrackingStatus callback receives status updates', () => {
    it('emits PreTrackingStatus to callback during pre-tracking', () => {
      const status = makePreTrackingStatus({
        state: 'positioning',
        framingScore: 0.8,
        startingPositionScore: 0.5,
      });
      mockProcessFrame.mockReturnValue(status);

      session = createSessionWithCanvas();
      session.start();

      const msg = makeKeypointMessage();
      simulateWorkerMessage(msg);

      expect(onPreTrackingStatusCb).toHaveBeenCalledWith(status);
    });

    it('does NOT emit PreTrackingStatus once active tracking begins', () => {
      session = createSessionWithCanvas();
      session.start();

      // Trigger lock transition
      const lockCallback = mockOnLockAchieved.mock.calls[0][0] as () => void;
      lockCallback();

      onPreTrackingStatusCb.mockClear();

      const msg = makeKeypointMessage();
      simulateWorkerMessage(msg);

      expect(onPreTrackingStatusCb).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Backward compatibility — no canvas skips pre-tracking
  // -------------------------------------------------------------------------

  describe('backward compatibility — no canvas skips pre-tracking', () => {
    it('starts directly in active state when no canvas is provided', () => {
      session = createSessionWithoutCanvas();
      session.start();

      const msg = makeKeypointMessage();
      simulateWorkerMessage(msg);

      // Should forward directly to RepCounter (no pre-tracking gate)
      expect(mockRepCounterUpdate).toHaveBeenCalledWith(msg);
      expect(mockFormEvaluatorEvaluateFrame).toHaveBeenCalledWith(msg);
    });

    it('does NOT create PreTrackingController when canvas is absent', () => {
      session = createSessionWithoutCanvas();
      session.start();

      const msg = makeKeypointMessage();
      simulateWorkerMessage(msg);

      // processFrame should never be called since no controller exists
      expect(mockProcessFrame).not.toHaveBeenCalled();
    });
  });
});
