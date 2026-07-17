import { type AgentMode } from '@/components/agents/mode-selector';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

export type ModelPickerSelection = {
  option: SessionModelOption;
  variant: string;
};

export type ModelPickerSelectionScope = {
  sessionId: string;
  ownerConnectionId: string | null;
  protocol: 'unknown' | 'legacy' | 'v1';
  catalogGenerationIdentity: object | null;
};

type ModelPickerBridge = {
  options: SessionModelOption[];
  currentValue: string;
  currentVariant: string;
  selectionScope: ModelPickerSelectionScope;
  isSelectionCurrent: (scope: ModelPickerSelectionScope) => boolean;
  onSelect: (selection: ModelPickerSelection) => void;
};

export function areModelPickerSelectionScopesEqual(
  left: ModelPickerSelectionScope,
  right: ModelPickerSelectionScope
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.ownerConnectionId === right.ownerConnectionId &&
    left.protocol === right.protocol &&
    left.catalogGenerationIdentity === right.catalogGenerationIdentity
  );
}

type ModePickerBridge = {
  currentValue: AgentMode;
  onSelect: (mode: AgentMode) => void;
};

export type RepoOption = {
  fullName: string;
  isPrivate: boolean;
};

type RepoPickerBridge = {
  repositories: RepoOption[];
  currentValue: string;
  onSelect: (repo: string) => void;
};

/**
 * One row inside the "Run on" instance picker. Identical to the tRPC
 * `activeSessions.listInstances` output shape so the bridge can hand the
 * server payload straight to the picker without re-derivation.
 */
export type InstancePickerInstance = {
  connectionId: string;
  name: string;
  projectName: string;
  version?: string;
};

type InstancePickerBridge = {
  instances: InstancePickerInstance[];
  currentValue: InstancePickerInstance | null;
  onSelect: (instance: InstancePickerInstance | null) => void;
};

let modelBridge: ModelPickerBridge | null = null;
let modeBridge: ModePickerBridge | null = null;
let repoBridge: RepoPickerBridge | null = null;
let instanceBridge: InstancePickerBridge | null = null;

export function resolveModelPickerSelection(
  bridge: ModelPickerBridge,
  value: string,
  variant: string
): ModelPickerSelection | null {
  const option = bridge.options.find(candidate => candidate.id === value);
  if (!option) {
    return null;
  }

  return {
    option,
    variant: option.variants.includes(variant) ? variant : (option.variants[0] ?? ''),
  };
}

export function commitModelPickerSelection(
  bridge: ModelPickerBridge,
  value: string,
  variant: string
): boolean {
  if (!bridge.isSelectionCurrent(bridge.selectionScope)) {
    return false;
  }

  const selection = resolveModelPickerSelection(bridge, value, variant);
  if (!selection) {
    return false;
  }

  bridge.onSelect(selection);
  return true;
}

export function setModelPickerBridge(bridge: ModelPickerBridge) {
  modelBridge = bridge;
}
export function getModelPickerBridge() {
  return modelBridge;
}
export function clearModelPickerBridge() {
  modelBridge = null;
}

export function setModePickerBridge(bridge: ModePickerBridge) {
  modeBridge = bridge;
}
export function getModePickerBridge() {
  return modeBridge;
}
export function clearModePickerBridge() {
  modeBridge = null;
}

export function setRepoPickerBridge(bridge: RepoPickerBridge) {
  repoBridge = bridge;
}
export function getRepoPickerBridge() {
  return repoBridge;
}
export function clearRepoPickerBridge() {
  repoBridge = null;
}

export function setInstancePickerBridge(bridge: InstancePickerBridge) {
  instanceBridge = bridge;
}
export function getInstancePickerBridge() {
  return instanceBridge;
}
export function clearInstancePickerBridge() {
  instanceBridge = null;
}
