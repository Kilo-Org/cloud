import { describe, expect, test } from '@jest/globals';
import {
  createProvidersAndModelsAllowListsInitialState,
  providersAndModelsAllowListsReducer,
  type ProvidersAndModelsAllowListsState,
} from '@/components/organizations/providers-and-models/useProvidersAndModelsAllowListsState';

describe('providersAndModelsAllowListsReducer', () => {
  test('init -> toggle -> reset returns to initial', () => {
    let state: ProvidersAndModelsAllowListsState = createProvidersAndModelsAllowListsInitialState();

    state = providersAndModelsAllowListsReducer(state, {
      type: 'INIT_FROM_SERVER',
      modelDenyList: ['openai/gpt-4.1'],
      providerDenyList: [],
    });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    state = providersAndModelsAllowListsReducer(state, {
      type: 'TOGGLE_MODEL',
      modelId: 'anthropic/claude-3-opus',
      nextAllowed: false,
    });

    state = providersAndModelsAllowListsReducer(state, { type: 'RESET_TO_INITIAL' });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    expect(state.draftModelDenyList).toEqual(state.initialModelDenyList);
    expect(state.draftProviderDenyList).toEqual(state.initialProviderDenyList);
  });

  test('init -> toggle -> mark saved marks clean (draft becomes initial)', () => {
    let state: ProvidersAndModelsAllowListsState = createProvidersAndModelsAllowListsInitialState();

    state = providersAndModelsAllowListsReducer(state, {
      type: 'INIT_FROM_SERVER',
      modelDenyList: [],
      providerDenyList: [],
    });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    state = providersAndModelsAllowListsReducer(state, {
      type: 'TOGGLE_PROVIDER',
      providerSlug: 'openai',
      nextEnabled: false,
    });

    state = providersAndModelsAllowListsReducer(state, { type: 'MARK_SAVED' });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    expect(state.initialProviderDenyList).toEqual(state.draftProviderDenyList);
    expect(state.initialModelDenyList).toEqual(state.draftModelDenyList);
  });
});
