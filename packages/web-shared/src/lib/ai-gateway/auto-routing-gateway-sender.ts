import {
  AUTO_ROUTING_DECIDE_SENDER_AUTH,
  GATEWAY_ROUTING_TABLES_SENDER_AUTH,
} from '@kilocode/web-shared/lib/config.server';
import type { StsTokenFailure } from '@kilocode/web-shared/lib/sts-service-tokens';
import { z } from 'zod';
import {
  isAutoRoutingReceiverOrigin,
  type AutoRoutingCredential,
  type AutoRoutingReceiverEnvironment,
  type AutoRoutingSender,
  type AutoRoutingSenderRoute,
} from './auto-routing-sender';

/**
 * The AI Gateway's auto-routing sender (`auto-routing-sender.ts`), installed by
 * `apps/ai-gateway/src/instrumentation.ts`. Its two switches, set on the `kilocode-ai-gateway`
 * project:
 * - `AUTO_ROUTING_DECIDE_SENDER_AUTH`: `POST /decide` on auto-routing, scope `auto-routing:decide`;
 * - `GATEWAY_ROUTING_TABLES_SENDER_AUTH`: the benchmark routing-table reads, scope
 *   `auto-routing-benchmark:routing-tables.read`.
 * The exact lowercase values:
 * - absent, empty or `legacy`: `Authorization: Bearer <INTERNAL_API_SECRET>`, exactly as before;
 * - `sts`: only an STS service token of the route's scope in `Authorization: Bearer`, minted with
 *   the deployment's Vercel identity, and only to the receiver's own origin; the secret is never
 *   read, and a missing token never falls back to it. Both Workers serve production only, so Vercel
 *   production mints from production STS and a process outside Vercel (local development) from
 *   development STS against the local Worker on loopback; the staging custom environment and
 *   previews send nothing. STS grants these scopes to the `ai-gateway` workload, so a build without
 *   `KILO_STS_WORKLOAD=ai-gateway` (inlined by `apps/ai-gateway/next.config.mjs`) sends nothing
 *   rather than ask for a token it cannot hold.
 * Any other value sends nothing. Every other route keeps the secret: the gateway has no edge there.
 *
 * This module imports no STS code, so a `legacy` deployment never loads the token client or the
 * Vercel OIDC exchange; `auto-routing-sender-sts.ts` holds them and is imported only for an STS send.
 */
const SenderAuthSchema = z.preprocess(
  value => (value === '' ? undefined : value),
  z.enum(['legacy', 'sts']).default('legacy')
);

type GatewayVariable = 'AUTO_ROUTING_DECIDE_SENDER_AUTH' | 'GATEWAY_ROUTING_TABLES_SENDER_AUTH';

const GATEWAY_SWITCHES: Partial<Record<AutoRoutingSenderRoute, GatewayVariable>> = {
  decide: 'AUTO_ROUTING_DECIDE_SENDER_AUTH',
  benchmarkRoutingTablesRead: 'GATEWAY_ROUTING_TABLES_SENDER_AUTH',
};

/** The deployment's runtime variables; `process.env` itself in production. */
export type VercelRuntime = Readonly<Record<string, string | undefined>> & {
  VERCEL_ENV?: string;
  VERCEL_TARGET_ENV?: string;
};

/**
 * Vercel production mints from production STS, and a process outside Vercel (local development)
 * from development STS. Every other deployment has none: neither Worker has one there.
 */
function receiverEnvironment(runtime: VercelRuntime): AutoRoutingReceiverEnvironment | null {
  const { VERCEL_ENV: environment, VERCEL_TARGET_ENV: target } = runtime;
  if (environment === 'production' && target === 'production') return 'production';
  if (environment === undefined && target === undefined) return 'development';
  return null;
}

export type GatewaySenderFailure =
  /** The switch holds a value other than `legacy` or `sts`. */
  | 'invalid_auth'
  /** `sts` outside the `ai-gateway` build, which alone holds these scopes. */
  | 'not_ai_gateway'
  /** `sts` on a deployment neither Worker serves (staging, previews). */
  | 'sts_production_only'
  /** The request URL is not the receiver's origin in this deployment's STS environment. */
  | 'origin_mismatch'
  /** The request's deadline ended before a token arrived; the mint runs on under `waitUntil`. */
  | 'token_deadline'
  /** STS refused the token; a policy, identity or registry change fixes it, waiting does not. */
  | 'token_denied'
  /** STS gave no token, or the transport failed; a later request may succeed. */
  | 'token_unavailable';

/** One switch, resolved once when the sender is built. */
type GatewayEdge =
  | { kind: 'legacy' }
  | { kind: 'sts'; environment: AutoRoutingReceiverEnvironment }
  | { kind: 'refused'; reason: GatewaySenderFailure };

function resolveEdge(auth: string | undefined, runtime: VercelRuntime): GatewayEdge {
  const parsed = SenderAuthSchema.safeParse(auth);
  if (!parsed.success) return { kind: 'refused', reason: 'invalid_auth' };
  if (parsed.data === 'legacy') return { kind: 'legacy' };
  // Literal `process.env` access, so Next inlines the value `apps/ai-gateway/next.config.mjs`
  // sets at build time (`web-internal-sts.ts` does the same).
  if (process.env.KILO_STS_WORKLOAD !== 'ai-gateway') {
    return { kind: 'refused', reason: 'not_ai_gateway' };
  }
  const environment = receiverEnvironment(runtime);
  return environment === null
    ? { kind: 'refused', reason: 'sts_production_only' }
    : { kind: 'sts', environment };
}

/** Reported once per switch and reason per process: decide and the table reads are hot paths. */
const reported = new Set<string>();

function unavailable(
  variable: GatewayVariable,
  reason: GatewaySenderFailure,
  detail: { failure?: StsTokenFailure } = {}
): AutoRoutingCredential {
  const key = `${variable} ${reason}`;
  if (!reported.has(key)) {
    reported.add(key);
    // The switch and the reason; never the token, the secret or an error message.
    console.warn('[auto-routing-gateway-sender] no credential; request not sent', {
      variable,
      reason,
      ...detail,
    });
  }
  const tokenFailure =
    reason === 'token_deadline' || reason === 'token_denied' || reason === 'token_unavailable';
  return { kind: 'unavailable', reason: tokenFailure ? 'token_unavailable' : 'misconfigured' };
}

/**
 * The gateway's sender. Both switches are resolved once, here; a request only checks its
 * destination and reads the token. A held token is a memory read; a cold one waits for one mint
 * until the request's `signal` aborts, after which the mint runs on under `waitUntil` for a later
 * request. The token client renews a held token in the background at 80% of its lifetime, so a
 * warm instance never waits.
 */
export function createGatewayAutoRoutingSender(
  runtime: VercelRuntime = process.env
): AutoRoutingSender {
  const edges: Record<GatewayVariable, GatewayEdge> = {
    AUTO_ROUTING_DECIDE_SENDER_AUTH: resolveEdge(AUTO_ROUTING_DECIDE_SENDER_AUTH, runtime),
    GATEWAY_ROUTING_TABLES_SENDER_AUTH: resolveEdge(GATEWAY_ROUTING_TABLES_SENDER_AUTH, runtime),
  };
  return async (route, { url, signal }) => {
    const variable = GATEWAY_SWITCHES[route];
    if (variable === undefined) return { kind: 'legacy' };
    const edge = edges[variable];
    if (edge.kind === 'legacy') return edge;
    if (edge.kind === 'refused') return unavailable(variable, edge.reason);
    if (!isAutoRoutingReceiverOrigin(route, url, edge.environment)) {
      return unavailable(variable, 'origin_mismatch');
    }
    // Loaded only under `sts`, so a `legacy` deployment never evaluates the token client, the STS
    // contracts or the Vercel OIDC exchange on the decide and routing-table paths.
    const { autoRoutingSenderToken } = await import('./auto-routing-sender-sts');
    const read = await autoRoutingSenderToken(edge.environment, route, signal);
    switch (read.kind) {
      case 'token':
        return { kind: 'sts', authorization: `Bearer ${read.token}` };
      case 'deadline':
        return unavailable(variable, 'token_deadline');
      case 'failed':
        return unavailable(
          variable,
          read.failure.reason === 'denied' ? 'token_denied' : 'token_unavailable',
          { failure: read.failure }
        );
    }
  };
}
