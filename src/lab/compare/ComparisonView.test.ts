/**
 * Unit tests for ComparisonView.
 *
 * Requirements validated: 5.1, 5.2, 5.4, 5.5
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComparisonView, type ComparisonFrame } from './ComparisonView.js';
import type { Keypoint } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Canvas mock
// ---------------------------------------------------------------------------

interface StubContext {
  clearRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
  measureText: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
  font: string;
  textBaseline: string;
}

function makeStubContext(): StubContext {
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

/**
 * Stub `HTMLCanvasElement.getContext` globally so every canvas the view
 * creates receives its own stub context. Contexts are tracked so tests can
 * inspect draw calls per panel.
 */
let createdContexts: StubContext[] = [];

beforeEach(() => {
  createdContexts = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    const ctx = makeStubContext();
    createdContexts.push(ctx);
    return ctx as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext);
});

// ---------------------------------------------------------------------------
// Keypoint helpers
// ---------------------------------------------------------------------------

function makeKeypoint(index: number, x: number, y: number, confidence = 0.9): Keypoint {
  return { index, x, y, z: 0, confidence };
}

/** 33 visible keypoints laid out identically for every model. */
function makeUniformKeypoints(x = 0.5, y = 0.5): Keypoint[] {
  return Array.from({ length: 33 }, (_, i) => makeKeypoint(i, x, y));
}

/** A fake source frame; drawImage is mocked, so any object works. */
const fakeSource = {} as unknown as HTMLCanvasElement;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ComparisonView', () => {
  let container: HTMLDivElement;
  let view: ComparisonView;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    view = new ComparisonView(container);
  });

  // --- Req 5.1: panel cap ---

  describe('setModels', () => {
    it('caps panels at 4 even when more model ids are supplied', () => {
      view.setModels(['a', 'b', 'c', 'd', 'e', 'f']);

      const canvases = container.querySelectorAll('canvas');
      expect(canvases).toHaveLength(4);
    });

    it('creates one panel per model when at or below the cap', () => {
      view.setModels(['a', 'b', 'c']);

      const canvases = container.querySelectorAll('canvas');
      expect(canvases).toHaveLength(3);
    });

    it('rebuilds panels on subsequent calls', () => {
      view.setModels(['a', 'b', 'c', 'd']);
      view.setModels(['x', 'y']);

      const canvases = container.querySelectorAll('canvas');
      expect(canvases).toHaveLength(2);
    });
  });

  // --- Req 5.2: metric table 'N/A' rendering ---

  describe('setMetrics', () => {
    it("renders 'N/A' for a null OKS while showing numeric fps/median", () => {
      view.setModels(['modelA']);
      view.setMetrics(
        new Map([['modelA', { fps: 30, medianMs: 12.3, oks: null }]]),
      );

      const table = container.querySelector('table');
      expect(table).not.toBeNull();
      const text = table!.textContent ?? '';
      expect(text).toContain('N/A');
      expect(text).toContain('30.0');
      expect(text).toContain('12.3');
    });

    it('renders the numeric OKS when present', () => {
      view.setModels(['modelA']);
      view.setMetrics(
        new Map([['modelA', { fps: 24, medianMs: 40, oks: 0.812 }]]),
      );

      const text = container.querySelector('table')!.textContent ?? '';
      expect(text).toContain('0.812');
    });

    it("renders 'N/A' cells for a model with no metrics entry", () => {
      view.setModels(['modelA']);
      view.setMetrics(new Map());

      const text = container.querySelector('table')!.textContent ?? '';
      expect(text).toContain('N/A');
    });
  });

  // --- Req 5.4: divergence highlighting ---

  describe('showFrame divergence highlighting', () => {
    it('draws an enlarged-radius marker + ring for keypoints that diverge > 0.05', () => {
      view.setModels(['m1', 'm2']);

      // m1 and m2 identical everywhere except index 15 which differs by 0.2.
      const m1 = makeUniformKeypoints(0.5, 0.5);
      const m2 = makeUniformKeypoints(0.5, 0.5);
      m2[15] = makeKeypoint(15, 0.7, 0.5); // dx = 0.2 > threshold
      // index 11 stays identical (0.5, 0.5) in both.

      const frame: ComparisonFrame = {
        frameIndex: 0,
        perModel: new Map([
          ['m1', m1],
          ['m2', m2],
        ]),
      };

      view.showFrame(frame, fakeSource);

      // Two panels drew; inspect arc radii. Divergent joints draw an arc with
      // radius 6 (marker) and radius 9 (ring); normal joints draw radius 4.
      // Across both panels we expect at least two radius-6 and two radius-9
      // arcs (one divergent keypoint per panel).
      const panelContexts = createdContexts;
      expect(panelContexts.length).toBeGreaterThanOrEqual(2);

      const allArcCalls = panelContexts.flatMap((ctx) => ctx.arc.mock.calls);
      const radii = allArcCalls.map((call) => call[2] as number);

      const enlargedMarkers = radii.filter((r) => r === 6).length;
      const rings = radii.filter((r) => r === 9).length;
      const normalMarkers = radii.filter((r) => r === 4).length;

      // One divergent keypoint highlighted in each of the two panels.
      expect(enlargedMarkers).toBe(2);
      expect(rings).toBe(2);
      // The remaining 32 visible keypoints per panel draw normal markers.
      expect(normalMarkers).toBe(2 * 32);
    });

    it('draws no enlarged markers when all models agree within threshold', () => {
      view.setModels(['m1', 'm2']);

      const m1 = makeUniformKeypoints(0.5, 0.5);
      const m2 = makeUniformKeypoints(0.51, 0.5); // dx = 0.01 < threshold

      view.showFrame(
        { frameIndex: 0, perModel: new Map([['m1', m1], ['m2', m2]]) },
        fakeSource,
      );

      const radii = createdContexts
        .flatMap((ctx) => ctx.arc.mock.calls)
        .map((call) => call[2] as number);

      expect(radii.filter((r) => r === 6)).toHaveLength(0);
      expect(radii.filter((r) => r === 9)).toHaveLength(0);
    });

    it('does not throw and draws both panels for a normal frame', () => {
      view.setModels(['m1', 'm2']);
      const kps = makeUniformKeypoints();

      expect(() =>
        view.showFrame(
          { frameIndex: 0, perModel: new Map([['m1', kps], ['m2', kps]]) },
          fakeSource,
        ),
      ).not.toThrow();

      // Every panel cleared and drew the source frame.
      for (const ctx of createdContexts) {
        expect(ctx.clearRect).toHaveBeenCalled();
        expect(ctx.drawImage).toHaveBeenCalled();
      }
    });
  });

  // --- Req 5.5: per-panel error indicator ---

  describe('markPanelError', () => {
    it('shows the error banner with the message text', () => {
      view.setModels(['m1', 'm2']);
      view.markPanelError('m1', 'inference failed');

      const banners = Array.from(
        container.querySelectorAll('div'),
      ).filter((el) => (el.textContent ?? '').startsWith('Error:'));

      expect(banners).toHaveLength(1);
      const banner = banners[0]!;
      expect(banner.style.display).toBe('block');
      expect(banner.textContent).toContain('inference failed');
    });

    it('is a no-op for an unknown model id', () => {
      view.setModels(['m1']);
      expect(() => view.markPanelError('nope', 'x')).not.toThrow();

      const banners = Array.from(container.querySelectorAll('div')).filter((el) =>
        (el.textContent ?? '').startsWith('Error:'),
      );
      expect(banners).toHaveLength(0);
    });
  });
});
