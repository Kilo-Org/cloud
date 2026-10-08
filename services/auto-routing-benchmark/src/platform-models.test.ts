import { describe, expect, it, vi } from 'vitest';
import {
  BenchmarkModelCatalogSchema,
  fetchPlatformRegistryEntries,
  platformRegistryEntries,
} from './platform-models';

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

  it('rejects missing selected models rather than treating unavailable metadata as nonreasoning', () => {
    expect(() =>
      platformRegistryEntries({ deciderModels: [{ id: 'missing/model' }] }, catalog)
    ).toThrow(/missing from Kilo catalog/);
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
      fetchPlatformRegistryEntries(
        env,
        { deciderModels: [{ id: 'm' }] },
        vi.fn<typeof fetch>().mockResolvedValue(new Response('unavailable', { status: 503 }))
      )
    ).rejects.toThrow(/catalog failed: HTTP 503/);
  });
});
