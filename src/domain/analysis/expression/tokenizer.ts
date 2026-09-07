/**
 * Tokeniser for signal / guard expressions.
 *
 * Runs once at load time. Turns an expression string into a flat token stream
 * the recursive-descent parser consumes. Throws {@link TokenizeError} on any
 * unrecognised character so the validator can surface a descriptive message.
 *
 * HARD CONSTRAINT: no exercise `id`, name, or alias appears here.
 *
 * Requirements: 2.1, 2.3
 */

/** The lexical categories the parser distinguishes. */
export type TokenType =
  | 'number'
  | 'string'
  | 'identifier'
  | 'operator'
  | 'comparison'
  | 'lparen'
  | 'rparen'
  | 'comma';

/** A single lexical token with its source position (0-based char index). */
export interface Token {
  type: TokenType;
  /** The token text; for strings this is the *unquoted* value. */
  value: string;
  /** 0-based index of the token's first character in the source string. */
  start: number;
}

/** Thrown when the source contains a character sequence that cannot be lexed. */
export class TokenizeError extends Error {
  /** 0-based index into the source where lexing failed. */
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = 'TokenizeError';
    this.position = position;
  }
}

const WHITESPACE = /\s/;
const DIGIT = /[0-9]/;
// Identifiers cover joint names (with `_` for `left_hip`) and bound vars / calls.
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

/**
 * Lex `source` into a token array. The stream carries no explicit end marker;
 * the parser tracks position against `tokens.length`.
 *
 * @throws {TokenizeError} on any unrecognised character.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;

  const charAt = (index: number): string => source.charAt(index);

  while (i < n) {
    const ch = charAt(i);

    // Whitespace — skip.
    if (WHITESPACE.test(ch)) {
      i += 1;
      continue;
    }

    // Numbers: integer or decimal (e.g. `12`, `0.5`, `.5`, `3.`).
    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(charAt(i + 1)))) {
      const start = i;
      let sawDot = false;
      while (i < n) {
        const c = charAt(i);
        if (DIGIT.test(c)) {
          i += 1;
        } else if (c === '.' && !sawDot) {
          sawDot = true;
          i += 1;
        } else {
          break;
        }
      }
      tokens.push({ type: 'number', value: source.slice(start, i), start });
      continue;
    }

    // Identifiers: joint names, bound vars, call names.
    if (IDENT_START.test(ch)) {
      const start = i;
      while (i < n && IDENT_PART.test(charAt(i))) {
        i += 1;
      }
      const value = source.slice(start, i);
      // `inside` / `outside` are comparison keywords, not identifiers.
      if (value === 'inside' || value === 'outside') {
        tokens.push({ type: 'comparison', value, start });
      } else {
        tokens.push({ type: 'identifier', value, start });
      }
      continue;
    }

    // String literals: single or double quoted, e.g. `"y"`, `'femur'`.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i += 1; // consume opening quote
      let value = '';
      let closed = false;
      while (i < n) {
        const c = charAt(i);
        if (c === '\\' && i + 1 < n) {
          // Simple escape: take the next char verbatim.
          value += charAt(i + 1);
          i += 2;
          continue;
        }
        if (c === quote) {
          i += 1; // consume closing quote
          closed = true;
          break;
        }
        value += c;
        i += 1;
      }
      if (!closed) {
        throw new TokenizeError(
          `Unterminated string literal starting at position ${start}`,
          start,
        );
      }
      tokens.push({ type: 'string', value, start });
      continue;
    }

    // Comparison operators: `<=`, `>=`, `<`, `>`.
    if (ch === '<' || ch === '>') {
      const start = i;
      if (charAt(i + 1) === '=') {
        tokens.push({ type: 'comparison', value: `${ch}=`, start });
        i += 2;
      } else {
        tokens.push({ type: 'comparison', value: ch, start });
        i += 1;
      }
      continue;
    }

    // Arithmetic operators.
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ type: 'operator', value: ch, start: i });
      i += 1;
      continue;
    }

    // Grouping / separators.
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch, start: i });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch, start: i });
      i += 1;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ch, start: i });
      i += 1;
      continue;
    }

    throw new TokenizeError(
      `Unexpected character ${JSON.stringify(ch)} at position ${i}`,
      i,
    );
  }

  return tokens;
}
