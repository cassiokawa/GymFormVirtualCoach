/**
 * Session UX — the machine RUNTIME, layered on top of the pure transition
 * relation ({@link transition} from `./machine`).
 *
 * The pure function decides *what the next state is*; this runtime is what
 * *happens* around that decision: it owns the live {@link SessionContext}, a
 * host element, and a registry mapping each {@link SessionState} to the
 * {@link Surface} that renders it, and it enforces the single-surface invariant
 * (R1.2) — on every state change it unmounts the outgoing surface and mounts
 * exactly one incoming surface bound to the new state.
 *
 * ## The single-surface invariant (R1.2)
 *
 * At most one surface is mounted at any instant, and after any state change
 * exactly one surface is mounted (the one bound to the current state, when a
 * surface is registered for it). The runtime tracks the currently-mounted
 * surface and *always unmounts before mounting the next*, so two surfaces can
 * never share the host. This is the structural guarantee behind 3-metre
 * legibility: nothing competes with the WORKING surface for the viewport, and
 * the telemetry/panel duplication R5.1/R5.3 forbid has nowhere to live.
 *
 * ## No remount on a no-op
 *
 * {@link transition} returns the SAME context reference for an illegal
 * `(state, event)` pair (e.g. `START_REQUESTED` while framing is invalid). The
 * runtime treats identity equality as "nothing changed": it does not remount
 * the surface and does not notify subscribers. Only a genuine transition — a
 * new context whose `state` differs — triggers a remount. A transition that
 * changes context fields but not `state` still notifies subscribers (the data
 * changed) but does not remount (the surface is unchanged).
 *
 * ## Framework-free DOM
 *
 * Surfaces are plain objects with `mount(host, ctx)` / `unmount()`; the runtime
 * makes no assumption about how they render. This matches the rest of the
 * codebase, which builds DOM directly rather than through a framework.
 *
 * ## Exercise identity is data, never code
 *
 * HARD CONSTRAINT (`tech.md` rule 1): no exercise id, name, or alias appears as
 * a literal here. The runtime only ever carries `ctx.exerciseId` as an opaque
 * string threaded through from data.
 *
 * Requirements: 1.1, 1.2
 */

import { transition } from './machine';
import type {
  SessionContext,
  SessionEvent,
  SessionState,
  Surface,
} from './types';

/**
 * A listener notified whenever the session context changes. Receives the new
 * context after the transition and any surface remount have been applied.
 */
export type SessionListener = (ctx: SessionContext) => void;

/**
 * A partial map from state to the surface that renders it. A state without a
 * registered surface simply mounts nothing when entered (the runtime still
 * upholds the invariant: it unmounts the outgoing surface either way).
 */
export type SurfaceRegistry = Partial<Record<SessionState, Surface>>;

/**
 * Configuration for a {@link SessionMachine}.
 */
export interface SessionMachineConfig {
  /** The host element every surface mounts into. */
  readonly host: HTMLElement;
  /** The initial context; the runtime mounts `initial.state`'s surface on {@link SessionMachine.start}. */
  readonly initial: SessionContext;
  /** Optional surfaces registered up front; more may be added via {@link SessionMachine.register}. */
  readonly surfaces?: SurfaceRegistry;
}

/**
 * The session machine runtime.
 *
 * Wraps the pure {@link transition} with surface mounting and subscriber
 * notification, guaranteeing the single-surface invariant (R1.2) across the
 * four states (R1.1).
 */
export class SessionMachine {
  private readonly host: HTMLElement;
  private ctx: SessionContext;
  private readonly registry: SurfaceRegistry = {};

  /** The surface currently mounted into the host, or `null` when none is. */
  private mounted: Surface | null = null;
  /** Whether {@link start} has run and the initial surface been mounted. */
  private started = false;

  private readonly listeners = new Set<SessionListener>();

  constructor(config: SessionMachineConfig) {
    this.host = config.host;
    this.ctx = config.initial;
    if (config.surfaces) {
      for (const key of Object.keys(config.surfaces) as SessionState[]) {
        const surface = config.surfaces[key];
        if (surface) {
          this.registry[key] = surface;
        }
      }
    }
  }

  /** The current session state. */
  get state(): SessionState {
    return this.ctx.state;
  }

  /** A read-only view of the current context. */
  get context(): SessionContext {
    return this.ctx;
  }

  /**
   * Register (or replace) the surface for a state. Registering the surface for
   * the current state *after* {@link start} mounts it immediately, upholding
   * the invariant (unmount any current surface first).
   */
  register(state: SessionState, surface: Surface): void {
    this.registry[state] = surface;
    if (this.started && state === this.ctx.state) {
      this.mountFor(this.ctx);
    }
  }

  /**
   * Mount the surface for the initial state. Idempotent: calling it more than
   * once does not stack surfaces. Returns the machine for chaining.
   */
  start(): this {
    if (this.started) {
      return this;
    }
    this.started = true;
    this.mountFor(this.ctx);
    return this;
  }

  /**
   * Apply an event through the pure transition.
   *
   * - If the pure function returns the SAME context (illegal `(state, event)`),
   *   nothing happens: no remount, no notification.
   * - If the context changed but the STATE did not, subscribers are notified
   *   (data changed) but the surface is not remounted (it is unchanged).
   * - If the STATE changed, the outgoing surface is unmounted, exactly one
   *   incoming surface is mounted (R1.2), then subscribers are notified.
   */
  send(ev: SessionEvent): void {
    const prev = this.ctx;
    const next = transition(prev, ev);

    // Identity equality == no transition occurred (see machine.ts contract).
    if (next === prev) {
      return;
    }

    const stateChanged = next.state !== prev.state;
    this.ctx = next;

    if (this.started && stateChanged) {
      this.mountFor(next);
    }

    this.notify();
  }

  /**
   * Subscribe to context changes. The listener fires after each genuine
   * transition (and after any remount). Returns an unsubscribe function; it is
   * safe to call more than once.
   */
  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (active) {
        active = false;
        this.listeners.delete(listener);
      }
    };
  }

  /**
   * Tear the machine down: unmount the current surface and drop all listeners.
   * Leaves the invariant intact (zero surfaces mounted).
   */
  dispose(): void {
    this.unmountCurrent();
    this.listeners.clear();
    this.started = false;
  }

  /**
   * Enforce the single-surface invariant for `ctx.state`: unmount whatever is
   * mounted, then mount exactly the surface bound to the new state (if one is
   * registered). Always unmount BEFORE mount so two surfaces never coexist.
   */
  private mountFor(ctx: SessionContext): void {
    this.unmountCurrent();
    const surface = this.registry[ctx.state];
    if (surface) {
      surface.mount(this.host, ctx);
      this.mounted = surface;
    }
  }

  /** Unmount the currently-mounted surface, if any. */
  private unmountCurrent(): void {
    if (this.mounted) {
      const outgoing = this.mounted;
      this.mounted = null;
      outgoing.unmount();
    }
  }

  /** Notify every subscriber with the current context. */
  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.ctx);
    }
  }
}
