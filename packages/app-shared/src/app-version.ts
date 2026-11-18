/**
 * Compare two dotted version strings up to three segments (major.minor.patch).
 *
 * A missing segment is 0. A non-numeric segment is also 0 (NaN coerced to 0).
 * Returns true when `current` is below `minimum`; false when equal or above.
 *
 * This cap at three segments is deliberate: its callers compare store minimums
 * (`force-update-policy`, `min-version`), which are always three-segment
 * release versions. For the unbounded comparator used by the feature-flag and
 * Android channel gates, see `compareAppVersions` below.
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

/**
 * Compare dotted numeric version strings (`1.10.0` > `1.9.9`, missing
 * segments count as zero). Returns <0, 0, or >0 like `strcmp`.
 *
 * Unlike `isVersionBelow`, this has no three-segment cap, so a longer
 * version cannot silently match a shorter one. Each segment is read as its
 * leading integer: a suffix like `-beta` is truncated away, not compared.
 * Used by the feature-flag and Android channel gates, which classify
 * recorded client builds rather than store minimums.
 */
export function compareAppVersions(a: string, b: string): number {
  const left = a.split('.').map(segment => Number.parseInt(segment, 10) || 0);
  const right = b.split('.').map(segment => Number.parseInt(segment, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) {
      return delta < 0 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * True when `current` is at or above `min`. An unknown version never clears
 * the gate: a client that cannot prove its age keeps the safe default, so it
 * never receives a value it may not understand.
 */
export function isAppVersionAtLeast(current: string | null | undefined, min: string): boolean {
  if (!current) {
    return false;
  }
  return compareAppVersions(current, min) >= 0;
}
