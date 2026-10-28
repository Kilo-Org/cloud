import {
  BenchmarkRoutingTableResponseSchema,
  ClassifierWinnerResponseSchema,
  CustomRouterBenchmarkContextSchema,
  CustomRoutingTableResponseSchema,
  CUSTOM_ROUTER_TABLE_PATH,
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

type BenchmarkEnv = Pick<Env, 'BENCHMARK_SERVICE' | 'INTERNAL_API_SECRET_PROD'>;

async function fetchBenchmark(
  env: BenchmarkEnv,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const secret = await env.INTERNAL_API_SECRET_PROD.get();
  return env.BENCHMARK_SERVICE.fetch(`https://auto-routing-benchmark${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(init?.headers ?? {}),
    },
  });
}

async function fetchBenchmarkJson(env: BenchmarkEnv, path: string): Promise<unknown> {
  const res = await fetchBenchmark(env, path);
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`benchmark origin ${path} responded ${res.status} ${detail}`);
  }
  return res.json();
}

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

export async function fetchCustomRouterTable(
  env: BenchmarkEnv,
  context: CustomRouterBenchmarkContext
): Promise<CustomRoutingTable | null> {
  const res = await fetchBenchmark(env, CUSTOM_ROUTER_TABLE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(context),
  });
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
  return parsed.data.table;
}

// The benchmark worker owns eval validation and error codes; its status and body pass through.
export async function forwardClientEval(
  env: BenchmarkEnv,
  path: string,
  body: unknown
): Promise<Response> {
  const res = await fetchBenchmark(env, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}
