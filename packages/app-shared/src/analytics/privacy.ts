/**
 * DEC-05 privacy deny-list for analytics payloads.
 *
 * Prohibited in analytics payloads (hard, enforced by schema and test): raw
 * prompts, message content, URLs, repository names, comments, emails, tokens,
 * secrets, transaction IDs, and resource IDs. Allowed: stable enum strings,
 * integer counts, `duration_ms` integers, booleans.
 *
 * The predicate operates on *property keys*: a payload key that names a
 * prohibited class of data is rejected. Matching is case-insensitive and
 * covers case, separator, acronym, and suffix variants: `Repository`,
 * `raw_prompt`, `apiToken`, `APIToken`, `repo_name`, and `secret_value` all
 * name prohibited data classes. Resource IDs are any key ending in `_id`; the
 * one carve-out is `event_uuid`, the deterministic event identity assigned by
 * the durable outbox (identity, not content).
 *
 * `repo` matches as a standalone segment (`repo_name`, `repo_url`) and as a
 * letter-suffix prefix (`repository`, `repositories`), so repository-content
 * keys are dropped. The one exception is `repo_count`, a count rather than
 * repository content. `repo_id` is caught by the `_id` rule.
 */

const PROHIBITED_PROPERTY_KEYS: ReadonlySet<string> = new Set([
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
] as const);

/** Whole keys that stay allowed even though a segment names a prohibited data
 *  class. `repo_count` is a count of repositories, not repository content. */
const ALLOWED_EXACT_KEYS: ReadonlySet<string> = new Set(['repo_count'] as const);

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

  if (ALLOWED_EXACT_KEYS.has(normalized)) {
    return false;
  }

  if (normalized.endsWith('_id') && normalized !== 'event_uuid') {
    return true;
  }

  const segments = normalized.split(/[^a-z0-9]+/).filter(Boolean);

  for (const term of PROHIBITED_PROPERTY_KEYS) {
    if (normalized === term) {
      return true;
    }
    // Separator variant: the term is a standalone word segment
    // (`raw_prompt`, `api_token`, `repo_name`, `secret_value`).
    if (segments.includes(term)) {
      return true;
    }
    // Suffix variant: the term is a word prefix followed only by letters
    // (`repository`, `emails`, `tokens`).
    if (
      segments.some(
        segment =>
          segment.length > term.length &&
          segment.startsWith(term) &&
          /^[a-z]+$/.test(segment.slice(term.length))
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Returns a copy of `properties` with every prohibited key removed. Used at
 * runtime capture for record-shaped payloads whose keys a strict object
 * schema cannot enumerate (`app_startup`) and for uncataloged dynamic-name
 * events (the AppsFlyer mirror path).
 */
export function redactProhibitedProperties<T extends Record<string, unknown>>(properties: T): T {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!isProhibitedPropertyKey(key)) {
      safe[key] = value;
    }
  }
  return safe as T;
}
