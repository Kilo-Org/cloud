/**
 * DEC-05 privacy deny-list for analytics payloads.
 *
 * Prohibited in analytics payloads (hard, enforced by schema and test): raw
 * prompts, message content, URLs, repository names, comments, emails, tokens,
 * secrets, transaction IDs, and resource IDs. Allowed: stable enum strings,
 * integer counts, `duration_ms` integers, booleans.
 *
 * The predicate operates on *property keys*: a payload key that names a
 * prohibited class of data is rejected. Resource IDs are any key ending in
 * `_id`; the one carve-out is `event_uuid`, the deterministic event identity
 * assigned by the durable outbox (identity, not content).
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
] as const);

/** True when a property key names a prohibited data class. */
export function isProhibitedPropertyKey(key: string): boolean {
  if (PROHIBITED_PROPERTY_KEYS.has(key)) {
    return true;
  }
  return key.endsWith('_id') && key !== 'event_uuid';
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
