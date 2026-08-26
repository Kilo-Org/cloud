import { type AgentMode } from '@/components/agents/mode-selector';
import { type ModeOption } from '@/components/agents/mode-normalize';
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

export type ModelPickerBridge = {
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

export type ModePickerBridge = {
  currentValue: AgentMode;
  onSelect: (mode: AgentMode) => void;
  customOptions?: ModeOption[];
};

export type RepoPlatform = 'github' | 'gitlab' | 'bitbucket';

/** i18n key for each repository provider's display name (rows, closed selector, and group headers). */
export const REPO_PLATFORM_LABEL_KEYS = {
  github: 'agentChat.repoPicker.platformGithub',
  gitlab: 'agentChat.repoPicker.platformGitlab',
  bitbucket: 'agentChat.repoPicker.platformBitbucket',
} satisfies Record<RepoPlatform, string>;

export type RepoOption = {
  platform: RepoPlatform;
  fullName: string;
  isPrivate: boolean;
  workspaceUuid?: string;
  repositoryUuid?: string;
};

export type RepoPickerSection = {
  key: 'recents' | RepoPlatform;
  /** i18n key the picker resolves for the section header. */
  titleKey: string;
  repos: RepoOption[];
};

export type RepoPickerBridge = {
  repositories: RepoOption[];
  /** Grouped sections (recents, then providers) shown when the search box is empty. */
  sections: RepoPickerSection[];
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
  /** Optional capability map carried through from the tRPC row. */
  capabilities?: { attachments?: boolean };
};

export type InstancePickerBridge = {
  instances: InstancePickerInstance[];
  currentValue: InstancePickerInstance | null;
  onSelect: (instance: InstancePickerInstance | null) => void;
};

type LanguagePickerBridge = {
  beforeReload?: () => Promise<void>;
  onApplied?: () => void;
};

let languageBridge: LanguagePickerBridge | null = null;

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

export function setLanguagePickerBridge(bridge: LanguagePickerBridge) {
  languageBridge = bridge;
}

export function getLanguagePickerBridge() {
  return languageBridge;
}

export function clearLanguagePickerBridge() {
  languageBridge = null;
}
