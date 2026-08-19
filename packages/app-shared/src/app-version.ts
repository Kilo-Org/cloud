/**
 * Compare two dotted version strings up to three segments (major.minor.patch).
 *
 * A missing segment is 0. A non-numeric segment is also 0 (NaN coerced to 0).
 * Returns true when `current` is below `minimum`; false when equal or above.
 */
export function isVersionBelow(current: string, minimum: string): boolean {
  const currentParts = current.split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);

  for (let i = 0; i < 3; i += 1) {
    const cur = toSegment(currentParts[i]);
    const min = toSegment(minimumParts[i]);
    if (cur < min) {
      return true;
    }
    if (cur > min) {
      return false;
    }
  }
  return false;
}

function toSegment(value: number | undefined): number {
  return value === undefined || Number.isNaN(value) ? 0 : value;
}
