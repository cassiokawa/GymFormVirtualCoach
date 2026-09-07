/**
 * Unit tests for joint reference resolution.
 *
 * Covers the two resolution rules (design.md, "Reference resolution";
 * Requirements 1.4, 1.5): unprefixed names resolve to the bilateral midpoint,
 * `left_`/`right_` names resolve to the named side landmark. Also covers the
 * "silence when uncertain" contract: below-threshold confidence and unresolved
 * names yield UNAVAILABLE.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveRef,
  makePoint3,
  isLandmarkConfident,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from './index';
import type { LandmarkPairs } from '../spec';
import type { LandmarkFrame } from '../types';
import { LANDMARK_COUNT, UNAVAILABLE } from '../types';

// MediaPipe Pose indices for hips: left = 23, right = 24.
const HIP_LEFT = 23;
const HIP_RIGHT = 24;
const KNEE_LEFT = 25;

const PAIRS: LandmarkPairs = {
  hip: { left: HIP_LEFT, right: HIP_RIGHT },
  knee: { left: KNEE_LEFT, right: 26 },
};

/**
 * Build a frame with all landmarks fully confident and their coordinates set to
 * a deterministic function of the index so assertions are unambiguous.
 * points[i] = [i, i + 0.1, i + 0.2].
 */
function makeFrame(): LandmarkFrame {
  const points = new Float32Array(LANDMARK_COUNT * 3);
  const visibility = new Float32Array(LANDMARK_COUNT).fill(1);
  const presence = new Float32Array(LANDMARK_COUNT).fill(1);
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    points[i * 3] = i;
    points[i * 3 + 1] = i + 0.1;
    points[i * 3 + 2] = i + 0.2;
  }
  return { t: 0, points, visibility, presence };
}

describe('resolveRef — unprefixed joint → bilateral midpoint', () => {
  it('resolves to the midpoint of the pair left/right landmarks', () => {
    const frame = makeFrame();
    const out = makePoint3();
    const result = resolveRef('hip', frame, PAIRS, out);
    expect(result).toBe(out);
    // midpoint of index 23 and 24
    expect(out[0]).toBeCloseTo((HIP_LEFT + HIP_RIGHT) / 2);
    expect(out[1]).toBeCloseTo((HIP_LEFT + 0.1 + HIP_RIGHT + 0.1) / 2);
    expect(out[2]).toBeCloseTo((HIP_LEFT + 0.2 + HIP_RIGHT + 0.2) / 2);
  });
});

describe('resolveRef — prefixed joint → named side landmark', () => {
  it('resolves left_ to the pair left index', () => {
    const frame = makeFrame();
    const out = makePoint3();
    const result = resolveRef('left_hip', frame, PAIRS, out);
    expect(result).toBe(out);
    expect(out[0]).toBeCloseTo(HIP_LEFT);
    expect(out[1]).toBeCloseTo(HIP_LEFT + 0.1);
    expect(out[2]).toBeCloseTo(HIP_LEFT + 0.2);
  });

  it('resolves right_ to the pair right index', () => {
    const frame = makeFrame();
    const out = makePoint3();
    const result = resolveRef('right_hip', frame, PAIRS, out);
    expect(result).toBe(out);
    expect(out[0]).toBeCloseTo(HIP_RIGHT);
    expect(out[1]).toBeCloseTo(HIP_RIGHT + 0.1);
    expect(out[2]).toBeCloseTo(HIP_RIGHT + 0.2);
  });
});

describe('resolveRef — silence when uncertain', () => {
  it('returns UNAVAILABLE for an unknown joint name', () => {
    const frame = makeFrame();
    const out = makePoint3();
    expect(resolveRef('elbow', frame, PAIRS, out)).toBe(UNAVAILABLE);
  });

  it('returns UNAVAILABLE for a prefixed name whose base is unknown', () => {
    const frame = makeFrame();
    const out = makePoint3();
    expect(resolveRef('left_elbow', frame, PAIRS, out)).toBe(UNAVAILABLE);
  });

  it('returns UNAVAILABLE when a side landmark is below threshold', () => {
    const frame = makeFrame();
    frame.visibility[HIP_LEFT] = DEFAULT_CONFIDENCE_THRESHOLD - 0.01;
    const out = makePoint3();
    expect(resolveRef('left_hip', frame, PAIRS, out)).toBe(UNAVAILABLE);
  });

  it('returns UNAVAILABLE for a midpoint when EITHER side is below threshold', () => {
    const frame = makeFrame();
    frame.presence[HIP_RIGHT] = DEFAULT_CONFIDENCE_THRESHOLD - 0.01;
    const out = makePoint3();
    expect(resolveRef('hip', frame, PAIRS, out)).toBe(UNAVAILABLE);
  });

  it('still resolves the confident side when only the other side is low', () => {
    const frame = makeFrame();
    frame.visibility[HIP_RIGHT] = 0; // right unusable
    const out = makePoint3();
    // left_hip is still confident, so it resolves.
    expect(resolveRef('left_hip', frame, PAIRS, out)).toBe(out);
    // but the unprefixed midpoint requires both → UNAVAILABLE.
    expect(resolveRef('hip', frame, PAIRS, makePoint3())).toBe(UNAVAILABLE);
  });
});

describe('resolveRef — allocation-conscious reuse', () => {
  it('writes into and returns the same provided buffer', () => {
    const frame = makeFrame();
    const out = makePoint3();
    const a = resolveRef('left_hip', frame, PAIRS, out);
    const b = resolveRef('right_hip', frame, PAIRS, out);
    expect(a).toBe(out);
    expect(b).toBe(out);
    // second call overwrote the buffer
    expect(out[0]).toBeCloseTo(HIP_RIGHT);
  });
});

describe('isLandmarkConfident', () => {
  it('is true when visibility and presence both meet the threshold', () => {
    const frame = makeFrame();
    expect(
      isLandmarkConfident(frame, HIP_LEFT, DEFAULT_CONFIDENCE_THRESHOLD),
    ).toBe(true);
  });

  it('is false at the boundary minus epsilon', () => {
    const frame = makeFrame();
    frame.visibility[HIP_LEFT] = DEFAULT_CONFIDENCE_THRESHOLD - 0.0001;
    expect(
      isLandmarkConfident(frame, HIP_LEFT, DEFAULT_CONFIDENCE_THRESHOLD),
    ).toBe(false);
  });

  it('is false for out-of-range and non-integer indices', () => {
    const frame = makeFrame();
    expect(isLandmarkConfident(frame, -1, 0.5)).toBe(false);
    expect(isLandmarkConfident(frame, LANDMARK_COUNT, 0.5)).toBe(false);
    expect(isLandmarkConfident(frame, 1.5, 0.5)).toBe(false);
  });
});
