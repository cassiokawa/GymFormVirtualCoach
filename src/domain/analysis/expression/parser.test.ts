/**
 * Unit tests for the expression tokeniser and recursive-descent parser.
 *
 * Covers the grammar shapes from design.md: numbers, joint refs, bound vars,
 * arithmetic precedence/associativity, comparisons, and every call form, plus
 * descriptive errors on malformed input.
 */

import { describe, expect, it } from 'vitest';
import {
  parseExpression,
  ParseError,
  tokenize,
  TokenizeError,
  type ExprNode,
} from './index';

describe('tokenize', () => {
  it('lexes numbers, identifiers, operators, and grouping', () => {
    const tokens = tokenize('angle(hip, knee, ankle) + 0.5');
    expect(tokens.map((t) => t.type)).toEqual([
      'identifier',
      'lparen',
      'identifier',
      'comma',
      'identifier',
      'comma',
      'identifier',
      'rparen',
      'operator',
      'number',
    ]);
  });

  it('lexes comparison keywords and symbols', () => {
    expect(tokenize('a inside b').map((t) => t.type)).toContain('comparison');
    expect(tokenize('a <= b').map((t) => t.value)).toContain('<=');
    expect(tokenize('a >= b').map((t) => t.value)).toContain('>=');
  });

  it('lexes quoted string literals and strips quotes', () => {
    const tokens = tokenize('axis(hip, "y")');
    const str = tokens.find((t) => t.type === 'string');
    expect(str?.value).toBe('y');
  });

  it('throws TokenizeError on an unknown character', () => {
    expect(() => tokenize('hip @ knee')).toThrow(TokenizeError);
  });

  it('throws TokenizeError on an unterminated string', () => {
    expect(() => tokenize('axis(hip, "y)')).toThrow(TokenizeError);
  });
});

describe('parseExpression — primaries', () => {
  it('parses a number literal', () => {
    expect(parseExpression('12.5')).toEqual({ kind: 'number', value: 12.5 });
  });

  it('parses an unprefixed joint reference verbatim (no resolution)', () => {
    expect(parseExpression('hip')).toEqual({ kind: 'ref', name: 'hip' });
  });

  it('parses side-prefixed joint references verbatim', () => {
    expect(parseExpression('left_hip')).toEqual({
      kind: 'ref',
      name: 'left_hip',
    });
  });

  it('parses bound variables as boundVar nodes', () => {
    for (const name of [
      'signal',
      'dSignal',
      'romFloor',
      'romTop',
      'velocityThreshold',
      'repMinSignal',
      'repMaxSignal',
      'phaseElapsedMs',
    ] as const) {
      expect(parseExpression(name)).toEqual({ kind: 'boundVar', name });
    }
  });
});

describe('parseExpression — arithmetic', () => {
  it('honours multiplicative-over-additive precedence', () => {
    const ast = parseExpression('1 + 2 * 3') as Extract<
      ExprNode,
      { kind: 'binaryOp' }
    >;
    expect(ast.kind).toBe('binaryOp');
    expect(ast.operator).toBe('+');
    expect(ast.right).toMatchObject({ kind: 'binaryOp', operator: '*' });
  });

  it('is left-associative for equal precedence', () => {
    const ast = parseExpression('10 - 3 - 2') as Extract<
      ExprNode,
      { kind: 'binaryOp' }
    >;
    expect(ast.operator).toBe('-');
    // ((10 - 3) - 2): left is the nested subtraction.
    expect(ast.left).toMatchObject({ kind: 'binaryOp', operator: '-' });
    expect(ast.right).toMatchObject({ kind: 'number', value: 2 });
  });

  it('respects parenthesised grouping', () => {
    const ast = parseExpression('(1 + 2) * 3') as Extract<
      ExprNode,
      { kind: 'binaryOp' }
    >;
    expect(ast.operator).toBe('*');
    expect(ast.left).toMatchObject({ kind: 'binaryOp', operator: '+' });
  });

  it('parses unary minus as (0 - operand)', () => {
    expect(parseExpression('-signal')).toEqual({
      kind: 'binaryOp',
      operator: '-',
      left: { kind: 'number', value: 0 },
      right: { kind: 'boundVar', name: 'signal' },
    });
  });
});

describe('parseExpression — comparisons', () => {
  it.each(['<', '>', '<=', '>=', 'inside', 'outside'])(
    'parses the %s comparator',
    (op) => {
      const ast = parseExpression(`signal ${op} romFloor`) as Extract<
        ExprNode,
        { kind: 'comparison' }
      >;
      expect(ast.kind).toBe('comparison');
      expect(ast.operator).toBe(op);
    },
  );

  it('binds comparison looser than arithmetic', () => {
    const ast = parseExpression('a + b < c') as Extract<
      ExprNode,
      { kind: 'comparison' }
    >;
    expect(ast.kind).toBe('comparison');
    expect(ast.left).toMatchObject({ kind: 'binaryOp', operator: '+' });
    expect(ast.right).toMatchObject({ kind: 'ref', name: 'c' });
  });

  it('rejects chained comparisons', () => {
    expect(() => parseExpression('a < b < c')).toThrow(ParseError);
  });
});

describe('parseExpression — calls', () => {
  it('parses angle(ref,ref,ref)', () => {
    expect(parseExpression('angle(hip, knee, ankle)')).toEqual({
      kind: 'call',
      name: 'angle',
      args: [
        { kind: 'ref', name: 'hip' },
        { kind: 'ref', name: 'knee' },
        { kind: 'ref', name: 'ankle' },
      ],
    });
  });

  it('parses distance(ref,ref)', () => {
    expect(parseExpression('distance(left_hip, right_hip)')).toMatchObject({
      kind: 'call',
      name: 'distance',
    });
  });

  it('parses axis(ref,string)', () => {
    expect(parseExpression('axis(hip, "y")')).toEqual({
      kind: 'call',
      name: 'axis',
      args: [
        { kind: 'ref', name: 'hip' },
        { kind: 'string', value: 'y' },
      ],
    });
  });

  it('parses midpoint(ref,ref)', () => {
    expect(parseExpression('midpoint(left_hip, right_hip)')).toMatchObject({
      kind: 'call',
      name: 'midpoint',
    });
  });

  it('parses normalize(expr,string) with an expression first argument', () => {
    const ast = parseExpression(
      'normalize(distance(left_hip, right_hip), "femur")',
    ) as Extract<ExprNode, { kind: 'call' }>;
    expect(ast.name).toBe('normalize');
    expect(ast.args[0]).toMatchObject({ kind: 'call', name: 'distance' });
    expect(ast.args[1]).toEqual({ kind: 'string', value: 'femur' });
  });

  it('parses delta(expr)', () => {
    expect(parseExpression('delta(signal)')).toEqual({
      kind: 'call',
      name: 'delta',
      args: [{ kind: 'boundVar', name: 'signal' }],
    });
  });

  it('nests calls inside arithmetic and comparisons', () => {
    const ast = parseExpression(
      'angle(hip, knee, ankle) < romFloor + 5',
    ) as Extract<ExprNode, { kind: 'comparison' }>;
    expect(ast.kind).toBe('comparison');
    expect(ast.left).toMatchObject({ kind: 'call', name: 'angle' });
    expect(ast.right).toMatchObject({ kind: 'binaryOp', operator: '+' });
  });
});

describe('parseExpression — malformed input', () => {
  it('rejects an unknown function', () => {
    expect(() => parseExpression('tangent(hip, knee)')).toThrow(ParseError);
  });

  it('rejects wrong arity', () => {
    expect(() => parseExpression('angle(hip, knee)')).toThrow(ParseError);
    expect(() => parseExpression('delta(a, b)')).toThrow(ParseError);
  });

  it('rejects a non-ref where a ref is required', () => {
    expect(() => parseExpression('angle(1, knee, ankle)')).toThrow(ParseError);
    expect(() => parseExpression('angle(signal, knee, ankle)')).toThrow(
      ParseError,
    );
  });

  it('rejects a missing string argument', () => {
    expect(() => parseExpression('axis(hip, y)')).toThrow(ParseError);
  });

  it('rejects unbalanced parentheses', () => {
    expect(() => parseExpression('(1 + 2')).toThrow(ParseError);
  });

  it('rejects trailing tokens', () => {
    expect(() => parseExpression('signal romFloor')).toThrow(ParseError);
  });

  it('rejects an empty expression', () => {
    expect(() => parseExpression('   ')).toThrow(ParseError);
  });

  it('exposes a source position on errors', () => {
    try {
      parseExpression('hip + ');
      throw new Error('expected ParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect(typeof (err as ParseError).position).toBe('number');
    }
  });
});
