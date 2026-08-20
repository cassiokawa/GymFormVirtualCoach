/**
 * Live demo — connects your webcam to the full pose analysis pipeline.
 * Uses MediaPipe PoseLandmarker directly on the main thread for simplicity.
 */

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Keypoint, KeypointMessage, ExerciseFSMConfig } from '../types/index.js';
import { RepCounter } from '../repCounter/RepCounter.js';
import { FormEvaluator } from '../formEvaluator/FormEvaluator.js';
import { SafetyMonitor } from '../safetyMonitor/SafetyMonitor.js';
import { AlertSystem } from '../alertSystem/AlertSystem.js';
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
const repCountEl = document.getElementById('repCount')!;
const fsmStateEl = document.getElementById('fsmState')!;
const fpsEl = document.getElementById('fps')!;
const lastTutEl = document.getElementById('lastTut')!;
const videoContainer = document.getElementById('video-container')!;

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
  statusEl.textContent = 'Camera active. Tracking squats...';
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

    // Feed to pipeline
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

  // FPS counter
  frameCount++;
  if (now - lastFpsUpdate > 1000) {
    const fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
    fpsEl.textContent = String(fps);
    frameCount = 0;
    lastFpsUpdate = now;
  }

  animationFrameId = requestAnimationFrame(processFrame);
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
  statusEl.textContent = 'Stopped. Click Start to resume.';
  startBtn.disabled = false;
  stopBtn.disabled = true;

  // Stop camera
  const stream = video.srcObject as MediaStream | null;
  stream?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
});

// ---------------------------------------------------------------------------
// Auto-init
// ---------------------------------------------------------------------------

initMediaPipe().catch((err) => {
  statusEl.textContent = `Failed to load model: ${err instanceof Error ? err.message : String(err)}`;
});
