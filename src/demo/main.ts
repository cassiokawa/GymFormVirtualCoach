/**
 * Live demo — connects your webcam to the full pose analysis pipeline.
 * Uses MediaPipe PoseLandmarker directly on the main thread for simplicity.
 *
 * Pre-tracking integration: gates rep counting behind the PreTrackingController
 * (framing → positioning → locking → active).
 */

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Keypoint, KeypointMessage, ExerciseFSMConfig, PreTrackingStatus, PositionCue } from '../types/index.js';
import { RepCounter } from '../repCounter/RepCounter.js';
import { FormEvaluator } from '../formEvaluator/FormEvaluator.js';
import { SafetyMonitor } from '../safetyMonitor/SafetyMonitor.js';
import { AlertSystem } from '../alertSystem/AlertSystem.js';
import { PreTrackingController } from '../preTracking/PreTrackingController.js';
import { squatConfig } from '../config/exerciseConfigs.js';

// ---------------------------------------------------------------------------
// DOM elements
// ---------------------------------------------------------------------------

const video = document.getElementById('video') as HTMLVideoElement;
const canvas = document.getElementById('overlay') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const statusEl = document.getElementById('status')!;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
const skipBtn = document.getElementById('skipBtn') as HTMLButtonElement;
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
  const w = canvas.width;
  const h = canvas.height;

  ctx.font = '16px -apple-system, sans-serif';
  ctx.fillStyle = 'rgba(255, 220, 100, 0.95)';
  ctx.textAlign = 'center';

  const startY = h * 0.15;
  const lineHeight = 24;

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (!cue) continue;
    ctx.fillText(cue.message, w / 2, startY + i * lineHeight);
  }
}

function renderLockProgress(progress: number): void {
  const w = canvas.width;
  const h = canvas.height;
  const pct = Math.round(progress * 100);

  ctx.font = 'bold 28px -apple-system, sans-serif';
  ctx.fillStyle = 'rgba(0, 184, 148, 0.95)';
  ctx.textAlign = 'center';
  ctx.fillText(`${pct}%`, w / 2, h * 0.12);

  ctx.font = '14px -apple-system, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.fillText('Hold still…', w / 2, h * 0.12 + 28);
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

/** Show a brief exercise animation and then a 3-2-1 countdown on the canvas. */
async function showCountdown(seconds: number): Promise<void> {
  const w = canvas.width;
  const h = canvas.height;

  // Phase 1: Brief exercise demonstration (show form guide frames)
  const guideFrames = [
    { text: '1. Stand tall, feet shoulder-width', emoji: '🧍' },
    { text: '2. Brace core, push hips back', emoji: '🏋️' },
    { text: '3. Lower until thighs parallel', emoji: '⬇️' },
    { text: '4. Drive through heels to stand', emoji: '⬆️' },
  ];

  for (const frame of guideFrames) {
    ctx.save();
    // Semi-transparent background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, w, h);

    // Emoji
    ctx.font = `${h * 0.15}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(frame.emoji, w / 2, h * 0.35);

    // Instruction text
    ctx.font = `bold ${Math.max(16, h * 0.04)}px -apple-system, sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(frame.text, w / 2, h * 0.6);

    ctx.restore();

    await sleep(1200);
    ctx.clearRect(0, 0, w, h);
  }

  // Phase 2: Countdown 3-2-1-GO
  for (let i = seconds; i >= 1; i--) {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, w, h);

    ctx.font = `bold ${h * 0.3}px -apple-system, sans-serif`;
    ctx.fillStyle = '#00b894';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i), w / 2, h / 2);

    ctx.restore();
    await sleep(1000);
    ctx.clearRect(0, 0, w, h);
  }

  // "GO!" flash
  ctx.save();
  ctx.fillStyle = 'rgba(0, 184, 148, 0.8)';
  ctx.fillRect(0, 0, w, h);
  ctx.font = `bold ${h * 0.2}px -apple-system, sans-serif`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('GO!', w / 2, h / 2);
  ctx.restore();
  await sleep(600);
  ctx.clearRect(0, 0, w, h);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

let lastTimestamp = -1;

function processFrame(): void {
  if (!isRunning || !poseLandmarker) return;

  const now = performance.now();

  // MediaPipe requires strictly increasing timestamps
  const timestamp = video.currentTime * 1000;
  if (timestamp <= lastTimestamp) {
    animationFrameId = requestAnimationFrame(processFrame);
    return;
  }
  lastTimestamp = timestamp;

  const result = poseLandmarker.detectForVideo(video, timestamp);

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

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
    formEvaluator.evaluateFrame(message);

    // Check if rep completed
    if (repCounter.getRepCount() > prevReps) {
      formEvaluator.setRepNumber(repCounter.getRepCount() + 1);
      alertSystem.dismiss();
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
    initPipeline(squatConfig);
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
  preTrackingActive = true;
  preTrackingController = null;
  statusEl.textContent = 'Stopped. Click Start to resume.';
  startBtn.disabled = false;
  stopBtn.disabled = true;
  skipBtn.style.display = 'none';

  // Show stat cards back
  statReps.style.display = '';
  statFsm.style.display = '';
  statTut.style.display = '';

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
