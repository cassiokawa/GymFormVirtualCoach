/**
 * Unit tests for AnnotationTool.
 *
 * Requirements validated: 7.1, 7.2, 7.3, 7.4, 7.8
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AnnotationTool,
  LANDMARK_COUNT,
  type AnnotationToolDeps,
} from './AnnotationTool.js';
import type { ResultStore } from '../store/ResultStore.js';
import type { GroundTruthFrame } from '../types.js';

// ---------------------------------------------------------------------------
// Canvas mock
// ---------------------------------------------------------------------------

function makeStubContext() {
  return {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 40 })),
    save: vi.fn(),
    restore: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    font: '',
    textBaseline: '',
  };
}

/** A deterministic bounding rect so click math is reproducible. */
const RECT = { left: 100, top: 50, width: 400, height: 300 } as const;

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 300;
  vi.spyOn(canvas, 'getContext').mockReturnValue(
    makeStubContext() as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: RECT.left,
    top: RECT.top,
    width: RECT.width,
    height: RECT.height,
    right: RECT.left + RECT.width,
    bottom: RECT.top + RECT.height,
    x: RECT.left,
    y: RECT.top,
    toJSON: () => ({}),
  } as DOMRect);
  // Standard HTMLCanvasElement path: define a toBlob that yields a Blob.
  (canvas as unknown as { toBlob: (cb: (b: Blob | null) => void) => void }).toBlob = (
    cb,
  ) => cb(new Blob(['x']));
  return canvas;
}

/** Dispatch a click at absolute client coordinates. */
function clickAt(canvas: HTMLCanvasElement, clientX: number, clientY: number): void {
  canvas.dispatchEvent(
    new MouseEvent('click', { clientX, clientY, bubbles: true }),
  );
}

/** Minimal ResultStore stub cast to the real type. */
function makeStore(): ResultStore & {
  saveAnnotation: ReturnType<typeof vi.fn>;
  getAnnotation: ReturnType<typeof vi.fn>;
} {
  return {
    saveAnnotation: vi.fn().mockResolvedValue(undefined),
    getAnnotation: vi.fn().mockResolvedValue(null),
  } as unknown as ResultStore & {
    saveAnnotation: ReturnType<typeof vi.fn>;
    getAnnotation: ReturnType<typeof vi.fn>;
  };
}

function makeTool(): {
  tool: AnnotationTool;
  canvas: HTMLCanvasElement;
  store: ReturnType<typeof makeStore>;
} {
  const canvas = makeCanvas();
  const store = makeStore();
  const deps: AnnotationToolDeps = { canvas, store };
  const tool = new AnnotationTool(deps);
  return { tool, canvas, store };
}

beforeEach(() => {
  // createImageBitmap is used by loadForEdit; stub it globally.
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn().mockResolvedValue({} as ImageBitmap),
  );
  // crypto.randomUUID may be missing in jsdom; provide a deterministic stub.
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    vi.stubGlobal('crypto', {
      randomUUID: () => '00000000-0000-0000-0000-000000000000',
    });
  }
});

// A source image for loadFrame; drawImage is mocked so any object works.
const fakeImage = {} as unknown as HTMLImageElement;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnnotationTool', () => {
  // --- Req 7.1: click placement + normalized coords ---

  describe('selectKeypoint + click placement', () => {
    it('places a marker at the expected normalized coordinate', () => {
      const { tool, canvas } = makeTool();
      tool.loadFrame('vid-1', 0, fakeImage);
      tool.selectKeypoint(5);

      // Click at the center of the rect: (300, 200) → nx = 0.5, ny = 0.5.
      clickAt(canvas, RECT.left + RECT.width / 2, RECT.top + RECT.height / 2);

      const state = tool.getState();
      expect(state.points[5]).not.toBeNull();
      expect(state.points[5]!.x).toBeCloseTo(0.5, 5);
      expect(state.points[5]!.y).toBeCloseTo(0.5, 5);
    });

    it('maps a corner click to the expected normalized coordinate', () => {
      const { tool, canvas } = makeTool();
      tool.loadFrame('vid-1', 0, fakeImage);
      tool.selectKeypoint(0);

      // Click at rect.left + 100, rect.top + 60 → nx = 100/400 = 0.25, ny = 60/300 = 0.2
      clickAt(canvas, RECT.left + 100, RECT.top + 60);

      const state = tool.getState();
      expect(state.points[0]!.x).toBeCloseTo(0.25, 5);
      expect(state.points[0]!.y).toBeCloseTo(0.2, 5);
    });

    it('auto-advances selectedIndex to the next unassigned index after a click', () => {
      const { tool, canvas } = makeTool();
      tool.loadFrame('vid-1', 0, fakeImage);
      tool.selectKeypoint(0);

      clickAt(canvas, RECT.left + 10, RECT.top + 10);

      // Nothing else assigned yet, so it should advance to index 1.
      expect(tool.getState().selectedIndex).toBe(1);
    });
  });

  // --- Req 7.2: not-visible flag ---

  describe('markNotVisible', () => {
    it('sets the visibility flag and clears any placed point', () => {
      const { tool, canvas } = makeTool();
      tool.loadFrame('vid-1', 0, fakeImage);

      tool.selectKeypoint(3);
      clickAt(canvas, RECT.left + 40, RECT.top + 30); // place index 3
      expect(tool.getState().points[3]).not.toBeNull();

      tool.markNotVisible(3);

      const state = tool.getState();
      expect(state.notVisible[3]).toBe(true);
      expect(state.points[3]).toBeNull();
    });

    it('rejects an out-of-range index', () => {
      const { tool } = makeTool();
      tool.loadFrame('vid-1', 0, fakeImage);
      expect(() => tool.markNotVisible(33)).toThrow(RangeError);
    });
  });

  // --- Req 7.8: validation on save ---

  describe('save validation', () => {
    it('throws listing missing indices when not all 33 are assigned', async () => {
      const { tool, canvas } = makeTool();
      tool.loadFrame('vid-1', 0, fakeImage);

      // Assign only index 0.
      tool.selectKeypoint(0);
      clickAt(canvas, RECT.left + 5, RECT.top + 5);

      await expect(tool.save()).rejects.toThrow(/unassigned/);
      // The error should list at least a couple of the missing indices.
      await expect(tool.save()).rejects.toThrow(/1, 2/);
    });

    it('throws when no frame is loaded', async () => {
      const { tool } = makeTool();
      await expect(tool.save()).rejects.toThrow(/no frame loaded/);
    });
  });

  // --- Req 7.3: successful save ---

  describe('save success', () => {
    it('persists a GroundTruthFrame with 33 keypoints + 33 visibility flags', async () => {
      const { tool, canvas, store } = makeTool();
      tool.loadFrame('vid-42', 7, fakeImage);

      // Assign all 33: even indices placed via click, odd indices not-visible.
      for (let i = 0; i < LANDMARK_COUNT; i += 1) {
        if (i % 2 === 0) {
          tool.selectKeypoint(i);
          const nx = 0.1 + i * 0.001;
          const ny = 0.2;
          clickAt(canvas, RECT.left + nx * RECT.width, RECT.top + ny * RECT.height);
        } else {
          tool.markNotVisible(i);
        }
      }

      const frame = await tool.save();

      expect(store.saveAnnotation).toHaveBeenCalledTimes(1);
      const persisted = store.saveAnnotation.mock.calls[0]![0] as GroundTruthFrame;

      expect(persisted.keypoints).toHaveLength(LANDMARK_COUNT);
      expect(persisted.visibility).toHaveLength(LANDMARK_COUNT);
      expect(persisted.sourceVideoId).toBe('vid-42');
      expect(persisted.frameIndex).toBe(7);
      expect(persisted.imageRef).toBeInstanceOf(Blob);

      // Odd indices were marked not-visible.
      expect(persisted.visibility[1]).toBe(false);
      // Even indices placed → visible.
      expect(persisted.visibility[0]).toBe(true);

      // Round-trip: returned frame equals persisted argument.
      expect(frame).toBe(persisted);
    });
  });

  // --- Req 7.4: GroundTruthFrame round-trip via loadForEdit ---

  describe('loadForEdit round-trip', () => {
    it('loads a saved frame and reflects its coords/visibility in state', async () => {
      const { tool, store } = makeTool();

      const keypoints = Array.from({ length: LANDMARK_COUNT }, (_, i) => ({
        x: i / LANDMARK_COUNT,
        y: (LANDMARK_COUNT - i) / LANDMARK_COUNT,
      }));
      const visibility = Array.from({ length: LANDMARK_COUNT }, (_, i) => i % 3 !== 0);

      const saved: GroundTruthFrame = {
        id: 'gt-1',
        sourceVideoId: 'vid-9',
        frameIndex: 3,
        imageRef: new Blob(['img']),
        keypoints,
        visibility,
        createdMs: 123,
      };
      store.getAnnotation.mockResolvedValue(saved);

      await tool.loadForEdit('gt-1');

      const state = tool.getState();
      expect(state.editingId).toBe('gt-1');
      expect(state.sourceVideoId).toBe('vid-9');
      expect(state.frameIndex).toBe(3);

      // Visible indices restored their coords; not-visible cleared to null.
      for (let i = 0; i < LANDMARK_COUNT; i += 1) {
        if (visibility[i]) {
          expect(state.notVisible[i]).toBe(false);
          expect(state.points[i]!.x).toBeCloseTo(keypoints[i]!.x, 6);
          expect(state.points[i]!.y).toBeCloseTo(keypoints[i]!.y, 6);
        } else {
          expect(state.notVisible[i]).toBe(true);
          expect(state.points[i]).toBeNull();
        }
      }
    });

    it('throws when the annotation id is not found', async () => {
      const { tool, store } = makeTool();
      store.getAnnotation.mockResolvedValue(null);
      await expect(tool.loadForEdit('missing')).rejects.toThrow(/no saved annotation/);
    });
  });
});
