/**
 * Abstract syntax tree for signal / guard expressions.
 *
 * An ExerciseSpec's `signal.expr` and each fault `when` guard are strings drawn
 * from a small, total, non-Turing-complete grammar. This module defines the AST
 * those strings parse into at *load time* (never per frame). Compilation of the
 * AST into a closure tree — and any evaluation — happens elsewhere (task 5); this
 * file is data-only and performs no resolution of joints to landmark indices.
 *
 * HARD CONSTRAINT: no exercise `id`, name, or alias appears here. The AST is
 * exercise-agnostic by construction.
 *
 * Grammar (see design.md, "Expression evaluator"):
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/') factor)*
 *   factor  := number | ref | boundVar | call | '(' expr ')' | comparison
 *   call    := angle(ref,ref,ref) | distance(ref,ref) | axis(ref,string)
 *            | midpoint(ref,ref) | normalize(expr,string) | delta(expr)
 *   compare := expr ('<' | '>' | '<=' | '>=' | 'inside' | 'outside') expr
 *
 * Requirements: 2.1, 2.3
 */

// ---------------------------------------------------------------------------
// Bound variables
// ---------------------------------------------------------------------------

/**
 * The set of variables the evaluation context binds. A reference to one of
 * these names parses to a {@link BoundVarNode} rather than a joint
 * {@link RefNode}. Kept in sync with `EvalContext` in `../types`.
 */
export const BOUND_VAR_NAMES = [
  'signal',
  'dSignal',
  'romFloor',
  'romTop',
  'velocityThreshold',
  'repMinSignal',
  'repMaxSignal',
  'phaseElapsedMs',
] as const;

/** A recognised bound-variable name. */
export type BoundVarName = (typeof BOUND_VAR_NAMES)[number];

/** Runtime membership test for {@link BoundVarName}. */
export function isBoundVarName(name: string): name is BoundVarName {
  return (BOUND_VAR_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

/** Arithmetic binary operators, in precedence-free node form. */
export type ArithmeticOperator = '+' | '-' | '*' | '/';

/** Comparison operators supported by the grammar. */
export type ComparisonOperator = '<' | '>' | '<=' | '>=' | 'inside' | 'outside';

/** The set of callable functions in the grammar. */
export type CallName =
  | 'angle'
  | 'distance'
  | 'axis'
  | 'midpoint'
  | 'normalize'
  | 'delta';

// ---------------------------------------------------------------------------
// AST node union
// ---------------------------------------------------------------------------

/** A literal numeric constant, e.g. `12`, `0.5`, `3.14`. */
export interface NumberLiteralNode {
  kind: 'number';
  value: number;
}

/**
 * A joint reference, e.g. `hip`, `knee`, `left_hip`, `right_ankle`.
 *
 * Resolution of a joint name to concrete landmark indices (unprefixed →
 * bilateral midpoint, `left_`/`right_` → side landmark) is NOT done here. The
 * raw name is preserved verbatim for a later compilation pass.
 */
export interface RefNode {
  kind: 'ref';
  /** The joint name exactly as written in the source expression. */
  name: string;
}

/** A reference to a bound context variable, e.g. `signal`, `romFloor`. */
export interface BoundVarNode {
  kind: 'boundVar';
  name: BoundVarName;
}

/** An arithmetic binary operation (`+`, `-`, `*`, `/`). */
export interface BinaryOpNode {
  kind: 'binaryOp';
  operator: ArithmeticOperator;
  left: ExprNode;
  right: ExprNode;
}

/** A comparison, yielding a boolean-as-number when evaluated. */
export interface ComparisonNode {
  kind: 'comparison';
  operator: ComparisonOperator;
  left: ExprNode;
  right: ExprNode;
}

/**
 * A function call. Argument arity and kinds are validated by the parser against
 * each call's signature (e.g. `axis` takes a ref and a string literal).
 */
export interface CallNode {
  kind: 'call';
  name: CallName;
  args: readonly CallArg[];
}

/** A string-literal argument, only valid in specific call positions. */
export interface StringLiteralNode {
  kind: 'string';
  value: string;
}

/** An argument to a {@link CallNode}: either a general expression or a string. */
export type CallArg = ExprNode | StringLiteralNode;

/** Any node that evaluates to a numeric-or-UNAVAILABLE result. */
export type ExprNode =
  | NumberLiteralNode
  | RefNode
  | BoundVarNode
  | BinaryOpNode
  | ComparisonNode
  | CallNode;

/** The root of a parsed expression. */
export type AstNode = ExprNode | StringLiteralNode;
