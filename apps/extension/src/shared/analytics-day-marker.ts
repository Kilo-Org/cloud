/**
 * Local calendar day (not UTC): a user's WAU must not turn over at their
 * midnight-UTC.
 */
export const toLocalDay = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
};

/**
 * FNV-1a marker for the signed-in email, so a stored day belongs to one user
 * without putting the address itself into extension storage. Two accounts on one
 * browser profile must both count.
 */
export const emailMarker = (email: string): string => {
  // FNV-1a (32-bit) constants, decimal so the formatter and the linter agree.
  const offsetBasis = 2_166_136_261;
  const prime = 16_777_619;
  let hash = offsetBasis;
  for (let index = 0; index < email.length; index += 1) {
    hash ^= email.codePointAt(index) ?? 0;
    hash = Math.imul(hash, prime) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};
