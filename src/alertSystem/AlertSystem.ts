/**
 * Alert_System for the CV Fitness & Form Assistant.
 *
 * Plays an audible warning tone via the Web Audio API and renders a visual
 * overlay banner on top of the video feed canvas when the Safety_Monitor
 * reports a critical deviation.
 *
 * Requirements covered: 5.2, 5.3, 5.4
 *   - 5.2: Play warning tone via Web Audio API on critical deviation
 *   - 5.3: Render visual overlay banner on the video feed canvas
 *   - 5.4: Maintain overlay while critical deviation persists across ≥2
 *           consecutive frames; dismiss audio + visual overlay when angles
 *           return to safe range
 */

import type { DeviationEvent } from '../types/index.js';
import type { SafetyAlertType } from '../safetyMonitor/SafetyMonitor.js';

export class AlertSystem {
  private audioCtx: AudioContext | null = null;
  private overlayEl: HTMLElement | null = null;
  private isActive = false;
  private consecutiveCriticalFrames = 0;
  private readonly OVERLAY_THRESHOLD = 2;
  private readonly canvasContainer: HTMLElement;

  constructor(canvasContainer: HTMLElement) {
    this.canvasContainer = canvasContainer;
  }

  /**
   * Called by Safety_Monitor when a critical deviation is detected on a frame.
   * Increments the consecutive-frame counter, plays an audio warning, and
   * shows the visual overlay once the threshold (≥2 frames) is reached.
   *
   * Requirement 5.2, 5.3, 5.4
   */
  trigger(event: DeviationEvent, alertType: SafetyAlertType): void {
    this.consecutiveCriticalFrames++;
    this.playWarningTone();
    if (this.consecutiveCriticalFrames >= this.OVERLAY_THRESHOLD) {
      this.showOverlay(event, alertType);
    }
    this.isActive = true;
  }

  /**
   * Called when angles return to the safe range. Resets the frame counter,
   * removes the overlay, and stops audio feedback.
   *
   * Requirement 5.4
   */
  dismiss(): void {
    this.consecutiveCriticalFrames = 0;
    this.isActive = false;
    this.hideOverlay();
    this.stopAudio();
  }

  /** Whether the alert system is currently in an active (triggered) state. */
  isAlertActive(): boolean {
    return this.isActive;
  }

  /** Number of consecutive frames with a critical deviation. */
  getConsecutiveFrames(): number {
    return this.consecutiveCriticalFrames;
  }

  // -------------------------------------------------------------------------
  // Private — Audio
  // -------------------------------------------------------------------------

  /**
   * Plays a short 440 Hz square-wave warning tone.
   * Gracefully degrades when Web Audio API is unavailable.
   *
   * Requirement 5.2
   */
  private playWarningTone(): void {
    try {
      if (this.audioCtx === null) {
        this.audioCtx = new AudioContext();
      }
      const oscillator = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      oscillator.type = 'square';
      oscillator.frequency.setValueAtTime(440, this.audioCtx.currentTime);
      gain.gain.setValueAtTime(0.3, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.3);
      oscillator.connect(gain);
      gain.connect(this.audioCtx.destination);
      oscillator.start();
      oscillator.stop(this.audioCtx.currentTime + 0.3);
    } catch {
      /* Web Audio unavailable — degrade silently */
    }
  }

  /**
   * Stops any ongoing audio. Scheduled oscillators auto-stop, so this is a
   * semantic placeholder allowing future extension (e.g. continuous tones).
   */
  private stopAudio(): void {
    // AudioContext will auto-stop scheduled oscillators; no explicit action needed
  }

  // -------------------------------------------------------------------------
  // Private — Visual overlay
  // -------------------------------------------------------------------------

  /**
   * Creates and displays the overlay banner positioned over the canvas
   * container, or updates it if already visible.
   *
   * Requirement 5.3
   */
  private showOverlay(event: DeviationEvent, alertType: SafetyAlertType): void {
    if (this.overlayEl === null) {
      this.overlayEl = document.createElement('div');
      this.overlayEl.className = 'alert-overlay';
      this.overlayEl.setAttribute('role', 'alert');
      this.overlayEl.setAttribute('aria-live', 'assertive');
      this.overlayEl.style.cssText =
        'position:absolute;top:0;left:0;right:0;padding:16px;' +
        'background:rgba(220,38,38,0.9);color:#fff;font-weight:bold;' +
        'text-align:center;z-index:9999;';
      this.canvasContainer.style.position = 'relative';
      this.canvasContainer.appendChild(this.overlayEl);
    }
    const label =
      alertType === 'valgus_cave'
        ? 'KNEE VALGUS — STOP'
        : alertType === 'lumbar_extension'
          ? 'LUMBAR HYPEREXTENSION — STOP'
          : 'CRITICAL FORM DEVIATION — STOP';
    this.overlayEl.textContent = `⚠️ ${label} (${event.jointName}: ${event.angleValue.toFixed(1)}°)`;
  }

  /**
   * Removes the overlay element from the DOM and releases the reference.
   *
   * Requirement 5.4
   */
  private hideOverlay(): void {
    if (this.overlayEl !== null) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
  }
}
