/**
 * Decode a stored percent-encoded value one `/`-separated segment at a time.
 *
 * This is the one decoder behind every label built from a stored
 * percent-encoded value: a git URL path (`formatGitUrlProject`) and a session
 * branch both store the encoded form while the name people read is the
 * decoded one.
 *
 * Splitting before decoding keeps an encoded slash inside its own segment, so
 * the value keeps the boundaries it had. Each segment is decoded once, so a
 * name holding a literal `%` stays intact. A malformed escape (a lone `%` or a
 * truncated sequence) cannot be decoded, and its raw segment is kept instead of
 * throwing: one bad segment never blanks the label.
 */
export function decodePercentEncodedSegments(value: string): string {
  return value
    .split('/')
    .map(segment => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

/**
 * Encode a value as the exact inverse of `decodePercentEncodedSegments`:
 * decoding the result gives back the original value.
 *
 * Splitting before encoding keeps `/` a separator. `encodeURIComponent` would
 * turn a slash inside the value into `%2F`, which the decoder then decodes
 * within one segment: the value would still decode, but every consumer that
 * splits a stored ref on `/` would see one segment instead of several. Each
 * segment is encoded once, so a name holding a literal `%` round-trips.
 *
 * `encodeURIComponent` escapes more ASCII characters than `encodeURI` does: it
 * also escapes `; / ? : @ & = + $ , #`. A stored ref that escapes any of them
 * (`fix/a%26b` for `fix/a&b`) is therefore matched by the text a person reads
 * off the row, which `encodeURI` misses. A segment that cannot be encoded (a
 * lone surrogate) keeps its raw text instead of throwing, mirroring the
 * decoder keeping a segment it cannot decode.
 */
export function encodePercentEncodedSegments(value: string): string {
  return value
    .split('/')
    .map(segment => {
      try {
        return encodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}
