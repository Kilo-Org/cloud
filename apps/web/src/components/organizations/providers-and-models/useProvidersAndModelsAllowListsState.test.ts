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

  test('bulk model action updates the draft in one dispatch and reset restores it', () => {
    let state: ProvidersAndModelsAllowListsState = createProvidersAndModelsAllowListsInitialState();

    state = providersAndModelsAllowListsReducer(state, {
      type: 'INIT_FROM_SERVER',
      modelDenyList: ['anthropic/claude-3-opus'],
      providerAllowList: ['openai'],
    });

    state = providersAndModelsAllowListsReducer(state, {
      type: 'SET_MODELS_ALLOWED',
      modelIds: ['openai/gpt-4.1', 'openai/gpt-4o'],
      nextAllowed: false,
    });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    expect(state.draftModelDenyList).toEqual([
      'anthropic/claude-3-opus',
      'openai/gpt-4.1',
      'openai/gpt-4o',
    ]);
    expect(state.initialModelDenyList).toEqual(['anthropic/claude-3-opus']);

    state = providersAndModelsAllowListsReducer(state, {
      type: 'SET_MODELS_ALLOWED',
      modelIds: ['openai/gpt-4.1', 'openai/gpt-4o', 'anthropic/claude-3-opus'],
      nextAllowed: true,
    });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    expect(state.draftModelDenyList).toEqual([]);

    state = providersAndModelsAllowListsReducer(state, { type: 'RESET_TO_INITIAL' });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    expect(state.draftModelDenyList).toEqual(['anthropic/claude-3-opus']);
  });

  test('bulk model action is a no-op while loading', () => {
    const state = createProvidersAndModelsAllowListsInitialState();

    const next = providersAndModelsAllowListsReducer(state, {
      type: 'SET_MODELS_ALLOWED',
      modelIds: ['openai/gpt-4.1'],
      nextAllowed: false,
    });

    expect(next).toBe(state);
  });
});
