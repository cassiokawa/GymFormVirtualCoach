/**
 * Live demo — connects your webcam to the full pose analysis pipeline.
 * Uses MediaPipe PoseLandmarker directly on the main thread for simplicity.
 *
 * Pre-tracking integration: gates rep counting behind the PreTrackingController
 * (framing → positioning → locking → active).
 */

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Keypoint, KeypointMessage, ExerciseFSMConfig, PreTrackingStatus, PositionCue, DeviationEvent, Session } from '../types/index.js';
import { RepCounter } from '../repCounter/RepCounter.js';
import { FormEvaluator } from '../formEvaluator/FormEvaluator.js';
import { SafetyMonitor } from '../safetyMonitor/SafetyMonitor.js';
import { AlertSystem } from '../alertSystem/AlertSystem.js';
import { PreTrackingController } from '../preTracking/PreTrackingController.js';
import { allConfigs } from '../config/exerciseConfigs.js';
import { EXERCISE_CATALOG, getExerciseByName } from '../config/exerciseCatalog.js';
import { RoutineMode } from './routineMode.js';
import { Storage } from '../storage/Storage.js';
import { ExerciseLogPanel } from '../exerciseLog/ExerciseLogPanel.js';

// ---------------------------------------------------------------------------
// DOM elements
// ---------------------------------------------------------------------------

const video = document.getElementById('video') as HTMLVideoElement;
const canvas = document.getElementById('overlay') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const uiCanvas = document.getElementById('ui-overlay') as HTMLCanvasElement;
const uiCtx = uiCanvas.getContext('2d')!;
const countdownOverlay = document.getElementById('countdown-overlay')!;
const statusEl = document.getElementById('status')!;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
const skipBtn = document.getElementById('skipBtn') as HTMLButtonElement;
const exerciseSelect = document.getElementById('exerciseSelect') as HTMLSelectElement;
const sensitivitySlider = document.getElementById('sensitivitySlider') as HTMLInputElement;
const sensitivityValue = document.getElementById('sensitivityValue')!;
const framingSlider = document.getElementById('framingSlider') as HTMLInputElement;
const framingValue = document.getElementById('framingValue')!;
const repCountEl = document.getElementById('repCount')!;
const fsmStateEl = document.getElementById('fsmState')!;
const fpsEl = document.getElementById('fps')!;
const lastTutEl = document.getElementById('lastTut')!;
const videoContainer = document.getElementById('video-container')!;

// Stat cards that are hidden during pre-tracking
const statReps = document.getElementById('statReps')!;
const statFsm = document.getElementById('statFsm')!;
const statTut = document.getElementById('statTut')!;

// ---------------------------------------------------------------------------
// Routine Mode DOM elements
// ---------------------------------------------------------------------------

const routineListEl = document.getElementById('routine-list')!;
const routineExerciseAdd = document.getElementById('routineExerciseAdd') as HTMLSelectElement;
const routineRepsInput = document.getElementById('routineReps') as HTMLInputElement;
const addToRoutineBtn = document.getElementById('addToRoutine') as HTMLButtonElement;
const startRoutineBtn = document.getElementById('startRoutineBtn') as HTMLButtonElement;
const routineProgressEl = document.getElementById('routine-progress')!;
const routineProgressText = document.getElementById('routine-progress-text')!;
const routineProgressBar = document.getElementById('routine-progress-bar')!;

// ---------------------------------------------------------------------------
// Routine Mode instance
// ---------------------------------------------------------------------------

const routineMode = new RoutineMode();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let poseLandmarker: PoseLandmarker | null = null;
let animationFrameId: number | null = null;
let isRunning = false;
let frameCount = 0;
let lastFpsUpdate = performance.now();

let repCounter: RepCounter;
let formEvaluator: FormEvaluator;
let safetyMonitor: SafetyMonitor;
let alertSystem: AlertSystem;

// Pre-tracking state
let preTrackingActive = true;
let preTrackingController: PreTrackingController | null = null;

// ---------------------------------------------------------------------------
// Exercise Log
// ---------------------------------------------------------------------------

const logStorage = Storage.getInstance();
logStorage.open().catch(() => { /* IndexedDB might not be available in all envs */ });
const logPanel = new ExerciseLogPanel(logStorage);
logPanel.mount(document.getElementById('log-container')!);

// Track the exercise name and start time for session logging
let selectedExerciseName = '';
let sessionStartTime = 0;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function initMediaPipe(): Promise<void> {
  statusEl.textContent = 'Loading MediaPipe model...';

  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
  );

  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
  });

  statusEl.textContent = 'MediaPipe ready. Click Start to begin.';
}

async function initCamera(): Promise<void> {
  statusEl.textContent = 'Requesting camera access...';
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' },
  });
  video.srcObject = stream;
  await video.play();
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  uiCanvas.width = video.videoWidth;
  uiCanvas.height = video.videoHeight;
  statusEl.textContent = 'Camera active. Step into frame...';
}

function initPipeline(config: ExerciseFSMConfig): void {
  alertSystem = new AlertSystem(videoContainer);
  safetyMonitor = new SafetyMonitor(config, (event, alertType) => {
    alertSystem.trigger(event, alertType);
  });
  formEvaluator = new FormEvaluator(config, (event) => {
    safetyMonitor.onCriticalDeviation(event);
  });
  repCounter = new RepCounter(config);

  // Initialize pre-tracking
  preTrackingActive = true;
  preTrackingController = new PreTrackingController({
    canvas,
    config,
  });

  // Hide stat cards during pre-tracking
  statReps.style.display = 'none';
  statFsm.style.display = 'none';
  statTut.style.display = 'none';

  // Show skip button
  skipBtn.style.display = '';
}

// ---------------------------------------------------------------------------
// Pre-tracking UI helpers
// ---------------------------------------------------------------------------

function getStatusText(status: PreTrackingStatus): string {
  switch (status.state) {
    case 'framing':
      return `Framing: ${Math.round(status.framingScore * 100)}% — Step into the frame`;
    case 'positioning':
      return `Position: ${Math.round(status.startingPositionScore * 100)}% — Adjust your stance`;
    case 'locking':
      return `Locking: ${Math.round(status.lockProgress * 100)}% — Hold still...`;
    case 'active':
      return 'Tracking active. Counting reps...';
  }
}

function renderPositionCues(cues: PositionCue[]): void {
  const w = uiCanvas.width;
  const h = uiCanvas.height;

  uiCtx.font = '16px -apple-system, sans-serif';
  uiCtx.fillStyle = 'rgba(255, 220, 100, 0.95)';
  uiCtx.textAlign = 'center';

  const startY = h * 0.15;
  const lineHeight = 24;

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (!cue) continue;
    uiCtx.fillText(cue.message, w / 2, startY + i * lineHeight);
  }
}

function renderLockProgress(progress: number): void {
  const w = uiCanvas.width;
  const h = uiCanvas.height;
  const pct = Math.round(progress * 100);

  uiCtx.font = 'bold 28px -apple-system, sans-serif';
  uiCtx.fillStyle = 'rgba(0, 184, 148, 0.95)';
  uiCtx.textAlign = 'center';
  uiCtx.fillText(`${pct}%`, w / 2, h * 0.12);

  uiCtx.font = '14px -apple-system, sans-serif';
  uiCtx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  uiCtx.fillText('Hold still…', w / 2, h * 0.12 + 28);
}

/** Render form deviation warnings on the non-mirrored UI canvas. */
function renderFormWarnings(deviations: DeviationEvent[]): void {
  const w = uiCanvas.width;
  const h = uiCanvas.height;

  const startY = h * 0.85;
  const lineHeight = 20;

  for (let i = 0; i < Math.min(deviations.length, 3); i++) {
    const dev = deviations[i];
    if (!dev) continue;

    const isCritical = dev.severity === 'critical';
    const color = isCritical ? 'rgba(239, 68, 68, 0.95)' : 'rgba(251, 191, 36, 0.95)';
    const icon = isCritical ? '🛑' : '⚠️';
    const jointDisplay = dev.jointName.replace(/_/g, ' ');

    uiCtx.font = 'bold 14px -apple-system, sans-serif';
    uiCtx.fillStyle = color;
    uiCtx.textAlign = 'center';
    uiCtx.fillText(
      `${icon} ${jointDisplay}: ${dev.angleValue.toFixed(0)}° — ${isCritical ? 'STOP!' : 'Check form'}`,
      w / 2,
      startY - i * lineHeight,
    );
  }
}

function activateTracking(): void {
  preTrackingActive = false;

  // Show countdown before starting
  showCountdown(3).then(() => {
    // Show stat cards
    statReps.style.display = '';
    statFsm.style.display = '';
    statTut.style.display = '';

    // Hide skip button
    skipBtn.style.display = 'none';

    statusEl.textContent = 'Tracking active. Counting reps...';
  });
}

/** Show exercise-specific tutorial and then a 3-2-1 countdown using DOM overlay. */
async function showCountdown(seconds: number): Promise<void> {
  countdownOverlay.style.display = 'flex';

  // Get exercise-specific steps from the catalog
  const entry = getExerciseByName(selectedExerciseName);
  const steps = entry?.steps ?? ['Get into starting position', 'Perform the movement', 'Return to start'];
  const cameraAdvice = entry?.cameraAngle === 'side' ? '📷 Position camera to your SIDE'
    : entry?.cameraAngle === 'front' ? '📷 Position camera in FRONT of you'
    : '📷 Camera position: front or side';
  const exerciseName = entry?.displayName ?? selectedExerciseName.replace(/_/g, ' ');

  // Phase 0: Camera angle advice
  countdownOverlay.innerHTML = `
    <div style="font-size:2.5rem;">📷</div>
    <div style="font-size:1.2rem; font-weight:700; color:#00b894; margin-top:12px;">${cameraAdvice}</div>
    <div style="font-size:0.9rem; color:#aaa; margin-top:8px;">for best tracking accuracy</div>
  `;
  await sleep(2000);

  // Phase 1: Exercise-specific steps
  const exerciseEmojis: Record<string, string[]> = {
    barbell_squat: ['🧍', '🏋️', '⬇️', '⬆️'],
    push_up: ['🧎', '⬇️', '💪', '⬆️'],
    bicep_curl: ['🧍', '💪', '✊', '⬇️'],
    shoulder_press: ['🧍', '🙌', '⬆️', '⬇️'],
    lunge: ['🧍', '🚶', '⬇️', '⬆️'],
    lateral_raise: ['🧍', '↔️', '🙌', '⬇️'],
    calf_raise: ['🧍', '⬆️', '🦶', '⬇️'],
    conventional_deadlift: ['🧍', '↙️', '🏗️', '⬆️'],
    tricep_dip: ['💺', '⬇️', '💪', '⬆️'],
    jumping_jack: ['🧍', '⭐', '🙌', '🧍'],
    wall_sit: ['🧱', '⬇️', '🪑', '⏱️'],
    glute_bridge: ['🛋️', '⬆️', '🍑', '⬇️'],
    high_knees: ['🧍', '🦵', '🏃', '🔄'],
    sit_up: ['🛋️', '⬆️', '🧘', '⬇️'],
    overhead_tricep_extension: ['🙌', '⬇️', '🔱', '⬆️'],
    bent_over_row: ['↙️', '⬇️', '🚣', '⬆️'],
    pull_up: ['🧗', '⬆️', '💪', '⬇️'],
    band_assisted_pull_up: ['🪢', '🧗', '⬆️', '⬇️'],
    diamond_push_up: ['💎', '⬇️', '💪', '⬆️'],
    wide_push_up: ['↔️', '⬇️', '💪', '⬆️'],
    plank: ['🧎', '➡️', '🧘', '⏱️'],
    mountain_climber: ['🧎', '🦵', '🏃', '🔄'],
  };

  const emojis = exerciseEmojis[selectedExerciseName] ?? ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] ?? '';
    const emoji = emojis[i] ?? '▶️';
    countdownOverlay.innerHTML = `
      <div style="font-size:3rem;">${emoji}</div>
      <div style="font-size:0.85rem; color:#888; margin-top:8px;">${exerciseName} — Step ${i + 1}/${steps.length}</div>
      <div style="font-size:1rem; font-weight:600; color:#fff; margin-top:8px; max-width:80%; text-align:center;">${step}</div>
    `;
    await sleep(1500);
  }

  // Phase 2: Countdown 3-2-1-GO
  for (let i = seconds; i >= 1; i--) {
    countdownOverlay.innerHTML = `<div style="font-size:6rem; font-weight:bold; color:#00b894;">${i}</div>`;
    await sleep(1000);
  }

  // "GO!" flash
  countdownOverlay.innerHTML = `<div style="font-size:4rem; font-weight:bold; color:#fff;">GO!</div>`;
  countdownOverlay.style.background = 'rgba(0, 184, 148, 0.85)';
  await sleep(600);

  // Hide overlay
  countdownOverlay.style.display = 'none';
  countdownOverlay.style.background = 'rgba(0,0,0,0.75)';
  countdownOverlay.innerHTML = '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Routine Mode UI helpers
// ---------------------------------------------------------------------------

function renderRoutineList(): void {
  const entries = routineMode.getEntries();
  if (entries.length === 0) {
    routineListEl.innerHTML = '<div style="color:#666; font-size:0.8rem; padding:4px 0;">No exercises added yet.</div>';
    startRoutineBtn.disabled = true;
    startRoutineBtn.style.opacity = '0.5';
    return;
  }

  let html = '';
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    html += `<div class="routine-item">
      <span class="routine-num">${i + 1}.</span>
      <span class="routine-name">${entry.displayName}</span>
      <span class="routine-reps-badge">${entry.targetReps} reps</span>
      <button class="routine-remove" data-index="${i}" type="button">×</button>
    </div>`;
  }
  routineListEl.innerHTML = html;

  // Bind remove buttons
  routineListEl.querySelectorAll('.routine-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number((btn as HTMLElement).dataset['index']);
      routineMode.removeExercise(idx);
      renderRoutineList();
    });
  });

  startRoutineBtn.disabled = false;
  startRoutineBtn.style.opacity = '1';
}

function updateRoutineProgress(index: number, total: number): void {
  const pct = Math.round(((index) / total) * 100);
  routineProgressBar.style.width = `${pct}%`;
  const entry = routineMode.getCurrentEntry();
  const name = entry ? entry.displayName : '';
  routineProgressText.textContent = `Exercise ${index + 1} of ${total}: ${name}`;
}

function showTransitionFlash(exerciseName: string): void {
  const flash = document.createElement('div');
  flash.className = 'routine-transition-flash';
  flash.innerHTML = `<span class="flash-label">Next Exercise</span><span class="flash-name">${exerciseName}</span>`;
  videoContainer.appendChild(flash);
  setTimeout(() => {
    flash.remove();
  }, 1800);
}

function reinitPipelineForRoutine(config: ExerciseFSMConfig): void {
  // Reset core pipeline components for the new exercise
  repCounter = new RepCounter(config);
  formEvaluator = new FormEvaluator(config, (event) => {
    safetyMonitor.onCriticalDeviation(event);
  });
  safetyMonitor = new SafetyMonitor(config, (event, alertType) => {
    alertSystem.trigger(event, alertType);
  });

  // Reset pre-tracking for the new exercise
  preTrackingController = new PreTrackingController({ canvas, config });

  // We skip the pre-tracking on exercise change within a routine —
  // the user is already positioned
  preTrackingActive = false;

  // Update UI
  repCountEl.textContent = '0';
  fsmStateEl.textContent = 'START';
  lastTutEl.textContent = '—';
}

// ---------------------------------------------------------------------------
// Routine Mode callbacks
// ---------------------------------------------------------------------------

routineMode.onExerciseAdvance((entry, index, total) => {
  showTransitionFlash(entry.displayName);
  reinitPipelineForRoutine(entry.config);
  updateRoutineProgress(index, total);
});

routineMode.onRoutineComplete(() => {
  isRunning = false;
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  routineProgressBar.style.width = '100%';
  routineProgressText.textContent = '🎉 Routine Complete!';
  statusEl.textContent = '🎉 Routine Complete!';
  startBtn.disabled = false;
  stopBtn.disabled = true;
  exerciseSelect.disabled = false;
  startRoutineBtn.disabled = false;
  startRoutineBtn.style.opacity = '1';

  // Stop camera
  const stream = video.srcObject as MediaStream | null;
  stream?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
});

// ---------------------------------------------------------------------------
// Routine Mode button handlers
// ---------------------------------------------------------------------------

addToRoutineBtn.addEventListener('click', () => {
  const exerciseName = routineExerciseAdd.value;
  const reps = parseInt(routineRepsInput.value, 10) || 10;
  routineMode.addExercise(exerciseName, reps);
  renderRoutineList();
});

startRoutineBtn.addEventListener('click', async () => {
  const firstEntry = routineMode.start();
  if (!firstEntry) return;

  // Disable UI
  startBtn.disabled = true;
  stopBtn.disabled = false;
  exerciseSelect.disabled = true;
  startRoutineBtn.disabled = true;
  startRoutineBtn.style.opacity = '0.5';

  try {
    if (!poseLandmarker) await initMediaPipe();
    await initCamera();

    initPipeline(firstEntry.config);

    // Show progress
    routineProgressEl.style.display = '';
    updateRoutineProgress(0, routineMode.getLength());

    isRunning = true;
    lastTimestamp = -1;
    processFrame();
  } catch (err) {
    statusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    startRoutineBtn.disabled = false;
    startRoutineBtn.style.opacity = '1';
  }
});

// Initial render
renderRoutineList();

// ---------------------------------------------------------------------------
// Sensitivity sliders
// ---------------------------------------------------------------------------

sensitivitySlider.addEventListener('input', () => {
  sensitivityValue.textContent = sensitivitySlider.value;
});

framingSlider.addEventListener('input', () => {
  framingValue.textContent = framingSlider.value;
});

/**
 * Get the current sensitivity factor (1=forgiving, 10=strict).
 * Affects how wide the angle threshold windows are for FSM transitions.
 * At level 5 (default), thresholds are used as-is.
 * At level 1, windows expand by +20° each side.
 * At level 10, windows contract by -10° each side.
 */
function getSensitivityExpansion(): number {
  const level = parseInt(sensitivitySlider.value, 10);
  // Level 1 = +20° expansion (very forgiving), level 10 = -10° contraction (strict)
  return 20 - (level - 1) * (30 / 9); // ranges from +20 to -10
}

/**
 * Get the minimum confidence for joint angle calculation based on framing slider.
 * Level 1 = 0.5 (needs clear visibility), level 10 = 0.1 (works with anything)
 */
function getMinConfidence(): number {
  const level = parseInt(framingSlider.value, 10);
  return 0.5 - (level - 1) * (0.4 / 9); // ranges from 0.5 to 0.1
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

let lastTimestamp = -1;
let timestampOffset = 0; // Monotonic offset to ensure MediaPipe never gets a backwards timestamp

function processFrame(): void {
  if (!isRunning || !poseLandmarker) return;

  const now = performance.now();

  // Use a monotonically increasing timestamp for MediaPipe
  // This avoids the "Packet timestamp mismatch" error on stop/restart
  const timestamp = timestampOffset + performance.now();
  if (timestamp <= lastTimestamp) {
    animationFrameId = requestAnimationFrame(processFrame);
    return;
  }
  lastTimestamp = timestamp;

  const result = poseLandmarker.detectForVideo(video, timestamp);

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  uiCtx.clearRect(0, 0, uiCanvas.width, uiCanvas.height);

  if (result.landmarks && result.landmarks.length > 0) {
    const landmarks = result.landmarks[0]!;

    // Draw skeleton
    drawLandmarks(landmarks);

    // Convert to our Keypoint format
    const keypoints: Keypoint[] = landmarks.map((lm, index) => ({
      index,
      x: lm.x,
      y: lm.y,
      z: lm.z,
      confidence: lm.visibility ?? 0,
    }));

    const message: KeypointMessage = {
      type: 'keypoints',
      frameId: frameCount,
      timestampMs: now,
      keypoints,
    };

    // Pre-tracking gate: route through PreTrackingController first
    if (preTrackingActive && preTrackingController) {
      const status = preTrackingController.processFrame(message);

      // Update status text
      statusEl.textContent = getStatusText(status);

      // Render position cues on canvas during positioning state
      if (status.state === 'positioning') {
        renderPositionCues(status.positionCues);
      }

      // Render lock progress during locking state
      if (status.state === 'locking') {
        renderLockProgress(status.lockProgress);
      }

      // Check if lock achieved
      if (status.isLocked) {
        activateTracking();
      }

      // Don't process with RepCounter/FormEvaluator yet
      updateFps(now);
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

    // Active tracking — feed to pipeline
    const prevReps = repCounter.getRepCount();
    repCounter.update(message);
    const deviations = formEvaluator.evaluateFrame(message);

    // Show form warnings on the UI canvas (non-mirrored, readable)
    if (deviations.length > 0) {
      renderFormWarnings(deviations);
    }

    // Check if rep completed
    if (repCounter.getRepCount() > prevReps) {
      formEvaluator.setRepNumber(repCounter.getRepCount() + 1);
      alertSystem.dismiss();
    }

    // Routine auto-advance check
    if (routineMode.isRoutineActive()) {
      const advanced = routineMode.checkAdvance(repCounter.getRepCount());
      if (advanced) {
        // Pipeline was reinitialized or routine completed — skip rest of frame
        updateFps(now);
        animationFrameId = requestAnimationFrame(processFrame);
        return;
      }
    }

    // Update UI
    repCountEl.textContent = String(repCounter.getRepCount());
    fsmStateEl.textContent = repCounter.getState();
    const tut = repCounter.getLastRepTutMs();
    if (tut !== null) {
      lastTutEl.textContent = String(Math.round(tut));
    }
  }

  updateFps(now);
  animationFrameId = requestAnimationFrame(processFrame);
}

function updateFps(now: number): void {
  frameCount++;
  if (now - lastFpsUpdate > 1000) {
    const fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
    fpsEl.textContent = String(fps);
    frameCount = 0;
    lastFpsUpdate = now;
  }
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

const CONNECTIONS: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26],
  [25, 27], [26, 28], [27, 29], [28, 30], [27, 31], [28, 32],
];

function drawLandmarks(landmarks: Array<{ x: number; y: number; z: number; visibility?: number }>): void {
  const w = canvas.width;
  const h = canvas.height;

  // Draw connections
  ctx.strokeStyle = 'rgba(0, 184, 148, 0.7)';
  ctx.lineWidth = 2;
  for (const [i, j] of CONNECTIONS) {
    const a = landmarks[i];
    const b = landmarks[j];
    if (!a || !b) continue;
    if ((a.visibility ?? 0) < 0.5 || (b.visibility ?? 0) < 0.5) continue;
    ctx.beginPath();
    ctx.moveTo(a.x * w, a.y * h);
    ctx.lineTo(b.x * w, b.y * h);
    ctx.stroke();
  }

  // Draw joints
  for (const lm of landmarks) {
    if ((lm.visibility ?? 0) < 0.5) continue;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.beginPath();
    ctx.arc(lm.x * w, lm.y * h, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Button handlers
// ---------------------------------------------------------------------------

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  stopBtn.disabled = false;

  try {
    if (!poseLandmarker) await initMediaPipe();
    await initCamera();

    // Get selected exercise config
    const selectedName = exerciseSelect.value;
    const selectedConfig = allConfigs.find(c => c.exerciseName === selectedName) ?? allConfigs[0]!;
    
    selectedExerciseName = selectedName;
    sessionStartTime = Date.now();

    initPipeline(selectedConfig);
    exerciseSelect.disabled = true;
    isRunning = true;
    lastTimestamp = -1;
    processFrame();
  } catch (err) {
    statusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});

stopBtn.addEventListener('click', () => {
  isRunning = false;
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  alertSystem?.dismiss();

  // Persist completed session to exercise log
  const completedReps = repCounter.getCompletedReps();
  if (completedReps.length > 0) {
    const now = Date.now();
    const durationMs = now - sessionStartTime;
    const session: Session = {
      id: crypto.randomUUID(),
      startedAt: new Date(sessionStartTime),
      endedAt: new Date(now),
      durationMs,
      routineId: 'demo',
      sets: [{
        setNumber: 1,
        exerciseName: selectedExerciseName,
        reps: completedReps,
        actualTutMs: completedReps.reduce((s, r) => s + r.tutMs, 0),
        expectedTutMs: 30000,
        tutDeltaMs: completedReps.reduce((s, r) => s + r.tutMs, 0) - 30000,
      }],
    };
    logStorage.persist(session).catch(() => {});
    logPanel.addSession(session);
  }

  preTrackingActive = true;
  preTrackingController = null;
  statusEl.textContent = 'Stopped. Click Start to resume.';
  startBtn.disabled = false;
  stopBtn.disabled = true;
  skipBtn.style.display = 'none';
  exerciseSelect.disabled = false;

  // Bump timestamp offset so next session never sends a backwards timestamp to MediaPipe
  timestampOffset = lastTimestamp + 1000;

  // Show stat cards back
  statReps.style.display = '';
  statFsm.style.display = '';
  statTut.style.display = '';

  // Reset routine mode if it was active
  if (routineMode.isRoutineActive()) {
    routineMode.stop();
  }
  routineProgressEl.style.display = 'none';
  startRoutineBtn.disabled = routineMode.getLength() === 0;
  startRoutineBtn.style.opacity = routineMode.getLength() === 0 ? '0.5' : '1';

  // Stop camera
  const stream = video.srcObject as MediaStream | null;
  stream?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
});

skipBtn.addEventListener('click', () => {
  if (preTrackingController) {
    preTrackingController.skipLock();
    activateTracking();
  }
});

// ---------------------------------------------------------------------------
// Auto-init
// ---------------------------------------------------------------------------

initMediaPipe().catch((err) => {
  statusEl.textContent = `Failed to load model: ${err instanceof Error ? err.message : String(err)}`;
});
