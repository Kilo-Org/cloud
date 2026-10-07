/**
 * Integer ranges for the PR loop experiment. Do not use in product code.
 */

/** The integers from `first` to `last`, both included; empty when `last` is below `first`. */
export function range(first: number, last: number): number[] {
  const values: number[] = [];
  for (let value = first; value <= last; value++) {
    values.push(value);
  }
  return values;
}
