/**
 * Instance identity helpers for multi-instance KiloClaw routing.
 *
 * instanceId = kiloclaw_instances.id UUID (the DB row primary key).
 * sandboxId = `ki_{uuid-no-dashes}` (35 chars) — used for Fly machine
 * naming, gateway token derivation, and metadata recovery.
 *
 * The `ki_` prefix distinguishes instance-keyed sandboxIds from legacy
 * userId-derived ones (which are raw base64url).
 */

const MAX_SANDBOX_ID_LENGTH = 63;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validate that a string is a lowercase UUID with dashes. */
export function isValidInstanceId(id: string): boolean {
  return UUID_RE.test(id);
}

/**
 * Derive a sandboxId from an instanceId (the DB row UUID).
 * Strips dashes and prefixes `ki_` — result is `ki_{32-char-hex}` (35 chars).
 */
export function sandboxIdFromInstanceId(instanceId: string): string {
  if (!isValidInstanceId(instanceId)) {
    throw new Error('Invalid instanceId: must be a UUID');
  }
  const hex = instanceId.replace(/-/g, '');
  const prefixed = `ki_${hex}`;
  if (prefixed.length > MAX_SANDBOX_ID_LENGTH) {
    throw new Error(
      `instanceId too long: prefixed sandboxId would be ${prefixed.length} chars (max ${MAX_SANDBOX_ID_LENGTH})`
    );
  }
  return prefixed;
}
