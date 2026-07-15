/* eslint-disable max-lines -- Model source transitions stay beside their option projections. */
import { useMemo } from 'react';
import {
  type ModelRef,
  type ModelSelection,
  type RemoteModelOverride,
  type RemoteModelState,
  type ResolvedSession,
} from 'cloud-agent-sdk';
import { sortRemoteModelCatalogProviders } from 'cloud-agent-sdk/remote-model-order';

import { type ModelOption } from '@/lib/hooks/use-available-models';

type SessionModelSource =
  | 'cloud-agent-gateway'
  | 'remote-cli-catalog'
  | 'remote-legacy-gateway'
  | 'remote-unavailable';

export type SessionModelOption = {
  id: string;
  name: string;
  displayId: string;
  variants: string[];
  isPreferred: boolean;
  isFree?: boolean;
  mayTrainOnYourPrompts?: boolean;
  hasUserByokAvailable?: boolean;
  contextWindow?: number;
  provider?: { id: string; name: string };
  modelRef?: ModelRef;
  overrideSource?: RemoteModelOverride['source'];
  showGatewayMetadata: boolean;
  unavailable?: boolean;
};

type BuildSessionModelOptionsInput = {
  activeSessionType: ResolvedSession['type'] | null;
  remoteModelState: RemoteModelState;
  observedModel: ModelSelection | null;
  remoteModelOverride: RemoteModelOverride | null;
  gatewayModels: ModelOption[];
  gatewayModelsLoading: boolean;
  organizationId?: string;
};

type SessionModelOptions = {
  source: SessionModelSource;
  options: SessionModelOption[];
  selectedValue: string;
  selectedVariant: string;
  pickerDisabled: boolean;
  isLoading: boolean;
};

export function useSessionModelOptions({
  activeSessionType,
  gatewayModels,
  gatewayModelsLoading,
  observedModel,
  organizationId,
  remoteModelOverride,
  remoteModelState,
}: BuildSessionModelOptionsInput): SessionModelOptions {
  return useMemo(
    () =>
      buildSessionModelOptions({
        activeSessionType,
        gatewayModels,
        gatewayModelsLoading,
        observedModel,
        organizationId,
        remoteModelOverride,
        remoteModelState,
      }),
    [
      activeSessionType,
      gatewayModels,
      gatewayModelsLoading,
      observedModel,
      organizationId,
      remoteModelOverride,
      remoteModelState,
    ]
  );
}

export function buildSessionModelOptions(
  input: BuildSessionModelOptionsInput
): SessionModelOptions {
  if (input.activeSessionType === 'remote') {
    if (input.remoteModelState.protocol === 'v1' && input.remoteModelState.catalog) {
      return buildCliCatalogOptions(input);
    }
    if (input.remoteModelState.protocol === 'legacy') {
      return buildLegacyGatewayOptions(input);
    }
    return buildUnavailableRemoteOptions(input);
  }

  return {
    source: 'cloud-agent-gateway',
    options: input.gatewayModels.map(createGatewayOption),
    selectedValue: '',
    selectedVariant: '',
    pickerDisabled: false,
    isLoading: input.gatewayModelsLoading,
  };
}

function buildUnavailableRemoteOptions(input: BuildSessionModelOptionsInput): SessionModelOptions {
  const currentSelection = getCurrentRemoteSelection(input);
  const option = currentSelection
    ? createUnavailableOption(currentSelection.model)
    : ({
        id: 'remote-session-model',
        name: 'Session model',
        displayId: '',
        variants: [],
        isPreferred: false,
        showGatewayMetadata: false,
        unavailable: true,
      } satisfies SessionModelOption);
  const loading = input.remoteModelState.refresh === 'loading';

  return {
    source: 'remote-unavailable',
    options: [option],
    selectedValue: option.id,
    selectedVariant: currentSelection?.variant ?? '',
    pickerDisabled: true,
    isLoading: loading,
  };
}

export function revalidateLegacyGatewayOverride(
  override: RemoteModelOverride | null,
  gatewayModels: ModelOption[]
): RemoteModelOverride | null {
  if (override?.source !== 'legacy-gateway') {
    return override;
  }

  const selectedModel = gatewayModels.find(model => model.id === override.selection.model.modelID);
  if (!selectedModel) {
    return null;
  }
  if (!override.selection.variant || selectedModel.variants.includes(override.selection.variant)) {
    return override;
  }

  return {
    source: 'legacy-gateway',
    selection: { model: override.selection.model },
  };
}

function buildLegacyGatewayOptions(input: BuildSessionModelOptionsInput): SessionModelOptions {
  const options: SessionModelOption[] = input.gatewayModels.map(model => ({
    ...createGatewayOption(model),
    modelRef: { providerID: 'kilo', modelID: model.id },
    overrideSource: 'legacy-gateway' as const,
  }));
  const remoteModelOverride = revalidateLegacyGatewayOverride(
    input.remoteModelOverride,
    input.gatewayModels
  );
  const currentSelection = getCurrentRemoteSelection(input, remoteModelOverride);
  let selectedOption = currentSelection
    ? options.find(
        option => option.modelRef && modelRefsEqual(option.modelRef, currentSelection.model)
      )
    : undefined;

  if (currentSelection && !selectedOption) {
    selectedOption = createUnavailableOption(currentSelection.model);
    options.unshift(selectedOption);
  }

  const selectedVariant =
    currentSelection?.variant && selectedOption?.variants.includes(currentSelection.variant)
      ? currentSelection.variant
      : '';

  return {
    source: 'remote-legacy-gateway',
    options,
    selectedValue: selectedOption?.id ?? '',
    selectedVariant,
    pickerDisabled: input.gatewayModelsLoading,
    isLoading: input.gatewayModelsLoading,
  };
}

function buildCliCatalogOptions(input: BuildSessionModelOptionsInput): SessionModelOptions {
  const catalog = input.remoteModelState.catalog;
  if (!catalog) {
    throw new Error('CLI catalog is required for v1 model options');
  }

  let opaqueIndex = 0;
  const options = sortRemoteModelCatalogProviders(catalog.providers).flatMap(provider =>
    provider.models.map(model => {
      const option: SessionModelOption = {
        id: `remote-model-${opaqueIndex}`,
        name: model.name ?? model.id,
        displayId: model.id,
        variants: model.variants,
        isPreferred: false,
        isFree: model.isFree,
        mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
        hasUserByokAvailable: model.hasUserByokAvailable,
        contextWindow: model.limits.context,
        provider: { id: provider.id, name: provider.name ?? provider.id },
        modelRef: { providerID: provider.id, modelID: model.id },
        overrideSource: 'cli-catalog',
        showGatewayMetadata: false,
      };
      opaqueIndex += 1;
      return option;
    })
  );
  const currentSelection = getCurrentRemoteSelection(input);
  let selectedOption = currentSelection
    ? options.find(
        option => option.modelRef && modelRefsEqual(option.modelRef, currentSelection.model)
      )
    : undefined;

  if (currentSelection && !selectedOption) {
    selectedOption = createUnavailableOption(currentSelection.model);
    options.unshift(selectedOption);
  }

  const selectedVariant =
    currentSelection?.variant && selectedOption?.variants.includes(currentSelection.variant)
      ? currentSelection.variant
      : '';

  return {
    source: 'remote-cli-catalog',
    options,
    selectedValue: selectedOption?.id ?? '',
    selectedVariant,
    pickerDisabled: false,
    isLoading: false,
  };
}

function createUnavailableOption(modelRef: ModelRef): SessionModelOption {
  return {
    id: 'remote-unavailable-model',
    name: modelRef.modelID,
    displayId: modelRef.modelID,
    variants: [],
    isPreferred: false,
    provider: { id: modelRef.providerID, name: modelRef.providerID },
    modelRef,
    showGatewayMetadata: false,
    unavailable: true,
  };
}

function createGatewayOption(model: ModelOption): SessionModelOption {
  // Strip the raw `context_length` so it doesn't leak onto SessionModelOption;
  // the projection below owns the camelCase `contextWindow` field.
  const { context_length: _contextLength, ...rest } = model;
  return {
    ...rest,
    displayId: model.id,
    contextWindow: model.context_length ?? undefined,
    showGatewayMetadata: true,
  };
}

function getCurrentRemoteSelection(
  input: BuildSessionModelOptionsInput,
  remoteModelOverride = input.remoteModelOverride
): ModelSelection | null {
  const defaultModel = input.remoteModelState.catalog?.defaultModel;
  return (
    remoteModelOverride?.selection ??
    input.observedModel ??
    (defaultModel ? { model: defaultModel } : null)
  );
}

// Mirrors the SDK's modelRefsEqual. Kept local because mobile imports only
// types from cloud-agent-sdk (vitest does not resolve the SDK value barrel).
function modelRefsEqual(left: ModelRef, right: ModelRef): boolean {
  return left.providerID === right.providerID && left.modelID === right.modelID;
}

export function createRemoteModelOverride(
  option: SessionModelOption | undefined,
  variant: string
): RemoteModelOverride | null {
  if (!option?.modelRef || !option.overrideSource || option.unavailable) {
    return null;
  }

  const validVariant = option.variants.includes(variant) ? variant : undefined;
  return {
    source: option.overrideSource,
    selection: {
      model: option.modelRef,
      ...(validVariant ? { variant: validVariant } : {}),
    },
  };
}
