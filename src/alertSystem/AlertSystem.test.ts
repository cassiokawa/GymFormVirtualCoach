/**
 * Unit tests for Alert_System.
 *
 * Requirements validated: 5.2, 5.3, 5.4
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AlertSystem } from './AlertSystem.js';
import type { DeviationEvent } from '../types/index.js';
import type { SafetyAlertType } from '../safetyMonitor/SafetyMonitor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeviationEvent(overrides?: Partial<DeviationEvent>): DeviationEvent {
  return {
    jointName: 'left_knee',
    angleValue: 155.5,
    severity: 'critical',
    timestampMs: Date.now(),
    repNumber: 1,
    ...overrides,
  };
}

/**
 * Minimal AudioContext stub for JSDOM which has no Web Audio API.
 */
function stubAudioContext(): void {
  const mockOscillator = {
    type: 'sine',
    frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const mockGain = {
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  };
  (globalThis as Record<string, unknown>)['AudioContext'] = vi.fn(() => ({
    currentTime: 0,
    destination: {},
    createOscillator: () => mockOscillator,
    createGain: () => mockGain,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AlertSystem', () => {
  let container: HTMLElement;
  let alertSystem: AlertSystem;

  beforeEach(() => {
    stubAudioContext();
    container = document.createElement('div');
    document.body.appendChild(container);
    alertSystem = new AlertSystem(container);
  });

  // --- Initial state ---

  it('starts in inactive state', () => {
    expect(alertSystem.isAlertActive()).toBe(false);
    expect(alertSystem.getConsecutiveFrames()).toBe(0);
  });

  // --- Trigger behaviour ---

  it('becomes active on first trigger', () => {
    alertSystem.trigger(makeDeviationEvent(), 'valgus_cave');
    expect(alertSystem.isAlertActive()).toBe(true);
    expect(alertSystem.getConsecutiveFrames()).toBe(1);
  });

  it('does NOT show overlay on first trigger (below threshold)', () => {
    alertSystem.trigger(makeDeviationEvent(), 'valgus_cave');
    expect(container.querySelector('.alert-overlay')).toBeNull();
  });

  it('shows overlay after ≥2 consecutive critical frames (Req 5.3, 5.4)', () => {
    alertSystem.trigger(makeDeviationEvent(), 'valgus_cave');
    alertSystem.trigger(makeDeviationEvent(), 'valgus_cave');
    const overlay = container.querySelector('.alert-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toContain('KNEE VALGUS');
  });

  it('displays lumbar extension label for lumbar_extension alert type', () => {
    const event = makeDeviationEvent({ jointName: 'lumbar_spine', angleValue: 42.3 });
    alertSystem.trigger(event, 'lumbar_extension');
    alertSystem.trigger(event, 'lumbar_extension');
    const overlay = container.querySelector('.alert-overlay');
    expect(overlay!.textContent).toContain('LUMBAR HYPEREXTENSION');
    expect(overlay!.textContent).toContain('42.3');
  });

  it('displays generic label for critical_deviation alert type', () => {
    const event = makeDeviationEvent({ jointName: 'right_shoulder', angleValue: 10.0 });
    alertSystem.trigger(event, 'critical_deviation');
    alertSystem.trigger(event, 'critical_deviation');
    const overlay = container.querySelector('.alert-overlay');
    expect(overlay!.textContent).toContain('CRITICAL FORM DEVIATION');
  });

  it('overlay has correct accessibility attributes', () => {
    alertSystem.trigger(makeDeviationEvent(), 'valgus_cave');
    alertSystem.trigger(makeDeviationEvent(), 'valgus_cave');
    const overlay = container.querySelector('.alert-overlay') as HTMLElement;
    expect(overlay.getAttribute('role')).toBe('alert');
    expect(overlay.getAttribute('aria-live')).toBe('assertive');
  });

  it('sets container position to relative for overlay positioning', () => {
    alertSystem.trigger(makeDeviationEvent(), 'valgus_cave');
    alertSystem.trigger(makeDeviationEvent(), 'valgus_cave');
    expect(container.style.position).toBe('relative');
  });

  // --- Dismiss behaviour ---

  it('dismiss removes overlay and resets state (Req 5.4)', () => {
    alertSystem.trigger(makeDeviationEvent(), 'valgus_cave');
    alertSystem.trigger(makeDeviationEvent(), 'valgus_cave');
    expect(container.querySelector('.alert-overlay')).not.toBeNull();

    alertSystem.dismiss();
    expect(alertSystem.isAlertActive()).toBe(false);
    expect(alertSystem.getConsecutiveFrames()).toBe(0);
    expect(container.querySelector('.alert-overlay')).toBeNull();
  });

  it('dismiss is safe to call when no overlay is shown', () => {
    alertSystem.trigger(makeDeviationEvent(), 'valgus_cave');
    alertSystem.dismiss();
    expect(alertSystem.isAlertActive()).toBe(false);
  });

  it('dismiss is idempotent', () => {
    alertSystem.trigger(makeDeviationEvent(), 'valgus_cave');
    alertSystem.trigger(makeDeviationEvent(), 'valgus_cave');
    alertSystem.dismiss();
    alertSystem.dismiss();
    expect(alertSystem.getConsecutiveFrames()).toBe(0);
    expect(container.querySelector('.alert-overlay')).toBeNull();
  });

  // --- Re-trigger after dismiss ---

  it('can re-trigger after dismiss (new alert cycle)', () => {
    alertSystem.trigger(makeDeviationEvent(), 'valgus_cave');
    alertSystem.trigger(makeDeviationEvent(), 'valgus_cave');
    alertSystem.dismiss();

    alertSystem.trigger(makeDeviationEvent(), 'lumbar_extension');
    expect(alertSystem.getConsecutiveFrames()).toBe(1);
    expect(container.querySelector('.alert-overlay')).toBeNull();

    alertSystem.trigger(makeDeviationEvent(), 'lumbar_extension');
    expect(container.querySelector('.alert-overlay')).not.toBeNull();
  });

  // --- Audio ---

  it('creates AudioContext on first trigger (Req 5.2)', () => {
    alertSystem.trigger(makeDeviationEvent(), 'valgus_cave');
    expect(globalThis.AudioContext).toHaveBeenCalledTimes(1);
  });

  it('gracefully handles AudioContext constructor failure', () => {
    (globalThis as Record<string, unknown>)['AudioContext'] = vi.fn(() => {
      throw new Error('NotAllowedError');
    });
    alertSystem = new AlertSystem(container);
    expect(() => alertSystem.trigger(makeDeviationEvent(), 'valgus_cave')).not.toThrow();
    expect(alertSystem.isAlertActive()).toBe(true);
  });
});
