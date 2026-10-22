import {
  BenchmarkProfileQuotaErrorSchema,
  BenchmarkProfileStatusesRequestSchema,
  BenchmarkProfileStatusesResponseSchema,
  BenchmarkRoutingTableResponseSchema,
  ClassifierWinnerResponseSchema,
  CustomRouterBenchmarkContextSchema,
  CustomRoutingTableRequestSchema,
  CustomRoutingTableResponseSchema,
  CUSTOM_ROUTER_TABLE_PATH,
  RegisterBenchmarkProfilesRequestSchema,
  SyncBenchmarkSubscriptionsRequestSchema,
  DEFAULT_AUTO_ROUTER,
  customRouterEntryKey,
  type AutoRouter,
  type AutoRoutingModeOwnerType,
  type BenchmarkProfileStatusesResponse,
  type ClassifierWinner,
  type CustomRouterBenchmarkContext,
  type CustomRouterDefinition,
  type CustomRoutingTable,
  type EfficientModelPool,
  type RegisterBenchmarkProfilesRequest,
  type SyncBenchmarkSubscriptionsRequest,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';
import { isDirectByokModelId } from '@kilocode/worker-utils/direct-byok-model';

type BenchmarkEnv = Pick<Env, 'BENCHMARK_SERVICE' | 'INTERNAL_API_SECRET_PROD'>;

type BenchmarkOwner = { ownerType: AutoRoutingModeOwnerType; ownerId: string };

export class BenchmarkProfileQuotaError extends Error {
  readonly retryAt: string;

  constructor(message: string, retryAt: string) {
    super(message);
    this.name = 'BenchmarkProfileQuotaError';
    this.retryAt = retryAt;
  }
}

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

export async function registerBenchmarkProfiles(
  env: BenchmarkEnv,
  request: RegisterBenchmarkProfilesRequest
): Promise<BenchmarkProfileStatusesResponse> {
  const body = RegisterBenchmarkProfilesRequestSchema.parse(request);
  const res = await fetchBenchmark(env, '/admin/profiles/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const raw: unknown = await res.json().catch(() => null);
    const quota = BenchmarkProfileQuotaErrorSchema.safeParse(raw);
    if (quota.success) {
      throw new BenchmarkProfileQuotaError(quota.data.error, quota.data.retryAt);
    }
    throw new Error('benchmark profile register responded 429 with invalid body');
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`benchmark origin /admin/profiles/register responded ${res.status} ${detail}`);
  }

  const raw: unknown = await res.json();
  const parsed = BenchmarkProfileStatusesResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `benchmark profile register response invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`
    );
  }
  return parsed.data;
}

export async function syncBenchmarkSubscriptions(
  env: BenchmarkEnv,
  request: SyncBenchmarkSubscriptionsRequest
): Promise<BenchmarkProfileStatusesResponse> {
  const body = SyncBenchmarkSubscriptionsRequestSchema.parse(request);
  const res = await fetchBenchmark(env, '/admin/profiles/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(
      `benchmark origin /admin/profiles/subscriptions responded ${res.status} ${detail}`
    );
  }
  return BenchmarkProfileStatusesResponseSchema.parse(await res.json());
}

export async function fetchBenchmarkProfileStatuses(
  env: BenchmarkEnv,
  request: BenchmarkOwner & { entries: EfficientModelPool }
): Promise<BenchmarkProfileStatusesResponse> {
  const body = BenchmarkProfileStatusesRequestSchema.parse(request);
  const res = await fetchBenchmark(env, '/admin/profiles/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`benchmark origin /admin/profiles/status responded ${res.status} ${detail}`);
  }
  const raw: unknown = await res.json();
  const parsed = BenchmarkProfileStatusesResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `benchmark profile statuses response invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`
    );
  }
  return parsed.data;
}

export async function fetchCustomRoutingTable(
  env: BenchmarkEnv,
  request: BenchmarkOwner & { entries: EfficientModelPool }
): Promise<CustomRoutingTable | null> {
  const body = CustomRoutingTableRequestSchema.parse(request);
  const res = await fetchBenchmark(env, '/admin/custom-routing-table', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(
      `benchmark origin /admin/custom-routing-table responded ${res.status} ${detail}`
    );
  }
  const raw: unknown = await res.json();
  const parsed = CustomRoutingTableResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `benchmark custom routing-table response invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`
    );
  }
  return parsed.data.table;
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
