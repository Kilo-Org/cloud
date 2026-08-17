/**
 * DEC-05 privacy deny-list for analytics payload property keys.
 *
 * Prohibited: raw prompts, message content, URLs, repository names, comments,
 * emails, tokens, secrets, transaction IDs, and resource IDs (any key ending in
 * `_id`). Allowed: stable enum strings, integer counts, `duration_ms`
 * integers, booleans.
 *
 * Matching is case-, separator-, and acronym-insensitive and covers letter
 * suffixes, so `Repository`, `raw_prompt`, `APIToken`, `repo_name`, and
 * `secret_value` are all rejected. The one carve-out is `repo_count`, a count
 * rather than repository content.
 */

const PROHIBITED_TERMS = [
  'email',
  'url',
  'repo',
  'prompt',
  'content',
  'token',
  'secret',
  'transaction',
  'comment',
  'message',
] as const;

/** A key segment that is a prohibited term plus an optional letter suffix
 *  (`repo`, `repository`, `tokens`). */
const PROHIBITED_SEGMENT = new RegExp(`^(?:${PROHIBITED_TERMS.join('|')})[a-z]*$`);

/** Lowercases and splits camelCase and acronym boundaries (`apiToken` →
 *  `api_token`, `APIToken` → `api_token`) so separator matching sees one
 *  canonical spelling. */
function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** True when a property key names a prohibited data class. */
export function isProhibitedPropertyKey(key: string): boolean {
  const normalized = normalizeKey(key);

  if (normalized === 'repo_count') {
    return false;
  }

  if (normalized.endsWith('_id')) {
    return true;
  }

  return normalized.split(/[^a-z0-9]+/).some(segment => PROHIBITED_SEGMENT.test(segment));
}

/**
 * Returns a copy of `properties` with every prohibited key removed. Used at
 * runtime capture for record-shaped payloads whose keys a strict object
 * schema cannot enumerate (`app_startup`) and for uncataloged dynamic-name
 * events (the AppsFlyer mirror path).
 */
export function redactProhibitedProperties<T extends Record<string, unknown>>(properties: T): T {
  return Object.fromEntries(
    Object.entries(properties).filter(([key]) => !isProhibitedPropertyKey(key))
  ) as T;
}
