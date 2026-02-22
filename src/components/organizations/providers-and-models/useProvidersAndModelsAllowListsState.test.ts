import { describe, expect, test } from '@jest/globals';
import {
  createProvidersAndModelsAllowListsInitialState,
  providersAndModelsAllowListsReducer,
  type ProvidersAndModelsAllowListsState,
} from '@/components/organizations/providers-and-models/useProvidersAndModelsAllowListsState';
import { buildModelProvidersIndex } from '@/components/organizations/providers-and-models/allowLists.domain';

describe('providersAndModelsAllowListsReducer', () => {
  test('init -> toggle -> reset returns to initial', () => {
    let state: ProvidersAndModelsAllowListsState = createProvidersAndModelsAllowListsInitialState();

    state = providersAndModelsAllowListsReducer(state, {
      type: 'INIT_FROM_SERVER',
      modelAllowList: ['openai/gpt-4.1'],
      providerAllowList: [],
    });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    state = providersAndModelsAllowListsReducer(state, {
      type: 'TOGGLE_MODEL',
      modelId: 'openai/gpt-4.1',
      nextAllowed: false,
      allModelIds: ['openai/gpt-4.1'],
      providerSlugsForModelId: ['openai'],
    });

    state = providersAndModelsAllowListsReducer(state, { type: 'RESET_TO_INITIAL' });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    expect(state.draftModelAllowList).toEqual(state.initialModelAllowList);
    expect(state.draftProviderAllowList).toEqual(state.initialProviderAllowList);
  });

  test('init -> toggle -> mark saved marks clean (draft becomes initial)', () => {
    let state: ProvidersAndModelsAllowListsState = createProvidersAndModelsAllowListsInitialState();

    state = providersAndModelsAllowListsReducer(state, {
      type: 'INIT_FROM_SERVER',
      modelAllowList: [],
      providerAllowList: [],
    });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    const modelProvidersIndex = buildModelProvidersIndex([
      { slug: 'openai', models: [] },
      { slug: 'anthropic', models: [] },
    ]);

    state = providersAndModelsAllowListsReducer(state, {
      type: 'TOGGLE_PROVIDER',
      providerSlug: 'openai',
      nextEnabled: false,
      allProviderSlugsWithEndpoints: ['openai', 'anthropic'],
      modelProvidersIndex,
    });

    state = providersAndModelsAllowListsReducer(state, { type: 'MARK_SAVED' });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    expect(state.initialProviderAllowList).toEqual(state.draftProviderAllowList);
    expect(state.initialModelAllowList).toEqual(state.draftModelAllowList);
  });
});
