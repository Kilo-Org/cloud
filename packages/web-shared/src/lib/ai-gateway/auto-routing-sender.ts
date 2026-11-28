/**
 * The credential the shared auto-routing clients (`auto-routing-decision.ts`,
 * `auto-routing-admin-client.ts`, `auto-routing-benchmark-admin-client.ts`) present to the
 * auto-routing and auto-routing-benchmark Workers (design 6.5, decision D59: the shared
 * `INTERNAL_API_SECRET` bearer moves to an STS service token, one scope per route family).
 *
 * The clients run in two apps, so the app chooses the credential, never the request: each app's
 * `instrumentation.ts` installs its own sender, which reads only that app's switches.
 * - `apps/web` installs `apps/web/src/lib/auto-routing-sender.ts` (`service-sender-auth.ts`):
 *   `AUTO_ROUTING_ADMIN_SENDER_AUTH`, `AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH` and
 *   `WEB_ROUTING_TABLES_SENDER_AUTH`.
 * - `apps/ai-gateway` installs `auto-routing-gateway-sender.ts`: `AUTO_ROUTING_DECIDE_SENDER_AUTH`
 *   and `GATEWAY_ROUTING_TABLES_SENDER_AUTH`.
 * A process that installs none (scripts, tests), and a route the installed sender has no switch
 * for, sends the internal secret exactly as before.
 */

/**
 * The route families of both receivers, as their `GOVERNED_ROUTES` name them (the benchmark's
 * prefixed `benchmark`); each maps to one scope (`auto-routing-sender-scopes.ts`).
 */
export type AutoRoutingSenderRoute =
  | 'decide'
  | 'adminRead'
  | 'adminWrite'
  | 'benchmarkRoutingTablesRead'
  | 'benchmarkAdminRead'
  | 'benchmarkAdminWrite';

export type AutoRoutingCredential =
  /** Send `Authorization: Bearer <INTERNAL_API_SECRET>`, exactly as before the switch existed. */
  | { kind: 'legacy' }
  /** `authorization` is the complete `Authorization` header value of an STS service token. */
  | { kind: 'sts'; authorization: string }
  /**
   * Send nothing: the switch or its destination is invalid (`misconfigured`), or no token arrived
   * before the request's deadline or STS gave none (`token_unavailable`). Never the secret.
   */
  | { kind: 'unavailable'; reason: 'misconfigured' | 'token_unavailable' };

/**
 * One app's sender. `url` is the exact request destination; `signal` is the request's own deadline,
 * which also bounds a cold mint.
 */
export type AutoRoutingSender = (
  route: AutoRoutingSenderRoute,
  request: { url: URL; signal?: AbortSignal }
) => Promise<AutoRoutingCredential>;

declare global {
  // Next.js evaluates a module once per bundle layer, so a sender an app installs from
  // `instrumentation.ts` reaches its route handlers only through a process-wide slot.
  var __kilocodeAutoRoutingSender: AutoRoutingSender | undefined;
}

/** Called once per process, from the `instrumentation.ts` of `apps/web` or `apps/ai-gateway`. */
export function installAutoRoutingSender(sender: AutoRoutingSender): void {
  globalThis.__kilocodeAutoRoutingSender = sender;
}

/** The credential of one request: the installed sender's, or `legacy` when none is installed. */
export async function autoRoutingCredential(
  route: AutoRoutingSenderRoute,
  request: { url: URL; signal?: AbortSignal }
): Promise<AutoRoutingCredential> {
  const sender = globalThis.__kilocodeAutoRoutingSender;
  return sender === undefined ? { kind: 'legacy' } : sender(route, request);
}
