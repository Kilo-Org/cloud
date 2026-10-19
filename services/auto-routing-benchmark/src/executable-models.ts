import type * as z from 'zod';
import { fetchBenchmarkUserToken } from './benchmark-token';
import { BenchmarkModelCatalogSchema, catalogModelSupportsTools } from './platform-models';

export async function fetchExecutableBenchmarkModelCatalog(
  env: Env,
  identity: { benchmarkUserId: string; benchmarkOrgId: string | null },
  fetchImpl: typeof fetch = fetch
): Promise<z.infer<typeof BenchmarkModelCatalogSchema>> {
  const { benchmarkUserId, benchmarkOrgId } = identity;
  const token = await fetchBenchmarkUserToken(env, benchmarkUserId, benchmarkOrgId, fetchImpl);
  const path = benchmarkOrgId
    ? `/api/organizations/${encodeURIComponent(benchmarkOrgId)}/models`
    : '/api/openrouter/models';
  const response = await fetchImpl(new URL(path, env.KILO_CLI_API_URL), {
    headers: {
      authorization: `Bearer ${token}`,
      ...(benchmarkOrgId ? { 'X-KiloCode-OrganizationId': benchmarkOrgId } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`benchmark executable model catalog failed: HTTP ${response.status}`);
  const catalog = BenchmarkModelCatalogSchema.parse(await response.json());
  return { data: catalog.data.filter(catalogModelSupportsTools) };
}
