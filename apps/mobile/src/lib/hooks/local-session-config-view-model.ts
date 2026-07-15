import {
  type LocalRuntimeCatalog,
  type LocalSessionConfigViewModel,
} from './local-runtime-catalog-types';
import { findAgentBySlug, resolveInitialModelSelection } from './local-runtime-catalog-selection';
import {
  type LocalSessionConfigModelSelection,
  type LocalSessionConfigSelection,
} from './local-session-config-selection';

export type LocalSessionConfigControllerHandlers = {
  onSelectAgent: (slug: string) => void;
  onSelectModel: (selection: LocalSessionConfigModelSelection) => void;
  onChangeRuntime: () => void;
};

type ApplyLocalSessionConfigOverridesInput = {
  viewModel: LocalSessionConfigViewModel;
  selection: LocalSessionConfigSelection;
  handlers: LocalSessionConfigControllerHandlers;
};

/**
 * Compose the screen's controller state onto the pure `LocalSessionConfigViewModel`.
 * For every non-ready branch the function is a no-op — the picker is not on
 * screen in those branches and the renderer can ignore the controller.
 *
 * For the `ready` branch the function:
 *
 * - Resolves the active agent slug (controller override → catalog default).
 * - Recomputes the locked-by-agent flag from the agent definition; the
 *   picker row hides itself when this is true.
 * - Resolves the model+variant: pinned agent → agent's pinned model; unpinned
 *   agent with a controller override → that override; otherwise the catalog
 *   default for the active agent.
 * - Replaces the no-op handlers from the pure view-model with the
 *   controller's transition dispatchers.
 */
export function applyLocalSessionConfigSelection({
  viewModel,
  selection,
  handlers,
}: ApplyLocalSessionConfigOverridesInput): LocalSessionConfigViewModel {
  if (viewModel.kind !== 'ready') {
    return viewModel;
  }

  const resolved = resolveReadySelection({
    catalog: viewModel.catalog,
    selection,
    defaultAgentSlug: viewModel.selectedAgent.slug,
  });

  return {
    ...viewModel,
    selectedAgent: resolved.selectedAgent,
    selectedModel: resolved.selectedModel,
    selectedVariant: resolved.selectedVariant,
    isModelLocked: resolved.isModelLocked,
    onSelectAgent: handlers.onSelectAgent,
    onSelectModel: handlers.onSelectModel,
    onChangeRuntime: handlers.onChangeRuntime,
  };
}

type ReadyLocalSessionConfigViewModel = Extract<LocalSessionConfigViewModel, { kind: 'ready' }>;

function resolveReadySelection({
  catalog,
  selection,
  defaultAgentSlug,
}: {
  catalog: LocalRuntimeCatalog;
  selection: LocalSessionConfigSelection;
  defaultAgentSlug: string;
}): {
  selectedAgent: ReadyLocalSessionConfigViewModel['selectedAgent'];
  selectedModel: { providerID: string; modelID: string };
  selectedVariant: string;
  isModelLocked: boolean;
} {
  const overrideAgent = selection.agentOverride
    ? findAgentBySlug(catalog, selection.agentOverride)
    : null;
  const activeAgent = overrideAgent ?? findAgentBySlug(catalog, defaultAgentSlug);
  if (!activeAgent) {
    // Unreachable — the view-model's `ready` branch already filtered this.
    throw new Error('Active agent must exist in a usable catalog');
  }

  if (activeAgent.model) {
    return {
      selectedAgent: activeAgent,
      selectedModel: {
        providerID: activeAgent.model.providerID,
        modelID: activeAgent.model.modelID,
      },
      selectedVariant: activeAgent.variant ?? '',
      isModelLocked: true,
    };
  }

  const initial = resolveInitialModelSelection(catalog, activeAgent);
  if (!initial) {
    // Unreachable — the view-model guarantees at least one model in the
    // usable catalog. The narrowing keeps the rest of the function simple.
    throw new Error('Usable catalog must expose at least one model');
  }

  const override = selection.modelOverride;
  if (override) {
    const provider = catalog.models.providers.find(
      candidate => candidate.id === override.providerID
    );
    const model = provider?.models.find(candidate => candidate.id === override.modelID);
    if (model && provider) {
      const variant = model.variants.includes(override.variant)
        ? override.variant
        : (model.variants[0] ?? '');
      return {
        selectedAgent: activeAgent,
        selectedModel: { providerID: provider.id, modelID: model.id },
        selectedVariant: variant,
        isModelLocked: false,
      };
    }
  }

  return {
    selectedAgent: activeAgent,
    selectedModel: { providerID: initial.providerID, modelID: initial.modelID },
    selectedVariant: initial.variant,
    isModelLocked: false,
  };
}
