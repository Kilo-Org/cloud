import {
  AUTO_ROUTING_ADMIN_SENDER_AUTH,
  AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH,
  AUTO_ROUTING_DECIDE_SENDER_AUTH,
  GATEWAY_ROUTING_TABLES_SENDER_AUTH,
  WEB_ROUTING_TABLES_SENDER_AUTH,
} from '@kilocode/web-shared/lib/config.server';

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
 * A route the installed sender has no switch for sends the internal secret exactly as before. A
 * process that installs none (scripts, tests) sends the secret too while every switch is `legacy`
 * or unset; once any of them reads `sts` it sends nothing, since only a sender can mint and `sts`
 * never falls back to the secret.
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

/**
 * Each receiver's origin in the STS environments it serves, its `RESOURCE_ORIGINS`
 * (`services/auto-routing/src/auth.ts`, `services/auto-routing-benchmark/src/auth.ts`): the only
 * places either app's sender sends an STS token.
 */
const RECEIVER_ORIGINS = {
  'auto-routing': {
    production: 'https://auto-routing.kiloapps.io',
    development: 'http://localhost:8810',
  },
  'auto-routing-benchmark': {
    production: 'https://auto-routing-benchmark.kiloapps.io',
    development: 'http://localhost:8814',
  },
} as const;

/** The STS environments the receivers serve: neither has a staging deployment. */
export type AutoRoutingReceiverEnvironment = keyof (typeof RECEIVER_ORIGINS)['auto-routing'];

/** Whether `url` is the route's receiver origin in `environment`. */
export function isAutoRoutingReceiverOrigin(
  route: AutoRoutingSenderRoute,
  url: URL,
  environment: AutoRoutingReceiverEnvironment
): boolean {
  const receiver = route.startsWith('benchmark') ? 'auto-routing-benchmark' : 'auto-routing';
  return url.origin === RECEIVER_ORIGINS[receiver][environment];
}

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

/** Whether a process without a sender has any switch at `sts`; read once, at module load. */
const stsWithoutSender = [
  AUTO_ROUTING_DECIDE_SENDER_AUTH,
  GATEWAY_ROUTING_TABLES_SENDER_AUTH,
  AUTO_ROUTING_ADMIN_SENDER_AUTH,
  AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH,
  WEB_ROUTING_TABLES_SENDER_AUTH,
].includes('sts');

let stsWithoutSenderReported = false;

/** The credential of one request: the installed sender's, else the rule above. */
export async function autoRoutingCredential(
  route: AutoRoutingSenderRoute,
  request: { url: URL; signal?: AbortSignal }
): Promise<AutoRoutingCredential> {
  const sender = globalThis.__kilocodeAutoRoutingSender;
  if (sender !== undefined) return sender(route, request);
  if (!stsWithoutSender) return { kind: 'legacy' };
  if (!stsWithoutSenderReported) {
    stsWithoutSenderReported = true;
    console.error(
      '[auto-routing-sender] an auto-routing sender switch is sts but this process installed no sender; requests not sent'
    );
  }
  return { kind: 'unavailable', reason: 'misconfigured' };
}
