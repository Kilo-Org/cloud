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

  test('bulk selection stores the canonical form of a mixed-case provider slug', () => {
    let state = providersAndModelsAllowListsReducer(
      createProvidersAndModelsAllowListsInitialState(),
      {
        type: 'INIT_FROM_SERVER',
        modelDenyList: [],
        providerAllowList: ['openai'],
      }
    );
    state = providersAndModelsAllowListsReducer(state, {
      type: 'SET_PROVIDERS_ENABLED',
      providerSlugs: ['OpenAI'],
      nextEnabled: true,
    });
    if (state.status !== 'ready') throw new Error('expected ready state');
    expect(state.draftProviderAllowList).toEqual(['openai']);

    state = providersAndModelsAllowListsReducer(state, {
      type: 'SET_PROVIDERS_ENABLED',
      providerSlugs: ['OpenAI'],
      nextEnabled: false,
    });
    if (state.status !== 'ready') throw new Error('expected ready state');
    expect(state.draftProviderAllowList).toEqual([]);
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

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }
    const draftProviderAllowList = state.draftProviderAllowList;
    state = providersAndModelsAllowListsReducer(state, {
      type: 'MARK_SAVED',
      modelDenyList: [],
      submitted: { modelDenyList: [], providerAllowList: draftProviderAllowList },
    });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    expect(state.initialProviderAllowList).toEqual(state.draftProviderAllowList);
    expect(state.initialModelDenyList).toEqual(state.draftModelDenyList);
  });

  test('mark saved rebases draft and initial deny list onto the server list', () => {
    let state: ProvidersAndModelsAllowListsState = createProvidersAndModelsAllowListsInitialState();

    state = providersAndModelsAllowListsReducer(state, {
      type: 'INIT_FROM_SERVER',
      modelDenyList: ['anthropic/claude-3-opus'],
      providerAllowList: ['openai'],
    });
    state = providersAndModelsAllowListsReducer(state, {
      type: 'MARK_SAVED',
      modelDenyList: ['anthropic/claude-3-opus', 'openai/new-model'],
      submitted: { modelDenyList: ['anthropic/claude-3-opus'], providerAllowList: ['openai'] },
    });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    expect(state.initialModelDenyList).toEqual(['anthropic/claude-3-opus', 'openai/new-model']);
    expect(state.draftModelDenyList).toEqual(state.initialModelDenyList);
  });

  test('mark saved keeps model and provider edits made after the save was submitted', () => {
    let state: ProvidersAndModelsAllowListsState = createProvidersAndModelsAllowListsInitialState();

    state = providersAndModelsAllowListsReducer(state, {
      type: 'INIT_FROM_SERVER',
      modelDenyList: ['openai/removed-later'],
      providerAllowList: ['openai', 'anthropic'],
    });
    state = providersAndModelsAllowListsReducer(state, {
      type: 'TOGGLE_MODEL',
      modelId: 'openai/a',
      nextAllowed: false,
    });
    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }
    const submitted = {
      modelDenyList: state.draftModelDenyList,
      providerAllowList: state.draftProviderAllowList,
    };
    // Edits while the request is in flight.
    state = providersAndModelsAllowListsReducer(state, {
      type: 'TOGGLE_MODEL',
      modelId: 'openai/b',
      nextAllowed: false,
    });
    state = providersAndModelsAllowListsReducer(state, {
      type: 'TOGGLE_MODEL',
      modelId: 'openai/removed-later',
      nextAllowed: true,
    });
    state = providersAndModelsAllowListsReducer(state, {
      type: 'TOGGLE_PROVIDER',
      providerSlug: 'anthropic',
      nextEnabled: false,
    });
    state = providersAndModelsAllowListsReducer(state, {
      type: 'MARK_SAVED',
      // The server also merged in an automatic deny.
      modelDenyList: ['openai/a', 'openai/auto', 'openai/removed-later'],
      submitted,
    });

    if (state.status !== 'ready') {
      throw new Error('expected ready state');
    }

    expect(state.initialModelDenyList).toEqual(['openai/a', 'openai/auto', 'openai/removed-later']);
    expect(state.draftModelDenyList).toEqual(['openai/a', 'openai/auto', 'openai/b']);
    expect(state.initialProviderAllowList).toEqual(['anthropic', 'openai']);
    expect(state.draftProviderAllowList).toEqual(['openai']);
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
