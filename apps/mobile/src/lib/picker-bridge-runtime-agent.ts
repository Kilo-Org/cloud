import {
  type LocalRuntimeCatalog,
  type LocalRuntimeFence,
} from '@/lib/hooks/local-runtime-catalog-types';

/**
 * Runtime-catalog agent picker bridge: the screen publishes the catalog
 * object, the exact fence the catalog was fetched for, the current agent
 * slug, and a draft selection scope. The picker UI calls
 * `commitRuntimeCatalogAgentPickerSelection` when the user taps a row.
 *
 * The scope combines the runtime identity (the fence the catalog came
 * from), the catalog's protocol version, and an opaque
 * `catalogGenerationIdentity` token that the screen refreshes on every
 * fetch. `commit` rejects when any of the three guard inputs — scope,
 * catalog object, fence — no longer match the live state, so a stale tap
 * from a detached picker can never reach the mutation hook.
 *
 * Unlike the model picker, the agent picker never converts the slug into
 * an `AgentMode`: the screen is the only consumer that decides how a
 * local-runtime agent relates to the cloud session-create surface, and
 * the bridge hands back the exact catalog slug the runtime advertised.
 */
export type RuntimeCatalogAgentSelectionScope = {
  runtimeId: string;
  connectionId: string;
  protocol: 'v1';
  catalogGenerationIdentity: object | null;
};

export type RuntimeCatalogAgentSelection = {
  slug: string;
  name: string;
  description?: string;
};

type RuntimeCatalogAgentPickerBridge = {
  catalog: LocalRuntimeCatalog;
  currentFence: LocalRuntimeFence;
  currentValue: string;
  selectionScope: RuntimeCatalogAgentSelectionScope;
  isSelectionCurrent: (scope: RuntimeCatalogAgentSelectionScope) => boolean;
  onSelect: (selection: RuntimeCatalogAgentSelection) => void;
};

export function areRuntimeCatalogAgentSelectionScopesEqual(
  left: RuntimeCatalogAgentSelectionScope,
  right: RuntimeCatalogAgentSelectionScope
): boolean {
  return (
    left.runtimeId === right.runtimeId &&
    left.connectionId === right.connectionId &&
    left.catalogGenerationIdentity === right.catalogGenerationIdentity
  );
}

let runtimeCatalogAgentBridge: RuntimeCatalogAgentPickerBridge | null = null;

/**
 * Resolve a draft agent selection against the published catalog. Returns
 * `null` when the agent slug is not in the catalog. The picker's commit
 * helper performs the additional scope/catalog/fence staleness checks.
 */
export function resolveRuntimeCatalogAgentSelection(
  bridge: RuntimeCatalogAgentPickerBridge,
  draft: { slug: string }
): RuntimeCatalogAgentSelection | null {
  const agent = bridge.catalog.agents.find(candidate => candidate.slug === draft.slug);
  if (!agent) {
    return null;
  }
  return {
    slug: agent.slug,
    name: agent.name,
    ...(agent.description !== undefined ? { description: agent.description } : {}),
  };
}

/**
 * Commit an agent picker tap. Discards the tap when:
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
export function commitRuntimeCatalogAgentPickerSelection(
  bridge: RuntimeCatalogAgentPickerBridge,
  draft: { slug: string }
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
  const selection = resolveRuntimeCatalogAgentSelection(bridge, draft);
  if (!selection) {
    return false;
  }
  bridge.onSelect(selection);
  return true;
}

export function setRuntimeCatalogAgentPickerBridge(bridge: RuntimeCatalogAgentPickerBridge) {
  runtimeCatalogAgentBridge = bridge;
}
export function getRuntimeCatalogAgentPickerBridge() {
  return runtimeCatalogAgentBridge;
}
export function clearRuntimeCatalogAgentPickerBridge() {
  runtimeCatalogAgentBridge = null;
}
