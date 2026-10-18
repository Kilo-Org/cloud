import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  BenchmarkModelCatalogSchema,
  catalogCandidatePrices,
  catalogModelProviders,
  fetchBenchmarkModelCatalog,
  catalogSupportsBenchmarkPair,
  platformRegistryEntries,
} from './platform-models';

describe('catalog inference providers', () => {
  it('preserves every canonical upstream identity rather than using the model author', () => {
    const catalog = BenchmarkModelCatalogSchema.parse({
      data: [
        {
          id: 'meta-llama/llama-3.3-70b-instruct',
          inference_provider_ids: ['deepinfra', 'fireworks', 'together'],
        },
      ],
    });
    expect(catalogModelProviders(catalog, 'meta-llama/llama-3.3-70b-instruct')).toEqual([
      'deepinfra',
      'fireworks',
      'together',
    ]);
  });

  it('uses the canonical target providers instead of stale alias metadata', () => {
    const catalog = BenchmarkModelCatalogSchema.parse({
      data: [
        {
          id: '~vendor/latest',
          alias_target: 'vendor/current',
          inference_provider_ids: ['deepinfra'],
        },
        { id: 'vendor/current', inference_provider_ids: ['google-vertex', 'google-ai-studio'] },
      ],
    });
    expect(catalogModelProviders(catalog, '~vendor/latest')).toEqual([
      'google-vertex',
      'google-ai-studio',
    ]);
  });

  it('returns unknown when a model or its provider metadata is absent', () => {
    const catalog = BenchmarkModelCatalogSchema.parse({
      data: [{ id: 'anthropic/claude-sonnet' }],
    });
    expect(catalogModelProviders(catalog, 'anthropic/claude-sonnet')).toEqual([]);
    expect(catalogModelProviders(catalog, 'missing/model')).toEqual([]);
  });

  it('retains published alias providers when the target is not listed', () => {
    const catalog = BenchmarkModelCatalogSchema.parse({
      data: [
        {
          id: '~vendor/latest',
          alias_target: 'vendor/missing',
          inference_provider_ids: ['deepinfra', 'deepinfra'],
        },
      ],
    });
    expect(catalogModelProviders(catalog, '~vendor/latest')).toEqual(['deepinfra']);
  });
});

describe('catalog candidate pricing', () => {
  it('keeps normal models usable alongside variable-price virtual models', () => {
    const catalog = BenchmarkModelCatalogSchema.parse({
      data: [
        { id: 'synthetic/virtual', pricing: { prompt: '-1', completion: '-1' } },
        {
          id: 'synthetic/normal',
          pricing: { prompt: '0.002', completion: '0.003', input_cache_read: '-1' },
        },
        { id: 'synthetic/malformed', pricing: 'unavailable' },
      ],
    });
    const prices = catalogCandidatePrices(catalog);
    expect(prices.get('synthetic/virtual')).toBeNull();
    expect(prices.get('synthetic/normal')).toEqual({
      promptUsdPerToken: 0.002,
      completionUsdPerToken: 0.003,
      cacheReadUsdPerToken: null,
    });
    expect(prices.get('synthetic/malformed')).toBeNull();
  });

  it('keeps USD-per-token catalog prices and treats missing or invalid prices as unpriced', () => {
    const prices = catalogCandidatePrices(
      BenchmarkModelCatalogSchema.parse({
        data: [
          {
            id: 'synthetic/priced',
            pricing: { prompt: '0.002', completion: '0.003', input_cache_read: '0.0001' },
          },
          { id: 'synthetic/uncached', pricing: { prompt: '0.002', completion: '0.003' } },
          { id: 'synthetic/missing' },
          { id: 'synthetic/invalid', pricing: { prompt: 'invalid', completion: '0.003' } },
        ],
      })
    );
    expect(prices.get('synthetic/priced')).toEqual({
      promptUsdPerToken: 0.002,
      completionUsdPerToken: 0.003,
      cacheReadUsdPerToken: 0.0001,
    });
    expect(prices.get('synthetic/uncached')?.cacheReadUsdPerToken).toBeNull();
    expect(prices.get('synthetic/missing')).toBeNull();
    expect(prices.get('synthetic/invalid')).toBeNull();
  });
});

const catalog = BenchmarkModelCatalogSchema.parse({
  data: [
    {
      id: 'manual/reasoning',
      opencode: {
        variants: {
          instant: { reasoning: { enabled: false, effort: 'none' } },
          thinking: { reasoning: { enabled: true, effort: 'high' } },
          max: { reasoning: { effort: 'max' } },
          curated: { verbosity: 'high' },
          empty: { reasoning: {} },
        },
      },
    },
    {
      id: 'auto/reasoning',
      opencode: {
        variants: {
          low: { reasoning: { effort: 'low' } },
          xhigh: { reasoning: { effort: 'xhigh' } },
        },
      },
    },
    { id: 'plain/model' },
    { id: 'preset/model', opencode: { variants: { curated: { verbosity: 'high' } } } },
  ],
});

describe('platform catalog expansion', () => {
  it.each([
    ['an alias and its concrete target', ['~vendor/latest', 'vendor/current']],
    ['two aliases sharing a target', ['~vendor/latest', '~vendor/fast-latest']],
  ])('deduplicates %s using the concrete target reasoning variants', (_label, ids) => {
    const resolvedCatalog = BenchmarkModelCatalogSchema.parse({
      data: [
        {
          id: '~vendor/latest',
          alias_target: 'vendor/current',
          opencode: { variants: { stale: { reasoning: { effort: 'low' } } } },
        },
        { id: '~vendor/fast-latest', alias_target: 'vendor/current' },
        {
          id: 'vendor/current',
          opencode: { variants: { thinking: { reasoning: { effort: 'high' } } } },
        },
      ],
    });
    expect(
      platformRegistryEntries({ deciderModels: ids.map(id => ({ id })) }, resolvedCatalog)
    ).toEqual([{ model: 'vendor/current', variant: 'thinking' }]);
  });

  it('requests a new concrete pair when an alias is retargeted', () => {
    const config = { deciderModels: [{ id: '~vendor/latest' }] };
    const entriesForTarget = (target: string) =>
      platformRegistryEntries(
        config,
        BenchmarkModelCatalogSchema.parse({
          data: [
            { id: '~vendor/latest', alias_target: target },
            { id: 'vendor/old' },
            { id: 'vendor/new' },
          ],
        })
      );
    expect(entriesForTarget('vendor/old')).toEqual([{ model: 'vendor/old', variant: null }]);
    expect(entriesForTarget('vendor/new')).toEqual([{ model: 'vendor/new', variant: null }]);
  });

  it('expands manual and auto models into all and only explicit reasoning configurations', () => {
    expect(
      platformRegistryEntries(
        {
          deciderModels: [
            { id: 'manual/reasoning' },
            { id: 'auto/reasoning' },
            { id: 'manual/reasoning' },
          ],
        },
        catalog
      )
    ).toEqual([
      { model: 'manual/reasoning', variant: 'instant' },
      { model: 'manual/reasoning', variant: 'thinking' },
      { model: 'manual/reasoning', variant: 'max' },
      { model: 'auto/reasoning', variant: 'low' },
      { model: 'auto/reasoning', variant: 'xhigh' },
    ]);
  });

  it('uses one null pair for models with no reasoning controls, not unrelated presets', () => {
    expect(
      platformRegistryEntries(
        { deciderModels: [{ id: 'plain/model' }, { id: 'preset/model' }] },
        catalog
      )
    ).toEqual([
      { model: 'plain/model', variant: null },
      { model: 'preset/model', variant: null },
    ]);
  });

  it('keeps available entries runnable when another selected model is missing', () => {
    expect(
      platformRegistryEntries(
        { deciderModels: [{ id: 'missing/model' }, { id: 'plain/model' }] },
        catalog
      )
    ).toEqual([{ model: 'plain/model', variant: null }]);
  });

  it('requires tool support and current concrete variants for exact admission', () => {
    const executable = BenchmarkModelCatalogSchema.parse({
      data: [
        { id: 'tools/model', supported_parameters: ['tools'] },
        { id: 'text/model', supported_parameters: ['temperature'] },
        { id: 'unknown/model', supported_parameters: [] },
        { id: '~vendor/latest', alias_target: 'tools/model' },
        {
          id: 'reasoning/model',
          opencode: { variants: { high: { reasoning: { effort: 'high' } } } },
        },
      ],
    });
    expect(catalogSupportsBenchmarkPair(executable, { model: 'tools/model', variant: null })).toBe(
      true
    );
    expect(
      catalogSupportsBenchmarkPair(executable, { model: 'unknown/model', variant: null })
    ).toBe(true);
    expect(catalogSupportsBenchmarkPair(executable, { model: 'text/model', variant: null })).toBe(
      false
    );
    expect(
      catalogSupportsBenchmarkPair(executable, { model: '~vendor/latest', variant: null })
    ).toBe(false);
    expect(
      catalogSupportsBenchmarkPair(executable, { model: 'tools/model', variant: 'high' })
    ).toBe(false);
    expect(
      catalogSupportsBenchmarkPair(executable, { model: 'reasoning/model', variant: 'high' })
    ).toBe(true);
    expect(
      catalogSupportsBenchmarkPair(executable, { model: 'reasoning/model', variant: 'low' })
    ).toBe(false);
    expect(
      catalogSupportsBenchmarkPair(executable, { model: 'reasoning/model', variant: null })
    ).toBe(false);
    expect(
      platformRegistryEntries(
        { deciderModels: [{ id: 'text/model' }, { id: 'tools/model' }] },
        executable
      )
    ).toEqual([{ model: 'tools/model', variant: null }]);
  });

  it('does not execute an alias whose concrete target is absent', () => {
    expect(
      platformRegistryEntries(
        { deciderModels: [{ id: '~vendor/latest' }] },
        BenchmarkModelCatalogSchema.parse({
          data: [{ id: '~vendor/latest', alias_target: 'vendor/missing' }],
        })
      )
    ).toEqual([]);
  });

  it('validates catalog reasoning control values at runtime', () => {
    expect(
      BenchmarkModelCatalogSchema.safeParse({
        data: [
          {
            id: 'm',
            opencode: {
              variants: { thinking: { reasoning: { enabled: 'true' } } },
            },
          },
        ],
      }).success
    ).toBe(false);
    expect(
      BenchmarkModelCatalogSchema.safeParse({
        data: [
          {
            id: 'm',
            opencode: {
              variants: { high: { reasoning: { effort: 'bogus' } } },
            },
          },
        ],
      }).success
    ).toBe(false);
  });

  it('fails closed on catalog HTTP errors', async () => {
    const env = { KILO_WEB_API_BASE_URL: 'https://app.test' };
    await expect(
      fetchBenchmarkModelCatalog(
        env,
        vi.fn<typeof fetch>().mockResolvedValue(new Response('unavailable', { status: 503 }))
      )
    ).rejects.toThrow(/catalog failed: HTTP 503/);
  });

  // Native AbortSignal.timeout bypasses Vitest's fake clock; exercise real fetch body cancellation.
  it('bounds stalled catalog body reads before queue work can remain blocked', async () => {
    let finishBody: ReturnType<typeof setTimeout> | undefined;
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"data":[');
      finishBody = setTimeout(() => response.end('{"id":"m"}]}'), 12_000);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local server port');
    try {
      await expect(
        fetchBenchmarkModelCatalog({ KILO_WEB_API_BASE_URL: `http://127.0.0.1:${address.port}` })
      ).rejects.toMatchObject({ name: expect.stringMatching(/^(AbortError|TimeoutError)$/) });
    } finally {
      clearTimeout(finishBody);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      );
    }
  }, 20_000);
});
