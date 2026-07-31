import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { type AgentMode } from '@/components/agents/mode-selector';
import { type RepositorySectionView } from '@/components/agents/new-session-repository-state';
import { REMOTE_SPAWN_INSTANCE_DISCONNECTED_NOTE } from '@/lib/remote-submit-outcome';

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
  NewSessionPrompt: () => null,
}));

vi.mock('@/components/agents/instance-selector', () => ({
  InstanceSelector: () => null,
}));

vi.mock('@/components/agents/new-session-repository-section', () => ({
  NewSessionRepositorySection: () => null,
}));

vi.mock('@/components/ui/button', () => ({
  Button: 'Button',
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
    runOnInstance: null,
    instanceList: [],
    isLoadingInstances: false,
    onChangeRunOnInstance: vi.fn(),
    showInstanceDisconnectedNote: false,
    view: 'loading' as RepositorySectionView,
    isRetrying: false,
    onChangeRepo: vi.fn(),
    onOpenGitHubIntegration: vi.fn(),
    onRefreshRepos: vi.fn(),
    repositories: [],
    selectedRepo: '',
    isStartDisabled: false,
    onStartSession: vi.fn(),
  };
}

describe('NewSessionCloudForm disconnected note', () => {
  it('renders the disconnected note when showRunOnSelector is hidden', async () => {
    const { NewSessionCloudForm } = await import('./new-session-cloud-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionCloudForm({
      ...defaultProps(),
      showRunOnSelector: false,
      showInstanceDisconnectedNote: true,
    }) as Node;

    expect(findTextContent(element, t => t.includes('disconnected'))).toBe(true);
    expect(findTextContent(element, t => t === REMOTE_SPAWN_INSTANCE_DISCONNECTED_NOTE)).toBe(true);
  });

  it('does not render the disconnected note when showInstanceDisconnectedNote is false', async () => {
    const { NewSessionCloudForm } = await import('./new-session-cloud-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionCloudForm({
      ...defaultProps(),
      showRunOnSelector: false,
      showInstanceDisconnectedNote: false,
    }) as Node;

    expect(findTextContent(element, t => t === REMOTE_SPAWN_INSTANCE_DISCONNECTED_NOTE)).toBe(
      false
    );
  });

  it('renders the disconnected note even when showRunOnSelector is true', async () => {
    const { NewSessionCloudForm } = await import('./new-session-cloud-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionCloudForm({
      ...defaultProps(),
      showRunOnSelector: true,
      showInstanceDisconnectedNote: true,
    }) as Node;

    expect(findTextContent(element, t => t === REMOTE_SPAWN_INSTANCE_DISCONNECTED_NOTE)).toBe(true);
  });
});
