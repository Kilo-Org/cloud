const ONE_BYTE_CODE_POINT_MAX = 127;
const TWO_BYTE_CODE_POINT_MAX = 2047;
const THREE_BYTE_CODE_POINT_MAX = 65_535;

/**
 * UTF-8 byte count of a single JavaScript code point (BMP character
 * or half of a surrogate pair). Does not validate surrogates; callers
 * must iterate `for … of` over well-formed strings.
 */
function utf8CodePointByteLength(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint <= ONE_BYTE_CODE_POINT_MAX) {
    return 1;
  }
  if (codePoint <= TWO_BYTE_CODE_POINT_MAX) {
    return 2;
  }
  if (codePoint <= THREE_BYTE_CODE_POINT_MAX) {
    return 3;
  }
  return 4;
}

/** Sum of UTF-8 byte counts for every code point in `value`. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    bytes += utf8CodePointByteLength(character);
  }
  return bytes;
}

/**
 * Truncate `value` to at most `maxBytes` UTF-8 bytes without splitting
 * a code point. Returns the longest prefix that fits the byte budget.
 * When `maxBytes` is 0 or negative the result is always the empty string.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  let bytes = 0;
  let result = '';

  for (const character of value) {
    const characterBytes = utf8CodePointByteLength(character);
    if (bytes + characterBytes > maxBytes) {
      break;
    }

    bytes += characterBytes;
    result += character;
  }

  return result;
}
