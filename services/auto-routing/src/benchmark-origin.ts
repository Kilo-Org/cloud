import {
  BenchmarkRoutingTableResponseSchema,
  ClassifierWinnerResponseSchema,
  CustomRouterBenchmarkContextSchema,
  CustomRouterTableVersionResponseSchema,
  CustomRoutingTableResponseSchema,
  CUSTOM_ROUTER_TABLE_PATH,
  CUSTOM_ROUTER_EPOCH_PATH,
  CUSTOM_ROUTER_TABLE_VERSION_PATH,
  CustomRouterEpochResponseSchema,
  DEFAULT_AUTO_ROUTER,
  customRouterEntryKey,
  type AutoRouter,
  type ClassifierWinner,
  type CustomRouterBenchmarkContext,
  type CustomRouterDefinition,
  type CustomRoutingTable,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';
import {
  createWorkerServiceTokens,
  ServiceTokenError,
  type MintBinding,
  type ServiceTokens,
} from '@kilocode/service-token-client';
import { STS_AUTO_ROUTING_BENCHMARK_ROUTING_TABLES_READ } from '@kilocode/sts-contracts';
import { isDirectByokModelId } from '@kilocode/worker-utils/direct-byok-model';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { readAutoRoutingSecret } from './secrets';

/**
 * `BENCHMARK_ROUTING_TABLES_SENDER_AUTH` is the switch of this Worker's routing-table reads over
 * `BENCHMARK_SERVICE` (routing table, classifier winner, custom router table, table version and
 * epoch; the benchmark Worker's `routingTablesRead` routes), and their rollback (decision D59):
 * - absent, empty or `legacy`: `Authorization: Bearer <INTERNAL_API_SECRET>`, exactly as before;
 * - `sts`: only an `auto-routing-benchmark:routing-tables.read` STS service token in
 *   `Authorization: Bearer`, minted over the `STS` binding; the secret is not read, and a missing
 *   token fails the read rather than fall back to it.
 * Any other value fails every such read and sends nothing. The client eval forwards
 * (`forwardClientEval`) reach routes the benchmark Worker guards with the secret in every mode,
 * so they keep it.
 */
export type BenchmarkEnv = Pick<Env, 'BENCHMARK_SERVICE' | 'INTERNAL_API_SECRET_PROD'> & {
  BENCHMARK_ROUTING_TABLES_SENDER_AUTH?: string;
  /** `{ binding: "STS", service: "sts", entrypoint: "SecretsBroker", props: { caller } }`. */
  STS?: MintBinding;
};

/**
 * The longest a routing-table read waits for a cold mint. The reads sit on the `/decide` path,
 * inside the gateway's 5 s decide deadline (`EFFICIENT_DECISION_TIMEOUT_MS`), so the wait ends well
 * before it; the mint runs on under the invocation's `waitUntil`, and a later read finds the token.
 */
export const ROUTING_TABLES_TOKEN_WAIT_MS = 2_000;

/**
 * One token client per isolate, built once: it holds and renews the token for every request. Its
 * transport calls the binding of the latest read, so a request whose `env` carries another `STS`
 * object still shares the held token.
 */
let tokens: ServiceTokens | null = null;
let latestBinding: MintBinding | null = null;

function tokensFor(binding: MintBinding): ServiceTokens {
  latestBinding = binding;
  tokens ??= createWorkerServiceTokens({
    mintTokens: request => (latestBinding ?? binding).mintTokens(request),
  });
  return tokens;
}

function routingTablesRefused(reason: string, detail: Record<string, string> = {}): Error {
  // The reason only; never the token, the secret or an error message.
  console.warn(
    JSON.stringify({ event: 'auto_routing_benchmark_sender_unavailable', reason, ...detail })
  );
  return new Error(`benchmark routing-table read not sent: ${reason}`);
}

/**
 * The `Authorization` value of one routing-table read. A held token is a memory read, and with
 * `ctx` its renewal runs under the invocation's `waitUntil` rather than inside the read. A cold
 * read waits for one mint at most `ROUTING_TABLES_TOKEN_WAIT_MS`. Throws, sending nothing, without
 * a credential.
 */
async function routingTablesAuthorization(
  env: BenchmarkEnv,
  ctx?: SecretsExecutionContext
): Promise<string> {
  const auth = env.BENCHMARK_ROUTING_TABLES_SENDER_AUTH;
  if (auth === undefined || auth === '' || auth === 'legacy') {
    return `Bearer ${await readAutoRoutingSecret(env, 'INTERNAL_API_SECRET', ctx)}`;
  }
  if (auth !== 'sts') throw routingTablesRefused('auth_misconfigured');
  if (env.STS === undefined) throw routingTablesRefused('sts_binding_missing');
  const attempt = tokensFor(env.STS).get(STS_AUTO_ROUTING_BENCHMARK_ROUTING_TABLES_READ, ctx);
  const expired = Promise.withResolvers<'deadline'>();
  const timer = setTimeout(() => expired.resolve('deadline'), ROUTING_TABLES_TOKEN_WAIT_MS);
  try {
    const outcome = await Promise.race([attempt, expired.promise]);
    if (outcome !== 'deadline') return `Bearer ${outcome}`;
    // Still the client's one in-flight mint; keeping it alive serves the next read. Its failure is
    // handled here, with or without `ctx`, so an abandoned mint never rejects unhandled.
    const abandoned = attempt.catch(() => {});
    ctx?.waitUntil(abandoned);
    throw routingTablesRefused('token_deadline');
  } catch (error) {
    if (!(error instanceof ServiceTokenError)) throw error;
    throw error.reason === 'denied'
      ? routingTablesRefused('token_denied', { denied_reason: error.deniedReason ?? 'unknown' })
      : routingTablesRefused('token_unavailable');
  } finally {
    clearTimeout(timer);
  }
}

function fetchBenchmark(
  env: BenchmarkEnv,
  path: string,
  authorization: string,
  init?: RequestInit
): Promise<Response> {
  return env.BENCHMARK_SERVICE.fetch(`https://auto-routing-benchmark${path}`, {
    ...init,
    headers: {
      authorization,
      ...(init?.headers ?? {}),
    },
  });
}

/** One read of a `routingTablesRead` route, under `BENCHMARK_ROUTING_TABLES_SENDER_AUTH`. */
async function fetchRoutingTables(
  env: BenchmarkEnv,
  path: string,
  init?: RequestInit,
  ctx?: SecretsExecutionContext
): Promise<Response> {
  return fetchBenchmark(env, path, await routingTablesAuthorization(env, ctx), init);
}

async function fetchBenchmarkJson(
  env: BenchmarkEnv,
  path: string,
  init?: RequestInit,
  ctx?: SecretsExecutionContext
): Promise<unknown> {
  const res = await fetchRoutingTables(env, path, init, ctx);
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`benchmark origin ${path} responded ${res.status} ${detail}`);
  }
  return res.json();
}

// The two cached origin reads below are loaded through `ttlCached` (routing-table.ts,
// classifier-config.ts) on the `/decide` path. Their caches hand the loader the invocation's
// `ctx`, so a token renewal or a bundle revalidation runs under its `waitUntil`.
export async function fetchRoutingTableFromOrigin(
  env: BenchmarkEnv,
  router: AutoRouter = DEFAULT_AUTO_ROUTER,
  ctx?: SecretsExecutionContext
): Promise<RoutingTable | null> {
  const path =
    router === DEFAULT_AUTO_ROUTER
      ? '/admin/routing-table'
      : `/admin/routing-table?router=${router}`;
  const body = await fetchBenchmarkJson(env, path, undefined, ctx);
  const parsed = BenchmarkRoutingTableResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `benchmark routing-table response invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`
    );
  }
  return parsed.data.table;
}

export async function fetchClassifierWinnerFromOrigin(
  env: BenchmarkEnv,
  ctx?: SecretsExecutionContext
): Promise<ClassifierWinner | null> {
  const body = await fetchBenchmarkJson(env, '/admin/classifier-winner', undefined, ctx);
  const parsed = ClassifierWinnerResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `benchmark classifier-winner response invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`
    );
  }
  return parsed.data.winner;
}

// The platform key serves gateway models except Kilo-stored direct-BYOK IDs; the owner's CLI
// measures those and every client entry (ADR 0005).
export function customRouterBenchmarkContext(
  router: CustomRouterDefinition
): CustomRouterBenchmarkContext {
  return CustomRouterBenchmarkContextSchema.parse({
    ownerType: router.ownerType,
    ownerId: router.ownerId,
    baseRouter: router.baseRouter,
    entries: router.entries,
    clientEvalEntryKeys: router.entries
      .filter(entry => entry.kind === 'client' || isDirectByokModelId(entry.model))
      .map(customRouterEntryKey),
  });
}

/**
 * The router's readiness epoch through the existing benchmark service binding. `null` means "this
 * deployment cannot prove the epoch" (an older benchmark Worker answering 404, a 5xx, or an
 * unreadable body), which the caller must treat as unproven rather than as an unchanged value.
 */
export async function fetchCustomRouterEpoch(
  env: BenchmarkEnv,
  router: AutoRouter,
  ctx?: SecretsExecutionContext
): Promise<number | null> {
  try {
    const body = await fetchBenchmarkJson(
      env,
      CUSTOM_ROUTER_EPOCH_PATH,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ router }),
      },
      ctx
    );
    const parsed = CustomRouterEpochResponseSchema.safeParse(body);
    return parsed.success ? parsed.data.epoch : null;
  } catch {
    return null;
  }
}

export async function fetchCustomRouterTableVersion(
  env: BenchmarkEnv,
  context: CustomRouterBenchmarkContext,
  ctx?: SecretsExecutionContext
): Promise<string | null> {
  try {
    const body = await fetchBenchmarkJson(
      env,
      CUSTOM_ROUTER_TABLE_VERSION_PATH,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(context),
      },
      ctx
    );
    const parsed = CustomRouterTableVersionResponseSchema.safeParse(body);
    return parsed.success ? parsed.data.readinessVersion : null;
  } catch {
    // A version probe failure is not a routing failure: the caller keeps its current table.
    return null;
  }
}

export type CustomRouterTableLoad = {
  table: CustomRoutingTable | null;
  servingPins: ReadonlyMap<string, string>;
  /** Entry keys whose saved pin target left the catalog; the live alias serves instead. */
  servingFallback: ReadonlySet<string>;
};

export async function fetchCustomRouterTable(
  env: BenchmarkEnv,
  context: CustomRouterBenchmarkContext,
  ctx?: SecretsExecutionContext
): Promise<CustomRouterTableLoad> {
  const res = await fetchRoutingTables(
    env,
    CUSTOM_ROUTER_TABLE_PATH,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(context),
    },
    ctx
  );
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(
      `benchmark origin ${CUSTOM_ROUTER_TABLE_PATH} responded ${res.status} ${detail}`
    );
  }
  const parsed = CustomRoutingTableResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(
      `benchmark custom router table response invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`
    );
  }
  return {
    table: parsed.data.table,
    servingPins: new Map(Object.entries(parsed.data.servingPins ?? {})),
    servingFallback: new Set(parsed.data.servingFallback ?? []),
  };
}

// The benchmark worker owns eval validation and error codes; its status and body pass through.
// The eval routes take the internal secret in every mode (see `BenchmarkEnv`).
export async function forwardClientEval(
  env: BenchmarkEnv,
  path: string,
  body: unknown,
  ctx?: SecretsExecutionContext
): Promise<Response> {
  const secret = await readAutoRoutingSecret(env, 'INTERNAL_API_SECRET', ctx);
  const res = await fetchBenchmark(env, path, `Bearer ${secret}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}
