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
