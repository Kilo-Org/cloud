// Fractional ordering keys over [0-9a-z]. Digits sort before lowercase letters
// both bytewise and in PostgreSQL's linguistic collations, so keys order the
// same in SQL and in JavaScript. No key ends in '0', which keeps room before
// every key.
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const VALID_KEY = /^[0-9a-z]*[1-9a-z]$/;

function digitAt(key: string, index: number): number {
  const char = key[index];
  const digit = char === undefined ? -1 : DIGITS.indexOf(char);
  if (digit === -1) throw new Error('Invalid position key');
  return digit;
}

function midpoint(lower: string, upper: string | null): string {
  if (upper !== null) {
    let shared = 0;
    while ((lower[shared] ?? '0') === upper[shared]) shared++;
    if (shared > 0) {
      return upper.slice(0, shared) + midpoint(lower.slice(shared), upper.slice(shared));
    }
  }
  const lowerDigit = lower === '' ? 0 : digitAt(lower, 0);
  const upperDigit = upper === null ? DIGITS.length : digitAt(upper, 0);
  if (upperDigit - lowerDigit > 1) {
    // Step by one beside an open end so repeated prepends and appends grow
    // keys by one character per run of digits instead of halving each time.
    const digit =
      upper === null && lower !== ''
        ? lowerDigit + 1
        : lower === '' && upper !== null
          ? upperDigit - 1
          : Math.round((lowerDigit + upperDigit) / 2);
    return DIGITS.charAt(digit);
  }
  if (upper !== null && upper.length > 1) return upper.charAt(0);
  return DIGITS.charAt(lowerDigit) + midpoint(lower.slice(1), null);
}

/** A key strictly between `before` and `after`; `null` means unbounded on that side. */
export function positionBetween(before: string | null, after: string | null): string {
  if (before !== null && !VALID_KEY.test(before)) throw new Error('Invalid position key');
  if (after !== null && !VALID_KEY.test(after)) throw new Error('Invalid position key');
  if (before !== null && after !== null && before >= after) {
    throw new Error('Position keys are out of order');
  }
  return midpoint(before ?? '', after);
}
