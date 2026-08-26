/* eslint-disable max-lines -- the form renders many mutually-exclusive target/state branches, each needing its own render case */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { type AgentMode } from '@/components/agents/mode-selector';
import { type RepositorySectionView } from '@/components/agents/new-session-repository-state';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { remoteSpawnInstanceDisconnectedNote } from '@/lib/remote-submit-outcome';

import '@/i18n';
import type * as ReactI18next from 'react-i18next';

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

// ── React hooks ────────────────────────────────────────────────────
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useCallback: vi.fn(<T extends (...args: never[]) => unknown>(fn: T) => fn),
    useEffect: vi.fn((fn: React.EffectCallback) => {
      fn();
    }),
    useRef: vi.fn(<T>(initial: T) => {
      const ref: React.RefObject<T> = { current: initial };
      return ref;
    }),
    useState: vi.fn(<T>(initial: T) => [initial, vi.fn() as () => void] as [T, (value: T) => void]),
  };
});

// ── react-native ───────────────────────────────────────────────────
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  ScrollView: 'ScrollView',
  View: 'View',
}));

// ── sub-components ─────────────────────────────────────────────────
vi.mock('@/components/agents/new-session-prompt', () => ({
  NewSessionPrompt: 'NewSessionPrompt',
}));

vi.mock('@/components/agents/instance-selector', () => ({
  InstanceSelector: 'InstanceSelector',
}));

vi.mock('@/components/agents/new-session-repository-section', () => ({
  NewSessionRepositorySection: 'NewSessionRepositorySection',
}));

vi.mock('@/components/ui/button', () => ({
  Button: 'Button',
}));

vi.mock('@/components/ui/segmented-control', () => ({
  SegmentedControl: 'SegmentedControl',
}));

vi.mock('@/components/ui/text', () => ({
  Text: ({ children }: { children?: unknown }) => children,
}));

// ── hooks ──────────────────────────────────────────────────────────
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000',
    mutedForeground: '#666',
    primaryForeground: '#fff',
  }),
}));

// ── helpers ────────────────────────────────────────────────────────
type Node = { props?: Record<string, unknown> } | null | undefined | string | number | boolean;

function findTextContent(node: Node, predicate: (text: string) => boolean): boolean {
  if (typeof node === 'string') {
    return predicate(node);
  }
  if (node === null || typeof node !== 'object') {
    return false;
  }
  const props = node.props ?? {};
  if (typeof props.children === 'string' && predicate(props.children)) {
    return true;
  }
  const children = props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    if (findTextContent(child as Node, predicate)) {
      return true;
    }
  }
  return false;
}

function findElementByType(node: Node, typeName: string): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') {
    return null;
  }
  const props = node.props ?? {};
  const children = props.children;
  const type = (node as { type?: unknown }).type;
  if (type === typeName) {
    return node.props ?? {};
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElementByType(child as Node, typeName);
    if (found) {
      return found;
    }
  }
  return null;
}

const INSTANCE: InstancePickerInstance = {
  connectionId: 'conn-abc',
  name: 'laptop',
  projectName: 'kilo',
};

function defaultProps() {
  const voiceInputSettlerRef: React.RefObject<(() => Promise<boolean>) | null> = {
    current: null,
  };
  return {
    attachments: [] as never[],
    attachmentMax: 5,
    isCreating: false,
    isModelsError: false,
    isLoadingModels: false,
    mode: 'code' as AgentMode,
    model: 'anthropic/claude-sonnet-4',
    variant: 'medium',
    modelOptions: [] as never[],
    onChangeText: vi.fn(),
    onModeChange: vi.fn(),
    onModelSelect: vi.fn(),
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onRetryAttachment: vi.fn(),
    onRefetchModels: vi.fn(),
    onPrefillAttachments: vi.fn(),
    shareId: undefined as string | undefined,
    voiceInputSettlerRef,
    showRunOnSelector: false,
    runOnInstance: null as InstancePickerInstance | null,
    instanceList: [] as InstancePickerInstance[],
    isLoadingInstances: false,
    onChangeRunOnInstance: vi.fn(),
    showInstanceDisconnectedNote: false,
    view: 'loading' as RepositorySectionView,
    isRetrying: false,
    onChangeRepo: vi.fn(),
    onOpenGitHubIntegration: vi.fn(),
    onRefreshRepos: vi.fn(),
    repositories: [] as { fullName: string; isPrivate: boolean }[],
    selectedRepo: '',
    profile: null as {
      id: string;
      name: string;
      commandCount: number;
      mcpServerCount: number;
      skillCount: number;
      agentCount: number;
    } | null,
    isProfileLoading: false,
    isProfileError: false,
    onRetryProfile: vi.fn(),
    autoCommit: false,
    onAutoCommitChange: vi.fn(),
    isSpawningRemote: false,
    isStartDisabled: false,
    onStartSession: vi.fn(),
  };
}

describe('NewSessionConfigureForm', () => {
  // ── Case 1: Cloud, selector shown ──
  it('renders prompt, repo, and "Run on" label when cloud target with selector shown', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      showRunOnSelector: true,
    }) as Node;

    expect(findElementByType(element, 'NewSessionPrompt')).not.toBeNull();
    expect(findElementByType(element, 'NewSessionRepositorySection')).not.toBeNull();
    expect(findTextContent(element, t => t === 'Run on')).toBe(true);
    expect(findTextContent(element, t => t === 'Run on: ')).toBe(false);
  });

  // ── Case 1b: ordered repository array passes through unchanged ──
  it('passes the ordered repository array unchanged into NewSessionRepositorySection', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    const orderedRepositories = [
      { fullName: 'Kilo-Org/cloud', isPrivate: true },
      { fullName: 'octocat/Hello-World', isPrivate: false },
      { fullName: 'acme/widgets', isPrivate: true },
    ];

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      repositories: orderedRepositories,
    }) as Node;

    const section = findElementByType(element, 'NewSessionRepositorySection');
    expect(section).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(section!.repositories).toEqual(orderedRepositories);
  });

  // ── Case 2: Cloud, selector hidden ──
  it('renders prompt and repo, no run-target block, when cloud target with selector hidden', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      showRunOnSelector: false,
    }) as Node;

    expect(findElementByType(element, 'NewSessionPrompt')).not.toBeNull();
    expect(findElementByType(element, 'NewSessionRepositorySection')).not.toBeNull();
    expect(findTextContent(element, t => t === 'Run on')).toBe(false);
    expect(findTextContent(element, t => t === 'Run on: ')).toBe(false);
  });

  // ── Case 3: Remote, selector shown ──
  it('shows prompt and "Run on" label, hides repo section, when remote target with selector shown', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: INSTANCE,
      showRunOnSelector: true,
    }) as Node;

    expect(findElementByType(element, 'NewSessionPrompt')).not.toBeNull();
    expect(findElementByType(element, 'NewSessionRepositorySection')).toBeNull();
    expect(findTextContent(element, t => t === 'Run on')).toBe(true);
    expect(findTextContent(element, t => t === 'Run on: ')).toBe(false);
  });

  // ── Case 4: Remote, selector hidden ──
  it('shows muted context line and prompt, hides repo section, when remote target with selector hidden', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: INSTANCE,
      showRunOnSelector: false,
    }) as Node;

    expect(findElementByType(element, 'NewSessionPrompt')).not.toBeNull();
    expect(findElementByType(element, 'NewSessionRepositorySection')).toBeNull();
    expect(findTextContent(element, t => t === 'Run on: laptop · kilo')).toBe(true);
  });

  // ── Case 5: Disconnected note — three contracts ──
  it('renders the disconnected note when showInstanceDisconnectedNote is true and selector is hidden', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      showInstanceDisconnectedNote: true,
      runOnInstance: null,
      showRunOnSelector: false,
    }) as Node;

    expect(findTextContent(element, t => t === remoteSpawnInstanceDisconnectedNote())).toBe(true);
  });

  it('does not render the disconnected note when showInstanceDisconnectedNote is false', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      showInstanceDisconnectedNote: false,
      runOnInstance: null,
      showRunOnSelector: false,
    }) as Node;

    expect(findTextContent(element, t => t === remoteSpawnInstanceDisconnectedNote())).toBe(false);
  });

  it('renders the disconnected note even when showRunOnSelector is true', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      showInstanceDisconnectedNote: true,
      runOnInstance: null,
      showRunOnSelector: true,
    }) as Node;

    expect(findTextContent(element, t => t === remoteSpawnInstanceDisconnectedNote())).toBe(true);
  });

  // ── Case 6: Start spinner switch ──
  it('shows spinner for remote spawn in flight', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: INSTANCE,
      isSpawningRemote: true,
    }) as Node;

    expect(findElementByType(element, 'ActivityIndicator')).not.toBeNull();
  });

  it('shows spinner for cloud session creation', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      isCreating: true,
    }) as Node;

    expect(findElementByType(element, 'ActivityIndicator')).not.toBeNull();
  });

  it('does not show spinner when neither flag is set', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      isCreating: false,
      isSpawningRemote: false,
    }) as Node;

    expect(findElementByType(element, 'ActivityIndicator')).toBeNull();
  });

  // ── Case 7: remote target keeps its context in the selector value ──
  it('passes the remote target and loading flag to the selector', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: INSTANCE,
      showRunOnSelector: true,
      isLoadingInstances: true,
    }) as Node;

    const selector = findElementByType(element, 'InstanceSelector');
    expect(selector).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(selector!.value).toBe(INSTANCE);
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion
    expect(selector!.isLoading).toBe(true);
    expect(findElementByType(element, 'NewSessionPrompt')).not.toBeNull();
    expect(findElementByType(element, 'NewSessionRepositorySection')).toBeNull();
  });

  // ── Case 8: prompt carry-over survives a target switch back to cloud ──
  it('seeds the prompt with initialPrompt when the cloud target renders', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      showRunOnSelector: true,
      initialPrompt: 'carried across the switch',
    }) as Node;

    const prompt = findElementByType(element, 'NewSessionPrompt');
    expect(prompt).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(prompt!.initialPrompt).toBe('carried across the switch');
  });

  // ── Case 9: remote target forwards spawn-flag as isCreating ──
  it('passes isSpawningRemote as isCreating on NewSessionPrompt for a remote target', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: INSTANCE,
      isSpawningRemote: true,
    }) as Node;

    const prompt = findElementByType(element, 'NewSessionPrompt');
    expect(prompt).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(prompt!.isCreating).toBe(true);
  });

  // ── Case 10: effective profile row ──
  it('renders the profile name and capability counts when a profile resolves', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      profile: {
        id: 'profile-1',
        name: 'Production',
        commandCount: 3,
        mcpServerCount: 1,
        skillCount: 2,
        agentCount: 4,
      },
    }) as Node;

    expect(findTextContent(element, t => t === 'Production')).toBe(true);
    expect(findTextContent(element, t => t === '3 commands · 1 MCP · 2 skills · 4 agents')).toBe(
      true
    );
  });

  it('renders "Default environment" when no profile resolves', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      profile: null,
    }) as Node;

    expect(findTextContent(element, t => t === 'Default environment')).toBe(true);
    expect(findTextContent(element, t => t === 'Production')).toBe(false);
  });

  it('renders an inline error with Retry when the profile query fails', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      isProfileError: true,
    }) as Node;

    expect(findTextContent(element, t => t.includes("Couldn't load"))).toBe(true);
    expect(findTextContent(element, t => t === 'Retry')).toBe(true);
  });

  it('hides the environment row while the profile query is loading', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      isProfileLoading: true,
    }) as Node;

    expect(findTextContent(element, t => t === 'Environment')).toBe(false);
    expect(findTextContent(element, t => t === 'Default environment')).toBe(false);
  });

  it('does not render the environment row for a remote target', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: INSTANCE,
      profile: {
        id: 'profile-1',
        name: 'Production',
        commandCount: 3,
        mcpServerCount: 1,
        skillCount: 2,
        agentCount: 4,
      },
    }) as Node;

    expect(findTextContent(element, t => t === 'Environment')).toBe(false);
    expect(findTextContent(element, t => t === 'Production')).toBe(false);
  });

  // ── Case 11: commit choice (cloud-only, default Leave) ──
  it('renders the commit control as Leave changes by default for a cloud target', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      autoCommit: false,
    }) as Node;

    const control = findElementByType(element, 'SegmentedControl');
    expect(control).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(control!.value).toBe('leave');
    expect(findTextContent(element, t => t === 'Changes')).toBe(true);
  });

  it('renders the commit control as Commit and push when autoCommit is true', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      autoCommit: true,
    }) as Node;

    const control = findElementByType(element, 'SegmentedControl');
    expect(control).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(control!.value).toBe('commit');
  });

  it('does not render the commit control for a remote target', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: INSTANCE,
    }) as Node;

    expect(findElementByType(element, 'SegmentedControl')).toBeNull();
    expect(findTextContent(element, t => t === 'Changes')).toBe(false);
  });

  // ── Case 12: kilo remote hint ──
  it('names both `kilo remote` and `/remote` for cloud and remote targets', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const cloud = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      showRunOnSelector: true,
    }) as Node;
    expect(findTextContent(cloud, t => t.includes('kilo remote') && t.includes('/remote'))).toBe(
      true
    );

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const remote = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: INSTANCE,
      showRunOnSelector: false,
    }) as Node;
    expect(findTextContent(remote, t => t.includes('kilo remote') && t.includes('/remote'))).toBe(
      true
    );
  });
});
