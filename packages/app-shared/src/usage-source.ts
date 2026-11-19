/**
 * The message the server puts on every usage read when the workspace has no
 * usage warehouse configured
 * (`apps/web/src/routers/usage-analytics-router.ts` `requireSnowflakeConfig`).
 *
 * The tRPC wire carries only the error code and message, so this string is the
 * one signal a client has for "this workspace is not reporting usage at all" —
 * a permanent condition, unlike a warehouse that answered and failed. It must
 * stay identical on both sides, which is why it lives here.
 */
export const USAGE_SOURCE_NOT_CONFIGURED_MESSAGE = 'Usage source not configured';

/**
 * True when a tRPC error's message says the usage source is not configured.
 * That condition is terminal: retrying cannot create a missing warehouse, so a
 * client must show its no-retry state instead of its retryable server state.
 */
export function isUsageSourceNotConfigured(message: string | undefined): boolean {
  return message === USAGE_SOURCE_NOT_CONFIGURED_MESSAGE;
}
