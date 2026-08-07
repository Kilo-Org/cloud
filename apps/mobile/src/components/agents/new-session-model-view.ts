import { type RemoteModelCatalogV1 } from '@kilocode/cloud-agent-sdk/instance-model-catalog';
import {
  type ModelSelection,
  type RemoteModelOverride,
  type RemoteModelState,
} from '@kilocode/cloud-agent-sdk/remote-model-catalog';

import { type ModelOption } from '@/lib/hooks/use-available-models';
import {
  buildSessionModelOptions,
  type SessionModelOption,
} from '@/lib/hooks/use-session-model-options';

export type NewSessionModelView = {
  options: SessionModelOption[];
  selectedValue: string;
  selectedVariant: string;
  /** Wire model for create_session; undefined means "let the CLI use its default". */
  spawnSelection?: ModelSelection;
  /** True when the current selection is not in the active catalog. Blocks Start. */
  isSelectionUnavailable: boolean;
};

type ResolveNewSessionRemoteOverrideInput = {
  catalog: RemoteModelCatalogV1 | null;
  gatewayModel: string;
  gatewayVariant: string;
  remoteOverride: RemoteModelOverride | null;
};

/**
 * Resolve the new-session model override against the active catalog state.
 *
 * An existing override wins, except where it is a stale artifact of the
 * other catalog state rather than a meaningful user pick:
 *
 * - `cli-catalog` with no catalog: a CLI-catalog pick has no meaning once
 *   the catalog is gone.
 * - `legacy-gateway` with a catalog that lacks the model under `kilo`: the
 *   pick was made against the fallback list before a valid catalog arrived.
 *
 * There is deliberately no third exception: a `cli-catalog` pick against a
 * real catalog that later drops the model must keep the override, because the
 * visible unavailable row plus the blocked Start is the intended signal.
 */
function resolveNewSessionRemoteOverride(
  input: ResolveNewSessionRemoteOverrideInput
): RemoteModelOverride | null {
  if (input.remoteOverride) {
    const staleCliCatalogPick =
      input.remoteOverride.source === 'cli-catalog' && input.catalog === null;
    const staleLegacyGatewayPick =
      input.remoteOverride.source === 'legacy-gateway' &&
      input.catalog !== null &&
      !catalogHasKiloModel(input.catalog, input.remoteOverride.selection.model.modelID);
    if (!staleCliCatalogPick && !staleLegacyGatewayPick) {
      return input.remoteOverride;
    }
  }

  if (!input.gatewayModel) {
    return null;
  }

  if (input.catalog === null) {
    return {
      source: 'legacy-gateway',
      selection: {
        model: { providerID: 'kilo', modelID: input.gatewayModel },
        ...(input.gatewayVariant ? { variant: input.gatewayVariant } : {}),
      },
    };
  }

  const kiloModel = input.catalog.providers
    .find(provider => provider.id === 'kilo')
    ?.models.find(model => model.id === input.gatewayModel);
  if (!kiloModel) {
    return null;
  }
  return {
    source: 'cli-catalog',
    selection: {
      model: { providerID: 'kilo', modelID: input.gatewayModel },
      ...(kiloModel.variants.includes(input.gatewayVariant)
        ? { variant: input.gatewayVariant }
        : {}),
    },
  };
}

function catalogHasKiloModel(catalog: RemoteModelCatalogV1, modelID: string): boolean {
  const kiloProvider = catalog.providers.find(provider => provider.id === 'kilo');
  return kiloProvider?.models.some(model => model.id === modelID) ?? false;
}

export type ResolveNewSessionModelViewInput = {
  isRemoteTarget: boolean;
  catalog: RemoteModelCatalogV1 | null;
  catalogLoading: boolean;
  gatewayModels: ModelOption[];
  gatewayModelsLoading: boolean;
  gatewayModel: string;
  gatewayVariant: string;
  remoteOverride: RemoteModelOverride | null;
};

/**
 * Pure projection of the new-session screen's model picker. No React.
 *
 * Cloud Agent (`isRemoteTarget: false`) delegates to the plain gateway
 * options and the persisted gateway strings, byte-identical to today.
 *
 * Remote target builds a `RemoteModelState` from the catalog (v1) or the
 * legacy fallback, resolves the override, and derives the wire selection from
 * the freshly built option list. The wire selection comes from the built
 * list, never from raw strings: an option the current catalog does not
 * contain exists only as the `unavailable` placeholder, which cannot produce
 * a wire model. When a valid catalog has no `defaultModel` and the gateway
 * model is absent, the first catalog option is selected so the picker is
 * never non-empty with nothing selected.
 */
export function resolveNewSessionModelView(
  input: ResolveNewSessionModelViewInput
): NewSessionModelView {
  if (!input.isRemoteTarget) {
    const { options } = buildSessionModelOptions({
      activeSessionType: null,
      remoteModelState: {
        ownerConnectionId: null,
        protocol: 'unknown',
        refresh: 'idle',
      },
      observedModel: null,
      remoteModelOverride: null,
      gatewayModels: input.gatewayModels,
      gatewayModelsLoading: input.gatewayModelsLoading,
    });
    return {
      options,
      selectedValue: input.gatewayModel,
      selectedVariant: input.gatewayVariant,
      isSelectionUnavailable: false,
    };
  }

  const remoteModelState: RemoteModelState = input.catalog
    ? {
        ownerConnectionId: null,
        protocol: 'v1',
        catalog: input.catalog,
        refresh: 'idle',
      }
    : {
        ownerConnectionId: null,
        protocol: 'legacy',
        refresh: input.catalogLoading ? 'loading' : 'idle',
      };

  const remoteModelOverride = resolveNewSessionRemoteOverride({
    catalog: input.catalog,
    gatewayModel: input.gatewayModel,
    gatewayVariant: input.gatewayVariant,
    remoteOverride: input.remoteOverride,
  });

  const delegate = buildSessionModelOptions({
    activeSessionType: 'remote',
    remoteModelState,
    observedModel: null,
    remoteModelOverride,
    gatewayModels: input.gatewayModels,
    gatewayModelsLoading: input.gatewayModelsLoading,
  });

  let selectedValue = delegate.selectedValue;
  if (delegate.source === 'remote-cli-catalog' && selectedValue === '') {
    const firstOption = delegate.options[0];
    if (firstOption) {
      // A valid catalog can carry no `defaultModel`. The first option comes
      // from the catalog, so it is always valid on that instance. Do not apply
      // this to the legacy fallback: "no selection" there means "let the CLI
      // use its own default", which is today's behavior.
      selectedValue = firstOption.id;
    }
  }

  const selected = delegate.options.find(option => option.id === selectedValue);
  const isSelectionUnavailable = selected?.unavailable === true;
  const spawnSelection =
    selected?.modelRef && !isSelectionUnavailable
      ? {
          model: selected.modelRef,
          ...(delegate.selectedVariant ? { variant: delegate.selectedVariant } : {}),
        }
      : undefined;

  return {
    options: delegate.options,
    selectedValue,
    selectedVariant: delegate.selectedVariant,
    spawnSelection,
    isSelectionUnavailable,
  };
}
