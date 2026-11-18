/**
 * The message the server puts on a mobile control-plane call that outlived its
 * procedure budget (`packages/web-shared/src/lib/trpc/control-plane-budget.ts`).
 *
 * The tRPC wire carries only the error code and message, so this string is the
 * one signal a client has for "the server was too slow to answer" — it must
 * stay identical on both sides, which is why it lives here.
 */
export const CONTROL_PLANE_TIMEOUT_MESSAGE = 'Control-plane request timed out';
