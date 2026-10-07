/**
 * Integer ranges for the PR loop experiment. Do not use in product code.
 */

/** The integers from `start` to `end`, both included. */
export function range(start: number, end: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end; value += 1) {
    values.push(value);
  }
  return values;
}
