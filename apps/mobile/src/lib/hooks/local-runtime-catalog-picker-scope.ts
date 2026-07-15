import { type LocalSessionConfigViewModel } from './local-runtime-catalog-types';

/**
 * Scope published by the configuration screen when it opens a runtime-catalog
 * picker (agent or model). The picker uses `isRuntimeCatalogPickerScopeCurrent`
 * to decide whether a draft selection is still valid.
 *
 * The scope carries the exact runtime fence the catalog was fetched for, the
 * catalog protocol version, and an opaque generation identity object. The
 * screen always publishes the current catalog object as the generation identity
 * on every picker open, so a refetch that replaces the catalog object makes
 * any in-flight picker selection stale by reference.
 */
export type RuntimeCatalogPickerScope = {
  runtimeId: string;
  connectionId: string;
  protocol: 'v1';
  catalogGenerationIdentity: object | null;
};

export const RUNTIME_CATALOG_PROTOCOL_V1 = 'v1' as const;

/**
 * Decide whether a published picker scope is still current. The live view-model
 * must be in the `ready` branch and must match the scope on:
 *
 * - the runtime identity (`runtimeId` and `connectionId`),
 * - the catalog protocol version (`v1`), and
 * - the catalog generation identity by reference.
 *
 * Any mismatch means the picker is detached from the live screen state and its
 * selection must be discarded.
 */
export function isRuntimeCatalogPickerScopeCurrent(
  scope: RuntimeCatalogPickerScope,
  current: LocalSessionConfigViewModel
): boolean {
  if (current.kind !== 'ready') {
    return false;
  }
  return (
    current.runtime.runtimeId === scope.runtimeId &&
    current.runtime.connectionId === scope.connectionId &&
    current.catalogGeneration === scope.catalogGenerationIdentity
  );
}
