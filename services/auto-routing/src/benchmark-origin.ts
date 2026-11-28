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
import { isDirectByokModelId } from '@kilocode/worker-utils/direct-byok-model';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { readAutoRoutingSecret } from './secrets';

type BenchmarkEnv = Pick<Env, 'BENCHMARK_SERVICE' | 'INTERNAL_API_SECRET_PROD'>;

async function fetchBenchmark(
  env: BenchmarkEnv,
  path: string,
  init?: RequestInit,
  ctx?: SecretsExecutionContext
): Promise<Response> {
  const secret = await readAutoRoutingSecret(env, 'INTERNAL_API_SECRET', ctx);
  return env.BENCHMARK_SERVICE.fetch(`https://auto-routing-benchmark${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(init?.headers ?? {}),
    },
  });
}

async function fetchBenchmarkJson(
  env: BenchmarkEnv,
  path: string,
  init?: RequestInit,
  ctx?: SecretsExecutionContext
): Promise<unknown> {
  const res = await fetchBenchmark(env, path, init, ctx);
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`benchmark origin ${path} responded ${res.status} ${detail}`);
  }
  return res.json();
}

// The two cached origin reads below are loaded through `ttlCached` (routing-table.ts,
// classifier-config.ts), whose loaders receive only the env. They therefore pass no invocation
// context: each caller already authenticated through a ctx-bearing read in the same invocation.
export async function fetchRoutingTableFromOrigin(
  env: BenchmarkEnv,
  router: AutoRouter = DEFAULT_AUTO_ROUTER
): Promise<RoutingTable | null> {
  const path =
    router === DEFAULT_AUTO_ROUTER
      ? '/admin/routing-table'
      : `/admin/routing-table?router=${router}`;
  const body = await fetchBenchmarkJson(env, path);
  const parsed = BenchmarkRoutingTableResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `benchmark routing-table response invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`
    );
  }
  return parsed.data.table;
}

export async function fetchClassifierWinnerFromOrigin(
  env: BenchmarkEnv
): Promise<ClassifierWinner | null> {
  const body = await fetchBenchmarkJson(env, '/admin/classifier-winner');
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
  const res = await fetchBenchmark(
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
export async function forwardClientEval(
  env: BenchmarkEnv,
  path: string,
  body: unknown,
  ctx?: SecretsExecutionContext
): Promise<Response> {
  const res = await fetchBenchmark(
    env,
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    ctx
  );
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}
