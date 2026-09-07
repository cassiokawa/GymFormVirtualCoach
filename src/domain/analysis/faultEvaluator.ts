/**
 * Phase-scoped fault evaluator.
 *
 * After the phase update for a frame completes, faults are evaluated scoped to
 * the CURRENT phase only (Req 4.1). Each fault carries a compiled guard closure,
 * its declared phase/severity/cue, and — precomputed at load time — the SET of
 * landmark indices its guard references. The confidence gate is a precomputed
 * check over that set, not a re-walk of the AST (design.md, "Fault evaluation").
 *
 * Per frame, for the faults declared in the current phase:
 *
 * - **Confidence gate (Req 4.2)** — if ANY referenced landmark's confidence is
 *   below threshold, the fault is suppressed (nothing emitted). Silence when
 *   uncertain.
 * - **UNAVAILABLE / false guard (Req 4.3)** — if the compiled guard evaluates to
 *   `UNAVAILABLE`, or to a falsey number (0), the fault is suppressed.
 * - **Emit (Req 4.4)** — only when the guard is confidently true (a non-zero
 *   number) does the evaluator produce a {@link FaultDetected} event carrying
 *   the fault `id`, `severity`, and `cue`. EVERY detected fault is emitted; the
 *   engine applies NO cue rationing (one-cue-per-rep / highest-severity-wins is
 *   the Coaching context's job, not the engine's).
 *
 * Allocation-conscious: faults are grouped by phase at construction; the output
 * array is allocated lazily and only when a fault actually fires. A frame in
 * which no fault fires returns a shared empty array (no allocation).
 *
 * `ingest` is pure and synchronous. This evaluator performs no I/O.
 *
 * HARD CONSTRAINT: no exercise `id`, name, or alias appears in this file. Joint
 * names (`hip`, `left_knee`, …) are anatomy, not exercise identity; fault ids
 * and cues arrive as runtime data from the spec, never as literals here.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */

import type { FaultSpec, LandmarkPairs } from './spec';
import type { EvalContext, FaultDetected, FaultSeverity, LandmarkFrame } from './types';
import { UNAVAILABLE } from './types';
import type { CallArg, ExprNode } from './expression/ast';
import { compileExpression, type CompiledExpr } from './expression/compile';
import { parseExpression } from './expression/parser';
import { DEFAULT_CONFIDENCE_THRESHOLD, isLandmarkConfident } from './expression/resolve';

// ---------------------------------------------------------------------------
// Compiled fault
// ---------------------------------------------------------------------------

/**
 * A fault compiled once at load time: its declared phase, the compiled guard
 * closure, the event payload fields, and the precomputed set of landmark
 * indices the guard references (used by the confidence gate).
 */
interface CompiledFault {
  /** The phase this fault is evaluated within. */
  readonly phase: string;
  /** The compiled guard closure; returns a {@link Signal} per frame. */
  readonly guard: CompiledExpr;
  /** Fault identifier, carried verbatim into the emitted event. */
  readonly faultId: string;
  /** Severity, carried verbatim into the emitted event. */
  readonly severity: FaultSeverity;
  /** Movement-focused cue text, carried verbatim into the emitted event. */
  readonly cue: string;
  /**
   * The landmark indices this guard references, precomputed at load time. The
   * confidence gate checks every index in this array; if any is below
   * threshold, the fault is suppressed. Reused every frame, no allocation.
   */
  readonly landmarks: readonly number[];
}

// ---------------------------------------------------------------------------
// Reference collection (load time only)
// ---------------------------------------------------------------------------

const LEFT_PREFIX = 'left_';
const RIGHT_PREFIX = 'right_';

/** Walk an {@link ExprNode} AST collecting every distinct joint ref name. */
function collectRefNames(node: ExprNode, out: Set<string>): void {
  switch (node.kind) {
    case 'number':
    case 'boundVar':
      return;
    case 'ref':
      out.add(node.name);
      return;
    case 'binaryOp':
    case 'comparison':
      collectRefNames(node.left, out);
      collectRefNames(node.right, out);
      return;
    case 'call':
      for (const arg of node.args) {
        collectRefArg(arg, out);
      }
      return;
  }
}

/** A call argument is either an expression or a string literal. */
function collectRefArg(arg: CallArg, out: Set<string>): void {
  if (arg.kind === 'string') {
    return;
  }
  collectRefNames(arg, out);
}

/**
 * Resolve a set of joint ref names to the set of landmark indices they touch,
 * using the spec's `landmarkPairs`:
 *
 * - an UNPREFIXED name (`hip`) touches BOTH the left and right indices of its
 *   pair (it resolves to their bilateral midpoint, so both must be confident);
 * - a `left_` / `right_` PREFIXED name touches only the one named side index.
 *
 * A name with no matching pair contributes no index (resolution of such a name
 * yields `UNAVAILABLE` at eval time, which the guard gate already handles).
 */
function resolveLandmarkIndices(
  refNames: ReadonlySet<string>,
  pairs: LandmarkPairs,
): number[] {
  const indices = new Set<number>();
  for (const name of refNames) {
    if (name.startsWith(LEFT_PREFIX)) {
      const pair = pairs[name.slice(LEFT_PREFIX.length)];
      if (pair !== undefined) {
        indices.add(pair.left);
      }
    } else if (name.startsWith(RIGHT_PREFIX)) {
      const pair = pairs[name.slice(RIGHT_PREFIX.length)];
      if (pair !== undefined) {
        indices.add(pair.right);
      }
    } else {
      const pair = pairs[name];
      if (pair !== undefined) {
        indices.add(pair.left);
        indices.add(pair.right);
      }
    }
  }
  return Array.from(indices);
}

// ---------------------------------------------------------------------------
// Fault evaluator
// ---------------------------------------------------------------------------

/** A shared empty result reused on frames where no fault fires (no allocation). */
const NO_FAULTS: readonly FaultDetected[] = Object.freeze([]);

/**
 * The phase-scoped fault evaluator. Construct once per spec via
 * {@link createFaultEvaluator}; call {@link FaultEvaluator.evaluate} per frame
 * after the phase machine has produced the current phase.
 */
export class FaultEvaluator {
  /**
   * Faults grouped by their declared phase. Per frame only the bucket for the
   * current phase is scanned (Req 4.1); phases with no faults are absent.
   */
  private readonly byPhase: ReadonlyMap<string, readonly CompiledFault[]>;

  /** Minimum visibility/presence a referenced landmark must meet. */
  private readonly threshold: number;

  constructor(
    faults: readonly CompiledFault[],
    threshold: number,
  ) {
    const byPhase = new Map<string, CompiledFault[]>();
    for (const fault of faults) {
      const bucket = byPhase.get(fault.phase);
      if (bucket === undefined) {
        byPhase.set(fault.phase, [fault]);
      } else {
        bucket.push(fault);
      }
    }
    this.byPhase = byPhase;
    this.threshold = threshold;
  }

  /**
   * Evaluate the faults declared in `currentPhase` against this frame.
   *
   * @param currentPhase the phase the machine is in after this frame's update
   * @param frame        the current landmark frame
   * @param ctx          the per-frame evaluation context (bound variables)
   * @param t            the frame's capture timestamp (ms), carried into events
   * @returns a {@link FaultDetected} array with 0..n events. When no fault
   *          fires, a shared empty array is returned (no allocation).
   */
  evaluate(
    currentPhase: string,
    frame: LandmarkFrame,
    ctx: EvalContext,
    t: number,
  ): readonly FaultDetected[] {
    const bucket = this.byPhase.get(currentPhase);
    if (bucket === undefined) {
      // Req 4.1: only current-phase faults are evaluated; nothing here.
      return NO_FAULTS;
    }

    // Allocate the output only when a fault actually fires.
    let out: FaultDetected[] | null = null;

    for (const fault of bucket) {
      // Confidence gate (Req 4.2): suppress if any referenced landmark is
      // below threshold. Precomputed set, not a re-walk of the AST.
      if (!this.allLandmarksConfident(fault, frame)) {
        continue;
      }

      // Guard evaluation (Req 4.3): UNAVAILABLE or falsey (0) → suppress.
      const result = fault.guard(frame, ctx);
      if (result === UNAVAILABLE || result === 0) {
        continue;
      }

      // Emit (Req 4.4): confidently true → emit, no cue rationing.
      const event: FaultDetected = {
        type: 'FaultDetected',
        t,
        faultId: fault.faultId,
        phase: currentPhase,
        severity: fault.severity,
        cue: fault.cue,
      };
      if (out === null) {
        out = [event];
      } else {
        out.push(event);
      }
    }

    return out ?? NO_FAULTS;
  }

  /** True when every landmark the fault references meets the threshold. */
  private allLandmarksConfident(
    fault: CompiledFault,
    frame: LandmarkFrame,
  ): boolean {
    const landmarks = fault.landmarks;
    for (let i = 0; i < landmarks.length; i++) {
      const index = landmarks[i];
      if (index === undefined) {
        continue;
      }
      if (!isLandmarkConfident(frame, index, this.threshold)) {
        return false;
      }
    }
    return true;
  }
}

/**
 * Compile a spec's fault list into a {@link FaultEvaluator}.
 *
 * Each {@link FaultSpec}'s `when` guard is parsed and compiled ONCE, its
 * referenced joint names are walked out of the AST, and those names are resolved
 * to a precomputed set of landmark indices via `pairs`. All parsing, walking,
 * and index resolution happens here at load time; per frame only the compiled
 * closures and the precomputed index sets are used.
 *
 * @param faults    the spec's fault rules
 * @param pairs     the spec's unprefixed-joint → left/right index map
 * @param threshold minimum landmark visibility/presence; defaults to
 *                  {@link DEFAULT_CONFIDENCE_THRESHOLD}
 */
export function createFaultEvaluator(
  faults: readonly FaultSpec[],
  pairs: LandmarkPairs,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): FaultEvaluator {
  const compiled: CompiledFault[] = faults.map((spec) => {
    const ast = parseExpression(spec.when);
    const guard = compileExpression(ast, pairs);
    const refNames = new Set<string>();
    collectRefNames(ast, refNames);
    const landmarks = resolveLandmarkIndices(refNames, pairs);
    return {
      phase: spec.phase,
      guard,
      faultId: spec.id,
      severity: spec.severity,
      cue: spec.cue,
      landmarks,
    };
  });
  return new FaultEvaluator(compiled, threshold);
}
