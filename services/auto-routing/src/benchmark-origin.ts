import {
  BenchmarkRoutingTableResponseSchema,
  ClassifierWinnerResponseSchema,
  type ClassifierWinner,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';

type BenchmarkEnv = Pick<Env, 'BENCHMARK_SERVICE' | 'INTERNAL_API_SECRET_PROD'>;

async function fetchBenchmark(env: BenchmarkEnv, path: string): Promise<unknown> {
  const secret = await env.INTERNAL_API_SECRET_PROD.get();
  const res = await env.BENCHMARK_SERVICE.fetch(`https://auto-routing-benchmark${path}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`benchmark origin ${path} responded ${res.status} ${detail}`);
  }
  return res.json();
}

export async function fetchRoutingTableFromOrigin(env: BenchmarkEnv): Promise<RoutingTable | null> {
  const body = await fetchBenchmark(env, '/admin/routing-table');
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
  const body = await fetchBenchmark(env, '/admin/classifier-winner');
  const parsed = ClassifierWinnerResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `benchmark classifier-winner response invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`
    );
  }
  return parsed.data.winner;
}
