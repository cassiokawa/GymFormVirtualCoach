/**
 * Recursive-descent parser for signal / guard expressions.
 *
 * Runs once at load time (never per frame). Consumes the token stream produced
 * by {@link tokenize} and yields an {@link ExprNode} AST. On malformed input it
 * throws {@link ParseError} with a descriptive message and source position; the
 * spec validator surfaces that to the author.
 *
 * Precedence (lowest → highest):
 *   1. comparison  (<, >, <=, >=, inside, outside)  — non-associative
 *   2. + -         (left-associative)
 *   3. * /         (left-associative)
 *   4. primary     (number, ref, boundVar, call, parenthesised expr)
 *
 * This differs slightly from the design's `factor := ... | comparison` shorthand:
 * comparison binds *loosest* so `angle(a,b,c) < romFloor` parses as a comparison
 * of two arithmetic sub-expressions, which is the only sensible reading. A
 * comparison may still be parenthesised to appear as a factor.
 *
 * HARD CONSTRAINT: no exercise `id`, name, or alias appears here. Joint names
 * are preserved verbatim as {@link RefNode}s — no resolution to indices.
 *
 * Requirements: 2.1, 2.3
 */

import {
  isBoundVarName,
  type ArithmeticOperator,
  type CallArg,
  type CallName,
  type ComparisonOperator,
  type ExprNode,
} from './ast';
import { tokenize, type Token } from './tokenizer';

/** Thrown when the token stream does not conform to the grammar. */
export class ParseError extends Error {
  /** 0-based source position associated with the failure, when known. */
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = 'ParseError';
    this.position = position;
  }
}

/** Argument shape descriptor for each call. */
interface CallSignature {
  /** Exact number of arguments the call accepts. */
  arity: number;
  /**
   * Per-position argument kind. `'ref'` means the argument MUST be a bare joint
   * reference; `'string'` means a string literal; `'expr'` means any expression.
   */
  argKinds: readonly ('ref' | 'string' | 'expr')[];
}

const CALL_SIGNATURES: Readonly<Record<CallName, CallSignature>> = {
  angle: { arity: 3, argKinds: ['ref', 'ref', 'ref'] },
  distance: { arity: 2, argKinds: ['ref', 'ref'] },
  axis: { arity: 2, argKinds: ['ref', 'string'] },
  midpoint: { arity: 2, argKinds: ['ref', 'ref'] },
  normalize: { arity: 2, argKinds: ['expr', 'string'] },
  delta: { arity: 1, argKinds: ['expr'] },
};

const CALL_NAMES = new Set<string>(Object.keys(CALL_SIGNATURES));
const COMPARISON_OPERATORS = new Set<string>([
  '<',
  '>',
  '<=',
  '>=',
  'inside',
  'outside',
]);

/**
 * Parse a signal / guard expression string into an AST.
 *
 * @throws {ParseError} on malformed input (also wraps tokeniser failures).
 */
export function parseExpression(source: string): ExprNode {
  const tokens = tokenize(source);
  const parser = new Parser(tokens, source);
  const node = parser.parseComparison();
  parser.expectEnd();
  return node;
}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly source: string,
  ) {}

  // --- token cursor helpers ------------------------------------------------

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) {
      throw new ParseError(
        'Unexpected end of expression',
        this.source.length,
      );
    }
    this.pos += 1;
    return token;
  }

  private atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  expectEnd(): void {
    const token = this.peek();
    if (token !== undefined) {
      throw new ParseError(
        `Unexpected trailing token ${JSON.stringify(token.value)} at position ${token.start}`,
        token.start,
      );
    }
  }

  // --- grammar rules -------------------------------------------------------

  /** compare := additive (compOp additive)?  — non-associative. */
  parseComparison(): ExprNode {
    const left = this.parseAdditive();
    const token = this.peek();
    if (
      token !== undefined &&
      token.type === 'comparison' &&
      COMPARISON_OPERATORS.has(token.value)
    ) {
      this.next();
      const right = this.parseAdditive();
      // Reject chained comparisons like `a < b < c`.
      const trailing = this.peek();
      if (
        trailing !== undefined &&
        trailing.type === 'comparison' &&
        COMPARISON_OPERATORS.has(trailing.value)
      ) {
        throw new ParseError(
          `Chained comparison is not allowed at position ${trailing.start}`,
          trailing.start,
        );
      }
      return {
        kind: 'comparison',
        operator: token.value as ComparisonOperator,
        left,
        right,
      };
    }
    return left;
  }

  /** expr := term (('+' | '-') term)*  — left-associative. */
  private parseAdditive(): ExprNode {
    let left = this.parseMultiplicative();
    for (;;) {
      const token = this.peek();
      if (
        token === undefined ||
        token.type !== 'operator' ||
        (token.value !== '+' && token.value !== '-')
      ) {
        break;
      }
      this.next();
      const right = this.parseMultiplicative();
      left = {
        kind: 'binaryOp',
        operator: token.value as ArithmeticOperator,
        left,
        right,
      };
    }
    return left;
  }

  /** term := factor (('*' | '/') factor)*  — left-associative. */
  private parseMultiplicative(): ExprNode {
    let left = this.parseFactor();
    for (;;) {
      const token = this.peek();
      if (
        token === undefined ||
        token.type !== 'operator' ||
        (token.value !== '*' && token.value !== '/')
      ) {
        break;
      }
      this.next();
      const right = this.parseFactor();
      left = {
        kind: 'binaryOp',
        operator: token.value as ArithmeticOperator,
        left,
        right,
      };
    }
    return left;
  }

  /** factor := number | call | ref | boundVar | '(' compare ')'. */
  private parseFactor(): ExprNode {
    const token = this.peek();
    if (token === undefined) {
      throw new ParseError(
        'Unexpected end of expression; expected a value',
        this.source.length,
      );
    }

    // Unary minus on a factor, e.g. `-signal`, `-3`.
    if (token.type === 'operator' && token.value === '-') {
      this.next();
      const operand = this.parseFactor();
      return {
        kind: 'binaryOp',
        operator: '-',
        left: { kind: 'number', value: 0 },
        right: operand,
      };
    }

    if (token.type === 'number') {
      this.next();
      const value = Number(token.value);
      if (!Number.isFinite(value)) {
        throw new ParseError(
          `Invalid number literal ${JSON.stringify(token.value)} at position ${token.start}`,
          token.start,
        );
      }
      return { kind: 'number', value };
    }

    if (token.type === 'lparen') {
      this.next();
      const inner = this.parseComparison();
      this.expect('rparen', ')');
      return inner;
    }

    if (token.type === 'identifier') {
      const nextToken = this.tokens[this.pos + 1];
      // A call: identifier immediately followed by '('.
      if (nextToken !== undefined && nextToken.type === 'lparen') {
        return this.parseCall();
      }
      this.next();
      if (isBoundVarName(token.value)) {
        return { kind: 'boundVar', name: token.value };
      }
      // Anything else is a joint reference; preserved verbatim, not resolved.
      return { kind: 'ref', name: token.value };
    }

    throw new ParseError(
      `Unexpected token ${JSON.stringify(token.value)} at position ${token.start}`,
      token.start,
    );
  }

  /** call := name '(' arg (',' arg)* ')'  with per-call arity/kind rules. */
  private parseCall(): ExprNode {
    const nameToken = this.next(); // identifier
    if (!CALL_NAMES.has(nameToken.value)) {
      throw new ParseError(
        `Unknown function ${JSON.stringify(nameToken.value)} at position ${nameToken.start}`,
        nameToken.start,
      );
    }
    const name = nameToken.value as CallName;
    const signature = CALL_SIGNATURES[name];

    this.expect('lparen', '(');

    const args: CallArg[] = [];
    // Empty argument list is never valid for our calls (min arity 1).
    const first = this.peek();
    if (first !== undefined && first.type === 'rparen') {
      this.next();
      throw new ParseError(
        `${name} expects ${signature.arity} argument(s) but got 0 at position ${nameToken.start}`,
        nameToken.start,
      );
    }

    for (;;) {
      const index = args.length;
      const expectedKind = signature.argKinds[index];
      // Guard against too many arguments before parsing another one.
      if (expectedKind === undefined) {
        throw new ParseError(
          `${name} expects ${signature.arity} argument(s) but got more at position ${nameToken.start}`,
          nameToken.start,
        );
      }
      args.push(this.parseCallArg(name, expectedKind));

      const sep = this.peek();
      if (sep !== undefined && sep.type === 'comma') {
        this.next();
        continue;
      }
      break;
    }

    this.expect('rparen', ')');

    if (args.length !== signature.arity) {
      throw new ParseError(
        `${name} expects ${signature.arity} argument(s) but got ${args.length} at position ${nameToken.start}`,
        nameToken.start,
      );
    }

    return { kind: 'call', name, args };
  }

  /** Parse a single call argument, enforcing its expected kind. */
  private parseCallArg(
    callName: CallName,
    expectedKind: 'ref' | 'string' | 'expr',
  ): CallArg {
    const token = this.peek();
    if (token === undefined) {
      throw new ParseError(
        `Unexpected end of expression in ${callName} arguments`,
        this.source.length,
      );
    }

    if (expectedKind === 'string') {
      if (token.type !== 'string') {
        throw new ParseError(
          `${callName} expects a string argument at position ${token.start}`,
          token.start,
        );
      }
      this.next();
      return { kind: 'string', value: token.value };
    }

    if (expectedKind === 'ref') {
      // A ref argument must be a bare joint identifier (not a bound var, call,
      // number, or compound expression).
      if (token.type !== 'identifier') {
        throw new ParseError(
          `${callName} expects a joint reference at position ${token.start}`,
          token.start,
        );
      }
      const following = this.tokens[this.pos + 1];
      if (following !== undefined && following.type === 'lparen') {
        throw new ParseError(
          `${callName} expects a joint reference, not a call, at position ${token.start}`,
          token.start,
        );
      }
      if (isBoundVarName(token.value)) {
        throw new ParseError(
          `${callName} expects a joint reference, not the bound variable ${JSON.stringify(token.value)}, at position ${token.start}`,
          token.start,
        );
      }
      this.next();
      return { kind: 'ref', name: token.value };
    }

    // expr — any general expression (comparison allowed inside parens only via
    // the comparison entry point; here we accept additive-and-up expressions).
    return this.parseComparison();
  }

  private expect(type: Token['type'], display: string): Token {
    const token = this.peek();
    if (token === undefined) {
      throw new ParseError(
        `Expected ${JSON.stringify(display)} but reached end of expression`,
        this.source.length,
      );
    }
    if (token.type !== type) {
      throw new ParseError(
        `Expected ${JSON.stringify(display)} but found ${JSON.stringify(token.value)} at position ${token.start}`,
        token.start,
      );
    }
    return this.next();
  }
}
