/**
 * BodyModel3D — a rotatable 3D muscle-activation figure built entirely from
 * three.js primitive meshes (no external model assets required).
 *
 * Each muscle group is its own mesh so it can be recolored by activation
 * intensity and form quality. The figure auto-rotates slowly and can be dragged
 * to inspect the back. Because the geometry is generated in code, this can
 * never fail to load a missing asset.
 *
 * The analytics layer is fully decoupled: this consumes MuscleActivation[] just
 * like the 2D AnatomyView, so the two are interchangeable.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MuscleActivation } from './analytics.js';
import { type MuscleRegion, REGION_LABELS } from './muscleMap.js';

/** A named body part: one or more meshes tagged with the muscle region. */
interface BodyPart {
  region: MuscleRegion | null; // null = structural (head, joints) — not heat-mapped
  meshes: THREE.Mesh[];
}

/** Base (unworked) material color. */
const BASE_COLOR = new THREE.Color(0x3a4668);
const STRUCTURAL_COLOR = new THREE.Color(0x2a3350);

/** Compute a heat color from activation intensity + form quality. */
function heatColor(intensity: number, quality: number): THREE.Color {
  if (intensity <= 0.001) return BASE_COLOR.clone();
  // quality 1 -> teal (0,212,160); quality 0 -> amber/red (255,120,90)
  const r = (255 * (1 - quality) + 0 * quality) / 255;
  const g = (120 * (1 - quality) + 212 * quality) / 255;
  const b = (90 * (1 - quality) + 160 * quality) / 255;
  const worked = new THREE.Color(r, g, b);
  // Blend from base toward the heat color by intensity.
  return BASE_COLOR.clone().lerp(worked, Math.min(1, 0.25 + 0.75 * intensity));
}

export class BodyModel3D {
  private readonly container: HTMLElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;
  private parts: BodyPart[] = [];
  private raf = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;
  private hoverLabel: HTMLElement | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private meshRegion = new WeakMap<THREE.Mesh, { region: MuscleRegion; act: MuscleActivation }>();

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Whether WebGL is available; callers can fall back to the 2D view if not. */
  static isSupported(): boolean {
    try {
      const canvas = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
    } catch {
      return false;
    }
  }

  /** Build the scene and start rendering. Call {@link update} to apply data. */
  init(): void {
    const width = this.container.clientWidth || 320;
    const height = 380;

    const scene = new THREE.Scene();
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
    camera.position.set(0, 0.2, 6.2);
    this.camera = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setSize(width, height);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = 'auto';
    renderer.domElement.style.cursor = 'grab';
    this.renderer = renderer;
    this.container.appendChild(renderer.domElement);

    // Hover label overlay.
    const label = document.createElement('div');
    label.style.cssText =
      'position:absolute; pointer-events:none; padding:4px 8px; border-radius:6px; background:rgba(10,16,32,0.9); border:1px solid rgba(255,255,255,0.15); font-size:0.72rem; color:#eee; display:none; z-index:5; white-space:nowrap;';
    this.container.style.position = 'relative';
    this.container.appendChild(label);
    this.hoverLabel = label;

    // Lights.
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(3, 5, 6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.5);
    rim.position.set(-4, 2, -4);
    scene.add(rim);

    // Orbit controls (rotate/zoom, no pan).
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableZoom = true;
    controls.minDistance = 4;
    controls.maxDistance = 9;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.1;
    controls.target.set(0, 0, 0);
    controls.addEventListener('start', () => { controls.autoRotate = false; });
    this.controls = controls;

    this.buildFigure();
    this.bindHover();
    this.observeResize();
    this.animate();
  }

  /** Recolor muscles from activation data. */
  update(activations: MuscleActivation[]): void {
    const byRegion = new Map<MuscleRegion, MuscleActivation>();
    for (const a of activations) byRegion.set(a.region, a);

    for (const part of this.parts) {
      const color = part.region
        ? heatColor(byRegion.get(part.region)?.intensity ?? 0, byRegion.get(part.region)?.quality ?? 0)
        : STRUCTURAL_COLOR.clone();
      for (const mesh of part.meshes) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.color.copy(color);
        if (part.region) {
          const act = byRegion.get(part.region);
          if (act) this.meshRegion.set(mesh, { region: part.region, act });
        }
      }
    }
  }

  /** Stop rendering and release GPU resources. */
  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.scene?.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    this.renderer?.dispose();
    if (this.renderer?.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  // --- Figure construction -------------------------------------------------

  private mat(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ color: BASE_COLOR.clone(), roughness: 0.7, metalness: 0.05 });
  }

  private addPart(region: MuscleRegion | null, ...meshes: THREE.Mesh[]): void {
    for (const m of meshes) this.scene!.add(m);
    this.parts.push({ region, meshes });
  }

  /** Capsule helper (radius, length along Y). */
  private capsule(r: number, len: number): THREE.Mesh {
    return new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 12), this.mat());
  }
  private sphere(r: number): THREE.Mesh {
    return new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), this.mat());
  }

  /**
   * Assemble a stylized humanoid from capsules/spheres. Units are arbitrary;
   * the figure spans roughly y in [-2.4, 2.4]. Left/right limbs mirror one
   * muscle region (we do not have reliable per-side data).
   */
  private buildFigure(): void {
    const mk = (mesh: THREE.Mesh, x: number, y: number, z: number, rotZ = 0): THREE.Mesh => {
      mesh.position.set(x, y, z);
      mesh.rotation.z = rotZ;
      return mesh;
    };

    // Head (structural).
    this.addPart(null, mk(this.sphere(0.34), 0, 2.05, 0));
    // Neck (structural).
    this.addPart(null, mk(this.capsule(0.13, 0.18), 0, 1.7, 0));

    // Shoulders (deltoids) — two caps at the top of the arms.
    this.addPart('shoulders',
      mk(this.sphere(0.26), -0.62, 1.5, 0),
      mk(this.sphere(0.26), 0.62, 1.5, 0));

    // Chest (front) + upper back share the torso-upper block visually; we use
    // a rounded box for the chest and a thinner slab behind it for back.
    const chest = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.72, 0.5), this.mat());
    this.addPart('chest', mk(chest, 0, 1.25, 0.06));
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.9, 0.22), this.mat());
    this.addPart('back', mk(back, 0, 1.15, -0.22));

    // Abs + obliques (front torso lower).
    const abs = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.7, 0.42), this.mat());
    this.addPart('abs', mk(abs, 0, 0.62, 0.1));
    this.addPart('obliques',
      mk(this.capsule(0.12, 0.5), -0.42, 0.62, 0.06),
      mk(this.capsule(0.12, 0.5), 0.42, 0.62, 0.06));

    // Upper arms: biceps (front) + triceps (back), left & right.
    this.addPart('biceps',
      mk(this.capsule(0.16, 0.6), -0.86, 1.0, 0.08, 0.12),
      mk(this.capsule(0.16, 0.6), 0.86, 1.0, 0.08, -0.12));
    this.addPart('triceps',
      mk(this.capsule(0.15, 0.6), -0.86, 1.0, -0.14, 0.12),
      mk(this.capsule(0.15, 0.6), 0.86, 1.0, -0.14, -0.12));

    // Forearms.
    this.addPart('forearms',
      mk(this.capsule(0.13, 0.55), -1.02, 0.42, 0.02, 0.18),
      mk(this.capsule(0.13, 0.55), 1.02, 0.42, 0.02, -0.18));

    // Hip/pelvis (structural) + glutes (back) + hip flexors (front).
    this.addPart(null, mk(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.4, 0.46), this.mat()), 0, 0.18, 0));
    this.addPart('glutes',
      mk(this.sphere(0.28), -0.22, 0.02, -0.18),
      mk(this.sphere(0.28), 0.22, 0.02, -0.18));
    this.addPart('hipFlexors',
      mk(this.capsule(0.12, 0.2), -0.22, 0.06, 0.2),
      mk(this.capsule(0.12, 0.2), 0.22, 0.06, 0.2));

    // Thighs: quads (front) + hamstrings (back).
    this.addPart('quads',
      mk(this.capsule(0.2, 0.8), -0.26, -0.55, 0.08),
      mk(this.capsule(0.2, 0.8), 0.26, -0.55, 0.08));
    this.addPart('hamstrings',
      mk(this.capsule(0.18, 0.8), -0.26, -0.55, -0.12),
      mk(this.capsule(0.18, 0.8), 0.26, -0.55, -0.12));

    // Calves.
    this.addPart('calves',
      mk(this.capsule(0.15, 0.7), -0.26, -1.6, -0.02),
      mk(this.capsule(0.15, 0.7), 0.26, -1.6, -0.02));

    // Feet (structural).
    this.addPart(null,
      mk(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.5), this.mat()), -0.26, -2.15, 0.12),
      mk(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.5), this.mat()), 0.26, -2.15, 0.12));
  }

  // --- Interaction / loop --------------------------------------------------

  private bindHover(): void {
    const dom = this.renderer!.domElement;
    dom.addEventListener('pointermove', (e: PointerEvent) => {
      const rect = dom.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.updateHover(e.clientX - rect.left, e.clientY - rect.top);
    });
    dom.addEventListener('pointerleave', () => {
      if (this.hoverLabel) this.hoverLabel.style.display = 'none';
    });
  }

  private updateHover(px: number, py: number): void {
    if (!this.camera || !this.scene || !this.hoverLabel) return;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.scene.children, false);
    const hit = hits.find((h) => h.object instanceof THREE.Mesh && this.meshRegion.has(h.object as THREE.Mesh));
    if (hit) {
      const info = this.meshRegion.get(hit.object as THREE.Mesh)!;
      this.hoverLabel.textContent =
        `${REGION_LABELS[info.region]} — ${Math.round(info.act.intensity * 100)}% activation, ${Math.round(info.act.quality * 100)}% form`;
      this.hoverLabel.style.left = `${px + 12}px`;
      this.hoverLabel.style.top = `${py + 12}px`;
      this.hoverLabel.style.display = 'block';
    } else {
      this.hoverLabel.style.display = 'none';
    }
  }

  private observeResize(): void {
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.renderer || !this.camera) return;
      const width = this.container.clientWidth || 320;
      const height = 380;
      this.renderer.setSize(width, height);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    });
    this.resizeObserver.observe(this.container);
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.animate);
    this.controls?.update();
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  };
}
