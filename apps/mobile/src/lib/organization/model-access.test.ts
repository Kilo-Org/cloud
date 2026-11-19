import { describe, expect, it } from 'vitest';

import {
  type CatalogModel,
  catalogProviderSlugs,
  denyListModels,
  draftsEqual,
  initialDraft,
  matchesSearch,
  modelAccessSave,
  normalizeModelId,
  providerRows,
  setModelsAllowed,
  setProvidersAllowed,
  toggleModel,
  toggleProvider,
  usableModelIds,
} from '@/lib/organization/model-access';

function model(id: string, providers: readonly string[]): CatalogModel {
  // Only the fields the module reads: a real catalog entry carries the rest of
  // the gateway's model descriptor, which these helpers never open.
  return { id, name: id, inference_provider_ids: [...providers] } satisfies CatalogModel;
}

const MODELS = [
  model('anthropic/claude', ['anthropic']),
  model('openai/gpt:free', ['openai', 'azure']),
  model('meta/llama', ['amazon-bedrock']),
];

describe('normalizeModelId', () => {
  it('drops the variant suffix', () => {
    expect(normalizeModelId('openai/gpt:free')).toBe('openai/gpt');
    expect(normalizeModelId('openai/gpt')).toBe('openai/gpt');
  });
});

describe('catalog derivation', () => {
  it('lists the provider slugs every catalog model points at, sorted and unique', () => {
    expect(catalogProviderSlugs(MODELS)).toEqual([
      'amazon-bedrock',
      'anthropic',
      'azure',
      'openai',
    ]);
  });
});

describe('providerRows', () => {
  // The organization's own catalog carries only the models its policy admits,
  // so with `anthropic` off it has none of that provider's models at all.
  const AVAILABLE_WITHOUT_ANTHROPIC = [model('openai/gpt', ['openai'])];

  it('keeps a provider the organization policy filtered out, so it can be turned back on', () => {
    expect(
      providerRows({
        catalog: MODELS,
        available: AVAILABLE_WITHOUT_ANTHROPIC,
        savedAllowList: ['azure', 'openai'],
      })
    ).toEqual(['amazon-bedrock', 'anthropic', 'azure', 'openai']);
  });

  it('adds a saved provider no catalog model serves any more, so it stays removable', () => {
    expect(
      providerRows({ catalog: [], available: [], savedAllowList: ['retired-provider'] })
    ).toEqual(['retired-provider']);
  });

  it('expands an absent allow list to every provider of the whole catalog', () => {
    const draft = initialDraft(
      {},
      providerRows({ catalog: MODELS, available: AVAILABLE_WITHOUT_ANTHROPIC, savedAllowList: [] })
    );
    expect(draft.providerAllowList).toEqual(['amazon-bedrock', 'anthropic', 'azure', 'openai']);
  });
});

describe('denyListModels', () => {
  it('keeps a denied model on the list from the unfiltered catalog, one row per bare id', () => {
    const rows = denyListModels({
      catalog: [
        { id: 'openai/gpt', name: 'GPT' },
        { id: 'openai/gpt:free', name: 'GPT (free)' },
        { id: 'meta/llama', name: 'Llama' },
      ],
      available: [{ id: 'anthropic/claude', name: 'Claude' }],
      denyList: ['meta/llama', 'gone/model'],
    });
    expect(rows).toEqual([
      { id: 'anthropic/claude', name: 'Claude' },
      { id: 'gone/model', name: 'gone/model' },
      { id: 'meta/llama', name: 'Llama' },
      { id: 'openai/gpt', name: 'GPT' },
    ]);
  });
});

describe('initialDraft', () => {
  it('treats an absent provider allow list as every catalog provider', () => {
    const draft = initialDraft({ model_deny_list: ['openai/gpt:free'] }, ['openai', 'anthropic']);
    expect(draft.providerAllowList).toEqual(['anthropic', 'openai']);
    expect(draft.modelDenyList).toEqual(['openai/gpt']);
  });

  it('keeps a saved allow list rather than expanding it', () => {
    const draft = initialDraft({ provider_allow_list: ['anthropic'], model_deny_list: [] }, [
      'openai',
      'anthropic',
    ]);
    expect(draft.providerAllowList).toEqual(['anthropic']);
    expect(draft.modelDenyList).toEqual([]);
  });
});

describe('toggles', () => {
  it('adds and removes a provider while keeping the list sorted', () => {
    const allowed = toggleProvider(
      { providerAllowList: ['openai'], modelDenyList: [] },
      'anthropic',
      true
    );
    expect(allowed.providerAllowList).toEqual(['anthropic', 'openai']);
    const removed = toggleProvider(allowed, 'openai', false);
    expect(removed.providerAllowList).toEqual(['anthropic']);
  });

  it('denies a model by its bare id and allows it again', () => {
    const denied = toggleModel(
      { providerAllowList: [], modelDenyList: [] },
      'openai/gpt:free',
      false
    );
    expect(denied.modelDenyList).toEqual(['openai/gpt']);
    expect(toggleModel(denied, 'openai/gpt', true).modelDenyList).toEqual([]);
  });

  it('applies one decision to every listed entry, as the bulk actions do', () => {
    const providers = setProvidersAllowed(
      { providerAllowList: ['openai'], modelDenyList: [] },
      ['openai', 'anthropic'],
      false
    );
    expect(providers.providerAllowList).toEqual([]);

    const models = setModelsAllowed(
      { providerAllowList: [], modelDenyList: ['meta/llama'] },
      ['openai/gpt:free', 'meta/llama'],
      false
    );
    expect(models.modelDenyList).toEqual(['meta/llama', 'openai/gpt']);
  });
});

describe('draftsEqual', () => {
  it('compares both lists in order', () => {
    const draft = { providerAllowList: ['a', 'b'], modelDenyList: [] };
    expect(draftsEqual(draft, { providerAllowList: ['a', 'b'], modelDenyList: [] })).toBe(true);
    expect(draftsEqual(draft, { providerAllowList: ['b', 'a'], modelDenyList: [] })).toBe(false);
    expect(draftsEqual(draft, { providerAllowList: ['a', 'b'], modelDenyList: ['x'] })).toBe(false);
  });
});

describe('usableModelIds', () => {
  it('drops denied models and models whose every provider the draft turned off', () => {
    expect(
      usableModelIds({
        models: MODELS,
        draft: { providerAllowList: ['anthropic', 'azure'], modelDenyList: ['openai/gpt'] },
      })
    ).toEqual(['anthropic/claude']);
  });

  it('keeps a model that names no provider, since the allow list only gates providers', () => {
    expect(
      usableModelIds({
        models: [{ id: 'auto', name: 'Auto' }],
        draft: { providerAllowList: [], modelDenyList: [] },
      })
    ).toEqual(['auto']);
  });
});

describe('modelAccessSave', () => {
  const everyModelDenied = MODELS.map(entry => normalizeModelId(entry.id)).sort();
  const everyProvider = ['amazon-bedrock', 'anthropic', 'azure', 'openai'];

  it('keeps an already empty saved list writable, since the list itself did not change', () => {
    expect(
      modelAccessSave({
        savedAllowList: [],
        baseline: { providerAllowList: [], modelDenyList: [] },
        draft: { providerAllowList: [], modelDenyList: ['openai/gpt'] },
        providerCatalogLoaded: true,
        models: MODELS,
      })
    ).toEqual({ kind: 'ready', providerAllowList: [], modelDenyList: ['openai/gpt'] });
  });

  it('refuses a deny list that would leave no model any member could use', () => {
    expect(
      modelAccessSave({
        savedAllowList: undefined,
        baseline: { providerAllowList: everyProvider, modelDenyList: [] },
        draft: { providerAllowList: everyProvider, modelDenyList: everyModelDenied },
        providerCatalogLoaded: true,
        models: MODELS,
      })
    ).toEqual({ kind: 'empty-model-list' });
  });

  it('keeps a policy that already denied every model writable, since the draft does not empty it', () => {
    expect(
      modelAccessSave({
        savedAllowList: undefined,
        baseline: { providerAllowList: everyProvider, modelDenyList: everyModelDenied },
        draft: { providerAllowList: everyProvider, modelDenyList: everyModelDenied },
        providerCatalogLoaded: true,
        models: MODELS,
      })
    ).toEqual({ kind: 'ready', providerAllowList: undefined, modelDenyList: everyModelDenied });
  });

  it('leaves the model guard inert while the catalog is unavailable', () => {
    expect(
      modelAccessSave({
        savedAllowList: undefined,
        baseline: { providerAllowList: ['anthropic'], modelDenyList: [] },
        draft: { providerAllowList: ['anthropic'], modelDenyList: ['anthropic/claude'] },
        providerCatalogLoaded: true,
        models: [],
      })
    ).toEqual({
      kind: 'ready',
      providerAllowList: undefined,
      modelDenyList: ['anthropic/claude'],
    });
  });

  it('leaves the provider list alone while the catalog is unavailable, even after a provider change', () => {
    expect(
      modelAccessSave({
        savedAllowList: undefined,
        baseline: { providerAllowList: ['anthropic'], modelDenyList: [] },
        draft: { providerAllowList: ['openai'], modelDenyList: [] },
        providerCatalogLoaded: false,
        models: MODELS,
      })
    ).toEqual({ kind: 'ready', providerAllowList: undefined, modelDenyList: [] });
  });
});

describe('matchesSearch', () => {
  it('matches any field case-insensitively, and everything for an empty query', () => {
    expect(matchesSearch(['OpenAI: GPT-5', 'openai/gpt-5'], 'gpt')).toBe(true);
    expect(matchesSearch(['OpenAI: GPT-5', 'openai/gpt-5'], 'anthropic')).toBe(false);
    expect(matchesSearch(['anything'], '  ')).toBe(true);
    expect(matchesSearch([undefined, 'openai/gpt'], 'GPT')).toBe(true);
  });
});
