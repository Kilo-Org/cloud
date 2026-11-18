/**
 * The message the server puts on a BYOK write refused because the provider it
 * names is not open for the caller's account yet
 * (`apps/web/src/routers/byok-router.ts`, `rejectUnavailableExperimentalProvider`).
 *
 * The tRPC wire carries only the error code and message, so this string is the
 * one signal a client has for that specific refusal — `FORBIDDEN` alone also
 * covers other denials — which is why it lives here and is imported by both
 * sides. The refused provider id stays on the server's log, never on the wire.
 */
export const BYOK_PROVIDER_UNAVAILABLE_MESSAGE = 'This provider is not available yet.';

/**
 * The message the server puts on a BYOK mutation refused because the stored key
 * is a coding plan's installed configuration, which is read-only
 * (`apps/web/src/routers/byok-router.ts`, `rejectManagedKeyMutation`). The plan
 * is cancelled in the Subscription Center; the reader cannot remove the key
 * themselves, so no refusal for it may ask for a removal.
 *
 * The tRPC wire carries only the error code and message, and `CONFLICT` also
 * covers an ordinary duplicate key, so this string is the signal a client has
 * for the managed-key refusal, which is why it lives here and is imported by
 * both sides.
 */
export const MANAGED_KEY_READ_ONLY_MESSAGE =
  'This key is managed by your coding plan and is read-only. Cancel the coding plan to remove it.';
