/**
 * AnatomyView — a lightweight 2D SVG body heat-map.
 *
 * Renders stylized front and back body silhouettes with muscle regions as SVG
 * paths. Each region is colored by activation intensity (0..1) and its opacity
 * scaled so heavily-worked muscles glow brighter. A quality tint shifts
 * well-executed muscles toward teal and poorly-executed ones toward amber/red.
 *
 * No external assets or 3D libraries — pure inline SVG, so it is fast,
 * responsive, and license-free. The analytics layer is decoupled, so this can
 * be swapped for a 3D renderer later without touching the metrics.
 */

import type { MuscleActivation } from './analytics.js';
import { type MuscleRegion, REGION_LABELS, REGION_VIEW } from './muscleMap.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Stylized region path data per view. Coordinates are in a 200x400 viewBox.
 * Shapes are intentionally simple blocks/ellipses that read as muscle groups
 * over a body outline — recognizable without being anatomically exact.
 */
interface RegionShape {
  region: MuscleRegion;
  /** SVG path `d` for the muscle blob. */
  d: string;
}

const FRONT_OUTLINE =
  'M100 18 C112 18 120 27 120 38 C120 47 115 53 112 56 C124 60 132 70 134 86 ' +
  'L140 150 C142 168 138 175 134 176 L128 130 L126 200 C126 230 122 250 120 268 ' +
  'L116 330 C116 355 112 372 108 388 L92 388 C88 372 84 355 84 330 L80 268 ' +
  'C78 250 74 230 74 200 L72 130 L66 176 C62 175 58 168 60 150 L66 86 ' +
  'C68 70 76 60 88 56 C85 53 80 47 80 38 C80 27 88 18 100 18 Z';

const BACK_OUTLINE = FRONT_OUTLINE; // mirror-symmetric silhouette works for both

const FRONT_SHAPES: RegionShape[] = [
  { region: 'shoulders', d: 'M70 66 q-10 4 -10 20 l8 2 q2 -14 10 -18 Z M130 66 q10 4 10 20 l-8 2 q-2 -14 -10 -18 Z' },
  { region: 'chest', d: 'M78 70 q22 -8 44 0 q2 18 -6 30 q-16 8 -32 0 q-8 -12 -6 -30 Z' },
  { region: 'biceps', d: 'M64 92 q-6 18 -4 34 l8 -2 q0 -18 4 -32 Z M136 92 q6 18 4 34 l-8 -2 q0 -18 -4 -32 Z' },
  { region: 'forearms', d: 'M58 128 q-4 16 -2 30 l7 -2 q0 -16 3 -28 Z M142 128 q4 16 2 30 l-7 -2 q0 -16 -3 -28 Z' },
  { region: 'abs', d: 'M86 104 q14 -4 28 0 l2 46 q-16 6 -32 0 Z' },
  { region: 'obliques', d: 'M78 108 q4 22 6 40 l4 -2 l-4 -40 Z M122 108 q-4 22 -6 40 l-4 -2 l4 -40 Z' },
  { region: 'hipFlexors', d: 'M84 152 q16 6 32 0 l-2 20 q-14 5 -28 0 Z' },
  { region: 'quads', d: 'M82 176 q10 4 16 0 l-2 66 q-8 4 -14 0 Z M118 176 q-10 4 -16 0 l2 66 q8 4 14 0 Z' },
];

const BACK_SHAPES: RegionShape[] = [
  { region: 'shoulders', d: 'M70 66 q-10 4 -10 20 l8 2 q2 -14 10 -18 Z M130 66 q10 4 10 20 l-8 2 q-2 -14 -10 -18 Z' },
  { region: 'back', d: 'M78 68 q22 -6 44 0 l6 60 q-28 12 -56 0 Z' },
  { region: 'triceps', d: 'M62 92 q-6 20 -4 36 l9 -2 q0 -20 3 -34 Z M138 92 q6 20 4 36 l-9 -2 q0 -20 -3 -34 Z' },
  { region: 'glutes', d: 'M80 168 q20 8 40 0 q2 20 -6 30 q-14 6 -28 0 q-8 -10 -6 -30 Z' },
  { region: 'hamstrings', d: 'M82 200 q10 4 16 0 l-2 54 q-8 3 -14 0 Z M118 200 q-10 4 -16 0 l2 54 q8 3 14 0 Z' },
  { region: 'calves', d: 'M84 268 q9 4 14 0 l-2 50 q-6 3 -10 0 Z M116 268 q-9 4 -14 0 l2 50 q6 3 10 0 Z' },
];

/** Interpolate activation intensity + quality into an rgb() fill. */
function regionFill(intensity: number, quality: number): string {
  if (intensity <= 0) return 'rgba(255,255,255,0.05)';
  // Hue: quality 1 -> teal (green-ish), quality 0 -> red/amber.
  // Teal ~ (0,212,160), Amber/red ~ (255,120,90).
  const r = Math.round(255 * (1 - quality) + 0 * quality);
  const g = Math.round(120 * (1 - quality) + 212 * quality);
  const b = Math.round(90 * (1 - quality) + 160 * quality);
  // Opacity scales with intensity so heavier work glows brighter.
  const alpha = 0.2 + 0.7 * Math.min(1, intensity);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
}

export interface AnatomyTooltip {
  region: MuscleRegion;
  label: string;
  intensity: number;
  quality: number;
}

/**
 * Renders the anatomy heat-map into a container. Returns nothing; call
 * {@link render} again with new data to update.
 */
export class AnatomyView {
  private readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Draw both views, heat-mapped by the supplied activations. */
  render(activations: MuscleActivation[]): void {
    const byRegion = new Map<MuscleRegion, MuscleActivation>();
    for (const a of activations) byRegion.set(a.region, a);

    this.container.replaceChildren(
      this.buildView('front', FRONT_OUTLINE, FRONT_SHAPES, byRegion),
      this.buildView('back', BACK_OUTLINE, BACK_SHAPES, byRegion),
    );
  }

  private buildView(
    view: 'front' | 'back',
    outline: string,
    shapes: RegionShape[],
    byRegion: Map<MuscleRegion, MuscleActivation>,
  ): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 200 400');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${view} body muscle activation`);
    svg.style.width = '100%';
    svg.style.maxWidth = '190px';
    svg.style.height = 'auto';

    // Body outline.
    const body = document.createElementNS(SVG_NS, 'path');
    body.setAttribute('d', outline);
    body.setAttribute('fill', 'rgba(255,255,255,0.06)');
    body.setAttribute('stroke', 'rgba(255,255,255,0.18)');
    body.setAttribute('stroke-width', '1.5');
    svg.appendChild(body);

    // Muscle regions on this view.
    for (const shape of shapes) {
      if (REGION_VIEW[shape.region] !== view) continue;
      const act = byRegion.get(shape.region);
      const intensity = act?.intensity ?? 0;
      const quality = act?.quality ?? 0;

      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', shape.d);
      path.setAttribute('fill', regionFill(intensity, quality));
      path.setAttribute('stroke', 'rgba(255,255,255,0.12)');
      path.setAttribute('stroke-width', '0.75');
      path.style.transition = 'fill 0.3s ease';
      const pct = Math.round(intensity * 100);
      const qpct = Math.round(quality * 100);
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = act
        ? `${REGION_LABELS[shape.region]} — ${pct}% activation, ${qpct}% form`
        : `${REGION_LABELS[shape.region]} — not worked`;
      path.appendChild(title);
      svg.appendChild(path);
    }

    // View label.
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', '100');
    label.setAttribute('y', '398');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', 'rgba(255,255,255,0.5)');
    label.setAttribute('font-size', '13');
    label.setAttribute('font-weight', '600');
    label.textContent = view === 'front' ? 'FRONT' : 'BACK';
    svg.appendChild(label);

    return svg;
  }
}
