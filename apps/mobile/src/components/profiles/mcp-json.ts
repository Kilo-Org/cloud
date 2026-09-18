/**
 * Pure helpers for the JSON fragments an MCP server's environment/headers are
 * typed as. No React and no React Native imports: every function is unit-tested
 * directly in `mcp-json.test.ts`.
 *
 * Ported from the web editor's `parseRecord`/env-JSON handling
 * (`apps/web/src/components/cloud-agent/profile-editor/McpServersTab.tsx`), so
 * a fragment the web accepts is accepted here with the same validation.
 */

/**
 * Placeholder the server returns in place of each stored env/header value.
 * Mirrors `MASKED_SECRET_VALUE` in `@kilocode/cloud-agent-profile`; the mobile
 * app does not depend on that server-only package, so the value is repeated
 * here. The MCP update procedure reuses a stored secret only when the input
 * value is exactly this string, so an edit must send it back unchanged for the
 * keys the user is not rotating.
 */
export const MASKED_MCP_VALUE = '\u2022\u2022\u2022\u2022';

/** The parse result: a `Record<string,string>`, or why the text is not one. */
export type ParsedRecord =
  | { ok: true; value: Record<string, string> | undefined }
  | { ok: false; error: string };

type DecodedJson = { ok: true; value: unknown } | { ok: false; error: string };

/** Decode the text the user typed; the JSON error message explains a refusal. */
function decodeJson(text: string): DecodedJson {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid JSON' };
  }
}

/**
 * Parse a JSON object whose values are all strings. Blank text is a valid,
 * empty fragment (`value: undefined`), matching the web editor. An array or a
 * non-string value is refused so the form cannot send a shape the server's
 * `z.record(z.string(), z.string())` would reject.
 */
export function parseRecord(raw: string): ParsedRecord {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: undefined };
  }
  const decoded = decodeJson(trimmed);
  if (!decoded.ok) {
    return { ok: false, error: decoded.error };
  }
  const parsed = decoded.value;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- user-typed JSON is decoded at this boundary; the object/array shape cannot be established statically
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Must be a JSON object of string → string' };
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- each decoded JSON value is unknown input; a non-string is refused below
    if (typeof value !== 'string') {
      return { ok: false, error: `Value for "${key}" must be a string` };
    }
    out[key] = value;
  }
  return { ok: true, value: Object.keys(out).length > 0 ? out : undefined };
}

/**
 * Render a masked fragment back into the text area. A server's masked values
 * round-trip verbatim: the update procedure keeps each stored secret whose
 * input is `MASKED_MCP_VALUE`, so the keys stay visible and the user can rotate
 * only the ones they retype.
 */
export function formatRecord(record: Record<string, string> | undefined): string {
  if (record === undefined || Object.keys(record).length === 0) {
    return '';
  }
  return JSON.stringify(record, null, 2);
}
