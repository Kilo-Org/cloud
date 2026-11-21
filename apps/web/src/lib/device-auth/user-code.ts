/**
 * The displayed user code of a device authorization request, in the two forms
 * the flow needs: the form a person types, and the canonical form this service
 * stores.
 *
 * The code is read off one device and typed into another, so it arrives with
 * stray whitespace, a missing separator, or lower case. The stored form is
 * always `XXXX-XXXX`, exactly as `generateUserCode` writes it.
 */

/** The length of a user code, not counting the separator. */
const USER_CODE_LENGTH = 8;

/**
 * The canonical form of a code a person typed: whitespace and every dash
 * punctuation character are dropped, then the letters are uppercased. A result
 * of exactly eight characters comes back in `XXXX-XXXX` form; any other result
 * comes back cleaned, so the caller's lookup reports it as no request rather
 * than as a malformed entry.
 */
export function normalizeDeviceAuthUserCode(value: string): string {
  const cleaned = value
    .replaceAll(/\p{Pd}/gu, '')
    .replaceAll(/\s+/gu, '')
    .toUpperCase();

  if (cleaned.length !== USER_CODE_LENGTH) return cleaned;

  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}
