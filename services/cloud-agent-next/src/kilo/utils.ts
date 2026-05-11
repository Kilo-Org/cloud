import type { ExecutionId } from '../types/ids.js';

/**
 * Type-safe extraction of the ULID portion from an execution ID.
 */
export const extractUlid = (id: ExecutionId): string => {
  return id.replace(/^exc_/, '');
};

/**
 * Shell-quote a value for safe interpolation into a POSIX sh command line.
 *
 * Wraps the value in single quotes, escaping any embedded single quotes via
 * the standard `'\\''` idiom (end current quote, escaped quote, start new quote).
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
