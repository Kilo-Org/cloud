import { type LocalRuntime } from '@/lib/hooks/runtime-discovery-logic';

import {
  findAgentBySlug,
  hasCatalogCapability,
  isUsableCatalog,
  resolveInitialModelSelection,
  runtimeFenceEquals,
} from './local-runtime-catalog-selection';
import { classifyLocalRuntimeCatalogError } from './local-runtime-catalog-errors';
import {
  type BuildLocalSessionConfigViewModelInput,
  type LocalRuntimeCatalog,
  type LocalRuntimeCatalogState,
  type LocalRuntimeFence,
  type LocalSessionConfigViewModel,
} from './local-runtime-catalog-types';

const noop = (): void => {
  // no-op: the ready view-model starts with default selections; the actual
  // change handlers are wired by the renderer after initial selection.
};

/**
 * Compose the four exclusive screen states the configuration view can be in.
 * The function is pure: it never calls a mutation hook or a tRPC client, and
 * it never sets local state. That keeps the screen's reducer simple and the
 * tests deterministic.
 */
export function buildLocalSessionConfigViewModel(
  input: BuildLocalSessionConfigViewModelInput
): LocalSessionConfigViewModel {
  const { runtimesState, selectedFence, onSelectFence, onClearFence, catalogState } = input;
  const { data, isError, refetch } = runtimesState;

  // Cached data always wins over a background error — a stale refetch failure
  // must not collapse a successful list into the error state.
  if (data === undefined) {
    if (isError) {
      // We surface a list-level error as the empty branch with the existing
      // Slice 1 retry copy so the user can re-attempt the discovery query.
      return {
        kind: 'empty',
        title: "Couldn't load local runtimes",
        message: 'Check your connection and try again.',
        retry: refetch,
      };
    }
    return { kind: 'loading' };
  }

  // Empty list: distinct from "no capable runtime"; the user has runtimes
  // installed on no machines right now.
  if (data.runtimes.length === 0) {
    return {
      kind: 'empty',
      title: 'No local runtimes',
      message: 'Run kilo remote in a project, then retry.',
      retry: refetch,
    };
  }

  // Incapable-only: at least one runtime exists but none of them advertise
  // `catalog.v1`. There is no recovery inside the picker — the user has to
  // upgrade the CLI.
  if (data.runtimes.every(runtime => !hasCatalogCapability(runtime))) {
    return { kind: 'incapable' };
  }

  if (!selectedFence) {
    // Auto-pick the only capable runtime so the catalog can start loading
    // immediately. We do not call `onSelectFence` here — the screen subscribes
    // to the view-model and persists the fence itself.
    const capable = data.runtimes.filter(runtime => hasCatalogCapability(runtime));
    if (capable.length === 1) {
      const only = capable[0];
      if (!only) {
        return {
          kind: 'selecting-runtime',
          runtimes: data.runtimes,
          currentFence: null,
          onSelect: onSelectFence,
          onRefresh: refetch,
        };
      }
      // Auto-select means the catalog hook should be running for this exact
      // runtime — pass its current state through so the screen can render
      // the loading/error/ready branch instead of re-entering the picker.
      const isCatalogForRuntime =
        catalogState.kind === 'idle' || runtimeFenceEquals(catalogState.runtime, only);
      if (isCatalogForRuntime) {
        return buildCatalogViewModel({
          runtime: only,
          catalogState,
          onClearFence,
          onSelectFence,
          runtimes: data.runtimes,
        });
      }
    }
    return {
      kind: 'selecting-runtime',
      runtimes: data.runtimes,
      currentFence: null,
      onSelect: onSelectFence,
      onRefresh: refetch,
    };
  }

  // Find the runtime object that matches the selected fence. The catalog query
  // was issued for this exact fence, so we use the same object the query
  // received. If the runtime has gone away, the catalog view-model is
  // meaningless — drop the fence and require an explicit re-selection.
  const selectedRuntime = data.runtimes.find(runtime => runtimeFenceEquals(runtime, selectedFence));
  if (!selectedRuntime) {
    return {
      kind: 'selecting-runtime',
      runtimes: data.runtimes,
      currentFence: null,
      onSelect: onSelectFence,
      onRefresh: refetch,
    };
  }

  if (!hasCatalogCapability(selectedRuntime)) {
    return { kind: 'incapable' };
  }

  return buildCatalogViewModel({
    runtime: selectedRuntime,
    catalogState,
    onClearFence,
    onSelectFence,
    runtimes: data.runtimes,
  });
}

function buildCatalogViewModel(args: {
  runtime: LocalRuntime;
  catalogState: LocalRuntimeCatalogState;
  onClearFence: () => void;
  onSelectFence: (fence: LocalRuntimeFence) => void;
  runtimes: LocalRuntime[];
}): LocalSessionConfigViewModel {
  const { runtime, catalogState, onClearFence, runtimes } = args;
  const onChangeRuntime = () => {
    onClearFence();
  };

  if (catalogState.kind === 'idle') {
    return {
      kind: 'selecting-runtime',
      runtimes,
      currentFence: { runtimeId: runtime.runtimeId, connectionId: runtime.connectionId },
      onSelect: args.onSelectFence,
      onRefresh: () => undefined,
    };
  }

  if (catalogState.kind === 'loading') {
    return { kind: 'catalog-loading', runtime, onCancel: onChangeRuntime };
  }

  if (catalogState.kind === 'error') {
    const classification = classifyLocalRuntimeCatalogError(catalogState.error);
    if (classification.kind === 'non-retryable-capability') {
      return {
        kind: 'catalog-error-non-retryable',
        runtime,
        title: classification.title,
        message: classification.message,
      };
    }
    if (classification.kind === 'non-retryable-malformed') {
      return {
        kind: 'catalog-error-non-retryable',
        runtime,
        title: classification.title,
        message: classification.message,
      };
    }
    return {
      kind: 'catalog-error-retryable',
      runtime,
      title: classification.title,
      message: classification.message,
      retry: catalogState.refetch,
      onChangeRuntime,
    };
  }

  // Defensive shape check: a successful response that is missing the default
  // agent or ships no models is treated as malformed. We do not auto-retry —
  // the user must change runtimes.
  if (!isUsableCatalog(catalogState.catalog)) {
    return {
      kind: 'catalog-error-non-retryable',
      runtime,
      title: "Couldn't load runtime catalog",
      message: "This runtime can't provide a usable catalog.",
    };
  }

  const readySelection = resolveReadySelection(catalogState.catalog);
  return {
    kind: 'ready',
    runtime,
    catalog: catalogState.catalog,
    catalogGeneration: catalogState.catalogGeneration,
    ...readySelection,
    isModelLocked: readySelection.selectedAgent.model !== undefined,
    onChangeRuntime,
  };
}

function resolveReadySelection(catalog: LocalRuntimeCatalog) {
  const defaultAgent = findAgentBySlug(catalog, catalog.defaultAgent);
  if (!defaultAgent) {
    // Unreachable — `isUsableCatalog` already filtered this branch — but the
    // narrowing keeps the rest of the function simple.
    throw new Error('Default agent must exist for a usable catalog');
  }
  const initialModel = resolveInitialModelSelection(catalog, defaultAgent);
  if (!initialModel) {
    throw new Error('Usable catalog must expose at least one model');
  }
  return {
    selectedAgent: defaultAgent,
    selectedModel: { providerID: initialModel.providerID, modelID: initialModel.modelID },
    selectedVariant: initialModel.variant,
    onSelectAgent: noop,
    onSelectModel: noop,
  };
}
