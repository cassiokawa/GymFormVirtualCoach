/**
 * Unit tests for {@link Recorder}.
 *
 * Validates capture lifecycle, session finalization shape, label validation,
 * the JSON export/import round-trip and its schema guards, the frame cap, and
 * store-backed persistence.
 *
 * Requirements: 12.3, 12.5, 13.2, 13.3
 */

import { describe, it, expect, vi } from 'vitest';
import { Recorder, InvalidRecordingError, MAX_FRAMES } from './Recorder.js';
import type { RecordingLabels } from '../types.js';
import type { Keypoint } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A single tiny keypoint array so the frame-cap test stays cheap. */
function tinyKeypoints(): Keypoint[] {
  return [{ index: 0, x: 0.5, y: 0.4, z: 0, confidence: 0.9 }];
}

/** Capture N frames onto an already-started recorder. */
function captureN(rec: Recorder, n: number, kp: Keypoint[] = tinyKeypoints()): void {
  for (let i = 0; i < n; i += 1) {
    rec.capture(kp, i);
  }
}

/** A valid labels object usable across tests. */
function validLabels(): RecordingLabels {
  return {
    exerciseName: 'BackSquat',
    repBoundaries: [{ startFrame: 0, endFrame: 2 }],
    qualityRating: 4,
    frameErrors: { 1: ['knee_valgus'] },
  };
}

// ---------------------------------------------------------------------------
// Capture lifecycle
// ---------------------------------------------------------------------------

describe('Recorder capture lifecycle', () => {
  it('reports frame count and recording state through start/capture/stop', () => {
    const rec = new Recorder();
    expect(rec.isRecording()).toBe(false);

    rec.start('BackSquat', 'movenet-thunder');
    expect(rec.isRecording()).toBe(true);
    expect(rec.getFrameCount()).toBe(0);

    captureN(rec, 5);
    expect(rec.getFrameCount()).toBe(5);

    rec.stop();
    expect(rec.isRecording()).toBe(false);
  });

  it('capture() is a no-op before start()', () => {
    const rec = new Recorder();
    rec.capture(tinyKeypoints(), 0);
    rec.capture(tinyKeypoints(), 1);
    expect(rec.getFrameCount()).toBe(0);
  });

  it('start() resets frames from a previous session', () => {
    const rec = new Recorder();
    rec.start('BackSquat', 'm1');
    captureN(rec, 3);
    rec.stop();

    rec.start('Deadlift', 'm2');
    expect(rec.getFrameCount()).toBe(0);
    expect(rec.isRecording()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stop() session shape
// ---------------------------------------------------------------------------

describe('Recorder.stop', () => {
  it('returns a schemaVersion-1 session with uuid id, metadata, and frames', () => {
    const rec = new Recorder();
    rec.start('BackSquat', 'movenet-thunder');
    rec.capture(tinyKeypoints(), 0);
    rec.capture(tinyKeypoints(), 100);
    const session = rec.stop();

    expect(session.schemaVersion).toBe(1);
    expect(typeof session.id).toBe('string');
    // UUID v4 shape.
    expect(session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(session.metadata.exerciseName).toBe('BackSquat');
    expect(session.metadata.modelId).toBe('movenet-thunder');
    expect(typeof session.metadata.createdMs).toBe('number');
    expect(session.metadata.durationMs).toBe(100);
    expect(session.frames).toHaveLength(2);
    expect(session.frames[0]?.keypoints[0]?.x).toBe(0.5);
  });

  it('derives durationMs of 0 when fewer than two frames captured', () => {
    const rec = new Recorder();
    rec.start('BackSquat', 'm1');
    rec.capture(tinyKeypoints(), 42);
    const session = rec.stop();
    expect(session.metadata.durationMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Frame cap
// ---------------------------------------------------------------------------

describe('Recorder frame cap', () => {
  it('stops appending at MAX_FRAMES and drops further captures', () => {
    const rec = new Recorder();
    rec.start('BackSquat', 'm1');
    const kp = tinyKeypoints();
    for (let i = 0; i < MAX_FRAMES + 2; i += 1) {
      rec.capture(kp, i);
    }
    expect(rec.getFrameCount()).toBe(MAX_FRAMES);
    expect(rec.isCapReached()).toBe(true);
  });

  it('does not flag cap reached below the limit', () => {
    const rec = new Recorder();
    rec.start('BackSquat', 'm1');
    captureN(rec, 10);
    expect(rec.isCapReached()).toBe(false);
    expect(rec.getFrameCount()).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Label validation
// ---------------------------------------------------------------------------

describe('Recorder.setLabels validation', () => {
  it('accepts valid labels', () => {
    const rec = new Recorder();
    rec.start('BackSquat', 'm1');
    expect(() => rec.setLabels(validLabels())).not.toThrow();
  });

  it('throws InvalidRecordingError when qualityRating is out of 1..5', () => {
    const rec = new Recorder();
    const labels = { ...validLabels(), qualityRating: 6 as unknown as 1 };
    expect(() => rec.setLabels(labels)).toThrow(InvalidRecordingError);
  });

  it('throws InvalidRecordingError when repBoundaries is not an array', () => {
    const rec = new Recorder();
    const labels = {
      ...validLabels(),
      repBoundaries: 'nope' as unknown as RecordingLabels['repBoundaries'],
    };
    expect(() => rec.setLabels(labels)).toThrow(InvalidRecordingError);
  });
});

// ---------------------------------------------------------------------------
// Export / import round-trip
// ---------------------------------------------------------------------------

describe('Recorder export/import round-trip', () => {
  it('exportJson then importJson yields an equal RecordingSession', async () => {
    const rec = new Recorder();
    rec.start('BackSquat', 'movenet-thunder');
    rec.setLabels(validLabels());
    rec.capture(
      [
        { index: 0, x: 0.1, y: 0.2, z: 0.01, confidence: 0.8 },
        { index: 1, x: 0.3, y: 0.4, z: 0.02, confidence: 0.7 },
      ],
      0,
    );
    rec.capture([{ index: 0, x: 0.5, y: 0.6, z: 0.03, confidence: 0.9 }], 33);
    const session = rec.stop();

    const blob = rec.exportJson(session);
    const text = await blob.text();
    const imported = rec.importJson(text);

    expect(imported).toEqual(session);
    expect(imported.frames).toEqual(session.frames);
    expect(imported.labels).toEqual(session.labels);
    expect(imported.metadata).toEqual(session.metadata);
  });

  it('throws InvalidRecordingError on malformed JSON', () => {
    const rec = new Recorder();
    expect(() => rec.importJson('{not valid json')).toThrow(InvalidRecordingError);
  });

  it('throws InvalidRecordingError on wrong schemaVersion', () => {
    const rec = new Recorder();
    rec.start('BackSquat', 'm1');
    const session = rec.stop();
    const mutated = { ...session, schemaVersion: 2 };
    expect(() => rec.importJson(JSON.stringify(mutated))).toThrow(
      InvalidRecordingError,
    );
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('Recorder.persist', () => {
  it('calls store.saveRecording when a store is injected', async () => {
    const saveRecording = vi.fn().mockResolvedValue(undefined);
    // Stub store shaped like the ResultStore surface Recorder.persist uses.
    const rec = new Recorder({ store: { saveRecording } as never });

    rec.start('BackSquat', 'm1');
    rec.capture(tinyKeypoints(), 0);
    const session = rec.stop();

    await rec.persist(session);
    expect(saveRecording).toHaveBeenCalledTimes(1);
    expect(saveRecording).toHaveBeenCalledWith(session);
  });

  it('is a no-op when no store is injected', async () => {
    const rec = new Recorder();
    rec.start('BackSquat', 'm1');
    const session = rec.stop();
    await expect(rec.persist(session)).resolves.toBeUndefined();
  });
});
