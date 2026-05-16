/**
 * SQL escape helpers ported from the wasteland Go SDK
 * (`internal/commons/commons.go`). The Wasteland data layer is MySQL/Dolt,
 * so these helpers follow MySQL's `\`-escape convention for string literals
 * and backtick-quoted identifiers.
 *
 * Byte-for-byte compatibility with the Go DML helpers is required: every
 * generated statement here must match what `EscapeSQL` / `EscapeLIKE` would
 * produce for the same input.
 */

/**
 * Escapes a string for safe interpolation between single quotes in a SQL
 * literal. Mirrors `commons.EscapeSQL`:
 *
 *     s = strings.ReplaceAll(s, `\`, `\\`)
 *     return strings.ReplaceAll(s, "'", "''")
 *
 * Does NOT include the surrounding quotes — wrap the result with `'…'`
 * yourself, or use {@link sqlStringLiteral} / {@link sqlStringOrNull}.
 *
 * Order matters: backslashes are doubled first so we don't double-escape the
 * backslash that the quote-doubling step would (not) introduce. The result of
 * a single quote is `''` (two single quotes), matching the Go reference.
 */
export function escapeSqlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

/**
 * Escapes a string for use inside a SQL `LIKE` pattern. Applies
 * {@link escapeSqlString} first, then escapes the `%` and `_` wildcards with
 * a backslash. Mirrors `commons.EscapeLIKE`.
 */
export function escapeSqlLike(s: string): string {
  return escapeSqlString(s).replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Escapes a SQL identifier (table or column name) by wrapping it in
 * backticks and doubling any embedded backticks. This is the standard
 * MySQL / Dolt convention.
 *
 * The Go reference does not expose an explicit helper for this — backtick
 * quoting in the Go DML is handled by hard-coding the identifier — but the
 * SDK needs one for generated DML where column names come from the schema.
 */
export function escapeSqlIdentifier(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

/**
 * Wraps an already-escaped string in single quotes. Provided so callers can
 * write `sqlStringLiteral(value)` instead of repeating the `'…'` template.
 */
export function sqlStringLiteral(s: string): string {
  return "'" + escapeSqlString(s) + "'";
}

/**
 * Renders a string field using the wl-commons "empty string means NULL"
 * convention used throughout `commons.go`:
 *
 *     descField := "NULL"
 *     if item.Description != "" {
 *         descField = fmt.Sprintf("'%s'", EscapeSQL(item.Description))
 *     }
 *
 * Returns the literal `NULL` (no quotes) for the empty string, otherwise the
 * quoted, escaped value.
 */
export function sqlStringOrNull(s: string | null | undefined): string {
  if (s === null || s === undefined || s === '') {
    return 'NULL';
  }
  return sqlStringLiteral(s);
}

/**
 * Renders a JavaScript value as a SQL literal. Supports the value shapes the
 * Go DML helpers actually emit:
 *
 *  - `null` / `undefined` → `NULL`
 *  - `string`             → quoted, escaped string literal
 *  - `number`             → numeric literal (rejects NaN / ±Infinity)
 *  - `bigint`             → numeric literal
 *  - `boolean`            → `TRUE` / `FALSE`
 *
 * Values outside this set throw; callers that need richer types (dates, JSON
 * arrays, etc.) should format them explicitly the same way the Go helpers do
 * (e.g. `formatTagsJSON`).
 */
export function sqlValue(v: string | number | bigint | boolean | null | undefined): string {
  if (v === null || v === undefined) {
    return 'NULL';
  }
  if (typeof v === 'string') {
    return sqlStringLiteral(v);
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error(`sqlValue: non-finite number ${String(v)}`);
    }
    return String(v);
  }
  if (typeof v === 'bigint') {
    return v.toString();
  }
  return v ? 'TRUE' : 'FALSE';
}
