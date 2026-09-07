/**
 * Expression subsystem — public surface.
 *
 * Load-time tokenising and parsing of signal / guard expressions into an AST.
 * Closure-tree compilation and per-frame evaluation live elsewhere (task 5).
 *
 * No exercise `id`, name, or alias appears in any file here.
 */

export * from './ast';
export * from './tokenizer';
export * from './parser';
export * from './compile';
export * from './resolve';
