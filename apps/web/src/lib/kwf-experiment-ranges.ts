/**
 * Integer ranges for the PR loop experiment. Do not use in product code.
 */

/**
 * The integers from `start` to `end`, both included, `step` apart.
 *
 * `step` must be a positive integer. A zero or negative step would never
 * advance toward `end`, so it is rejected instead of looping forever.
 */
export function range(start: number, end: number, step = 1): number[] {
  if (!Number.isInteger(step) || step <= 0) {
    throw new Error(`range: step must be a positive integer, got ${step}`);
  }
  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(value);
  }
  return values;
}
