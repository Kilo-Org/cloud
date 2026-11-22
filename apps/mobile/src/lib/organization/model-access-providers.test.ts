import { describe, expect, it } from 'vitest';

import {
  canonicalDraft,
  type CatalogModel,
  initialDraft,
  modelAccessSave,
  usableModelIds,
} from '@/lib/organization/model-access';

function model(id: string, providers: readonly string[]): CatalogModel {
  return { id, name: id, inference_provider_ids: [...providers] } satisfies CatalogModel;
}

describe('initialDraft provider slugs', () => {
  it('canonicalizes a legacy stored slug, so a mixed-case entry names its provider', () => {
    const draft = initialDraft({ provider_allow_list: ['OpenAI'], model_deny_list: [] }, [
      'openai',
      'anthropic',
    ]);
    expect(draft.providerAllowList).toEqual(['openai']);
  });
});

describe('usableModelIds provider slugs', () => {
  it('admits a model whose provider slug is mixed case, against a canonical allow list', () => {
    const draft = initialDraft({ provider_allow_list: ['OpenAI'], model_deny_list: [] }, [
      'openai',
    ]);
    expect(usableModelIds({ models: [model('openai/gpt', ['OpenAI'])], draft })).toEqual([
      'openai/gpt',
    ]);
  });

  it('admits a model whose provider entry is model-shaped, against a canonical allow list', () => {
    const draft = initialDraft({ provider_allow_list: ['OpenAI'], model_deny_list: [] }, [
      'openai',
    ]);
    expect(usableModelIds({ models: [model('openai/gpt', ['openai/gpt-4o'])], draft })).toEqual([
      'openai/gpt',
    ]);
  });

  it('admits a model against a restored draft that still holds a legacy slug', () => {
    // The form's encrypted store only checks the draft's shape, so a draft
    // written before writers stored the canonical form can carry one.
    expect(
      usableModelIds({
        models: [model('openai/gpt', ['openai'])],
        draft: { providerAllowList: ['OpenAI'], modelDenyList: [] },
      })
    ).toEqual(['openai/gpt']);
  });
});

describe('canonicalDraft', () => {
  it('canonicalizes a restored draft so its provider rows render enabled', () => {
    expect(
      canonicalDraft({ providerAllowList: ['OpenAI', 'openai'], modelDenyList: ['x:free'] })
    ).toEqual({
      providerAllowList: ['openai'],
      modelDenyList: ['x'],
    });
  });
});

describe('modelAccessSave provider slugs', () => {
  it('saves a restored legacy draft without tripping the empty-model-list refusal', () => {
    expect(
      modelAccessSave({
        savedAllowList: ['openai'],
        providerCatalogLoaded: true,
        providerListEdited: false,
        models: [model('openai/gpt', ['openai'])],
        baseline: { providerAllowList: ['openai'], modelDenyList: [] },
        draft: { providerAllowList: ['OpenAI'], modelDenyList: [] },
      }).kind
    ).toBe('ready');
  });
});
