import { describe, expect, it, jest } from '@jest/globals';
import { VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT } from '@kilocode/db/schema-types';
import { mapResolvedModelIdToVercelWithoutOverrides } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import {
  LEGACY_OPENROUTER_MODEL_ID_OVERRIDES,
  legacyOpenRouterAliases,
} from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-openrouter-model-ids';
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

function buildGenerated(
  modelsDevCatalog: ModelsDevCatalog,
  openrouterModelIds: string[],
  vercelModelIds: string[]
) {
  return build(modelsDevCatalog, openrouterModelIds, vercelModelIds).filter(
    override => !(override.openrouter_model_id in LEGACY_OPENROUTER_MODEL_ID_OVERRIDES)
  );
}

describe('buildVercelModelIdOverrides', () => {
  it('matches OpenRouter and Vercel models that share a canonical ID', () => {
    expect(
      buildGenerated(
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
      buildGenerated(
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

  it('matches free variants with free variants of the same canonical model', () => {
    expect(
      buildGenerated(
        catalog({
          openrouter: [
            { id: 'vendor/model:free', canonical_model_id: 'vendor/model' },
            { id: 'vendor/model', canonical_model_id: 'vendor/model' },
            { id: 'vendor/other-free', canonical_model_id: 'vendor/other-free' },
          ],
          vercel: [
            { id: 'other/model-free', canonical_model_id: 'vendor/model' },
            { id: 'other/model', canonical_model_id: 'vendor/model' },
            { id: 'other/other-free', canonical_model_id: 'vendor/other-free' },
          ],
        }),
        ['vendor/model:free', 'vendor/model', 'vendor/other-free'],
        ['other/model-free', 'other/model', 'other/other-free']
      )
    ).toEqual([
      { openrouter_model_id: 'vendor/model', vercel_model_id: 'other/model' },
      { openrouter_model_id: 'vendor/model:free', vercel_model_id: 'other/model-free' },
      { openrouter_model_id: 'vendor/other-free', vercel_model_id: 'other/other-free' },
    ]);
  });

  it('never pairs a free model with a paid model', () => {
    expect(
      buildGenerated(
        catalog({
          openrouter: [
            { id: 'vendor/paid-only', canonical_model_id: 'vendor/paid-only' },
            { id: 'vendor/free-only:free', canonical_model_id: 'vendor/free-only' },
          ],
          vercel: [
            { id: 'other/paid-only-free', canonical_model_id: 'vendor/paid-only' },
            { id: 'other/free-only', canonical_model_id: 'vendor/free-only' },
          ],
        }),
        ['vendor/paid-only', 'vendor/free-only:free'],
        ['other/paid-only-free', 'other/free-only']
      )
    ).toEqual([]);
  });

  it('picks the shortest free model ID without considering paid ones', () => {
    expect(
      buildGenerated(
        catalog({
          openrouter: [
            { id: 'vendor/m', canonical_model_id: 'vendor/model' },
            { id: 'vendor/model:free', canonical_model_id: 'vendor/model' },
          ],
          vercel: [
            { id: 'other/m', canonical_model_id: 'vendor/model' },
            { id: 'other/model-free', canonical_model_id: 'vendor/model' },
          ],
        }),
        ['vendor/m', 'vendor/model:free'],
        ['other/m', 'other/model-free']
      )
    ).toEqual([
      { openrouter_model_id: 'vendor/m', vercel_model_id: 'other/m' },
      { openrouter_model_id: 'vendor/model:free', vercel_model_id: 'other/model-free' },
    ]);
  });

  it('skips identical IDs', () => {
    expect(
      buildGenerated(
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
      buildGenerated(
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
      buildGenerated(
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
      buildGenerated(
        catalog({
          openrouter: [{ id: 'vendor/model' }],
          vercel: [{ id: 'other/model' }],
        }),
        ['vendor/model'],
        ['other/model']
      )
    ).toEqual([]);
  });

  it('rejects a models.dev catalog without the expected provider entries', () => {
    expect(() => build({ openrouter: { models: {} } }, [], [])).toThrow(
      /missing a valid vercel provider entry/
    );
    expect(() => build({ vercel: { models: {} } }, [], [])).toThrow(
      /missing a valid openrouter provider entry/
    );
  });

  it('maps every hardcoded legacy OpenRouter alias that needs an override', () => {
    const overrides = build(catalog({ openrouter: [], vercel: [] }), [], []);

    for (const [alias, vercelModelId] of Object.entries(LEGACY_OPENROUTER_MODEL_ID_OVERRIDES)) {
      expect(legacyOpenRouterAliases.has(alias)).toBe(true);
      const needsOverride =
        alias !== vercelModelId &&
        mapResolvedModelIdToVercelWithoutOverrides(alias) !== vercelModelId;
      if (needsOverride) {
        expect(overrides).toContainEqual({
          openrouter_model_id: alias,
          vercel_model_id: vercelModelId,
        });
      } else {
        expect(overrides).not.toContainEqual({
          openrouter_model_id: alias,
          vercel_model_id: vercelModelId,
        });
      }
    }
  });

  it('allows several legacy aliases to share a Vercel model ID', () => {
    expect(build(catalog({ openrouter: [], vercel: [] }), [], [])).toEqual(
      expect.arrayContaining([
        {
          openrouter_model_id: 'anthropic/claude-sonnet-4-5',
          vercel_model_id: 'anthropic/claude-sonnet-4.5',
        },
        {
          openrouter_model_id: 'claude-sonnet-4.5',
          vercel_model_id: 'anthropic/claude-sonnet-4.5',
        },
      ])
    );
  });

  it('sorts overrides and truncates generated entries to the configured maximum', () => {
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
    expect(new Set(overrides.map(override => override.openrouter_model_id)).size).toBe(
      overrides.length
    );
    expect(overrides.map(override => override.openrouter_model_id)).toEqual(
      [...overrides.map(override => override.openrouter_model_id)].sort()
    );
  });
});
