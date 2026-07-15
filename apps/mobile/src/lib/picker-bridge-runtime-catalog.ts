import {
  type LocalRuntimeCatalog,
  type LocalRuntimeFence,
} from '@/lib/hooks/local-runtime-catalog-types';

/**
 * Runtime-catalog model picker bridge: the screen publishes the catalog
 * object, the exact fence the catalog was fetched for, and a draft selection
 * scope. The picker UI calls `commitRuntimeCatalogModelPickerSelection` when
 * the user taps a row.
 *
 * The scope combines the runtime identity (the fence the catalog came from),
 * the catalog's protocol version, and an opaque `catalogGenerationIdentity`
 * token that the screen refreshes on every fetch. `commit` rejects when any
 * of the three guard inputs — scope, catalog object, fence — no longer match
 * the live state, so a stale tap from a detached picker can never reach the
 * mutation hook.
 */
export type RuntimeCatalogModelSelectionScope = {
  runtimeId: string;
  connectionId: string;
  protocol: 'v1';
  catalogGenerationIdentity: object | null;
};

export type RuntimeCatalogModelSelection = {
  providerID: string;
  modelID: string;
  variant: string;
};

type RuntimeCatalogModelPickerBridge = {
  catalog: LocalRuntimeCatalog;
  currentFence: LocalRuntimeFence;
  currentValue: string;
  currentVariant: string;
  selectionScope: RuntimeCatalogModelSelectionScope;
  isSelectionCurrent: (scope: RuntimeCatalogModelSelectionScope) => boolean;
  onSelect: (selection: RuntimeCatalogModelSelection) => void;
};

export function areRuntimeCatalogModelSelectionScopesEqual(
  left: RuntimeCatalogModelSelectionScope,
  right: RuntimeCatalogModelSelectionScope
): boolean {
  return (
    left.runtimeId === right.runtimeId &&
    left.connectionId === right.connectionId &&
    left.catalogGenerationIdentity === right.catalogGenerationIdentity
  );
}

let runtimeCatalogModelBridge: RuntimeCatalogModelPickerBridge | null = null;

/**
 * Resolve a draft model selection against the published catalog. Returns
 * `null` when the model id is not in the catalog, when the provider cannot
 * be located, or when the requested variant is missing (in which case the
 * first variant of the model is used as a fallback). The picker bridge
 * performs the additional scope/catalog/fence staleness checks in `commit`.
 */
export function resolveRuntimeCatalogModelSelection(
  bridge: RuntimeCatalogModelPickerBridge,
  draft: RuntimeCatalogModelSelection
): RuntimeCatalogModelSelection | null {
  const provider = bridge.catalog.models.providers.find(
    candidate => candidate.id === draft.providerID
  );
  if (!provider) {
    return null;
  }
  const model = provider.models.find(candidate => candidate.id === draft.modelID);
  if (!model) {
    return null;
  }
  const resolvedVariant = model.variants.includes(draft.variant)
    ? draft.variant
    : (model.variants[0] ?? '');
  return { providerID: provider.id, modelID: model.id, variant: resolvedVariant };
}

/**
 * Commit a runtime-catalog model picker tap. Discards the tap when:
 *
 * - the draft scope is no longer current (`isSelectionCurrent` returns
 *   `false` — e.g. the user scrolled away and the screen re-published a
 *   fresh scope),
 * - the published catalog object identity has changed (a refetch
 *   superseded the picker), or
 * - the exact fence the catalog was fetched for no longer matches the
 *   scope's runtime identity (runtime reconnect or disconnect).
 *
 * Returns `true` only when the bridge's `onSelect` was actually invoked.
 */
export function commitRuntimeCatalogModelPickerSelection(
  bridge: RuntimeCatalogModelPickerBridge,
  draft: RuntimeCatalogModelSelection
): boolean {
  if (!bridge.isSelectionCurrent(bridge.selectionScope)) {
    return false;
  }
  if (
    bridge.currentFence.runtimeId !== bridge.selectionScope.runtimeId ||
    bridge.currentFence.connectionId !== bridge.selectionScope.connectionId
  ) {
    return false;
  }
  const selection = resolveRuntimeCatalogModelSelection(bridge, draft);
  if (!selection) {
    return false;
  }
  bridge.onSelect(selection);
  return true;
}

export function setRuntimeCatalogModelPickerBridge(bridge: RuntimeCatalogModelPickerBridge) {
  runtimeCatalogModelBridge = bridge;
}
export function getRuntimeCatalogModelPickerBridge() {
  return runtimeCatalogModelBridge;
}
export function clearRuntimeCatalogModelPickerBridge() {
  runtimeCatalogModelBridge = null;
}
