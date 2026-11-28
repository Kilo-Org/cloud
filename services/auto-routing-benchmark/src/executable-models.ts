import type { BenchmarkIdentity } from '@kilocode/auto-routing-contracts';
import { KILO_API_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import type * as z from 'zod';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { fetchBenchmarkUserToken } from './benchmark-token';
import { BenchmarkModelCatalogSchema, catalogModelSupportsTools } from './platform-models';

// The organization catalog verifies the `kilo-api` audience, so it gets only a `kilo-api`
// token, never the gateway token the CLI container holds.
export async function fetchExecutableBenchmarkModelCatalog(
  env: Env,
  identity: BenchmarkIdentity,
  fetchImpl: typeof fetch = fetch,
  /** A `kilo-api` token the caller already minted, so one queue message mints it once. */
  mintedApiToken?: string,
  ctx?: SecretsExecutionContext
): Promise<z.infer<typeof BenchmarkModelCatalogSchema>> {
  const { benchmarkUserId, benchmarkOrgId } = identity;
  const token =
    mintedApiToken ??
    (await fetchBenchmarkUserToken(
      env,
      benchmarkUserId,
      benchmarkOrgId,
      KILO_API_AUDIENCE,
      fetchImpl,
      ctx
    ));
  const path = `/api/organizations/${encodeURIComponent(benchmarkOrgId)}/models`;
  const response = await fetchImpl(new URL(path, env.KILO_CLI_API_URL), {
    headers: {
      authorization: `Bearer ${token}`,
      'X-KiloCode-OrganizationId': benchmarkOrgId,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`benchmark executable model catalog failed: HTTP ${response.status}`);
  const catalog = BenchmarkModelCatalogSchema.parse(await response.json());
  return { data: catalog.data.filter(catalogModelSupportsTools) };
}
