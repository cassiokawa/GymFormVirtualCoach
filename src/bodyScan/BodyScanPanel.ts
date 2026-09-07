/**
 * BodyScanPanel — UI for taking standardized body measurements and tracking
 * muscle development progress over time using pose keypoints.
 *
 * The user stands in a standard pose (arms relaxed, facing camera), clicks
 * "Scan", and the system extracts normalized body proportions. Over weeks/months
 * of scans, trends in ratios reveal muscle growth (wider shoulders, thicker
 * thighs, etc.) without needing a tape measure.
 */

import type { Keypoint } from '../types/index.js';
import {
  type BodyScan,
  type BodyMeasurements,
  extractMeasurements,
  computeProgress,
  MEASUREMENT_LABELS,
  GROWTH_INDICATORS,
  assessPoseQuality,
  detectOutliers,
  clampProgress,
} from './BodyMeasurement.js';
import { PrivacyManager } from '../privacy/PrivacyManager.js';
import { PrivacyUI } from '../privacy/PrivacyUI.js';

/** Known reference objects and their real-world heights in cm. */
const REFERENCE_OBJECTS: Array<{ id: string; label: string; heightCm: number }> = [
  { id: 'iphone15promax', label: 'iPhone 15 Pro Max (16.0 cm)', heightCm: 16.0 },
  { id: 'iphone15pro', label: 'iPhone 15 Pro (14.7 cm)', heightCm: 14.7 },
  { id: 'iphone15', label: 'iPhone 15 (14.8 cm)', heightCm: 14.8 },
  { id: 'iphone14', label: 'iPhone 14 (14.7 cm)', heightCm: 14.7 },
  { id: 'samsung_s24', label: 'Samsung S24 Ultra (16.3 cm)', heightCm: 16.3 },
  { id: 'pen', label: 'Standard pen (14.0 cm)', heightCm: 14.0 },
  { id: 'creditcard', label: 'Credit card height (8.6 cm)', heightCm: 8.6 },
  { id: 'custom', label: 'I know my height (cm)', heightCm: 0 },
];

const STORAGE_KEY = 'gym-coach-body-scans';
const REF_STORAGE_KEY = 'gym-coach-body-ref';

export class BodyScanPanel {
  private container: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private scans: BodyScan[] = [];
  private privacy = PrivacyManager.getInstance();
  private privacyUI = new PrivacyUI();
  /** Latest weight entered by the user (kg), applied to the next scan. */
  private pendingWeightKg: number | null = null;
  private getKeypoints: (() => Keypoint[] | null) | null = null;
  private startCamera: (() => Promise<void>) | null = null;
  private runSingleDetection: (() => Promise<Keypoint[] | null>) | null = null;
  private overlayCanvas: HTMLCanvasElement | null = null;

  /** Set the non-mirrored UI overlay canvas for drawing prompts on the video. */
  setOverlayCanvas(canvas: HTMLCanvasElement): void {
    this.overlayCanvas = canvas;
  }

  /** Wire the keypoint source (called during each scan to grab the current frame). */
  setKeypointSource(fn: () => Keypoint[] | null): void {
    this.getKeypoints = fn;
  }

  /**
   * Wire a camera-start function so Body Scan can activate the camera
   * independently of the workout loop.
   */
  setCameraStarter(fn: () => Promise<void>): void {
    this.startCamera = fn;
  }

  /**
   * Wire a single-frame detection function so Body Scan can get keypoints
   * even when no workout is active.
   */
  setSingleDetection(fn: () => Promise<Keypoint[] | null>): void {
    this.runSingleDetection = fn;
  }

  /**
   * Re-load scans and re-render after the user logs in / out / signs up via the
   * navbar. When locked, scans are cleared from memory; when unlocked, the
   * encrypted store is decrypted and shown.
   */
  refreshAfterAuthChange(): void {
    if (this.privacy.isUnlocked()) {
      void this.privacy.loadScans().then((scans) => {
        this.scans = scans;
        this.renderContent();
      }).catch(() => { this.scans = []; this.renderContent(); });
    } else {
      this.scans = [];
      this.renderContent();
    }
  }

  mount(container: HTMLElement): void {
    this.container = container;
    this.loadScans();

    const details = document.createElement('details');
    details.style.marginTop = '12px';

    const summary = document.createElement('summary');
    summary.textContent = '📐 Body Scan (Muscle Progress)';
    details.appendChild(summary);

    const body = document.createElement('div');
    body.style.cssText = 'padding-top:14px; display:flex; flex-direction:column; gap:14px;';
    this.bodyEl = body;
    details.appendChild(body);

    container.appendChild(details);
    this.renderContent();
  }

  private renderContent(): void {
    const body = this.bodyEl;
    if (!body) return;
    body.replaceChildren();

    // Instructions with reference object guidance.
    const instructions = document.createElement('div');
    instructions.style.cssText = 'font-size:0.82rem; color:var(--text-dim); line-height:1.5;';
    instructions.innerHTML =
      '<strong>How it works:</strong><br>' +
      '1. Select a reference object below (your phone or known height).<br>' +
      '2. Stand facing the camera, arms relaxed, full body visible.<br>' +
      '3. Click <strong>Take Scan</strong> — a timer counts down, then captures.<br>' +
      '4. Repeat weekly to track muscle growth.';
    body.appendChild(instructions);

    // Reference object selector.
    const refRow = document.createElement('div');
    refRow.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;';
    const refLabel = document.createElement('span');
    refLabel.style.cssText = 'font-size:0.78rem; color:var(--text-dim); font-weight:600;';
    refLabel.textContent = 'Reference:';
    refRow.appendChild(refLabel);

    const refSelect = document.createElement('select');
    refSelect.style.cssText = 'flex:1; min-width:180px; font-size:0.82rem;';
    for (const ref of REFERENCE_OBJECTS) {
      const opt = document.createElement('option');
      opt.value = ref.id;
      opt.textContent = ref.label;
      refSelect.appendChild(opt);
    }
    // Load saved reference.
    const savedRef = localStorage.getItem(REF_STORAGE_KEY) ?? 'iphone15promax';
    refSelect.value = savedRef;
    refSelect.addEventListener('change', () => {
      localStorage.setItem(REF_STORAGE_KEY, refSelect.value);
      if (refSelect.value === 'custom') heightInput.style.display = '';
      else heightInput.style.display = 'none';
    });
    refRow.appendChild(refSelect);

    const heightInput = document.createElement('input');
    heightInput.type = 'number';
    heightInput.placeholder = 'Height in cm';
    heightInput.min = '100';
    heightInput.max = '220';
    heightInput.style.cssText = 'width:90px; display:' + (savedRef === 'custom' ? '' : 'none') + ';';
    heightInput.value = localStorage.getItem('gym-coach-height-cm') ?? '175';
    heightInput.addEventListener('change', () => {
      localStorage.setItem('gym-coach-height-cm', heightInput.value);
    });
    refRow.appendChild(heightInput);
    body.appendChild(refRow);

    // Pose quality indicator + scan button.
    const scanRow = document.createElement('div');
    scanRow.style.cssText = 'display:flex; gap:10px; align-items:center;';

    const qualityDot = document.createElement('span');
    qualityDot.id = 'scanQualityDot';
    qualityDot.style.cssText = 'width:12px; height:12px; border-radius:50%; background:var(--bg-3);';
    scanRow.appendChild(qualityDot);

    const qualityText = document.createElement('span');
    qualityText.id = 'scanQualityText';
    qualityText.style.cssText = 'font-size:0.78rem; color:var(--text-dim);';
    qualityText.textContent = 'Waiting for pose…';
    scanRow.appendChild(qualityText);

    const scanBtn = document.createElement('button');
    scanBtn.type = 'button';
    scanBtn.textContent = '📸 Take Scan';
    scanBtn.style.cssText = 'margin-left:auto;';
    scanBtn.addEventListener('click', () => { void this.takeScan(); });
    scanRow.appendChild(scanBtn);
    body.appendChild(scanRow);

    // Optional weight input (asked at the moment of measurement).
    const weightRow = document.createElement('div');
    weightRow.style.cssText = 'display:flex; gap:8px; align-items:center; margin-top:8px;';
    const weightLabel = document.createElement('label');
    weightLabel.textContent = 'Weight (optional):';
    weightLabel.style.cssText = 'font-size:0.78rem; color:var(--text-dim);';
    weightLabel.htmlFor = 'scanWeight';
    const weightInput = document.createElement('input');
    weightInput.id = 'scanWeight';
    weightInput.type = 'number';
    weightInput.min = '20';
    weightInput.max = '400';
    weightInput.step = '0.1';
    weightInput.placeholder = 'kg';
    weightInput.style.cssText = 'width:90px; padding:6px 8px; border-radius:8px; border:1px solid var(--border,#333); background:var(--bg-2,#242424); color:var(--text,#fff); font-size:0.82rem;';
    weightInput.value = this.pendingWeightKg != null ? String(this.pendingWeightKg) : '';
    weightInput.addEventListener('input', () => {
      const v = parseFloat(weightInput.value);
      this.pendingWeightKg = Number.isFinite(v) && v > 0 ? v : null;
    });
    const weightNote = document.createElement('span');
    weightNote.textContent = '🔒 encrypted, stored only on this device';
    weightNote.style.cssText = 'font-size:0.68rem; color:var(--text-faint);';
    weightRow.append(weightLabel, weightInput, weightNote);
    body.appendChild(weightRow);

    // Big visible timer + status.
    const timerDisplay = document.createElement('div');
    timerDisplay.id = 'scanTimer';
    timerDisplay.style.cssText = 'font-size:2.5rem; font-weight:800; color:var(--accent); text-align:center; min-height:3rem; font-variant-numeric:tabular-nums;';
    body.appendChild(timerDisplay);

    const statusLine = document.createElement('div');
    statusLine.id = 'scanStatus';
    statusLine.style.cssText = 'font-size:0.78rem; color:var(--accent); font-weight:600; min-height:1.2em; text-align:center;';
    body.appendChild(statusLine);

    // Live quality updater.
    this.startQualityPolling(qualityDot, qualityText);

    // Progress section (if we have 2+ scans).
    if (this.scans.length >= 2) {
      body.appendChild(this.buildProgressSection());
    }

    // History.
    if (this.scans.length > 0) {
      body.appendChild(this.buildHistorySection());
    }

    // Privacy & data controls (consent status, export, erase, lock).
    const spacer = document.createElement('div');
    spacer.style.cssText = 'height:1px; background:var(--border,#333); margin:14px 0;';
    body.appendChild(spacer);
    body.appendChild(this.privacyUI.buildSettingsSection(() => {
      this.scans = [];
      this.renderContent();
    }));
  }

  /**
   * Guided scan: starts camera, gives voice prompts to help the user frame
   * their body, runs a countdown, and only captures when pose quality is good.
   */
  private async takeScan(): Promise<void> {
    const statusEl = this.bodyEl?.querySelector('#scanStatus') as HTMLElement | null;
    const setStatus = (msg: string) => { if (statusEl) statusEl.textContent = msg; };

    // 1) Ensure camera + MediaPipe are running.
    if (this.startCamera) {
      try {
        setStatus('Starting camera…');
        this.speak('Starting body scan. Please stand in front of the camera.');
        await this.startCamera();
        await this.delay(800);
      } catch (e) {
        alert('Could not start camera: ' + (e instanceof Error ? e.message : String(e)));
        return;
      }
    }

    // 2) Voice guidance: framing instructions with on-screen overlay.
    this.speak('Stand upright with your arms relaxed at your sides. Make sure your full body is visible, head to feet.');
    this.drawOverlayText([
      'BODY SCAN',
      '',
      'Stand upright, arms at sides',
      'Full body visible (head to feet)',
      'Hold reference object next to thigh',
    ], { timerText: '📐', color: 'rgba(255,255,255,0.7)' });
    setStatus('Position yourself… full body visible, arms at sides.');
    await this.delay(3500);

    // 3) Countdown with live quality checking + 15-second max timeout.
    // We check pose each second, keep the best frame, and abort after 15s total.
    let bestKeypoints: Keypoint[] | null = null;
    let bestQuality = 0;
    const MAX_SCAN_SECONDS = 10; // countdown duration (total guided time ~15s with intro)

    const timerEl = this.bodyEl?.querySelector('#scanTimer') as HTMLElement | null;
    this.speak('Hold your reference object next to your thigh, then step back. Scanning in ' + MAX_SCAN_SECONDS + ' seconds. Hold still.');
    for (let i = MAX_SCAN_SECONDS; i >= 1; i--) {
      setStatus(`Scanning in ${i}… hold still`);
      if (timerEl) timerEl.textContent = String(i);
      if (i <= 3) this.speak(String(i));

      // Check pose + draw on overlay.
      let kps = this.getKeypoints ? this.getKeypoints() : null;
      if ((!kps || kps.length < 33) && this.runSingleDetection) {
        kps = await this.runSingleDetection();
      }
      const currentQ = kps && kps.length >= 33 ? assessPoseQuality(kps) : 0;
      const hint = currentQ >= 0.8 ? 'Great! Hold still.' :
        currentQ >= 0.6 ? 'Good — stay steady.' : 'Stand straighter, full body in frame.';
      this.drawOverlayText([hint], { timerText: String(i), quality: currentQ });

      await this.delay(1000);

      if (kps && kps.length >= 33) {
        const q = currentQ;
        if (q > bestQuality) {
          bestQuality = q;
          bestKeypoints = kps;
        }
        // If we get a great pose early (quality >= 0.85), capture immediately.
        if (q >= 0.85 && i <= MAX_SCAN_SECONDS - 3) {
          this.speak('Great pose! Capturing now.');
          if (timerEl) timerEl.textContent = '✓';
          this.drawOverlayText(['✓ Captured!'], { timerText: '✓', color: '#00d4a0' });
          setStatus('Capturing…');
          await this.delay(600);
          this.clearOverlay();
          break;
        }
      }
    }

    // 4) Final capture attempt.
    if (!bestKeypoints || bestKeypoints.length < 33) {
      if (timerEl) timerEl.textContent = '—';
      this.speak('Could not detect your pose. The scan timed out. Please try again.');
      setStatus('Timed out — no pose detected. Try again.');
      this.drawOverlayText([
        '⏱️ Timed out',
        '',
        'No pose detected.',
        'Make sure full body is visible.',
        'Try again.',
      ]);
      return;
    }

    if (bestQuality < 0.6) {
      if (timerEl) timerEl.textContent = '—';
      this.speak('Pose quality was too low. Stand straighter with full body visible and try again.');
      setStatus('Pose quality too low — stand straighter, full body visible.');
      this.drawOverlayText([
        '❌ Pose quality too low',
        '',
        'Stand STRAIGHTER.',
        'Full body visible (head to feet).',
        'Arms relaxed at sides.',
        'Try again.',
      ]);
      return;
    }

    // 5) Extract measurements from the best frame.
    const keypoints = bestKeypoints;
    const result = extractMeasurements(keypoints);
    if (!result) {
      alert('Pose quality too low. Stand upright, arms at sides, full body visible, and try again.');
      return;
    }

    const scan: BodyScan = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      measurements: result.measurements,
      poseQuality: result.poseQuality,
    };
    // Attach optional weight entered at the moment of measurement (sensitive).
    if (this.pendingWeightKg != null && this.pendingWeightKg > 0) {
      scan.weightKg = this.pendingWeightKg;
    }
    if (timerEl) timerEl.textContent = '✓';
    this.drawOverlayText(['✅ Scan captured!', '', 'Measurements recorded.'], { timerText: '✓', color: '#00d4a0' });
    // Auto-clear the success message after 2 seconds.
    setTimeout(() => this.clearOverlay(), 2000);
    // Check for outliers (implausible changes vs history).
    const outliers = detectOutliers(scan.measurements, this.scans);
    if (outliers.length >= 3) {
      // Too many suspicious measurements — reject the scan.
      const names = outliers.slice(0, 3).map((k) => MEASUREMENT_LABELS[k] ?? k).join(', ');
      this.speak('This scan looks inconsistent. ' + names + ' deviated too much. Try standing more consistently and scan again.');
      setStatus('Scan rejected — ' + names + ' look inconsistent. Try again with a stable pose.');
      this.drawOverlayText([
        '⚠️ Scan rejected',
        '',
        'Measurements look inconsistent.',
        'Stand the same way each time.',
        'Try again.',
      ]);
      return;
    }

    // Privacy gate: require consent + an unlocked vault before storing sensitive
    // body/weight data. If the user declines or cancels, the scan is not saved.
    const ready = await this.privacyUI.ensureReadyToStore();
    if (!ready) {
      this.speak('Scan discarded. Enable secure storage to save your measurements.');
      setStatus('Not saved — secure storage was not enabled.');
      this.drawOverlayText([
        '🔒 Not saved',
        '',
        'Enable secure storage to keep',
        'your measurements private.',
      ]);
      setTimeout(() => this.clearOverlay(), 2500);
      return;
    }
    // The vault may have just been created/unlocked — reload the (decrypted)
    // set so we append to the real history rather than a stale in-memory copy.
    try {
      this.scans = await this.privacy.loadScans();
    } catch { /* keep current in-memory scans */ }

    this.scans.push(scan);
    await this.saveScans();
    if (outliers.length > 0) {
      this.speak('Scan saved, but some measurements may be off. Try to stand consistently next time.');
    } else {
      this.speak('Scan complete! Your measurements have been recorded.');
    }
    this.renderContent();
  }

  private buildProgressSection(): HTMLElement {
    const wrap = document.createElement('div');
    const title = document.createElement('div');
    title.style.cssText = 'font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-faint); margin-bottom:8px;';
    title.textContent = 'Progress (oldest → latest)';
    wrap.appendChild(title);

    const oldest = this.scans[0]!;
    const latest = this.scans[this.scans.length - 1]!;
    const progress = computeProgress(oldest.measurements, latest.measurements);
    const daysBetween = Math.round((latest.timestamp - oldest.timestamp) / (24 * 60 * 60 * 1000));

    const subtitle = document.createElement('div');
    subtitle.style.cssText = 'font-size:0.72rem; color:var(--text-faint); margin-bottom:10px;';
    subtitle.textContent = `${this.scans.length} scans over ${daysBetween} days`;
    wrap.appendChild(subtitle);

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:8px;';

    for (const [key, pct] of Object.entries(progress)) {
      if (key === 'torsoLength') continue; // not a growth indicator
      const label = MEASUREMENT_LABELS[key] ?? key;
      const muscles = GROWTH_INDICATORS[key];
      const { value: displayPct, clamped } = clampProgress(pct);
      const color = displayPct > 1 ? 'var(--accent)' : displayPct < -1 ? 'var(--danger)' : 'var(--text-dim)';
      const arrow = displayPct > 1 ? '↑' : displayPct < -1 ? '↓' : '→';
      const pctText = (clamped ? '~' : '') + (displayPct > 0 ? '+' : '') + displayPct.toFixed(1) + '%';
      const muscleNote = muscles && muscles.length > 0 ? `<div style="font-size:0.62rem; color:var(--text-faint);">${muscles.join(', ')}</div>` : '';

      const card = document.createElement('div');
      card.style.cssText = 'background:var(--bg-2); border:1px solid var(--line); border-radius:10px; padding:8px 10px;';
      card.innerHTML =
        `<div style="font-size:0.72rem; color:var(--text-dim);">${label}</div>` +
        `<div style="font-size:1.1rem; font-weight:700; color:${color};">${arrow} ${pctText}</div>` +
        muscleNote;
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  private buildHistorySection(): HTMLElement {
    const wrap = document.createElement('div');
    const title = document.createElement('div');
    title.style.cssText = 'font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-faint); margin-bottom:8px;';
    title.textContent = `Scan History (${this.scans.length})`;
    wrap.appendChild(title);

    const list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:6px; max-height:180px; overflow-y:auto;';
    for (const scan of [...this.scans].reverse()) {
      const date = new Date(scan.timestamp).toLocaleDateString();
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; justify-content:space-between; font-size:0.75rem; padding:6px 8px; background:var(--bg-2); border-radius:8px; border:1px solid var(--line);';
      const weightSpan = scan.weightKg != null
        ? `<span style="color:var(--text-dim);">${scan.weightKg.toFixed(1)} kg</span>`
        : '';
      row.innerHTML =
        `<span>${date}</span>` +
        weightSpan +
        `<span style="color:var(--text-dim);">Quality: ${Math.round(scan.poseQuality * 100)}%</span>` +
        `<span>V-taper: ${scan.measurements.shoulderToHipRatio.toFixed(2)}</span>`;
      list.appendChild(row);
    }
    wrap.appendChild(list);

    // Clear button.
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = '🗑 Clear History';
    clearBtn.style.cssText = 'margin-top:8px; font-size:0.72rem; background:var(--bg-3); color:var(--text-dim);';
    clearBtn.addEventListener('click', () => {
      if (confirm('Delete all body scan history?')) {
        this.scans = [];
        void this.saveScans();
        this.renderContent();
      }
    });
    wrap.appendChild(clearBtn);
    return wrap;
  }

  private qualityInterval: ReturnType<typeof setInterval> | null = null;

  private startQualityPolling(dot: HTMLElement, text: HTMLElement): void {
    if (this.qualityInterval) clearInterval(this.qualityInterval);
    this.qualityInterval = setInterval(() => {
      if (!this.getKeypoints) return;
      const kps = this.getKeypoints();
      if (!kps || kps.length < 33) {
        dot.style.background = 'var(--bg-3)';
        text.textContent = 'No pose detected';
        // Draw on video overlay too.
        this.drawOverlayText([
          '📐 BODY SCAN',
          '',
          'No pose detected.',
          'Start the camera and stand in frame.',
        ]);
        return;
      }
      const q = assessPoseQuality(kps);
      if (q >= 0.8) {
        dot.style.background = 'var(--accent)';
        text.textContent = 'Great pose! Ready to scan.';
        this.drawOverlayText([
          '✅ Great pose! Ready to scan.',
          '',
          'Click "Take Scan" when ready.',
        ], { quality: q });
      } else if (q >= 0.6) {
        dot.style.background = 'var(--warn)';
        text.textContent = 'Acceptable — stand a bit straighter.';
        this.drawOverlayText([
          '⚠️ Almost ready',
          '',
          'Stand a bit straighter.',
          'Arms relaxed at sides.',
        ], { quality: q });
      } else {
        dot.style.background = 'var(--danger)';
        text.textContent = 'Pose not ready — stand upright, full body visible.';
        this.drawOverlayText([
          '❌ Pose not ready',
          '',
          'Stand UPRIGHT facing camera.',
          'Arms relaxed at your sides.',
          'Full body visible (head to feet).',
          'Step back if needed.',
        ], { quality: q });
      }
    }, 600);
  }

  // --- Overlay drawing (on the camera feed) ---

  /** Draw a big centered text on the video overlay. */
  private drawOverlayText(
    lines: string[],
    opts: { timerText?: string; color?: string; quality?: number } = {},
  ): void {
    const canvas = this.overlayCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Semi-transparent backdrop for readability.
    ctx.fillStyle = 'rgba(10, 16, 32, 0.55)';
    ctx.fillRect(0, 0, w, h);

    // Timer (big center number).
    if (opts.timerText) {
      ctx.font = `bold ${Math.round(h * 0.25)}px -apple-system, sans-serif`;
      ctx.fillStyle = opts.color ?? 'rgba(0, 212, 160, 0.95)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(opts.timerText, w / 2, h * 0.4);
    }

    // Instruction lines below the timer.
    ctx.font = `600 ${Math.round(h * 0.038)}px -apple-system, sans-serif`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const startY = opts.timerText ? h * 0.58 : h * 0.35;
    const lineHeight = h * 0.055;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i] ?? '', w / 2, startY + i * lineHeight);
    }

    // Pose quality bar at bottom.
    if (opts.quality !== undefined) {
      const barW = w * 0.5;
      const barH = 8;
      const barX = (w - barW) / 2;
      const barY = h - 30;
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.fillRect(barX, barY, barW, barH);
      const qColor = opts.quality >= 0.8 ? '#00d4a0' : opts.quality >= 0.6 ? '#ffce54' : '#ff5a6a';
      ctx.fillStyle = qColor;
      ctx.fillRect(barX, barY, barW * Math.min(1, opts.quality), barH);
      ctx.font = `600 ${Math.round(h * 0.028)}px -apple-system, sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.textAlign = 'center';
      ctx.fillText(`Pose quality: ${Math.round(opts.quality * 100)}%`, w / 2, barY - 10);
    }
  }

  /** Clear the overlay. */
  private clearOverlay(): void {
    const canvas = this.overlayCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // --- Helpers ---

  /** TTS shortcut using the browser's speech synthesis. */
  private speak(text: string): void {
    if (typeof speechSynthesis === 'undefined') return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.pitch = 1.0;
    // Use an English voice if available.
    const voices = speechSynthesis.getVoices();
    const en = voices.find((v) => v.lang.startsWith('en') && v.localService);
    if (en) u.voice = en;
    speechSynthesis.speak(u);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- Persistence (encrypted, via PrivacyManager) ---

  /**
   * Load scans. If a vault exists and is unlocked, decrypt from the encrypted
   * store. If the vault is not set up yet, fall back to any legacy plaintext
   * scans so first-run users still see prior data (migrated on first save).
   */
  private loadScans(): void {
    if (this.privacy.isUnlocked()) {
      void this.privacy.loadScans().then((scans) => {
        this.scans = scans;
        this.renderContent();
      }).catch(() => { this.scans = []; });
      return;
    }
    // Vault locked / not set up — show legacy plaintext if present (read-only
    // until the vault is created, at which point it is migrated + encrypted).
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this.scans = raw ? (JSON.parse(raw) as BodyScan[]) : [];
    } catch { this.scans = []; }
  }

  /** Persist scans to the encrypted store. Requires an unlocked vault. */
  private async saveScans(): Promise<void> {
    try {
      await this.privacy.saveScans(this.scans);
    } catch { /* vault locked — save is gated in takeScan, so this is rare */ }
  }
}
