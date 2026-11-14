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
 * `secret_value` are all rejected. The `repo_count` and `auth_ready` metrics
 * are explicit carve-outs. A cataloged event's own schema may declare another
 * key as a closed enum — `auth_method` on the SSH connect events is one — and
 * the caller passes those keys as `allowed`; every other payload, including
 * uncataloged dynamic ones, is scrubbed.
 */

/** Payload keys that are closed enums or counts despite a prohibited term. */
const ALLOWED_PROPERTY_KEYS: Record<string, true> = {
  repo_count: true,
  auth_ready: true,
};

const NO_ALLOWED_KEYS: ReadonlySet<string> = new Set();

const PROHIBITED_TERMS = [
  'email',
  'url',
  'repo',
  'prompt',
  'content',
  'token',
  'secret',
  'password',
  'passwd',
  'auth',
  'key',
  'credential',
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
export function normalizePropertyKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Whether `key` is on the deny-list. `allowed` holds the deny-list terms the
 * payload's own schema declares, in {@link normalizePropertyKey} spelling;
 * pass it only for a cataloged event, never for a dynamic payload.
 */
export function isProhibitedPropertyKey(
  key: string,
  allowed: ReadonlySet<string> = NO_ALLOWED_KEYS
): boolean {
  const normalized = normalizePropertyKey(key);

  if (Object.hasOwn(ALLOWED_PROPERTY_KEYS, normalized) || allowed.has(normalized)) {
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
 * events (the AppsFlyer mirror path). `allowed` carries a cataloged event's
 * schema-declared carve-outs and is empty for both of those.
 */
export function redactProhibitedProperties<T extends Record<string, unknown>>(
  properties: T,
  allowed: ReadonlySet<string> = NO_ALLOWED_KEYS
): T {
  return Object.fromEntries(
    Object.entries(properties).filter(([key]) => !isProhibitedPropertyKey(key, allowed))
  ) as T;
}
