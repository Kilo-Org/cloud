import { BenchmarkConfigSchema, resolveBenchmarkIdentity } from '@kilocode/auto-routing-contracts';
import { describe, expect, it, vi } from 'vitest';
import { fetchExecutableBenchmarkModelCatalog } from './executable-models';

const config = BenchmarkConfigSchema.parse({
  classifierModels: ['classifier/model'],
  deciderModels: [{ id: 'candidate/model' }],
  minAccuracy: 0.7,
  benchmarkUserId: 'benchmark-user',
  benchmarkOrgId: 'benchmark-org',
  switchCostFactor: 3,
  updatedAt: null,
  updatedBy: null,
});
const secretGet = vi.fn(async () => 'internal-secret');
const env = {
  INTERNAL_API_SECRET_PROD: { get: secretGet },
  KILO_WEB_API_BASE_URL: 'https://internal.test',
  KILO_CLI_API_URL: 'https://cli.test',
} as unknown as Env;

function catalogFetch() {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ token: 'candidate-token', expiresAt: '2026-10-18T01:00:00Z' })
    )
    .mockResolvedValueOnce(
      Response.json({
        data: [
          { id: 'candidate/model', supported_parameters: ['tools', 'temperature'] },
          { id: 'text/model', supported_parameters: ['temperature'] },
          { id: 'no-parameters/model', supported_parameters: [] },
          { id: 'legacy/model' },
        ],
      })
    );
}

describe('executable benchmark catalog', () => {
  it('mints the benchmark identity and fetches the CLI organization catalog with matching credentials', async () => {
    const fetch = catalogFetch();
    const catalog = await fetchExecutableBenchmarkModelCatalog(
      env,
      resolveBenchmarkIdentity(config),
      fetch
    );
    const [tokenCall, modelsCall] = fetch.mock.calls;
    expect(tokenCall[0] instanceof Request ? tokenCall[0].url : tokenCall[0].toString()).toBe(
      'https://internal.test/api/internal/auto-routing-benchmark/token'
    );
    expect(tokenCall[1]).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer internal-secret' },
      body: JSON.stringify({ userId: 'benchmark-user', organizationId: 'benchmark-org' }),
    });
    expect(modelsCall[0] instanceof Request ? modelsCall[0].url : modelsCall[0].toString()).toBe(
      'https://cli.test/api/organizations/benchmark-org/models'
    );
    expect(modelsCall[1]).toMatchObject({
      headers: {
        authorization: 'Bearer candidate-token',
        'X-KiloCode-OrganizationId': 'benchmark-org',
      },
    });
    expect(catalog.data.map(model => model.id)).toEqual(['candidate/model', 'legacy/model']);
  });

  it('uses the effective default identity instead of treating null organization as personal scope', async () => {
    const defaults = { ...config, benchmarkUserId: null, benchmarkOrgId: null };
    const identity = resolveBenchmarkIdentity(defaults);
    const fetch = catalogFetch();
    await fetchExecutableBenchmarkModelCatalog(env, identity, fetch);
    expect(fetch.mock.calls[0][1]?.body).toBe(
      JSON.stringify({ userId: identity.benchmarkUserId, organizationId: identity.benchmarkOrgId })
    );
    const modelsInput = fetch.mock.calls[1][0];
    expect(modelsInput instanceof Request ? modelsInput.url : modelsInput.toString()).toBe(
      `https://cli.test/api/organizations/${identity.benchmarkOrgId}/models`
    );
  });

  it('uses the personal catalog without an organization header when no effective organization exists', async () => {
    const fetch = catalogFetch();
    await fetchExecutableBenchmarkModelCatalog(
      env,
      { benchmarkUserId: 'benchmark-user', benchmarkOrgId: null },
      fetch
    );
    expect(fetch.mock.calls[0][1]?.body).toBe(JSON.stringify({ userId: 'benchmark-user' }));
    const modelsInput = fetch.mock.calls[1][0];
    expect(modelsInput instanceof Request ? modelsInput.url : modelsInput.toString()).toBe(
      'https://cli.test/api/openrouter/models'
    );
    expect(fetch.mock.calls[1][1]?.headers).toEqual({ authorization: 'Bearer candidate-token' });
  });

  it('never falls back to a public catalog after authenticated admission fails', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ token: 'candidate-token', expiresAt: '2026-10-18T01:00:00Z' })
      )
      .mockResolvedValueOnce(new Response('private response body', { status: 403 }));
    await expect(
      fetchExecutableBenchmarkModelCatalog(env, resolveBenchmarkIdentity(config), fetch)
    ).rejects.toThrow('benchmark executable model catalog failed: HTTP 403');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not disclose token mint response bodies or continue without a valid token', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('private response body', { status: 500 }));
    await expect(
      fetchExecutableBenchmarkModelCatalog(env, resolveBenchmarkIdentity(config), fetch)
    ).rejects.toThrow('token mint failed: HTTP 500');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
