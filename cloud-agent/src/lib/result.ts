/**
 * Result type for explicit error handling without exceptions.
 *
 * This pattern makes error cases explicit in the type system,
 * avoiding the need to rely on try/catch for control flow.
 */

// ---------------------------------------------------------------------------
// Result Type
// ---------------------------------------------------------------------------

/**
 * A Result represents either success (Ok) or failure (Err).
 * Use this instead of throwing exceptions for expected error cases.
 */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Create a successful Result containing a value */
export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/** Create a failed Result containing an error */
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/** Check if a Result is Ok (successful) */
export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;

/** Check if a Result is Err (failed) */
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

/**
 * Transform the value inside a successful Result.
 * If the Result is an error, it passes through unchanged.
 *
 * @param r - The Result to transform
 * @param fn - Function to apply to the value
 * @returns A new Result with the transformed value
 */
export const mapResult = <T, U, E>(r: Result<T, E>, fn: (v: T) => U): Result<U, E> =>
  r.ok ? Ok(fn(r.value)) : r;

/**
 * Extract the value from a Result, throwing if it's an error.
 * Use sparingly - prefer pattern matching or combinators.
 *
 * @param r - The Result to unwrap
 * @returns The value if Ok
 * @throws The error if Err (wrapped in Error if not already an Error instance)
 */
export const unwrap = <T, E>(r: Result<T, E>): T => {
  if (r.ok) return r.value;
  if (r.error instanceof Error) throw r.error;
  throw new Error(String(r.error));
};

/**
 * Extract the value from a Result, returning a default if it's an error.
 *
 * @param r - The Result to unwrap
 * @param defaultValue - Value to return if Result is an error
 * @returns The value if Ok, otherwise the default
 */
export const unwrapOr = <T, E>(r: Result<T, E>, defaultValue: T): T =>
  r.ok ? r.value : defaultValue;
