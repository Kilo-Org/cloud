import { describe, expect, it } from 'vitest';

import {
  type CatalogModel,
  catalogModelIds,
  catalogProviderSlugs,
  draftsEqual,
  initialDraft,
  matchesSearch,
  normalizeModelId,
  setModelsAllowed,
  setProvidersAllowed,
  toggleModel,
  toggleProvider,
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

  it('lists model ids without their variant suffixes', () => {
    expect(catalogModelIds(MODELS)).toEqual(['anthropic/claude', 'meta/llama', 'openai/gpt']);
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

describe('matchesSearch', () => {
  it('matches any field case-insensitively, and everything for an empty query', () => {
    expect(matchesSearch(['OpenAI: GPT-5', 'openai/gpt-5'], 'gpt')).toBe(true);
    expect(matchesSearch(['OpenAI: GPT-5', 'openai/gpt-5'], 'anthropic')).toBe(false);
    expect(matchesSearch(['anything'], '  ')).toBe(true);
    expect(matchesSearch([undefined, 'openai/gpt'], 'GPT')).toBe(true);
  });
});
