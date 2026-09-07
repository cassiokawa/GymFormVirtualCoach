/**
 * demoEventSource — a fixture/mock {@link AnalysisEventSource} for standing up
 * the Coach session before the spec 02 Analysis engine is connected.
 *
 * The real Analysis engine (spec 02) will publish the same {@link DomainEvent}
 * stream; until it lands, this replay drives the {@link CoachController} with a
 * scripted sequence so the four-state session can be demonstrated and tested
 * without the live camera. It is DEMO/TEST scaffolding, not production logic —
 * the controller depends only on the {@link AnalysisEventSource} contract, so
 * swapping this for the engine changes nothing in the controller.
 *
 * No exercise id, name, or alias appears here (`tech.md` rule 1); the events are
 * exercise-agnostic by construction.
 */

import type { AnalysisEventSource } from './CoachController';
import type { DomainEvent } from '../domain/analysis/types';

/** A manually-drivable event source: `emit` pushes one event to subscribers. */
export class ManualEventSource implements AnalysisEventSource {
  private readonly subscribers = new Set<(event: DomainEvent) => void>();

  subscribe(cb: (event: DomainEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Push one event to every current subscriber. */
  emit(event: DomainEvent): void {
    for (const cb of this.subscribers) cb(event);
  }
}

/**
 * A scripted replay that emits a run of {@link RepCompleted} events (with an
 * occasional {@link FaultDetected}) on an interval once {@link start} is called.
 * Purely for the demo seam; deterministic and self-contained.
 */
export class DemoReplaySource implements AnalysisEventSource {
  private readonly manual = new ManualEventSource();
  private handle: ReturnType<typeof setInterval> | null = null;
  private rep = 0;

  subscribe(cb: (event: DomainEvent) => void): () => void {
    return this.manual.subscribe(cb);
  }

  /** Begin emitting one rep per `intervalMs` (default 2 s), up to `totalReps`. */
  start(totalReps = 6, intervalMs = 2000): void {
    this.stop();
    this.rep = 0;
    this.handle = setInterval(() => {
      this.rep += 1;
      // Every third rep, offer a fault before the rep closes so the rationer
      // has something to voice.
      if (this.rep % 3 === 0) {
        this.manual.emit({
          type: 'FaultDetected',
          t: Date.now(),
          faultId: 'demo-fault',
          phase: 'concentric',
          severity: 'warning',
          cue: 'brace core',
        });
      }
      this.manual.emit({
        type: 'RepCompleted',
        t: Date.now(),
        repNumber: this.rep,
        tutMs: 1800,
        minSignal: 0.1,
        maxSignal: 0.9,
        romGatePassed: true,
      });
      if (this.rep >= totalReps) this.stop();
    }, intervalMs);
  }

  /** Stop the replay interval. */
  stop(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }
}
