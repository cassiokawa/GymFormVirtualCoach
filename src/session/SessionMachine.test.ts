/**
 * Unit tests for the SessionMachine runtime (task 2.4).
 *
 * Verify the single-surface invariant (R1.2): after any transition exactly one
 * surface is mounted and the previous one is unmounted; subscribers fire on a
 * genuine change; and an illegal transition neither remounts nor notifies
 * (R1.1).
 *
 * Requirements: 1.1, 1.2
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { SessionMachine } from './SessionMachine';
import type {
  SessionContext,
  SessionState,
  Surface,
} from './types';

/**
 * A test surface that records its own mount/unmount into a shared log and
 * tracks whether it is currently mounted, so tests can assert the invariant.
 */
class SpySurface implements Surface {
  mounted = false;
  mountCount = 0;
  unmountCount = 0;
  lastCtx: SessionContext | null = null;
  private node: HTMLElement | null = null;

  constructor(
    readonly label: SessionState,
    private readonly log: string[],
  ) {}

  mount(host: HTMLElement, ctx: SessionContext): void {
    this.mounted = true;
    this.mountCount += 1;
    this.lastCtx = ctx;
    this.log.push(`mount:${this.label}`);
    const node = document.createElement('div');
    node.dataset['surface'] = this.label;
    host.appendChild(node);
    this.node = node;
  }

  unmount(): void {
    this.mounted = false;
    this.unmountCount += 1;
    this.log.push(`unmount:${this.label}`);
    this.node?.remove();
    this.node = null;
  }
}

function ctxIn(
  state: SessionState,
  overrides: Partial<SessionContext> = {},
): SessionContext {
  return {
    state,
    exerciseId: null,
    framingValid: true,
    set: null,
    ...overrides,
  };
}

describe('SessionMachine runtime', () => {
  let host: HTMLElement;
  let log: string[];
  let surfaces: Record<SessionState, SpySurface>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    log = [];
    surfaces = {
      SETUP: new SpySurface('SETUP', log),
      ARMED: new SpySurface('ARMED', log),
      WORKING: new SpySurface('WORKING', log),
      REVIEW: new SpySurface('REVIEW', log),
    };
  });

  function make(state: SessionState, overrides: Partial<SessionContext> = {}) {
    return new SessionMachine({
      host,
      initial: ctxIn(state, overrides),
      surfaces,
    });
  }

  /** Count how many spy surfaces report themselves currently mounted. */
  function mountedCount(): number {
    return Object.values(surfaces).filter((s) => s.mounted).length;
  }

  it('start() mounts exactly the surface for the initial state', () => {
    const m = make('SETUP').start();

    expect(mountedCount()).toBe(1);
    expect(surfaces.SETUP.mounted).toBe(true);
    expect(surfaces.SETUP.mountCount).toBe(1);
    expect(host.querySelector('[data-surface="SETUP"]')).not.toBeNull();
  });

  it('start() is idempotent — does not stack surfaces', () => {
    const m = make('SETUP');
    m.start();
    m.start();

    expect(surfaces.SETUP.mountCount).toBe(1);
    expect(mountedCount()).toBe(1);
  });

  it('after a transition exactly one surface is mounted and the previous is unmounted', () => {
    const m = make('SETUP').start();

    // SETUP -> ARMED (framing valid).
    m.send({ kind: 'START_REQUESTED' });

    expect(m.state).toBe('ARMED');
    expect(mountedCount()).toBe(1);
    expect(surfaces.ARMED.mounted).toBe(true);
    expect(surfaces.SETUP.mounted).toBe(false);
    expect(surfaces.SETUP.unmountCount).toBe(1);
    // Unmount precedes mount, so surfaces never coexist.
    expect(log).toEqual(['mount:SETUP', 'unmount:SETUP', 'mount:ARMED']);
  });

  it('holds the single-surface invariant across a full walk of the state graph', () => {
    const m = make('SETUP').start();

    m.send({ kind: 'START_REQUESTED' }); // -> ARMED
    expect(mountedCount()).toBe(1);
    m.send({ kind: 'COUNTDOWN_ELAPSED' }); // -> WORKING
    expect(mountedCount()).toBe(1);
    expect(surfaces.WORKING.mounted).toBe(true);
    m.send({ kind: 'SET_ENDED' }); // -> REVIEW
    expect(mountedCount()).toBe(1);
    expect(surfaces.REVIEW.mounted).toBe(true);
    m.send({ kind: 'RETURN_TO_SETUP' }); // -> SETUP
    expect(mountedCount()).toBe(1);
    expect(surfaces.SETUP.mounted).toBe(true);

    // The host only ever holds one surface node.
    expect(host.querySelectorAll('[data-surface]').length).toBe(1);
  });

  it('mounts the incoming surface with the post-transition context', () => {
    const m = make('SETUP', { exerciseId: 'e-opaque' }).start();

    m.send({ kind: 'START_REQUESTED' });

    expect(surfaces.ARMED.lastCtx?.state).toBe('ARMED');
    expect(surfaces.ARMED.lastCtx?.exerciseId).toBe('e-opaque');
  });

  it('subscribe fires on a genuine transition with the new context', () => {
    const m = make('SETUP').start();
    const seen: SessionState[] = [];
    m.subscribe((ctx) => seen.push(ctx.state));

    m.send({ kind: 'START_REQUESTED' }); // -> ARMED
    m.send({ kind: 'COUNTDOWN_ELAPSED' }); // -> WORKING

    expect(seen).toEqual(['ARMED', 'WORKING']);
  });

  it('unsubscribe stops further notifications', () => {
    const m = make('SETUP').start();
    const seen: SessionState[] = [];
    const off = m.subscribe((ctx) => seen.push(ctx.state));

    m.send({ kind: 'START_REQUESTED' }); // -> ARMED (seen)
    off();
    m.send({ kind: 'COUNTDOWN_ELAPSED' }); // -> WORKING (not seen)

    expect(seen).toEqual(['ARMED']);
  });

  it('an illegal transition does not remount and does not notify', () => {
    // START_REQUESTED while framing is INVALID is a no-op (R4.5).
    const m = make('SETUP', { framingValid: false }).start();
    const seen: SessionState[] = [];
    m.subscribe((ctx) => seen.push(ctx.state));

    m.send({ kind: 'START_REQUESTED' });

    expect(m.state).toBe('SETUP');
    expect(surfaces.SETUP.mountCount).toBe(1); // still the original mount
    expect(surfaces.SETUP.unmountCount).toBe(0); // never unmounted
    expect(seen).toEqual([]); // no notification
    expect(mountedCount()).toBe(1);
  });

  it('an event with no legal edge for the current state is a no-op', () => {
    const m = make('WORKING').start();
    const seen: SessionState[] = [];
    m.subscribe((ctx) => seen.push(ctx.state));

    // REPEAT_SET is only legal from REVIEW.
    m.send({ kind: 'REPEAT_SET' });

    expect(m.state).toBe('WORKING');
    expect(surfaces.WORKING.mountCount).toBe(1);
    expect(surfaces.WORKING.unmountCount).toBe(0);
    expect(seen).toEqual([]);
  });

  it('registering the current state surface after start mounts it immediately', () => {
    const m = new SessionMachine({ host, initial: ctxIn('SETUP') });
    m.start();

    // No surface registered yet: invariant allows zero mounted.
    expect(host.querySelectorAll('[data-surface]').length).toBe(0);

    m.register('SETUP', surfaces.SETUP);

    expect(surfaces.SETUP.mounted).toBe(true);
    expect(host.querySelectorAll('[data-surface]').length).toBe(1);
  });

  it('transitioning into a state with no registered surface unmounts the outgoing one', () => {
    const m = new SessionMachine({
      host,
      initial: ctxIn('SETUP'),
      surfaces: { SETUP: surfaces.SETUP }, // only SETUP registered
    }).start();

    expect(surfaces.SETUP.mounted).toBe(true);

    m.send({ kind: 'START_REQUESTED' }); // -> ARMED (no surface registered)

    expect(m.state).toBe('ARMED');
    expect(surfaces.SETUP.mounted).toBe(false);
    expect(mountedCount()).toBe(0);
    expect(host.querySelectorAll('[data-surface]').length).toBe(0);
  });

  it('dispose unmounts the current surface and stops notifications', () => {
    const m = make('SETUP').start();
    const seen: SessionState[] = [];
    m.subscribe((ctx) => seen.push(ctx.state));

    m.dispose();

    expect(surfaces.SETUP.mounted).toBe(false);
    expect(mountedCount()).toBe(0);
  });
});
