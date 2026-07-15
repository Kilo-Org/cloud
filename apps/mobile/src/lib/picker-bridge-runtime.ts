import { type LocalRuntime } from '@/lib/hooks/runtime-discovery-logic';

import { type LocalRuntimeFence } from '@/lib/hooks/local-runtime-catalog-types';

/**
 * Runtime picker bridge: the screen publishes the live runtime list and the
 * exact fence the user is currently drafting a selection for, and the picker
 * UI calls `commitRuntimePickerSelection` when the user taps a row. The scope
 * is the draft identity of the selection itself (the candidate fence) — when
 * the underlying runtime list refreshes underneath the picker, the draft
 * fence is no longer "current" and a tap must be discarded.
 */
export type RuntimePickerSelectionScope = {
  runtimeId: string;
  connectionId: string;
};

type RuntimePickerBridge = {
  runtimes: LocalRuntime[];
  currentFence: LocalRuntimeFence | null;
  selectionScope: RuntimePickerSelectionScope | null;
  isSelectionCurrent: (scope: RuntimePickerSelectionScope | null) => boolean;
  onSelect: (fence: LocalRuntimeFence) => void;
};

export function areRuntimePickerSelectionScopesEqual(
  left: RuntimePickerSelectionScope,
  right: RuntimePickerSelectionScope
): boolean {
  return left.runtimeId === right.runtimeId && left.connectionId === right.connectionId;
}

let runtimeBridge: RuntimePickerBridge | null = null;

/**
 * Resolve a draft runtime fence against the live runtime list. Returns
 * `null` when the candidate fence is not in the list (the runtime
 * disconnected or its connectionId changed underneath the picker). The
 * caller is expected to call `commitRuntimePickerSelection`, which uses
 * this helper internally and additionally checks scope staleness.
 */
export function resolveRuntimePickerSelection(
  bridge: RuntimePickerBridge,
  runtimeId: string,
  connectionId: string
): LocalRuntimeFence | null {
  const runtime = bridge.runtimes.find(
    candidate => candidate.runtimeId === runtimeId && candidate.connectionId === connectionId
  );
  if (!runtime) {
    return null;
  }
  return { runtimeId: runtime.runtimeId, connectionId: runtime.connectionId };
}

/**
 * Commit a runtime picker tap. Discards the tap when the draft scope is no
 * longer current or the candidate fence is not in the live list. Returns
 * `true` only when the bridge's `onSelect` was actually invoked.
 */
export function commitRuntimePickerSelection(
  bridge: RuntimePickerBridge,
  runtimeId: string,
  connectionId: string
): boolean {
  if (!bridge.selectionScope || !bridge.isSelectionCurrent(bridge.selectionScope)) {
    return false;
  }
  const fence = resolveRuntimePickerSelection(bridge, runtimeId, connectionId);
  if (!fence) {
    return false;
  }
  bridge.onSelect(fence);
  return true;
}

export function setRuntimePickerBridge(bridge: RuntimePickerBridge) {
  runtimeBridge = bridge;
}
export function getRuntimePickerBridge() {
  return runtimeBridge;
}
export function clearRuntimePickerBridge() {
  runtimeBridge = null;
}
