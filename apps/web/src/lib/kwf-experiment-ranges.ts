/**
 * Integer ranges for the PR loop experiment. Do not use in product code.
 */

/** The integers from `start` to `end`, both included, `step` apart. */
export function range(start: number, end: number, step = 1): number[] {
  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(value);
  }
  return values;
}
