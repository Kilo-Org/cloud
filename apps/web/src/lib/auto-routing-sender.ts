import {
  AUTO_ROUTING_ADMIN_SENDER_AUTH,
  AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH,
  AUTO_ROUTING_BENCHMARK_WORKER_URL,
  AUTO_ROUTING_WORKER_URL,
  WEB_ROUTING_TABLES_SENDER_AUTH,
} from '@kilocode/web-shared/lib/config.server';
import {
  isAutoRoutingReceiverOrigin,
  type AutoRoutingSender,
  type AutoRoutingSenderRoute,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-sender';
import { AUTO_ROUTING_SENDER_SCOPES } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-sender-scopes';
import {
  resolveServiceSenderAuth,
  serviceSenderHeaders,
  type ServiceSenderAuth,
  type VercelRuntime,
} from '@kilocode/web-shared/lib/service-sender-auth';

/**
 * The web app's auto-routing sender (`auto-routing-sender.ts` in web-shared), installed by
 * `src/instrumentation.ts`. Its switches (`packages/web-shared/src/lib/service-sender-auth.ts`),
 * set on `kilocode-app`:
 * - `AUTO_ROUTING_ADMIN_SENDER_AUTH`: auto-routing `/admin/*`, `auto-routing:admin.read` (GET) or
 *   `auto-routing:admin.write` (PUT);
 * - `AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH`: the benchmark `/admin/*` routes outside the
 *   routing tables, `auto-routing-benchmark:admin.read` or `admin.write` per the Worker's
 *   `GOVERNED_ROUTES`;
 * - `WEB_ROUTING_TABLES_SENDER_AUTH`: the benchmark routing-table reads,
 *   `auto-routing-benchmark:routing-tables.read`.
 * `legacy` (also when unset) sends the internal secret as before; explicit `sts` sends only an STS
 * token of the route's scope, for Vercel production and local development only (neither Worker
 * has a staging deployment), and only to the receiver's own origin: `https://auto-routing.kiloapps.io`
 * or `https://auto-routing-benchmark.kiloapps.io` in production, the local Worker on loopback in
 * development. Any other value or destination sends nothing. The web app sends no `POST /decide`,
 * so that route keeps the secret.
 */
type WebVariable =
  | 'AUTO_ROUTING_ADMIN_SENDER_AUTH'
  | 'AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH'
  | 'WEB_ROUTING_TABLES_SENDER_AUTH';

const WEB_SWITCHES: Partial<Record<AutoRoutingSenderRoute, WebVariable>> = {
  adminRead: 'AUTO_ROUTING_ADMIN_SENDER_AUTH',
  adminWrite: 'AUTO_ROUTING_ADMIN_SENDER_AUTH',
  benchmarkAdminRead: 'AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH',
  benchmarkAdminWrite: 'AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH',
  benchmarkRoutingTablesRead: 'WEB_ROUTING_TABLES_SENDER_AUTH',
};

/** Resolves when `signal` aborts; never when there is none. */
function aborted(signal: AbortSignal | undefined): Promise<'aborted'> {
  const ended = Promise.withResolvers<'aborted'>();
  if (signal?.aborted) ended.resolve('aborted');
  else signal?.addEventListener('abort', () => ended.resolve('aborted'), { once: true });
  return ended.promise;
}

/**
 * The web app's sender. Each switch is resolved once, here, against its configured Worker URL; a
 * request then checks its own destination against the receiver's origin. Under `sts` a request
 * waits for one mint at most until its own deadline (`signal`), as the code review and session
 * ingest senders do; without a token it is not sent.
 */
export function createWebAutoRoutingSender(runtime: VercelRuntime = process.env): AutoRoutingSender {
  const resolve = (auth: string | undefined, url: string) =>
    resolveServiceSenderAuth({ auth, url, runtime });
  const senders: Record<WebVariable, ServiceSenderAuth> = {
    AUTO_ROUTING_ADMIN_SENDER_AUTH: resolve(AUTO_ROUTING_ADMIN_SENDER_AUTH, AUTO_ROUTING_WORKER_URL),
    AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH: resolve(
      AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH,
      AUTO_ROUTING_BENCHMARK_WORKER_URL
    ),
    WEB_ROUTING_TABLES_SENDER_AUTH: resolve(
      WEB_ROUTING_TABLES_SENDER_AUTH,
      AUTO_ROUTING_BENCHMARK_WORKER_URL
    ),
  };
  return async (route, { url, signal }) => {
    const variable = WEB_SWITCHES[route];
    if (variable === undefined) return { kind: 'legacy' };
    const sender = senders[variable];
    if (sender.kind === 'legacy') return { kind: 'legacy' };
    if (sender.kind === 'sts' && !isAutoRoutingReceiverOrigin(route, url, sender.environment)) {
      console.error('auto-routing sender: destination is not the receiver origin; request refused', {
        variable,
      });
      return { kind: 'unavailable', reason: 'misconfigured' };
    }
    try {
      const headers = await Promise.race([
        serviceSenderHeaders({
          sender,
          variable,
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
