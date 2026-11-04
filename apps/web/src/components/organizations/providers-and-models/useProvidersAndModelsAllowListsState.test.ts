import { describe, expect, test } from '@jest/globals';
import {
  createProvidersAndModelsAllowListsInitialState,
  providersAndModelsAllowListsReducer,
  type ProvidersAndModelsAllowListsState,
} from '@/components/organizations/providers-and-models/useProvidersAndModelsAllowListsState';

describe('providersAndModelsAllowListsReducer', () => {
  test('bulk selection preserves entries outside the requested models and providers', () => {
    let state = providersAndModelsAllowListsReducer(
      createProvidersAndModelsAllowListsInitialState(),
      {
        type: 'INIT_FROM_SERVER',
        modelDenyList: ['vendor/a', 'vendor/hidden'],
        providerAllowList: ['hidden', 'one'],
      }
    );
    state = providersAndModelsAllowListsReducer(state, {
      type: 'SET_MODELS_ALLOWED',
      modelIds: ['vendor/a', 'vendor/b'],
      nextAllowed: true,
    });
    state = providersAndModelsAllowListsReducer(state, {
      type: 'SET_PROVIDERS_ENABLED',
      providerSlugs: ['one', 'two'],
      nextEnabled: true,
    });
    if (state.status !== 'ready') throw new Error('expected ready state');
    expect(state.draftModelDenyList).toEqual(['vendor/hidden']);
    expect(state.draftProviderAllowList).toEqual(['hidden', 'one', 'two']);

    state = providersAndModelsAllowListsReducer(state, {
      type: 'SET_MODELS_ALLOWED',
      modelIds: ['vendor/a', 'vendor/b'],
      nextAllowed: false,
    });
    state = providersAndModelsAllowListsReducer(state, {
      type: 'SET_PROVIDERS_ENABLED',
      providerSlugs: ['one', 'two'],
      nextEnabled: false,
    });
    if (state.status !== 'ready') throw new Error('expected ready state');
    expect(state.draftModelDenyList).toEqual(['vendor/a', 'vendor/b', 'vendor/hidden']);
    expect(state.draftProviderAllowList).toEqual(['hidden']);
    state = providersAndModelsAllowListsReducer(state, { type: 'RESET_TO_INITIAL' });
    if (state.status !== 'ready') throw new Error('expected ready state');
    expect(state.draftModelDenyList).toEqual(['vendor/a', 'vendor/hidden']);
    expect(state.draftProviderAllowList).toEqual(['hidden', 'one']);
  });

  test('init -> toggle -> reset returns to initial', () => {
    let state: ProvidersAndModelsAllowListsState = createProvidersAndModelsAllowListsInitialState();

    state = providersAndModelsAllowListsReducer(state, {
      type: 'INIT_FROM_SERVER',
      modelDenyList: ['anthropic/claude-3-opus'],
      providerAllowList: ['openai'],
    });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    state = providersAndModelsAllowListsReducer(state, {
      type: 'TOGGLE_MODEL',
      modelId: 'anthropic/claude-3-opus',
      nextAllowed: true,
    });

    state = providersAndModelsAllowListsReducer(state, { type: 'RESET_TO_INITIAL' });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    expect(state.draftModelDenyList).toEqual(state.initialModelDenyList);
    expect(state.draftProviderAllowList).toEqual(state.initialProviderAllowList);
  });

  test('init -> toggle -> mark saved marks clean (draft becomes initial)', () => {
    let state: ProvidersAndModelsAllowListsState = createProvidersAndModelsAllowListsInitialState();

    state = providersAndModelsAllowListsReducer(state, {
      type: 'INIT_FROM_SERVER',
      modelDenyList: [],
      providerAllowList: ['openai'],
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

    expect(state.initialProviderAllowList).toEqual(state.draftProviderAllowList);
    expect(state.initialModelDenyList).toEqual(state.draftModelDenyList);
  });
});
