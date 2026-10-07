/**
 * Integer ranges for the PR loop experiment. Do not use in product code.
 */

/**
 * The integers from `first` to `last`, both included, `step` apart; empty when `last` is below `first`.
 *
 * `step` must be a positive integer. A zero or negative step would never
 * advance toward `last`, so it is rejected instead of looping forever.
 */
export function range(first: number, last: number, step = 1): number[] {
  if (!Number.isInteger(step) || step <= 0) {
    throw new Error(`range: step must be a positive integer, got ${step}`);
  }
  const values: number[] = [];
  for (let value = first; value <= last; value += step) {
    values.push(value);
  }
  return values;
}
