import { useMemo } from 'react';
import {
  createModelRefKeyMap,
  isRemoteModelRecommended,
  modelRefsEqual,
  sortRemoteModelCatalogProviders,
  type FetchedSessionData,
  type ModelRef,
  type ModelSelection,
  type RemoteModelOverride,
  type RemoteModelState,
  type ResolvedSession,
} from '@/lib/cloud-agent-sdk';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import {
  buildContextLengthByProviderAndModel,
  type ContextLengthByProviderAndModel,
} from '../model-context-lengths';
import { useOrganizationModels } from './useOrganizationModels';

type ActiveSessionType = ResolvedSession['type'];

type SessionModelSource =
  | 'cloud-agent-gateway'
  | 'remote-cli-catalog'
  | 'remote-legacy-gateway'
  | 'remote-unavailable';

type SessionModelOption = ModelOption & {
  displayId?: string;
  providerGroup?: { id: string; label: string };
  searchTerms?: string[];
  supportsReasoning?: boolean;
  showGatewayMetadata?: boolean;
  modelRef?: ModelRef;
  overrideSource?: RemoteModelOverride['source'];
  unavailable?: boolean;
};

type BuildSessionModelsInput = {
  activeSessionType: ActiveSessionType | null;
  remoteModelState: RemoteModelState;
  observedModel: ModelSelection | null;
  remoteModelOverride: RemoteModelOverride | null;
  gatewayModels: ModelOption[];
  gatewayModelsLoading: boolean;
  gatewayModelId?: string;
  gatewayVariant?: string | null;
  gatewayOrganizationId?: string;
};

type UseSessionModelsInput = Omit<
  BuildSessionModelsInput,
  'gatewayModels' | 'gatewayModelsLoading' | 'gatewayOrganizationId'
> & {
  fetchedSessionData: Pick<FetchedSessionData, 'organizationId'> | null;
  routeOrganizationId?: string;
  sessionIdFromParams: string | null;
};

type SessionModels = {
  source: SessionModelSource;
  modelOptions: SessionModelOption[];
  selectedValue?: string;
  selectedVariant?: string;
  availableVariants: string[];
  modelPickerDisabled: boolean;
  isLoadingModels: boolean;
  gatewayOrganizationId?: string;
};

type UseSessionModelsResult = SessionModels & {
  gatewayContextLengthByModelId: ReadonlyMap<string, number>;
  remoteContextLengthByProviderAndModel?: ContextLengthByProviderAndModel;
};

type GatewayOrganization = { organizationId?: string; resolved: boolean };

export function resolveGatewayOrganization(
  fetchedSessionData: Pick<FetchedSessionData, 'organizationId'> | null,
  routeOrganizationId: string | undefined,
  sessionIdFromParams: string | null
): GatewayOrganization {
  if (fetchedSessionData) {
    return { organizationId: fetchedSessionData.organizationId ?? undefined, resolved: true };
  }
  // An existing session's owning organization is only known once its data
  // loads. Until then the Gateway catalog must stay unfetched — falling back
  // to the personal catalog could expose models outside the organization's
  // model policy (e.g. through the legacy-CLI Gateway fallback).
  if (sessionIdFromParams) {
    return { resolved: false };
  }
  return { organizationId: routeOrganizationId, resolved: true };
}

export function useSessionModels(input: UseSessionModelsInput): UseSessionModelsResult {
  const {
    activeSessionType,
    remoteModelState,
    observedModel,
    remoteModelOverride,
    gatewayModelId,
    gatewayVariant,
    fetchedSessionData,
    routeOrganizationId,
    sessionIdFromParams,
  } = input;
  const gatewayOrganization = resolveGatewayOrganization(
    fetchedSessionData,
    routeOrganizationId,
    sessionIdFromParams
  );
  const usesGateway = activeSessionType !== 'remote' || remoteModelState.protocol === 'legacy';
  const gatewayModels = useOrganizationModels(
    gatewayOrganization.organizationId,
    usesGateway && gatewayOrganization.resolved
  );
  const models = useMemo(
    () =>
      buildSessionModels({
        activeSessionType,
        remoteModelState,
        observedModel,
        remoteModelOverride,
        gatewayModels: gatewayOrganization.resolved ? gatewayModels.modelOptions : [],
        gatewayModelsLoading: gatewayModels.isLoadingModels || !gatewayOrganization.resolved,
        gatewayModelId,
        gatewayVariant,
        gatewayOrganizationId: gatewayOrganization.organizationId,
      }),
    [
      activeSessionType,
      gatewayModelId,
      gatewayModels.isLoadingModels,
      gatewayModels.modelOptions,
      gatewayOrganization.organizationId,
      gatewayOrganization.resolved,
      gatewayVariant,
      observedModel,
      remoteModelOverride,
      remoteModelState,
    ]
  );
  const remoteContextLengthByProviderAndModel = useMemo(
    () =>
      models.source === 'remote-cli-catalog' && remoteModelState.catalog
        ? buildContextLengthByProviderAndModel(remoteModelState.catalog.providers)
        : undefined,
    [models.source, remoteModelState.catalog]
  );

  return {
    ...models,
    gatewayContextLengthByModelId: gatewayModels.contextLengthByModelId,
    remoteContextLengthByProviderAndModel,
  };
}

export function buildSessionModels(input: BuildSessionModelsInput): SessionModels {
  if (input.activeSessionType === 'remote') {
    if (input.remoteModelState.protocol === 'v1' && input.remoteModelState.catalog) {
      return buildCliCatalogModels(input);
    }
    if (input.remoteModelState.protocol === 'legacy') {
      return buildLegacyGatewayModels(input);
    }
    return buildUnavailableRemoteModels(input);
  }

  const selectedOption = input.gatewayModels.find(model => model.id === input.gatewayModelId);

  return {
    source: 'cloud-agent-gateway',
    modelOptions: input.gatewayModels,
    selectedValue: input.gatewayModelId,
    selectedVariant: input.gatewayVariant ?? undefined,
    availableVariants: selectedOption?.variants ?? [],
    modelPickerDisabled: false,
    isLoadingModels: input.gatewayModelsLoading,
    gatewayOrganizationId: input.gatewayOrganizationId,
  };
}

function buildUnavailableRemoteModels(input: BuildSessionModelsInput): SessionModels {
  const currentSelection = currentRemoteSelection(input);
  const unavailableOption = currentSelection
    ? createUnavailableOption(currentSelection.model)
    : ({
        id: 'remote-session-model-unavailable',
        name: 'Session model',
        showGatewayMetadata: false,
        unavailable: true,
      } satisfies SessionModelOption);
  const loading = input.remoteModelState.refresh === 'loading';

  return {
    source: 'remote-unavailable',
    modelOptions: [unavailableOption],
    selectedValue: unavailableOption.id,
    selectedVariant: currentSelection?.variant,
    availableVariants: [],
    modelPickerDisabled: true,
    isLoadingModels: loading,
    gatewayOrganizationId: input.gatewayOrganizationId,
  };
}

function buildLegacyGatewayModels(input: BuildSessionModelsInput): SessionModels {
  const modelOptions: SessionModelOption[] = input.gatewayModels.map(model => ({
    ...model,
    modelRef: { providerID: 'kilo', modelID: model.id },
    overrideSource: 'legacy-gateway' as const,
  }));
  const currentSelection = currentRemoteSelection(input);
  let selectedOption = currentSelection
    ? modelOptions.find(
        option => option.modelRef && modelRefsEqual(option.modelRef, currentSelection.model)
      )
    : undefined;

  if (currentSelection && !selectedOption) {
    const unavailableOption = createUnavailableOption(currentSelection.model);
    modelOptions.unshift(unavailableOption);
    selectedOption = unavailableOption;
  }

  const selectedVariant =
    currentSelection?.variant && selectedOption?.variants?.includes(currentSelection.variant)
      ? currentSelection.variant
      : undefined;

  return {
    source: 'remote-legacy-gateway',
    modelOptions,
    selectedValue: selectedOption?.id,
    selectedVariant,
    availableVariants: selectedOption?.variants ?? [],
    modelPickerDisabled: input.gatewayModelsLoading,
    isLoadingModels: input.gatewayModelsLoading,
    gatewayOrganizationId: input.gatewayOrganizationId,
  };
}

function buildCliCatalogModels(input: BuildSessionModelsInput): SessionModels {
  const catalog = input.remoteModelState.catalog;
  if (!catalog) throw new Error('CLI catalog is required for v1 model options');

  const keyMap = createModelRefKeyMap();
  const modelOptions: SessionModelOption[] = sortRemoteModelCatalogProviders(
    catalog.providers
  ).flatMap(provider =>
    provider.models.map(model => {
      const modelRef = { providerID: provider.id, modelID: model.id };
      return {
        id: keyMap.getOrCreateKey(modelRef),
        name: model.name ?? model.id,
        displayId: model.id,
        providerGroup:
          provider.id === 'kilo' && isRemoteModelRecommended(provider.id, model)
            ? { id: 'kilo-recommended', label: 'Recommended' }
            : { id: provider.id, label: provider.name ?? provider.id },
        searchTerms: [provider.id, provider.name, model.id, model.name].filter(
          (term): term is string => term !== undefined
        ),
        supportsVision: model.capabilities.attachment,
        supportsReasoning: model.capabilities.reasoning,
        isFree: model.isFree,
        mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
        hasUserByokAvailable: model.hasUserByokAvailable,
        showGatewayMetadata: false,
        variants: model.variants,
        modelRef,
        overrideSource: 'cli-catalog' as const,
      } satisfies SessionModelOption;
    })
  );
  const currentSelection = currentRemoteSelection(input);
  let selectedOption = currentSelection
    ? modelOptions.find(
        option => option.modelRef && modelRefsEqual(option.modelRef, currentSelection.model)
      )
    : undefined;

  if (currentSelection && !selectedOption) {
    const unavailableOption = createUnavailableOption(currentSelection.model);
    modelOptions.unshift(unavailableOption);
    selectedOption = unavailableOption;
  }

  const selectedVariant =
    currentSelection?.variant && selectedOption?.variants?.includes(currentSelection.variant)
      ? currentSelection.variant
      : undefined;

  return {
    source: 'remote-cli-catalog',
    modelOptions,
    selectedValue: selectedOption?.id,
    selectedVariant,
    availableVariants: selectedOption?.variants ?? [],
    modelPickerDisabled: false,
    isLoadingModels: false,
    gatewayOrganizationId: input.gatewayOrganizationId,
  };
}

function currentRemoteSelection(input: BuildSessionModelsInput): ModelSelection | null {
  const defaultModel = input.remoteModelState.catalog?.defaultModel;
  return (
    input.remoteModelOverride?.selection ??
    input.observedModel ??
    (defaultModel ? { model: defaultModel } : null)
  );
}

function createUnavailableOption(modelRef: ModelRef): SessionModelOption {
  const keyMap = createModelRefKeyMap();
  return {
    id: `unavailable-${keyMap.getOrCreateKey(modelRef)}`,
    name: modelRef.modelID,
    displayId: modelRef.modelID,
    providerGroup: { id: modelRef.providerID, label: modelRef.providerID },
    searchTerms: [modelRef.providerID, modelRef.modelID],
    showGatewayMetadata: false,
    modelRef,
    unavailable: true,
  };
}

export function validateRemoteModelOverride(
  override: RemoteModelOverride | null,
  modelOptions: readonly SessionModelOption[],
  source: RemoteModelOverride['source']
): RemoteModelOverride | null {
  if (!override || override.source !== source) return override;

  const selectedOption = modelOptions.find(
    option =>
      !option.unavailable &&
      option.overrideSource === source &&
      option.modelRef !== undefined &&
      modelRefsEqual(option.modelRef, override.selection.model)
  );

  if (!selectedOption) return null;

  const variant = override.selection.variant;
  if (!variant || selectedOption.variants?.includes(variant)) return override;

  return {
    source: override.source,
    selection: { model: override.selection.model },
  };
}

export function createRemoteModelOverride(
  option: SessionModelOption | undefined,
  variant?: string
): RemoteModelOverride | null {
  if (!option?.modelRef || !option.overrideSource || option.unavailable) return null;
  const validVariant = variant && option.variants?.includes(variant) ? variant : undefined;
  return {
    source: option.overrideSource,
    selection: {
      model: option.modelRef,
      ...(validVariant ? { variant: validVariant } : {}),
    },
  };
}

export type {
  BuildSessionModelsInput,
  SessionModelOption,
  SessionModels,
  UseSessionModelsInput,
  UseSessionModelsResult,
};
