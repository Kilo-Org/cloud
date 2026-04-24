/**
 * Strip NUL bytes (\u0000) in place from every string-typed field on `obj`.
 *
 * Postgres `text` columns reject NUL bytes with `22021 invalid byte sequence
 * for encoding "UTF8": 0x00`, which crashes inserts into affected tables.
 *
 * Any sanitized field names are appended to `dirtyFields` so the caller can
 * log them for source attribution.
 */
export function stripNulBytesInPlace(obj: object, dirtyFields: string[]): void {
  for (const key of Object.keys(obj)) {
    const value = Reflect.get(obj, key);
    if (typeof value === 'string' && value.indexOf('\u0000') >= 0) {
      // Using split/join rather than a regex avoids the no-control-regex
      // lint rule; the NUL byte is the intended match here.
      Reflect.set(obj, key, value.split('\u0000').join(''));
      dirtyFields.push(key);
    }
  }
}
