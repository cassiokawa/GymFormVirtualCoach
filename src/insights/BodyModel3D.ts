/**
 * BodyModel3D — loads a real anatomical muscle model (BodyParts3D/Z-Anatomy
 * derived, CC-BY-SA licensed) and heat-maps each muscle by activation/quality.
 *
 * The model is a 25MB glTF binary containing 468 individually-named muscle
 * meshes (e.g. "rectus femoris of right thigh", "biceps brachii long head").
 * Each mesh is mapped to one of our `MuscleRegion` categories by keyword
 * matching, then colored by activation intensity and form quality.
 *
 * Attribution: "BodyParts3D, (c) The Database Center for Life Science licensed
 * under CC Attribution-Share Alike 2.1 Japan" + Z-Anatomy (CC-BY-SA 4.0).
 * Model assembled by JohanBellander/BodyExplorer.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { MuscleActivation } from './analytics.js';
import { type MuscleRegion, REGION_LABELS } from './muscleMap.js';

/** Model file path (served from public/models/). */
const MODEL_URL = '/models/anatomy.glb';

/**
 * Heatmap color scheme:
 * - Cold (blue/cyan): neglected/undertrained muscles
 * - Neutral (dark grey): unmapped muscles with no data
 * - Warm (orange → red): heavily exercised muscles
 * - Injury risk (purple/magenta): muscles with poor form quality (<50%)
 */
const COLOR_COLD = new THREE.Color(0x1a6bff);       // bright blue — forgotten
const COLOR_COOL = new THREE.Color(0x22aadd);       // cyan — lightly worked
const COLOR_WARM = new THREE.Color(0xff8c00);       // orange — moderately worked
const COLOR_HOT = new THREE.Color(0xff2200);        // red — heavily exercised
const COLOR_INJURY = new THREE.Color(0xcc00ff);     // purple/magenta — injury risk
const BASE_COLOR = new THREE.Color(0x2a3350);       // neutral grey — unmapped

/** Map mesh English names to our MuscleRegion by keyword. */
function classifyMesh(name: string): MuscleRegion | null {
  const n = name.toLowerCase();
  // Order matters: more specific checks first.
  if (n.includes('pectoralis')) return 'chest';
  if (n.includes('deltoid')) return 'shoulders';
  if (n.includes('trapezius')) return 'shoulders';
  if (n.includes('biceps brachii')) return 'biceps';
  if (n.includes('triceps brachii')) return 'triceps';
  if (n.includes('brachioradialis') || n.includes('pronator') || n.includes('supinator') || (n.includes('flexor') && !n.includes('hip')) || (n.includes('extensor') && n.includes('digit'))) return 'forearms';
  if (n.includes('rectus abdominis') || n.includes('transversus abdominis')) return 'abs';
  if (n.includes('oblique')) return 'obliques';
  if (n.includes('latissimus') || n.includes('erector spinae') || n.includes('rhomboid') || n.includes('infraspinatus') || n.includes('supraspinatus') || n.includes('teres') || n.includes('serratus anterior')) return 'back';
  if (n.includes('gluteus')) return 'glutes';
  if (n.includes('iliacus') || n.includes('psoas') || n.includes('tensor fasciae')) return 'hipFlexors';
  if (n.includes('rectus femoris') || n.includes('vastus') || n.includes('sartorius')) return 'quads';
  if (n.includes('biceps femoris') || n.includes('semitendinosus') || n.includes('semimembranosus')) return 'hamstrings';
  if (n.includes('gastrocnemius') || n.includes('soleus') || n.includes('tibialis') || n.includes('peroneus') || n.includes('fibularis')) return 'calves';
  // Catch-all: many small hand/foot/deep muscles don't map to our tracked groups.
  return null;
}

/**
 * Compute material properties using a thermal heatmap + injury overlay:
 *
 * Volume axis (intensity 0→1):
 *   0.0       → cold blue (neglected)
 *   0.0–0.3   → cool cyan
 *   0.3–0.6   → warm orange
 *   0.6–1.0   → hot red (heavily trained)
 *
 * Injury overlay (quality < 0.5):
 *   Muscles with poor form quality get a purple/magenta tint that overrides
 *   the heat gradient, signaling injury risk. The worse the form, the stronger
 *   the purple.
 */
function heatMaterial(intensity: number, quality: number): { color: THREE.Color; emissive: THREE.Color; emissiveIntensity: number } {
  // No data at all: dark neutral.
  if (intensity <= 0.001) {
    return { color: BASE_COLOR.clone(), emissive: new THREE.Color(0, 0, 0), emissiveIntensity: 0 };
  }

  // Thermal gradient based on training volume.
  let baseHeat: THREE.Color;
  if (intensity < 0.25) {
    // Cold → cool (blue to cyan).
    baseHeat = COLOR_COLD.clone().lerp(COLOR_COOL, intensity / 0.25);
  } else if (intensity < 0.5) {
    // Cool → warm (cyan to orange).
    baseHeat = COLOR_COOL.clone().lerp(COLOR_WARM, (intensity - 0.25) / 0.25);
  } else {
    // Warm → hot (orange to red).
    baseHeat = COLOR_WARM.clone().lerp(COLOR_HOT, (intensity - 0.5) / 0.5);
  }

  // Injury risk overlay: poor form (quality < 0.5) shifts toward purple.
  let finalColor: THREE.Color;
  let emissiveBoost = 0;
  if (quality < 0.5) {
    // Stronger purple the worse the form (quality 0.5→0 maps to 0→1 purple blend).
    const injuryStrength = 1 - quality * 2; // 0 at quality=0.5, 1 at quality=0.
    finalColor = baseHeat.clone().lerp(COLOR_INJURY, injuryStrength * 0.7);
    emissiveBoost = injuryStrength * 0.3;
  } else {
    finalColor = baseHeat;
  }

  return {
    color: finalColor,
    emissive: finalColor.clone().multiplyScalar(0.15 + emissiveBoost),
    emissiveIntensity: 0.4 + intensity * 0.5 + emissiveBoost,
  };
}

export class BodyModel3D {
  private readonly container: HTMLElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;
  private raf = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;
  private hoverLabel: HTMLElement | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  /** Map from mesh → its classified region + current activation. */
  private meshInfo = new WeakMap<THREE.Mesh, { region: MuscleRegion; act?: MuscleActivation }>();
  /** All muscle meshes grouped by region for batch recoloring. */
  private regionMeshes = new Map<MuscleRegion, THREE.Mesh[]>();
  /** Cached activations so they can be re-applied after async model load. */
  private lastActivations: MuscleActivation[] = [];

  private loadingEl: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  static isSupported(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch { return false; }
  }

  /** Build the scene, start the render loop, and begin loading the model. */
  init(): void {
    const width = this.container.clientWidth || 340;
    const height = 440;

    const scene = new THREE.Scene();
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(32, width / height, 0.01, 50);
    camera.position.set(0, 0.85, 3.2);
    this.camera = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = 'auto';
    renderer.domElement.style.cursor = 'grab';
    this.renderer = renderer;
    this.container.appendChild(renderer.domElement);

    // Loading indicator.
    const loading = document.createElement('div');
    loading.style.cssText = 'position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--text-dim); font-size:0.8rem; pointer-events:none;';
    loading.textContent = 'Loading anatomy model…';
    this.container.style.position = 'relative';
    this.container.appendChild(loading);
    this.loadingEl = loading;

    // Hover label.
    const label = document.createElement('div');
    label.style.cssText = 'position:absolute; pointer-events:none; padding:5px 10px; border-radius:8px; background:rgba(10,16,32,0.92); border:1px solid rgba(255,255,255,0.15); font-size:0.72rem; color:#eee; display:none; z-index:5; white-space:nowrap;';
    this.container.appendChild(label);
    this.hoverLabel = label;

    // Lights.
    scene.add(new THREE.HemisphereLight(0xaaccff, 0x223344, 0.65));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(2, 4, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x8899cc, 0.4);
    fill.position.set(-3, 1, 3);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0x55ccff, 0.5);
    rim.position.set(-1, 2, -4);
    scene.add(rim);

    // Controls.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableZoom = true;
    controls.minDistance = 1.5;
    controls.maxDistance = 5;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.8;
    controls.target.set(0, 0.85, 0);
    controls.addEventListener('start', () => { controls.autoRotate = false; });
    this.controls = controls;

    this.bindHover();
    this.observeResize();
    this.animate();
    this.loadModel();
  }

  /** Apply activation data to the loaded model. */
  update(activations: MuscleActivation[]): void {
    this.lastActivations = activations;
    const byRegion = new Map<MuscleRegion, MuscleActivation>();
    for (const a of activations) byRegion.set(a.region, a);

    for (const [region, meshes] of this.regionMeshes) {
      const act = byRegion.get(region);
      const heat = heatMaterial(act?.intensity ?? 0, act?.quality ?? 0);
      for (const mesh of meshes) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.color.copy(heat.color);
        mat.emissive.copy(heat.emissive);
        mat.emissiveIntensity = heat.emissiveIntensity;
        if (act) this.meshInfo.set(mesh, { region, act });
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.renderer?.dispose();
    if (this.renderer?.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  // --- Model loading -------------------------------------------------------

  private loadModel(): void {
    const loader = new GLTFLoader();
    loader.load(
      MODEL_URL,
      (gltf) => {
        if (this.loadingEl) { this.loadingEl.style.display = 'none'; }

        const model = gltf.scene;
        // The anatomy model uses Z-up convention and is ~1672 units tall.
        // Rotate to Y-up, scale to ~1.7 units, and center in viewport.
        model.rotation.x = -Math.PI / 2; // Z-up → Y-up
        model.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());

        // Scale so the tallest dimension becomes ~1.7 units.
        const maxDim = Math.max(size.x, size.y, size.z);
        const targetHeight = 1.7;
        const scale = targetHeight / maxDim;
        model.scale.multiplyScalar(scale);

        // Recalculate bounds after scale.
        model.updateMatrixWorld(true);
        const box2 = new THREE.Box3().setFromObject(model);
        const center2 = box2.getCenter(new THREE.Vector3());

        // Center the model at origin, then shift up so feet are near y=0.
        model.position.sub(center2);
        model.position.y += targetHeight / 2;

        // Traverse and classify each mesh.
        model.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          const name = child.name || '';
          const region = classifyMesh(name);

          // Replace material with a uniform MeshStandard for consistent heat-mapping.
          const mat = new THREE.MeshStandardMaterial({
            color: BASE_COLOR.clone(),
            roughness: 0.52,
            metalness: 0.04,
            emissive: new THREE.Color(0, 0, 0),
            emissiveIntensity: 0,
          });
          child.material = mat;

          if (region) {
            this.meshInfo.set(child, { region });
            const arr = this.regionMeshes.get(region) ?? [];
            arr.push(child);
            this.regionMeshes.set(region, arr);
          }
        });

        this.scene!.add(model);

        // Re-apply activations that were set before the model finished loading.
        if (this.lastActivations.length > 0) {
          this.update(this.lastActivations);
        } else {
          // No workout data yet: color all classified muscles cold-blue so the
          // user sees the model is interactive (not just grey blobs).
          for (const [_region, meshes] of this.regionMeshes) {
            for (const mesh of meshes) {
              const mat = mesh.material as THREE.MeshStandardMaterial;
              mat.color.copy(COLOR_COLD);
              mat.emissive.copy(COLOR_COLD.clone().multiplyScalar(0.1));
              mat.emissiveIntensity = 0.3;
            }
          }
        }
      },
      undefined,
      (err) => {
        if (this.loadingEl) {
          this.loadingEl.textContent = `Failed to load anatomy model. ${err instanceof Error ? err.message : ''}`;
          this.loadingEl.style.color = 'var(--danger, #ff5a6a)';
        }
      },
    );
  }

  // --- Interaction ---------------------------------------------------------

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
    const hits = this.raycaster.intersectObjects(this.scene.children, true);
    const hit = hits.find((h) => h.object instanceof THREE.Mesh && this.meshInfo.has(h.object as THREE.Mesh));
    if (hit) {
      const info = this.meshInfo.get(hit.object as THREE.Mesh)!;
      let status: string;
      if (!info.act) {
        status = 'not worked';
      } else {
        const vol = Math.round(info.act.intensity * 100);
        const form = Math.round(info.act.quality * 100);
        const tag = info.act.quality < 0.5 ? ' ⚠️ injury risk' : '';
        status = `${vol}% volume · ${form}% form${tag}`;
      }
      this.hoverLabel.textContent = `${REGION_LABELS[info.region]} — ${status}`;
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
      const width = this.container.clientWidth || 340;
      const height = 440;
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
