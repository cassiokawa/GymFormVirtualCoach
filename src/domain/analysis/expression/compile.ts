/**
 * Closure-tree compiler for signal / guard expressions.
 *
 * An {@link ExprNode} AST (produced once at load time by the parser) is compiled
 * ONCE into a closure tree: a single function
 * `(frame: LandmarkFrame, ctx: EvalContext) => Signal`. Per frame only that
 * closure tree runs — there is NO parsing, NO string work, and NO heap
 * allocation on the per-frame hot path. All scratch storage (the {@link Point3}
 * buffers point-producing calls read landmarks into) is allocated once at
 * compile time and reused every frame.
 *
 * ## Evaluation semantics
 *
 * Every node evaluates to a {@link Signal} (`number | UNAVAILABLE`):
 *
 * - **number** — the literal value.
 * - **boundVar** — the matching field of {@link EvalContext} (already a Signal,
 *   so `UNAVAILABLE` flows straight through).
 * - **ref** — a bare joint reference is a *point*, not a scalar. It is only
 *   valid inside a point-consuming call (`angle`/`distance`/`axis`/`midpoint`),
 *   which the parser enforces. A `ref` never appears as a standalone scalar
 *   node in a valid AST; if one is reached it yields `UNAVAILABLE`.
 * - **angle(a,b,c)** — the interior angle at `b` (degrees, `[0, 180]`) between
 *   vectors `b→a` and `b→c`. `UNAVAILABLE` if any joint is unavailable or an
 *   edge vector has zero length.
 * - **distance(a,b)** — Euclidean distance between the two points.
 *   `UNAVAILABLE` if either joint is unavailable.
 * - **axis(a,"x"|"y"|"z")** — the named coordinate of point `a`. `UNAVAILABLE`
 *   if `a` is unavailable.
 * - **midpoint(a,b)** — the midpoint is a *point*; used as a scalar it projects
 *   to the point's magnitude (‖midpoint‖). It is meaningful chiefly in the
 *   velocity `trackedPoint` slot; as a signal scalar the magnitude is a total,
 *   well-defined projection. `UNAVAILABLE` if either joint is unavailable.
 * - **normalize(expr,"segment")** — passes `expr` through unchanged in this
 *   task; segment-relative scaling is wired when calibration segments land.
 *   `UNAVAILABLE` if `expr` is `UNAVAILABLE`.
 * - **delta(expr)** — the change in `expr`; the engine feeds the windowed rate
 *   through `dSignal`, so `delta(signal)` reads `ctx.dSignal`. For a general
 *   `expr`, `delta` is defined as the difference from the previous evaluation of
 *   that expression, held in compile-time scratch (no allocation). The first
 *   sample after a reset yields `UNAVAILABLE` (no previous value yet).
 * - **arithmetic** (`+ - * /`) — if either operand is `UNAVAILABLE`, the result
 *   is `UNAVAILABLE`. Division by zero yields `UNAVAILABLE`.
 * - **comparison** (`< > <= >= inside outside`) — yields `1` for true, `0` for
 *   false, and `0` (false) if either operand is `UNAVAILABLE`.
 *
 * ### `inside` / `outside`
 *
 * `inside` and `outside` compare one coordinate position against another —
 * following the design's knee-valgus reading `axis(knee,'x') inside axis(ankle,'x')`.
 * Both operands are scalar axis positions. The comparison is defined *relative
 * to the frame origin* as a total ordering by magnitude:
 *
 * - `a inside b`  ⟺ `|a| < |b|`  (the first position is closer to the origin /
 *   body midline than the second — e.g. the knee has tracked medially "inside"
 *   the ankle);
 * - `a outside b` ⟺ `|a| > |b|`  (the first position is farther from the
 *   origin than the second).
 *
 * This is a sensible total definition for normalised, midline-relative
 * coordinates: "inside" means nearer the centre line, "outside" means farther
 * from it, and equality (`|a| == |b|`) is neither inside nor outside (both
 * yield `0`). `UNAVAILABLE` on either side yields `0`.
 *
 * HARD CONSTRAINT: no exercise `id`, name, or alias appears in this file.
 *
 * Requirements: 2.1, 2.2, 2.4, 2.5, 2.6
 */

import type { LandmarkPairs } from '../spec';
import { UNAVAILABLE, type EvalContext, type LandmarkFrame, type Signal } from '../types';
import { makePoint3, resolveRef, type Point3 } from './resolve';
import type {
  BinaryOpNode,
  BoundVarName,
  CallArg,
  CallNode,
  ComparisonNode,
  ExprNode,
} from './ast';

/**
 * A compiled expression. Pure and synchronous; performs no parsing, no string
 * work, and no heap allocation. Returns a {@link Signal} for every input.
 */
export type CompiledExpr = (frame: LandmarkFrame, ctx: EvalContext) => Signal;

/** True when a {@link Signal} is a usable finite number (not `UNAVAILABLE`). */
function isNum(s: Signal): s is number {
  return s !== UNAVAILABLE;
}

/**
 * Read slot `i` (0=x, 1=y, 2=z) of a resolved {@link Point3}. A resolved point
 * always has three slots, but `noUncheckedIndexedAccess` types the read as
 * `number | undefined`; the `?? 0` collapses the impossible `undefined` without
 * allocating or branching in the common path.
 */
function coord(p: Point3, i: number): number {
  return p[i] ?? 0;
}

/**
 * Read a bound variable out of the eval context without index-signature access
 * (keeps `noPropertyAccessFromIndexSignature` happy and avoids a lookup table
 * allocation).
 */
function readBoundVar(name: BoundVarName, ctx: EvalContext): Signal {
  switch (name) {
    case 'signal':
      return ctx.signal;
    case 'dSignal':
      return ctx.dSignal;
    case 'romFloor':
      return ctx.romFloor;
    case 'romTop':
      return ctx.romTop;
    case 'velocityThreshold':
      return ctx.velocityThreshold;
    case 'repMinSignal':
      return ctx.repMinSignal;
    case 'repMaxSignal':
      return ctx.repMaxSignal;
    case 'phaseElapsedMs':
      return ctx.phaseElapsedMs;
  }
}

/**
 * Compile an {@link ExprNode} AST into a closure tree once. The returned
 * {@link CompiledExpr} does no parsing/allocation per call.
 *
 * @param node  the parsed expression
 * @param pairs the spec's landmark-pair map (for joint resolution)
 */
export function compileExpression(
  node: ExprNode,
  pairs: LandmarkPairs,
): CompiledExpr {
  return compileNode(node, pairs);
}

function compileNode(node: ExprNode, pairs: LandmarkPairs): CompiledExpr {
  switch (node.kind) {
    case 'number': {
      const value = node.value;
      return () => value;
    }

    case 'boundVar': {
      const name = node.name;
      return (_frame, ctx) => readBoundVar(name, ctx);
    }

    case 'ref': {
      // A bare joint reference is a point, not a scalar. Valid ASTs only place
      // refs inside point-consuming calls (enforced by the parser), so this
      // branch is unreachable for well-formed specs. Stay total: yield
      // UNAVAILABLE rather than throwing.
      return () => UNAVAILABLE;
    }

    case 'binaryOp':
      return compileBinaryOp(node, pairs);

    case 'comparison':
      return compileComparison(node, pairs);

    case 'call':
      return compileCall(node, pairs);
  }
}

function compileBinaryOp(
  node: BinaryOpNode,
  pairs: LandmarkPairs,
): CompiledExpr {
  const left = compileNode(node.left, pairs);
  const right = compileNode(node.right, pairs);
  switch (node.operator) {
    case '+':
      return (frame, ctx) => {
        const l = left(frame, ctx);
        const r = right(frame, ctx);
        if (!isNum(l) || !isNum(r)) return UNAVAILABLE;
        return l + r;
      };
    case '-':
      return (frame, ctx) => {
        const l = left(frame, ctx);
        const r = right(frame, ctx);
        if (!isNum(l) || !isNum(r)) return UNAVAILABLE;
        return l - r;
      };
    case '*':
      return (frame, ctx) => {
        const l = left(frame, ctx);
        const r = right(frame, ctx);
        if (!isNum(l) || !isNum(r)) return UNAVAILABLE;
        return l * r;
      };
    case '/':
      return (frame, ctx) => {
        const l = left(frame, ctx);
        const r = right(frame, ctx);
        if (!isNum(l) || !isNum(r)) return UNAVAILABLE;
        if (r === 0) return UNAVAILABLE;
        return l / r;
      };
  }
}

function compileComparison(
  node: ComparisonNode,
  pairs: LandmarkPairs,
): CompiledExpr {
  const left = compileNode(node.left, pairs);
  const right = compileNode(node.right, pairs);
  switch (node.operator) {
    case '<':
      return (frame, ctx) => {
        const l = left(frame, ctx);
        const r = right(frame, ctx);
        if (!isNum(l) || !isNum(r)) return 0;
        return l < r ? 1 : 0;
      };
    case '>':
      return (frame, ctx) => {
        const l = left(frame, ctx);
        const r = right(frame, ctx);
        if (!isNum(l) || !isNum(r)) return 0;
        return l > r ? 1 : 0;
      };
    case '<=':
      return (frame, ctx) => {
        const l = left(frame, ctx);
        const r = right(frame, ctx);
        if (!isNum(l) || !isNum(r)) return 0;
        return l <= r ? 1 : 0;
      };
    case '>=':
      return (frame, ctx) => {
        const l = left(frame, ctx);
        const r = right(frame, ctx);
        if (!isNum(l) || !isNum(r)) return 0;
        return l >= r ? 1 : 0;
      };
    case 'inside':
      // a inside b ⟺ |a| < |b|  (nearer the origin / midline).
      return (frame, ctx) => {
        const l = left(frame, ctx);
        const r = right(frame, ctx);
        if (!isNum(l) || !isNum(r)) return 0;
        return Math.abs(l) < Math.abs(r) ? 1 : 0;
      };
    case 'outside':
      // a outside b ⟺ |a| > |b|  (farther from the origin / midline).
      return (frame, ctx) => {
        const l = left(frame, ctx);
        const r = right(frame, ctx);
        if (!isNum(l) || !isNum(r)) return 0;
        return Math.abs(l) > Math.abs(r) ? 1 : 0;
      };
  }
}

/** Narrow a call argument that must be a bare joint ref; returns its name. */
function refName(arg: CallArg): string {
  // The parser guarantees ref-position args are RefNodes for angle/distance/
  // axis/midpoint, so this is a safe read.
  return arg.kind === 'ref' ? arg.name : '';
}

/** Narrow a string-literal call argument; returns its value. */
function stringValue(arg: CallArg): string {
  return arg.kind === 'string' ? arg.value : '';
}

function compileCall(node: CallNode, pairs: LandmarkPairs): CompiledExpr {
  switch (node.name) {
    case 'angle':
      return compileAngle(node, pairs);
    case 'distance':
      return compileDistance(node, pairs);
    case 'axis':
      return compileAxis(node, pairs);
    case 'midpoint':
      return compileMidpoint(node, pairs);
    case 'normalize':
      return compileNormalize(node, pairs);
    case 'delta':
      return compileDelta(node, pairs);
  }
}

function compileAngle(node: CallNode, pairs: LandmarkPairs): CompiledExpr {
  const a = refName(node.args[0] as CallArg);
  const b = refName(node.args[1] as CallArg);
  const c = refName(node.args[2] as CallArg);
  // Dedicated scratch buffers, allocated once at compile time and reused.
  const pa: Point3 = makePoint3();
  const pb: Point3 = makePoint3();
  const pc: Point3 = makePoint3();
  return (frame) => {
    if (
      resolveRef(a, frame, pairs, pa) === UNAVAILABLE ||
      resolveRef(b, frame, pairs, pb) === UNAVAILABLE ||
      resolveRef(c, frame, pairs, pc) === UNAVAILABLE
    ) {
      return UNAVAILABLE;
    }
    // Vectors b→a and b→c.
    const ux = coord(pa, 0) - coord(pb, 0);
    const uy = coord(pa, 1) - coord(pb, 1);
    const uz = coord(pa, 2) - coord(pb, 2);
    const vx = coord(pc, 0) - coord(pb, 0);
    const vy = coord(pc, 1) - coord(pb, 1);
    const vz = coord(pc, 2) - coord(pb, 2);
    const um = Math.sqrt(ux * ux + uy * uy + uz * uz);
    const vm = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (um === 0 || vm === 0) {
      return UNAVAILABLE;
    }
    let cos = (ux * vx + uy * vy + uz * vz) / (um * vm);
    // Guard floating-point drift outside the valid acos domain.
    if (cos > 1) cos = 1;
    else if (cos < -1) cos = -1;
    return (Math.acos(cos) * 180) / Math.PI;
  };
}

function compileDistance(node: CallNode, pairs: LandmarkPairs): CompiledExpr {
  const a = refName(node.args[0] as CallArg);
  const b = refName(node.args[1] as CallArg);
  const pa: Point3 = makePoint3();
  const pb: Point3 = makePoint3();
  return (frame) => {
    if (
      resolveRef(a, frame, pairs, pa) === UNAVAILABLE ||
      resolveRef(b, frame, pairs, pb) === UNAVAILABLE
    ) {
      return UNAVAILABLE;
    }
    const dx = coord(pa, 0) - coord(pb, 0);
    const dy = coord(pa, 1) - coord(pb, 1);
    const dz = coord(pa, 2) - coord(pb, 2);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
}

function compileAxis(node: CallNode, pairs: LandmarkPairs): CompiledExpr {
  const a = refName(node.args[0] as CallArg);
  const axis = stringValue(node.args[1] as CallArg);
  const pa: Point3 = makePoint3();
  // Precompute which coordinate to project at compile time (no per-frame string
  // comparison). 0 = x, 1 = y, 2 = z, -1 = unknown axis (always UNAVAILABLE).
  const which = axis === 'x' ? 0 : axis === 'y' ? 1 : axis === 'z' ? 2 : -1;
  return (frame) => {
    if (which < 0 || resolveRef(a, frame, pairs, pa) === UNAVAILABLE) {
      return UNAVAILABLE;
    }
    return coord(pa, which);
  };
}

function compileMidpoint(node: CallNode, pairs: LandmarkPairs): CompiledExpr {
  const a = refName(node.args[0] as CallArg);
  const b = refName(node.args[1] as CallArg);
  const pa: Point3 = makePoint3();
  const pb: Point3 = makePoint3();
  return (frame) => {
    if (
      resolveRef(a, frame, pairs, pa) === UNAVAILABLE ||
      resolveRef(b, frame, pairs, pb) === UNAVAILABLE
    ) {
      return UNAVAILABLE;
    }
    // The midpoint is a point; as a scalar it projects to its magnitude.
    const mx = (coord(pa, 0) + coord(pb, 0)) * 0.5;
    const my = (coord(pa, 1) + coord(pb, 1)) * 0.5;
    const mz = (coord(pa, 2) + coord(pb, 2)) * 0.5;
    return Math.sqrt(mx * mx + my * my + mz * mz);
  };
}

function compileNormalize(node: CallNode, pairs: LandmarkPairs): CompiledExpr {
  // normalize(expr, "segment"): the segment argument selects a calibration
  // segment length to divide by. Calibration segments are not yet wired (they
  // arrive with the calibration context), so this passes the inner expression
  // through unchanged for now while preserving UNAVAILABLE propagation.
  const inner = compileNode(node.args[0] as ExprNode, pairs);
  return (frame, ctx) => inner(frame, ctx);
}

function compileDelta(node: CallNode, pairs: LandmarkPairs): CompiledExpr {
  const inner = compileNode(node.args[0] as ExprNode, pairs);
  // Per-node scratch holding the previous evaluation. `has` guards the first
  // sample (no previous value → UNAVAILABLE). Reused every frame, no alloc.
  let prev = 0;
  let has = false;
  return (frame, ctx) => {
    const cur = inner(frame, ctx);
    if (!isNum(cur)) {
      // Do not advance the previous value across an UNAVAILABLE sample.
      return UNAVAILABLE;
    }
    if (!has) {
      prev = cur;
      has = true;
      return UNAVAILABLE;
    }
    const d = cur - prev;
    prev = cur;
    return d;
  };
}
