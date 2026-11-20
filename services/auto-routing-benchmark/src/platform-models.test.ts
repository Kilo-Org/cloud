import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { NON_ENROLLABLE_BENCHMARK_MODEL_REASON } from '@kilocode/auto-routing-contracts';
import {
  BenchmarkModelCatalogSchema,
  benchmarkPairUnavailability,
  blockedEnrollmentTarget,
  CATALOG_CONTEXT_TOO_SMALL_REASON,
  CATALOG_PAIR_UNAVAILABLE_REASON,
  MIN_BENCHMARK_INPUT_TOKENS,
  catalogCandidatePrices,
  catalogModelVariants,
  fetchBenchmarkModelCatalog,
  catalogSupportsBenchmarkPair,
  platformRegistryEntries,
} from './platform-models';

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
        { id: 'no-parameters/model', supported_parameters: [] },
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
      catalogSupportsBenchmarkPair(executable, { model: 'no-parameters/model', variant: null })
    ).toBe(false);
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

  it('rejects a window whose input room after the CLI completion reservation is too small', () => {
    const executable = BenchmarkModelCatalogSchema.parse({
      data: [
        {
          id: 'reka-like/model',
          context_length: 16_384,
          top_provider: { max_completion_tokens: 14_745 },
          opencode: { variants: { high: { reasoning: { effort: 'high' } } } },
        },
        {
          id: 'reserved/model',
          context_length: 32_768,
          top_provider: { max_completion_tokens: 29_000 },
        },
        {
          id: 'capped/model',
          context_length: 32_000 + MIN_BENCHMARK_INPUT_TOKENS,
          max_completion_tokens: 1_000_000,
        },
        { id: 'default-reserve/model', context_length: 25_000 },
        {
          id: 'roomy/model',
          context_length: 32_768,
          top_provider: { max_completion_tokens: 8_192 },
        },
        { id: 'unknown/model', context_length: null },
        { id: 'malformed/model', context_length: 'wide' },
      ],
    });
    const reason = (model: string, variant: string | null = null) =>
      benchmarkPairUnavailability(executable, { model, variant });
    expect(reason('reka-like/model', 'high')).toEqual({
      failureClass: 'context_too_small',
      reason: CATALOG_CONTEXT_TOO_SMALL_REASON,
    });
    expect(reason('reserved/model')).toEqual({
      failureClass: 'context_too_small',
      reason: CATALOG_CONTEXT_TOO_SMALL_REASON,
    });
    expect(reason('capped/model')).toBeNull();
    expect(reason('default-reserve/model')).toBeNull();
    expect(reason('roomy/model')).toBeNull();
    expect(reason('unknown/model')).toBeNull();
    expect(reason('malformed/model')).toBeNull();
    expect(reason('missing/model')).toEqual({
      failureClass: 'catalog_absent',
      reason: CATALOG_PAIR_UNAVAILABLE_REASON,
    });
    expect(
      catalogSupportsBenchmarkPair(executable, { model: 'reserved/model', variant: null })
    ).toBe(true);
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

  it('refuses a non-enrollable model on every expansion and admission path', () => {
    const executable = BenchmarkModelCatalogSchema.parse({
      data: [
        { id: 'openai/gpt-6.2-astra-fast', supported_parameters: ['tools'] },
        { id: 'openai/gpt-6.2-astra', supported_parameters: ['tools'] },
        { id: '~openai/astra-latest', alias_target: 'openai/gpt-6.2-astra-fast' },
      ],
    });
    // A direct selection enters no run; the plain model beside it still does.
    expect(
      platformRegistryEntries(
        {
          deciderModels: [{ id: 'openai/gpt-6.2-astra-fast' }, { id: 'openai/gpt-6.2-astra' }],
        },
        executable
      )
    ).toEqual([{ model: 'openai/gpt-6.2-astra', variant: null }]);
    expect(
      platformRegistryEntries({ deciderModels: [{ id: '~openai/astra-latest' }] }, executable)
    ).toEqual([]);
    // Exact admission and the drain's unavailability reason both refuse it.
    expect(
      catalogSupportsBenchmarkPair(executable, {
        model: 'openai/gpt-6.2-astra-fast',
        variant: null,
      })
    ).toBe(false);
    expect(
      catalogSupportsBenchmarkPair(executable, { model: 'openai/gpt-6.2-astra', variant: null })
    ).toBe(true);
    expect(
      benchmarkPairUnavailability(executable, {
        model: 'openai/gpt-6.2-astra-fast',
        variant: null,
      })
    ).toEqual({ failureClass: 'unsupported', reason: NON_ENROLLABLE_BENCHMARK_MODEL_REASON });
    expect(
      benchmarkPairUnavailability(executable, { model: 'openai/gpt-6.2-astra', variant: null })
    ).toBeNull();
    // The variant lookup stays a pure catalog read, so an owner client eval of the same
    // id is untouched; blocking is applied at the platform call sites instead.
    expect(catalogModelVariants(executable, 'openai/gpt-6.2-astra-fast')).toEqual({
      model: 'openai/gpt-6.2-astra-fast',
      variants: [null],
    });
    expect(catalogModelVariants(executable, 'openai/gpt-6.2-astra')).toEqual({
      model: 'openai/gpt-6.2-astra',
      variants: [null],
    });
    // An alias cannot smuggle a blocked concrete target past the check.
    expect(blockedEnrollmentTarget(executable, '~openai/astra-latest')).toBe(
      'openai/gpt-6.2-astra-fast'
    );
    expect(blockedEnrollmentTarget(executable, 'openai/gpt-6.2-astra-fast')).toBe(
      'openai/gpt-6.2-astra-fast'
    );
    expect(blockedEnrollmentTarget(executable, 'openai/gpt-6.2-astra')).toBeNull();
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
