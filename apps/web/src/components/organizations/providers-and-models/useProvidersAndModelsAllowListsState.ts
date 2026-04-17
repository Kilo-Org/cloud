import { useCallback, useMemo, useReducer } from 'react';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import {
  buildModelProvidersIndex,
  canonicalizeDenyList,
  computeAllowedModelIds,
  computeAllProviderSlugsWithEndpoints,
  computeEnabledProviderSlugs,
  sortUniqueStrings,
  stringListsEqual,
  toggleModelAllowed,
  toggleProviderEnabled,
  type OpenRouterModelSlugSnapshot,
  type OpenRouterProviderModelsSnapshot,
} from '@/components/organizations/providers-and-models/allowLists.domain';

export type ProviderPolicyFilter = 'all' | 'yes' | 'no';

export type ProvidersAndModelsAllowListsReadyState = {
  status: 'ready';
  draftModelDenyList: string[];
  draftProviderDenyList: string[];
  initialModelDenyList: string[];
  initialProviderDenyList: string[];
  modelSearch: string;
  modelSelectedOnly: boolean;
  infoModelId: string | null;
  providerSearch: string;
  enabledProvidersOnly: boolean;
  providerTrainsFilter: ProviderPolicyFilter;
  providerRetainsPromptsFilter: ProviderPolicyFilter;
  providerLocationsFilter: string[];
  infoProviderSlug: string | null;
};

export type ProvidersAndModelsAllowListsState =
  | {
      status: 'loading';
      modelSearch: string;
      modelSelectedOnly: boolean;
      infoModelId: string | null;
      providerSearch: string;
      enabledProvidersOnly: boolean;
      providerTrainsFilter: ProviderPolicyFilter;
      providerRetainsPromptsFilter: ProviderPolicyFilter;
      providerLocationsFilter: string[];
      infoProviderSlug: string | null;
    }
  | ProvidersAndModelsAllowListsReadyState;

export type ProvidersAndModelsAllowListsAction =
  | {
      type: 'INIT_FROM_SERVER';
      modelDenyList: ReadonlyArray<string>;
      providerDenyList: ReadonlyArray<string>;
    }
  | {
      type: 'TOGGLE_PROVIDER';
      providerSlug: string;
      nextEnabled: boolean;
    }
  | {
      type: 'TOGGLE_MODEL';
      modelId: string;
      nextAllowed: boolean;
    }
  | {
      type: 'RESET_TO_INITIAL';
    }
  | {
      type: 'MARK_SAVED';
    }
  | {
      type: 'SET_MODEL_SEARCH';
      value: string;
    }
  | {
      type: 'SET_MODEL_SELECTED_ONLY';
      value: boolean;
    }
  | {
      type: 'SET_INFO_MODEL_ID';
      value: string | null;
    }
  | {
      type: 'SET_PROVIDER_SEARCH';
      value: string;
    }
  | {
      type: 'SET_ENABLED_PROVIDERS_ONLY';
      value: boolean;
    }
  | {
      type: 'SET_PROVIDER_TRAINS_FILTER';
      value: ProviderPolicyFilter;
    }
  | {
      type: 'SET_PROVIDER_RETAINS_PROMPTS_FILTER';
      value: ProviderPolicyFilter;
    }
  | {
      type: 'SET_PROVIDER_LOCATIONS_FILTER';
      value: string[];
    }
  | {
      type: 'SET_INFO_PROVIDER_SLUG';
      value: string | null;
    };

export function createProvidersAndModelsAllowListsInitialState(): ProvidersAndModelsAllowListsState {
  return {
    status: 'loading',
    modelSearch: '',
    modelSelectedOnly: false,
    infoModelId: null,
    providerSearch: '',
    enabledProvidersOnly: false,
    providerTrainsFilter: 'all',
    providerRetainsPromptsFilter: 'all',
    providerLocationsFilter: [],
    infoProviderSlug: null,
  };
}

export function providersAndModelsAllowListsReducer(
  state: ProvidersAndModelsAllowListsState,
  action: ProvidersAndModelsAllowListsAction
): ProvidersAndModelsAllowListsState {
  switch (action.type) {
    case 'INIT_FROM_SERVER': {
      const nextModelDenyList = canonicalizeDenyList(action.modelDenyList);
      const nextProviderDenyList = canonicalizeDenyList(action.providerDenyList);
      return {
        status: 'ready',
        draftModelDenyList: nextModelDenyList,
        draftProviderDenyList: nextProviderDenyList,
        initialModelDenyList: nextModelDenyList,
        initialProviderDenyList: nextProviderDenyList,
        modelSearch: state.modelSearch,
        modelSelectedOnly: state.modelSelectedOnly,
        infoModelId: state.infoModelId,
        providerSearch: state.providerSearch,
        enabledProvidersOnly: state.enabledProvidersOnly,
        providerTrainsFilter: state.providerTrainsFilter,
        providerRetainsPromptsFilter: state.providerRetainsPromptsFilter,
        providerLocationsFilter: state.providerLocationsFilter,
        infoProviderSlug: state.infoProviderSlug,
      };
    }

    case 'TOGGLE_PROVIDER': {
      if (state.status !== 'ready') return state;
      const nextProviderDenyList = toggleProviderEnabled({
        providerSlug: action.providerSlug,
        nextEnabled: action.nextEnabled,
        draftProviderDenyList: state.draftProviderDenyList,
      });
      return {
        ...state,
        draftProviderDenyList: nextProviderDenyList,
      };
    }

    case 'TOGGLE_MODEL': {
      if (state.status !== 'ready') return state;
      const nextModelDenyList = toggleModelAllowed({
        modelId: action.modelId,
        nextAllowed: action.nextAllowed,
        draftModelDenyList: state.draftModelDenyList,
      });
      return {
        ...state,
        draftModelDenyList: nextModelDenyList,
      };
    }

    case 'RESET_TO_INITIAL': {
      if (state.status !== 'ready') return state;
      return {
        ...state,
        draftModelDenyList: state.initialModelDenyList,
        draftProviderDenyList: state.initialProviderDenyList,
      };
    }

    case 'MARK_SAVED': {
      if (state.status !== 'ready') return state;
      return {
        ...state,
        initialModelDenyList: state.draftModelDenyList,
        initialProviderDenyList: state.draftProviderDenyList,
      };
    }

    case 'SET_MODEL_SEARCH':
      return { ...state, modelSearch: action.value };
    case 'SET_MODEL_SELECTED_ONLY':
      return { ...state, modelSelectedOnly: action.value };
    case 'SET_INFO_MODEL_ID':
      return { ...state, infoModelId: action.value };
    case 'SET_PROVIDER_SEARCH':
      return { ...state, providerSearch: action.value };
    case 'SET_ENABLED_PROVIDERS_ONLY':
      return { ...state, enabledProvidersOnly: action.value };
    case 'SET_PROVIDER_TRAINS_FILTER':
      return { ...state, providerTrainsFilter: action.value };
    case 'SET_PROVIDER_RETAINS_PROMPTS_FILTER':
      return { ...state, providerRetainsPromptsFilter: action.value };
    case 'SET_PROVIDER_LOCATIONS_FILTER':
      return { ...state, providerLocationsFilter: action.value };
    case 'SET_INFO_PROVIDER_SLUG':
      return { ...state, infoProviderSlug: action.value };
  }
}

export type ProvidersAndModelsAllowListsSelectors = {
  allProviderSlugsWithEndpoints: string[];
  enabledProviderSlugs: Set<string>;
  allowedModelIds: Set<string>;
  allModelIds: string[];
  modelProvidersIndex: Map<string, Set<string>>;
  hasUnsavedChanges: boolean;
};

export function useProvidersAndModelsAllowListsState(params: {
  openRouterModels: ReadonlyArray<OpenRouterModelSlugSnapshot>;
  openRouterProviders: OpenRouterProviderModelsSnapshot;
}): {
  state: ProvidersAndModelsAllowListsState;
  dispatch: (action: ProvidersAndModelsAllowListsAction) => void;
  selectors: ProvidersAndModelsAllowListsSelectors;
  actions: {
    initFromServer: (params: {
      modelDenyList: ReadonlyArray<string>;
      providerDenyList: ReadonlyArray<string>;
    }) => void;
    toggleProvider: (params: { providerSlug: string; nextEnabled: boolean }) => void;
    toggleModel: (params: { modelId: string; nextAllowed: boolean }) => void;
    resetToInitial: () => void;
    markSaved: () => void;
    setModelSearch: (value: string) => void;
    setModelSelectedOnly: (value: boolean) => void;
    setInfoModelId: (value: string | null) => void;
    setProviderSearch: (value: string) => void;
    setEnabledProvidersOnly: (value: boolean) => void;
    setProviderTrainsFilter: (value: ProviderPolicyFilter) => void;
    setProviderRetainsPromptsFilter: (value: ProviderPolicyFilter) => void;
    setProviderLocationsFilter: (value: string[]) => void;
    setInfoProviderSlug: (value: string | null) => void;
  };
} {
  const { openRouterModels, openRouterProviders } = params;

  const [state, dispatch] = useReducer(
    providersAndModelsAllowListsReducer,
    undefined,
    createProvidersAndModelsAllowListsInitialState
  );

  const draftProviderDenyList = state.status === 'ready' ? state.draftProviderDenyList : null;
  const draftModelDenyList = state.status === 'ready' ? state.draftModelDenyList : null;
  const initialProviderDenyList = state.status === 'ready' ? state.initialProviderDenyList : null;
  const initialModelDenyList = state.status === 'ready' ? state.initialModelDenyList : null;

  const allProviderSlugsWithEndpoints = useMemo(() => {
    return computeAllProviderSlugsWithEndpoints(openRouterProviders);
  }, [openRouterProviders]);

  const allModelIds = useMemo(() => {
    return sortUniqueStrings(openRouterModels.map(m => normalizeModelId(m.slug)));
  }, [openRouterModels]);

  const modelProvidersIndex = useMemo(() => {
    return buildModelProvidersIndex(openRouterProviders);
  }, [openRouterProviders]);

  const enabledProviderSlugs = useMemo(() => {
    if (!draftProviderDenyList) return new Set<string>();
    return computeEnabledProviderSlugs(draftProviderDenyList, allProviderSlugsWithEndpoints);
  }, [allProviderSlugsWithEndpoints, draftProviderDenyList]);

  const allowedModelIds = useMemo(() => {
    if (!draftModelDenyList) return new Set<string>();
    return computeAllowedModelIds(draftModelDenyList, openRouterModels);
  }, [draftModelDenyList, openRouterModels]);

  const hasUnsavedChanges = useMemo(() => {
    if (
      !draftModelDenyList ||
      !draftProviderDenyList ||
      !initialModelDenyList ||
      !initialProviderDenyList
    ) {
      return false;
    }
    return (
      !stringListsEqual(draftModelDenyList, initialModelDenyList) ||
      !stringListsEqual(draftProviderDenyList, initialProviderDenyList)
    );
  }, [draftModelDenyList, draftProviderDenyList, initialModelDenyList, initialProviderDenyList]);

  const initFromServer = useCallback(
    (init: { modelDenyList: ReadonlyArray<string>; providerDenyList: ReadonlyArray<string> }) => {
      dispatch({
        type: 'INIT_FROM_SERVER',
        modelDenyList: init.modelDenyList,
        providerDenyList: init.providerDenyList,
      });
    },
    []
  );

  const toggleProvider = useCallback((input: { providerSlug: string; nextEnabled: boolean }) => {
    dispatch({
      type: 'TOGGLE_PROVIDER',
      providerSlug: input.providerSlug,
      nextEnabled: input.nextEnabled,
    });
  }, []);

  const toggleModel = useCallback((input: { modelId: string; nextAllowed: boolean }) => {
    dispatch({
      type: 'TOGGLE_MODEL',
      modelId: input.modelId,
      nextAllowed: input.nextAllowed,
    });
  }, []);

  const selectors: ProvidersAndModelsAllowListsSelectors = useMemo(
    () => ({
      allProviderSlugsWithEndpoints,
      enabledProviderSlugs,
      allowedModelIds,
      allModelIds,
      modelProvidersIndex,
      hasUnsavedChanges,
    }),
    [
      allModelIds,
      allProviderSlugsWithEndpoints,
      allowedModelIds,
      enabledProviderSlugs,
      hasUnsavedChanges,
      modelProvidersIndex,
    ]
  );

  const actions = useMemo(
    () => ({
      initFromServer,
      toggleProvider,
      toggleModel,
      resetToInitial: () => dispatch({ type: 'RESET_TO_INITIAL' }),
      markSaved: () => dispatch({ type: 'MARK_SAVED' }),
      setModelSearch: (value: string) => dispatch({ type: 'SET_MODEL_SEARCH', value }),
      setModelSelectedOnly: (value: boolean) =>
        dispatch({ type: 'SET_MODEL_SELECTED_ONLY', value }),
      setInfoModelId: (value: string | null) => dispatch({ type: 'SET_INFO_MODEL_ID', value }),
      setProviderSearch: (value: string) => dispatch({ type: 'SET_PROVIDER_SEARCH', value }),
      setEnabledProvidersOnly: (value: boolean) =>
        dispatch({ type: 'SET_ENABLED_PROVIDERS_ONLY', value }),
      setProviderTrainsFilter: (value: ProviderPolicyFilter) =>
        dispatch({ type: 'SET_PROVIDER_TRAINS_FILTER', value }),
      setProviderRetainsPromptsFilter: (value: ProviderPolicyFilter) =>
        dispatch({ type: 'SET_PROVIDER_RETAINS_PROMPTS_FILTER', value }),
      setProviderLocationsFilter: (value: string[]) =>
        dispatch({ type: 'SET_PROVIDER_LOCATIONS_FILTER', value }),
      setInfoProviderSlug: (value: string | null) =>
        dispatch({ type: 'SET_INFO_PROVIDER_SLUG', value }),
    }),
    [initFromServer, toggleModel, toggleProvider]
  );

  return {
    state,
    dispatch,
    selectors,
    actions,
  };
}
