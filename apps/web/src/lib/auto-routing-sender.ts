import {
  AUTO_ROUTING_ADMIN_SENDER_AUTH,
  AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH,
  WEB_ROUTING_TABLES_SENDER_AUTH,
} from '@kilocode/web-shared/lib/config.server';
import type {
  AutoRoutingSender,
  AutoRoutingSenderRoute,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-sender';
import { AUTO_ROUTING_SENDER_SCOPES } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-sender-scopes';
import {
  resolveServiceSenderAuth,
  serviceSenderHeaders,
  type VercelRuntime,
} from '@/lib/service-sender-auth';

/**
 * The web app's auto-routing sender (`auto-routing-sender.ts` in web-shared), installed by
 * `src/instrumentation.ts`. Its switches (`service-sender-auth.ts`), set on `kilocode-app`:
 * - `AUTO_ROUTING_ADMIN_SENDER_AUTH`: auto-routing `/admin/*`, `auto-routing:admin.read` (GET) or
 *   `auto-routing:admin.write` (PUT);
 * - `AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH`: the benchmark `/admin/*` routes outside the
 *   routing tables, `auto-routing-benchmark:admin.read` or `admin.write` per the Worker's
 *   `GOVERNED_ROUTES`;
 * - `WEB_ROUTING_TABLES_SENDER_AUTH`: the benchmark routing-table reads,
 *   `auto-routing-benchmark:routing-tables.read`.
 * `legacy` (also when unset) sends the internal secret as before; explicit `sts` sends only an STS
 * token of the route's scope, for Vercel production and local development only (neither Worker
 * has a staging deployment). Any other value sends nothing. The web app sends no `POST /decide`,
 * so that route keeps the secret.
 */
const WEB_SWITCHES: Partial<
  Record<AutoRoutingSenderRoute, { variable: string; auth: () => string | undefined }>
> = {
  adminRead: {
    variable: 'AUTO_ROUTING_ADMIN_SENDER_AUTH',
    auth: () => AUTO_ROUTING_ADMIN_SENDER_AUTH,
  },
  adminWrite: {
    variable: 'AUTO_ROUTING_ADMIN_SENDER_AUTH',
    auth: () => AUTO_ROUTING_ADMIN_SENDER_AUTH,
  },
  benchmarkAdminRead: {
    variable: 'AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH',
    auth: () => AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH,
  },
  benchmarkAdminWrite: {
    variable: 'AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH',
    auth: () => AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH,
  },
  benchmarkRoutingTablesRead: {
    variable: 'WEB_ROUTING_TABLES_SENDER_AUTH',
    auth: () => WEB_ROUTING_TABLES_SENDER_AUTH,
  },
};

/** Resolves when `signal` aborts; never when there is none. */
function aborted(signal: AbortSignal | undefined): Promise<'aborted'> {
  const ended = Promise.withResolvers<'aborted'>();
  if (signal?.aborted) ended.resolve('aborted');
  else signal?.addEventListener('abort', () => ended.resolve('aborted'), { once: true });
  return ended.promise;
}

/**
 * Under `sts` a request waits for one mint at most until its own deadline (`signal`), as the code
 * review and session ingest senders do; without a token it is not sent.
 */
export function createWebAutoRoutingSender(
  runtime: VercelRuntime = process.env
): AutoRoutingSender {
  return async (route, { url, signal }) => {
    const edge = WEB_SWITCHES[route];
    if (edge === undefined) return { kind: 'legacy' };
    const sender = resolveServiceSenderAuth({ auth: edge.auth(), url: url.href, runtime });
    if (sender.kind === 'legacy') return { kind: 'legacy' };
    try {
      const headers = await Promise.race([
        serviceSenderHeaders({
          sender,
          variable: edge.variable,
          label: 'auto-routing sender',
          request: AUTO_ROUTING_SENDER_SCOPES[route],
          // Unreachable: a `legacy` switch returned above.
          legacyHeaders: async () => ({}),
        }),
        aborted(signal),
      ]);
      return headers === 'aborted' || headers.Authorization === undefined
        ? { kind: 'unavailable', reason: 'token_unavailable' }
        : { kind: 'sts', authorization: headers.Authorization };
    } catch {
      // `serviceSenderHeaders` logged the refusal or the token failure.
      return {
        kind: 'unavailable',
        reason: sender.kind === 'refused' ? 'misconfigured' : 'token_unavailable',
      };
    }
  };
}
