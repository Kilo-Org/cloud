import { describe, expect, it, jest } from '@jest/globals';
import { VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT } from '@kilocode/db/schema-types';
import type { ModelsDevCatalog } from '@/lib/providers/direct-byok/models-dev';
import { buildVercelModelIdOverrides } from './vercel-model-id-overrides';

type CatalogModel = { id: string; canonical_model_id?: string };

function catalog(params: { openrouter: CatalogModel[]; vercel: CatalogModel[] }): ModelsDevCatalog {
  const provider = (models: CatalogModel[]) => ({
    models: Object.fromEntries(models.map(model => [model.id, model])),
  });
  return {
    openrouter: provider(params.openrouter),
    vercel: provider(params.vercel),
  };
}

function build(
  modelsDevCatalog: ModelsDevCatalog,
  openrouterModelIds: string[],
  vercelModelIds: string[]
) {
  return buildVercelModelIdOverrides({
    modelsDevCatalog,
    openrouterModelIds: new Set(openrouterModelIds),
    vercelModelIds: new Set(vercelModelIds),
  });
}

describe('buildVercelModelIdOverrides', () => {
  it('matches OpenRouter and Vercel models that share a canonical ID', () => {
    expect(
      build(
        catalog({
          openrouter: [{ id: 'vendor/old-name', canonical_model_id: 'vendor/new-name' }],
          vercel: [{ id: 'vendor/new-name', canonical_model_id: 'vendor/new-name' }],
        }),
        ['vendor/old-name'],
        ['vendor/new-name']
      )
    ).toEqual([{ openrouter_model_id: 'vendor/old-name', vercel_model_id: 'vendor/new-name' }]);
  });

  it('picks the shortest model ID on both sides when several share a canonical ID', () => {
    expect(
      build(
        catalog({
          openrouter: [
            { id: 'vendor/a-much-longer-name', canonical_model_id: 'vendor/model' },
            { id: 'vendor/short', canonical_model_id: 'vendor/model' },
          ],
          vercel: [
            { id: 'other/longer', canonical_model_id: 'vendor/model' },
            { id: 'other/b', canonical_model_id: 'vendor/model' },
          ],
        }),
        ['vendor/a-much-longer-name', 'vendor/short'],
        ['other/longer', 'other/b']
      )
    ).toEqual([{ openrouter_model_id: 'vendor/short', vercel_model_id: 'other/b' }]);
  });

  it('skips free variants', () => {
    expect(
      build(
        catalog({
          openrouter: [
            { id: 'vendor/model:free', canonical_model_id: 'vendor/model' },
            { id: 'vendor/model-free', canonical_model_id: 'vendor/model-free' },
          ],
          vercel: [
            { id: 'other/model', canonical_model_id: 'vendor/model' },
            { id: 'other/model-free', canonical_model_id: 'vendor/model-free' },
          ],
        }),
        ['vendor/model:free', 'vendor/model-free'],
        ['other/model', 'other/model-free']
      )
    ).toEqual([]);
  });

  it('skips identical IDs', () => {
    expect(
      build(
        catalog({
          openrouter: [{ id: 'vendor/model', canonical_model_id: 'vendor/model' }],
          vercel: [{ id: 'vendor/model', canonical_model_id: 'vendor/model' }],
        }),
        ['vendor/model'],
        ['vendor/model']
      )
    ).toEqual([]);
  });

  it('skips IDs already handled by the prefix rewrite', () => {
    expect(
      build(
        catalog({
          openrouter: [
            { id: 'qwen/qwen3-32b', canonical_model_id: 'qwen/qwen3-32b' },
            { id: 'mistralai/mistral-large', canonical_model_id: 'mistralai/mistral-large' },
          ],
          vercel: [
            { id: 'alibaba/qwen3-32b', canonical_model_id: 'qwen/qwen3-32b' },
            { id: 'mistral/mistral-large', canonical_model_id: 'mistralai/mistral-large' },
          ],
        }),
        ['qwen/qwen3-32b', 'mistralai/mistral-large'],
        ['alibaba/qwen3-32b', 'mistral/mistral-large']
      )
    ).toEqual([]);
  });

  it('only matches models present in the gateway model lists', () => {
    expect(
      build(
        catalog({
          openrouter: [{ id: 'vendor/model', canonical_model_id: 'vendor/model' }],
          vercel: [{ id: 'other/model', canonical_model_id: 'vendor/model' }],
        }),
        [],
        ['other/model']
      )
    ).toEqual([]);
  });

  it('ignores models without a canonical ID', () => {
    expect(
      build(
        catalog({
          openrouter: [{ id: 'vendor/model' }],
          vercel: [{ id: 'other/model' }],
        }),
        ['vendor/model'],
        ['other/model']
      )
    ).toEqual([]);
  });

  it('sorts overrides and truncates to the configured maximum', () => {
    const count = VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT + 1;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const openrouter = Array.from({ length: count }, (_, index) => ({
      id: `vendor/openrouter-${index}`,
      canonical_model_id: `canonical-${index}`,
    }));
    const vercel = Array.from({ length: count }, (_, index) => ({
      id: `vendor/vercel-${index}`,
      canonical_model_id: `canonical-${index}`,
    }));

    const overrides = build(
      catalog({ openrouter, vercel }),
      openrouter.map(model => model.id),
      vercel.map(model => model.id)
    );

    expect(overrides).toHaveLength(VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT);
    expect(overrides[0]).toEqual({
      openrouter_model_id: 'vendor/openrouter-0',
      vercel_model_id: 'vendor/vercel-0',
    });
  });
});
