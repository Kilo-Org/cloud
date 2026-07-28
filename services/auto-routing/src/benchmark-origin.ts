import {
  BenchmarkProfileQuotaErrorSchema,
  BenchmarkProfileStatusesRequestSchema,
  BenchmarkProfileStatusesResponseSchema,
  BenchmarkRoutingTableResponseSchema,
  ClassifierWinnerResponseSchema,
  CustomRoutingTableRequestSchema,
  CustomRoutingTableResponseSchema,
  RegisterBenchmarkProfilesRequestSchema,
  type BenchmarkProfileStatusesResponse,
  type ClassifierWinner,
  type CustomRoutingTable,
  type EfficientModelPool,
  type RegisterBenchmarkProfilesRequest,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';

type BenchmarkEnv = Pick<Env, 'BENCHMARK_SERVICE' | 'INTERNAL_API_SECRET_PROD'>;

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

export async function fetchRoutingTableFromOrigin(env: BenchmarkEnv): Promise<RoutingTable | null> {
  const body = await fetchBenchmarkJson(env, '/admin/routing-table');
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

export async function fetchBenchmarkProfileStatuses(
  env: BenchmarkEnv,
  entries: EfficientModelPool
): Promise<BenchmarkProfileStatusesResponse> {
  const body = BenchmarkProfileStatusesRequestSchema.parse({ entries });
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
  entries: EfficientModelPool
): Promise<CustomRoutingTable | null> {
  const body = CustomRoutingTableRequestSchema.parse({ entries });
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
