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
