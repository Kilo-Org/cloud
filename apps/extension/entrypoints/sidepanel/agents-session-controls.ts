import type {
  ActiveSessionType,
  ContextUsage,
  ModelRef,
  ModelSelection,
  RemoteModelCatalogV1,
  RemoteModelOverride,
  RemoteModelState,
} from '@kilocode/cloud-agent-sdk';
import { CLI_CATALOG_ID_PREFIX } from '@/src/shared/model-picker-rows';
import type { KiloGatewayModelOption } from '@/src/shared/kilo-api-client';

/** Provider id the gateway reports for its own catalog. Remote CLIs report their own. */
const GATEWAY_PROVIDER_ID = 'kilo';

const isPositive = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;

/**
 * Context window of the model that produced the latest assistant message.
 * Only the gateway catalog is available here, so a remote CLI provider stays
 * unknown. A conflicting duplicate id is unknown too — never guess a window.
 */
export const resolveSessionContextWindow = (
  contextUsage: ContextUsage | undefined,
  modelOptions: readonly KiloGatewayModelOption[]
): number | undefined => {
  if (contextUsage === undefined || contextUsage.providerID !== GATEWAY_PROVIDER_ID) {
    return undefined;
  }

  const windows = new Set<number>();
  for (const option of modelOptions) {
    if (option.id === contextUsage.modelID && isPositive(option.contextLength)) {
      windows.add(option.contextLength);
    }
  }

  return windows.size === 1 ? [...windows].at(0) : undefined;
};

/**
 * Canonical session spend in USD. Session cost only grows, so the persisted
 * total and the live client sum are both lower bounds and the max is closest
 * to the truth.
 */
export const selectSessionCostUsd = (
  persistedMicrodollars: number | null | undefined,
  liveUsd: number
): number => {
  const persisted =
    typeof persistedMicrodollars === 'number' && Number.isFinite(persistedMicrodollars)
      ? Math.max(0, persistedMicrodollars / 1_000_000)
      : 0;
  const live = Number.isFinite(liveUsd) ? Math.max(0, liveUsd) : 0;

  return Math.max(persisted, live);
};

/** The indicator needs a loaded session with at least one assistant reply. */
export const shouldShowContextMetrics = (
  isLoading: boolean,
  contextUsage: ContextUsage | undefined
): boolean => !isLoading && contextUsage !== undefined;

/** Picker row id for a CLI-catalog model. Carries the CLI's own model ref. */
export const cliCatalogModelId = (model: ModelRef): string =>
  `${CLI_CATALOG_ID_PREFIX}${model.providerID}/${model.modelID}`;

/**
 * The catalog entry a picker row id points at. Compares built ids instead of
 * parsing, so a model id containing a slash stays unambiguous.
 */
export const findCliCatalogModelRef = (
  catalog: RemoteModelCatalogV1 | undefined,
  optionId: string
): ModelRef | undefined => {
  for (const provider of catalog?.providers ?? []) {
    for (const model of provider.models) {
      const modelRef = { modelID: model.id, providerID: provider.id };
      if (cliCatalogModelId(modelRef) === optionId) {
        return modelRef;
      }
    }
  }

  return undefined;
};

/** The CLI's own catalog projected onto the shared picker's option shape. */
const buildCliCatalogOptions = (catalog: RemoteModelCatalogV1): readonly KiloGatewayModelOption[] =>
  catalog.providers.flatMap(provider =>
    provider.models.map(model => ({
      contextLength: model.limits.context,
      id: cliCatalogModelId({ modelID: model.id, providerID: provider.id }),
      // No RECOMMENDED group: keep the CLI's own catalog order, as mobile does.
      isPreferred: false,
      name: model.name ?? model.id,
      variants: model.variants,
      ...(model.isFree === undefined ? {} : { isFree: model.isFree }),
      ...(model.hasUserByokAvailable === undefined
        ? {}
        : { hasUserByokAvailable: model.hasUserByokAvailable }),
      ...(model.mayTrainOnYourPrompts === undefined
        ? {}
        : { mayTrainOnYourPrompts: model.mayTrainOnYourPrompts }),
    }))
  );

/**
 * Which catalog an open session picks from, and which override setter applies.
 * A v1 CLI owns its catalog, so a gateway model id is rejected at send; a CLI
 * that has not reported one yet gets a disabled trigger, never a wrong model.
 */
// eslint-disable-next-line typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type
export type SessionModelPicker = {
  readonly target: 'cloud-agent' | 'remote-cli' | 'remote-legacy' | 'remote-unavailable' | null;
  readonly options: readonly KiloGatewayModelOption[];
  readonly selectedId: string;
  readonly disabledReason: string | undefined;
};

export const selectSessionModelPicker = ({
  activeSessionType,
  cloudOverride,
  gatewayModels,
  observedModel,
  remoteModelOverride,
  remoteModelState,
  sessionModel,
}: {
  activeSessionType: ActiveSessionType | null;
  cloudOverride: { readonly model: string } | null;
  gatewayModels: readonly KiloGatewayModelOption[];
  observedModel: ModelSelection | null;
  remoteModelOverride: RemoteModelOverride | null;
  remoteModelState: RemoteModelState;
  sessionModel: string | null | undefined;
}): SessionModelPicker => {
  if (activeSessionType === 'remote') {
    const { catalog } = remoteModelState;

    // An empty catalog (no connected provider) is as unpickable as no catalog.
    if (
      remoteModelState.protocol === 'v1' &&
      catalog !== undefined &&
      catalog.providers.length > 0
    ) {
      const selection =
        remoteModelOverride?.selection ??
        observedModel ??
        (catalog.defaultModel === undefined ? null : { model: catalog.defaultModel });

      return {
        disabledReason: undefined,
        options: buildCliCatalogOptions(catalog),
        selectedId: selection === null ? '' : cliCatalogModelId(selection.model),
        target: 'remote-cli',
      };
    }

    if (remoteModelState.protocol === 'legacy') {
      return {
        disabledReason: undefined,
        options: gatewayModels,
        selectedId: remoteModelOverride?.selection.model.modelID ?? sessionModel ?? '',
        target: 'remote-legacy',
      };
    }

    return {
      disabledReason:
        remoteModelState.refresh === 'error' ? 'Models unavailable' : 'Loading models…',
      options: [],
      selectedId: observedModel?.model.modelID ?? sessionModel ?? '',
      target: 'remote-unavailable',
    };
  }

  if (activeSessionType === 'cloud-agent') {
    return {
      disabledReason: undefined,
      options: gatewayModels,
      selectedId: cloudOverride?.model ?? sessionModel ?? '',
      target: 'cloud-agent',
    };
  }

  return { disabledReason: undefined, options: [], selectedId: '', target: null };
};
