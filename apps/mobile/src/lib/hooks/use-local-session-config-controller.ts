import { useCallback, useEffect, useMemo, useReducer } from 'react';

import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import { type LocalRuntime } from '@/lib/hooks/runtime-discovery-logic';
import { buildLocalSessionConfigViewModel } from './local-runtime-catalog-view-model';
import { projectLocalRuntimeCatalog } from './local-runtime-catalog-projection';
import {
  type LocalRuntimeCatalog,
  type LocalRuntimeCatalogState,
  type LocalRuntimeFence,
  type LocalRuntimesState,
  type LocalSessionConfigViewModel,
} from './local-runtime-catalog-types';
import { resolveSelectedRuntimeFence, runtimeFenceEquals } from './local-runtime-catalog-selection';
import {
  INITIAL_LOCAL_SESSION_CONFIG_SELECTION,
  type LocalSessionConfigModelSelection,
  type LocalSessionConfigSelection,
  reduceLocalSessionConfigSelection,
} from './local-session-config-selection';
import { applyLocalSessionConfigSelection } from './local-session-config-view-model';
import { useLocalRuntimeCatalog } from './use-local-runtime-catalog';
import { useLocalRuntimes } from './use-local-runtimes';

export type LocalSessionConfigController = {
  selection: LocalSessionConfigSelection;
  runtimesState: LocalRuntimesState;
  catalogState: LocalRuntimeCatalogState;
  onSelectFence: (fence: LocalRuntimeFence) => void;
  onClearFence: () => void;
  onSelectAgent: (slug: string) => void;
  onSelectModel: (selection: LocalSessionConfigModelSelection) => void;
  onResetOverrides: () => void;
  refetchCatalog: () => void;
};

/**
 * Pure projection from a raw `getCatalog` query result and the currently
 * selected fence to the catalog state consumed by the view-model. Keeps the
 * controller's React hook thin and testable without a renderer.
 */
export function buildLocalRuntimeCatalogState(
  fence: LocalRuntimeFence | null,
  query: {
    data: LocalRuntimeCatalog | undefined;
    error: unknown;
    refetch: () => void;
  }
): LocalRuntimeCatalogState {
  if (fence === null) {
    return { kind: 'idle' };
  }
  const runtime: LocalRuntime = {
    runtimeId: fence.runtimeId,
    connectionId: fence.connectionId,
    protocolVersion: 1,
    cliVersion: '',
    displayName: '',
    projectName: '',
    capabilities: [],
  };
  if (query.error) {
    return {
      kind: 'error',
      runtime,
      error: query.error,
      refetch: query.refetch,
    };
  }
  if (query.data === undefined) {
    return { kind: 'loading', runtime };
  }
  return {
    kind: 'ready',
    runtime,
    catalog: query.data,
    catalogGeneration: query.data,
  };
}

/**
 * Screen-level controller for the local session configuration. Owns the
 * selected fence, the agent override, and the model override; wires the
 * runtime-discovery and catalog queries; and projects their results onto the
 * pure `LocalSessionConfigViewModel` discriminated union.
 *
 * The screen's only writable surface is the controller's `on*` handlers —
 * the renderer never reaches into the reducer or the query results.
 */
export function useLocalSessionConfigController(): LocalSessionConfigController {
  // The user-web connection is the only consumer-side consumer of the
  // connection object. Touching it here keeps the controller's React-Query
  // mocks honest in tests (and ensures the existing useLocalRuntimes /
  // useLocalRuntimeCatalog lifecycles share the same retain).
  useUserWebConnection();

  const [selection, dispatch] = useReducer(
    reduceLocalSessionConfigSelection,
    INITIAL_LOCAL_SESSION_CONFIG_SELECTION
  );
  const runtimesQuery = useLocalRuntimes();
  const { data: runtimesData, isError, refetch: runtimesRefetch } = runtimesQuery;
  const runtimesState = useMemo<LocalRuntimesState>(
    () => ({
      data: runtimesData,
      isError,
      refetch: () => {
        void runtimesRefetch();
      },
    }),
    [runtimesData, isError, runtimesRefetch]
  );

  // Sync the selected fence with the live runtime list. A single capable
  // runtime auto-selects; a disconnected runtime clears the fence; a reconnect
  // for the same runtimeId adopts the new connectionId. Multiple capable
  // runtimes require an explicit user choice.
  useEffect(() => {
    const runtimes = runtimesData?.runtimes ?? [];
    const resolved = resolveSelectedRuntimeFence(runtimes, selection.selectedFence);
    if (resolved === null && selection.selectedFence !== null) {
      dispatch({ type: 'setFence', fence: null });
      return;
    }
    if (
      resolved !== null &&
      (selection.selectedFence === null || !runtimeFenceEquals(resolved, selection.selectedFence))
    ) {
      dispatch({ type: 'setFence', fence: resolved });
    }
  }, [dispatch, runtimesData, selection.selectedFence]);

  const catalogQuery = useLocalRuntimeCatalog(selection.selectedFence);
  const { data: catalogData, error: catalogError, refetch: catalogRefetch } = catalogQuery;
  const catalogState = useMemo<LocalRuntimeCatalogState>(() => {
    const projectedData = catalogData ? projectLocalRuntimeCatalog(catalogData) : undefined;
    return buildLocalRuntimeCatalogState(selection.selectedFence, {
      data: projectedData,
      error: catalogError,
      refetch: () => {
        void catalogRefetch();
      },
    });
  }, [selection.selectedFence, catalogData, catalogError, catalogRefetch]);

  const onSelectFence = useCallback((fence: LocalRuntimeFence) => {
    dispatch({ type: 'setFence', fence });
  }, []);

  const onClearFence = useCallback(() => {
    dispatch({ type: 'setFence', fence: null });
  }, []);

  const onSelectAgent = useCallback(
    (slug: string) => {
      const catalog = catalogState.kind === 'ready' ? catalogState.catalog : null;
      if (!catalog) {
        // The agent picker only opens on a `ready` view-model — the controller
        // never needs to accept a slug without a catalog to validate it.
        return;
      }
      dispatch({ type: 'selectAgent', slug, catalog });
    },
    [catalogState]
  );

  const onSelectModel = useCallback((next: LocalSessionConfigModelSelection) => {
    dispatch({ type: 'selectModel', selection: next });
  }, []);

  const onResetOverrides = useCallback(() => {
    dispatch({ type: 'resetOverrides' });
  }, []);

  const refetchCatalog = useCallback(() => {
    void catalogRefetch();
  }, [catalogRefetch]);

  return {
    selection,
    runtimesState,
    catalogState,
    onSelectFence,
    onClearFence,
    onSelectAgent,
    onSelectModel,
    onResetOverrides,
    refetchCatalog,
  };
}

/**
 * Compose the controller's `LocalSessionConfigViewModel`. Thin wrapper over
 * the pure helpers so the renderer can be a pure function of the controller.
 */
export function buildLocalSessionConfigScreenViewModel(
  controller: LocalSessionConfigController
): LocalSessionConfigViewModel {
  const base = buildLocalSessionConfigViewModel({
    runtimesState: controller.runtimesState,
    selectedFence: controller.selection.selectedFence,
    onSelectFence: controller.onSelectFence,
    onClearFence: controller.onClearFence,
    catalogState: controller.catalogState,
  });
  return applyLocalSessionConfigSelection({
    viewModel: base,
    selection: controller.selection,
    handlers: {
      onSelectAgent: controller.onSelectAgent,
      onSelectModel: controller.onSelectModel,
      onChangeRuntime: controller.onClearFence,
    },
  });
}
