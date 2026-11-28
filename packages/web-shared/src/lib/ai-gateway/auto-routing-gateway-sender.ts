import type { StsEnvironment } from '@kilocode/sts-contracts';
import {
  AUTO_ROUTING_DECIDE_SENDER_AUTH,
  GATEWAY_ROUTING_TABLES_SENDER_AUTH,
} from '@kilocode/web-shared/lib/config.server';
import type { StsTokenFailure } from '@kilocode/web-shared/lib/sts-service-tokens';
import { z } from 'zod';
import type {
  AutoRoutingCredential,
  AutoRoutingSender,
  AutoRoutingSenderRoute,
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
 *   development STS against the local Worker; the staging custom environment and previews send
 *   nothing. STS grants these scopes to the `ai-gateway` workload, so a build without
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

/**
 * Each receiver's origin in the STS environments it serves, its `RESOURCE_ORIGINS`
 * (`services/auto-routing/src/auth.ts`, `services/auto-routing-benchmark/src/auth.ts`): the only
 * places an STS token is sent.
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

type GatewayEdge = {
  variable: 'AUTO_ROUTING_DECIDE_SENDER_AUTH' | 'GATEWAY_ROUTING_TABLES_SENDER_AUTH';
  /** The switch's value, read at each call. */
  auth: () => string | undefined;
  receiver: keyof typeof RECEIVER_ORIGINS;
};

const GATEWAY_EDGES: Partial<Record<AutoRoutingSenderRoute, GatewayEdge>> = {
  decide: {
    variable: 'AUTO_ROUTING_DECIDE_SENDER_AUTH',
    auth: () => AUTO_ROUTING_DECIDE_SENDER_AUTH,
    receiver: 'auto-routing',
  },
  benchmarkRoutingTablesRead: {
    variable: 'GATEWAY_ROUTING_TABLES_SENDER_AUTH',
    auth: () => GATEWAY_ROUTING_TABLES_SENDER_AUTH,
    receiver: 'auto-routing-benchmark',
  },
};

/** The deployment's runtime variables; `process.env` itself in production. */
export type VercelRuntime = Readonly<Record<string, string | undefined>> & {
  VERCEL_ENV?: string;
  VERCEL_TARGET_ENV?: string;
};

type ReceiverEnvironment = keyof (typeof RECEIVER_ORIGINS)['auto-routing'] & StsEnvironment;

/**
 * Vercel production mints from production STS, and a process outside Vercel (local development)
 * from development STS. Every other deployment has none: neither Worker has one there.
 */
function receiverEnvironment(runtime: VercelRuntime): ReceiverEnvironment | null {
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

/** Reported once per switch and reason per process: decide and the table reads are hot paths. */
const reported = new Set<string>();

function unavailable(
  variable: GatewayEdge['variable'],
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
 * The gateway's credential for one request. Under `sts` a held token is a memory read; a cold one
 * waits for one mint until the request's `signal` aborts, after which the mint runs on under
 * `waitUntil` for a later request. The token client renews a held token in the background at 80%
 * of its lifetime, so a warm instance never waits.
 */
export function createGatewayAutoRoutingSender(
  runtime: VercelRuntime = process.env
): AutoRoutingSender {
  return async (route, { url, signal }) => {
    const edge = GATEWAY_EDGES[route];
    if (edge === undefined) return { kind: 'legacy' };
    const auth = SenderAuthSchema.safeParse(edge.auth());
    if (!auth.success) return unavailable(edge.variable, 'invalid_auth');
    if (auth.data === 'legacy') return { kind: 'legacy' };
    // Literal `process.env` access, so Next inlines the value `apps/ai-gateway/next.config.mjs`
    // sets at build time (`web-internal-sts.ts` does the same).
    if (process.env.KILO_STS_WORKLOAD !== 'ai-gateway') {
      return unavailable(edge.variable, 'not_ai_gateway');
    }
    const environment = receiverEnvironment(runtime);
    if (environment === null) return unavailable(edge.variable, 'sts_production_only');
    if (url.origin !== RECEIVER_ORIGINS[edge.receiver][environment]) {
      return unavailable(edge.variable, 'origin_mismatch');
    }
    // Loaded only under `sts`, so a `legacy` deployment never evaluates the token client, the STS
    // contracts or the Vercel OIDC exchange on the decide and routing-table paths.
    const { autoRoutingSenderToken } = await import('./auto-routing-sender-sts');
    const read = await autoRoutingSenderToken(environment, route, signal);
    switch (read.kind) {
      case 'token':
        return { kind: 'sts', authorization: `Bearer ${read.token}` };
      case 'deadline':
        return unavailable(edge.variable, 'token_deadline');
      case 'failed':
        return unavailable(
          edge.variable,
          read.failure.reason === 'denied' ? 'token_denied' : 'token_unavailable',
          { failure: read.failure }
        );
    }
  };
}
