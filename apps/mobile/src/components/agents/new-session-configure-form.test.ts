/* eslint-disable max-lines -- the form renders many mutually-exclusive target/state branches, each needing its own render case */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { type AgentMode } from '@/components/agents/mode-selector';
import {
  type NewSessionRepository,
  type RepositoryGroup,
} from '@/components/agents/new-session-repository-state';
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
const platformState = vi.hoisted(() => ({ OS: 'android' }));

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: platformState,
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('@/components/kilo-chat/app-aware-keyboard-padding', () => ({
  AppAwareKeyboardPaddingView: 'AppAwareKeyboardPaddingView',
}));

const insetsState = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insetsState,
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

vi.mock('@/components/agents/new-session-run-target', () => ({
  NewSessionRunTarget: 'NewSessionRunTarget',
}));

vi.mock('@/components/agents/folder-selector', () => ({
  LaunchFolderField: 'LaunchFolderField',
}));

vi.mock('@/components/agents/new-session-start-button', () => ({
  NewSessionStartButton: 'NewSessionStartButton',
}));

vi.mock('@/components/agents/new-session-cloud-create-error', () => ({
  NewSessionCloudCreateError: 'NewSessionCloudCreateError',
}));

vi.mock('@/components/ui/button', () => ({
  Button: 'Button',
}));
vi.mock('@/components/ui/icons', () => ({ RefreshCw: 'RefreshCw' }));

vi.mock('@/components/ui/segmented-control', () => ({
  SegmentedControl: 'SegmentedControl',
}));

// The profile row renders a real `Skeleton` (which pulls Reanimated) unless it
// is stubbed; the case below asserts on the element by type.
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

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

function findElement(node: Node, typeName: string): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') {
    return null;
  }
  const props = node.props ?? {};
  const children = props.children;
  const type = (node as { type?: unknown }).type;
  if (type === typeName) {
    return node;
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElement(child as Node, typeName);
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
  kind: 'cli',
  startedAt: null,
  gitBranch: null,
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
    onMoveAttachment: vi.fn(),
    onReorderAttachments: vi.fn(),
    onRefetchModels: vi.fn(),
    onPrefillAttachments: vi.fn(),
    shareId: undefined as string | undefined,
    voiceInputSettlerRef,
    showRunOnSelector: false,
    runOnInstance: null as InstancePickerInstance | null,
    instanceList: [] as InstancePickerInstance[],
    isLoadingInstances: false,
    isFetchingInstances: false,
    onRefreshInstances: vi.fn(),
    onChangeRunOnInstance: vi.fn(),
    showInstanceDisconnectedNote: false,
    folderPath: '',
    onChangeFolderPath: vi.fn(),
    groups: [] as RepositoryGroup[],
    isRetrying: false,
    onChangeRepo: vi.fn(),
    onConnectProvider: vi.fn(),
    onRefreshRepos: vi.fn(),
    repositories: [] as NewSessionRepository[],
    recents: [] as NewSessionRepository[],
    selectedRepo: '',
    organizationId: undefined as string | undefined,
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
  it.each([false, true])(
    'passes the target state to the run-target block while fetching=%s',
    async isFetchingInstances => {
      const { NewSessionConfigureForm: renderForm } = await import('./new-session-configure-form');
      const props = {
        ...defaultProps(),
        showRunOnSelector: true,
        runOnInstance: INSTANCE,
        isFetchingInstances,
      };
      const element = renderForm(props);
      const runTarget = findElementByType(element, 'NewSessionRunTarget');
      expect(runTarget).toMatchObject({
        showRunOnSelector: true,
        runOnInstance: INSTANCE,
        instanceList: [],
        isLoadingInstances: false,
        isFetchingInstances,
        disabled: false,
        onChangeRunOnInstance: props.onChangeRunOnInstance,
        onRefreshInstances: props.onRefreshInstances,
      });
    }
  );

  it('passes the creation busy flag as the run-target disabled state', async () => {
    const { NewSessionConfigureForm: renderForm } = await import('./new-session-configure-form');
    const element = renderForm({ ...defaultProps(), showRunOnSelector: true, isCreating: true });
    expect(findElementByType(element, 'NewSessionRunTarget')?.disabled).toBe(true);
  });

  it.each(['android', 'ios'] as const)(
    'clears the navigation bar at the screen root and lifts the body above the IME on %s',
    async os => {
      platformState.OS = os;
      insetsState.bottom = 42;
      try {
        const { NewSessionConfigureForm } = await import('./new-session-configure-form');

        // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
        const element = NewSessionConfigureForm({ ...defaultProps() }) as Node;

        // The root pads by the safe-area inset, so the pinned Start footer
        // (its child) can never render inside the navigation bar's region.
        expect(findElementByType(element, 'View')?.style).toEqual({ paddingBottom: 42 });
        // Neither platform resizes the window for the IME, so the body sits
        // inside a keyboard-lift view that adds the IME height on top of the
        // safe area — the same implementation on iOS and Android.
        expect(findElementByType(element, 'AppAwareKeyboardPaddingView')).not.toBeNull();
      } finally {
        insetsState.bottom = 0;
        platformState.OS = 'android';
      }
    }
  );

  // ── The primary action is pinned below the scroll body, never inside it ──
  it('keeps the Start action out of the scroll body so the bottom bar cannot clip it', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    insetsState.bottom = 44;
    try {
      // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
      const element = NewSessionConfigureForm({ ...defaultProps() }) as Node;

      // The form is taller than a short screen: a Start button in this content
      // sits below the visible viewport, leaving only the top of the control
      // showing above the navigation bar (the device capture).
      const scrollBody = findElement(element, 'ScrollView');
      expect(scrollBody).not.toBeNull();
      expect(findElementByType(scrollBody, 'NewSessionStartButton')).toBeNull();

      // It renders in the footer instead: a sibling of the body inside the
      // keyboard-lift view, so it is always on screen and the IME lifts it.
      const liftView = findElement(element, 'AppAwareKeyboardPaddingView');
      expect(liftView).not.toBeNull();
      expect(findElementByType(liftView, 'ScrollView')).not.toBeNull();
      expect(findElementByType(liftView, 'NewSessionStartButton')).not.toBeNull();

      // Below the body, not above it: the pinned bottom bar.
      const liftChildren = (liftView?.props as { children?: Node[] } | undefined)?.children ?? [];
      const bodyIndex = liftChildren.findIndex(
        child => (child as { type?: unknown } | undefined)?.type === 'ScrollView'
      );
      const footerIndex = liftChildren.findIndex(
        child => findElementByType(child, 'NewSessionStartButton') !== null
      );
      expect(bodyIndex).toBeGreaterThanOrEqual(0);
      expect(footerIndex).toBeGreaterThan(bodyIndex);
    } finally {
      insetsState.bottom = 0;
    }
  });

  it('keeps the cloud-create failure with the Start action it answers', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      cloudCreateError: { retryable: true, message: 'prepare failed' },
    }) as Node;

    const scrollBody = findElement(element, 'ScrollView');
    expect(scrollBody).not.toBeNull();
    // A failure the user answers at the pinned Start must not end up scrolled
    // off screen above it.
    expect(findElementByType(scrollBody, 'NewSessionCloudCreateError')).toBeNull();
    expect(findElementByType(element, 'NewSessionCloudCreateError')).not.toBeNull();
  });

  // ── Case 1: Cloud, selector shown ──
  it('renders prompt, repo, and the run-target block when cloud target with selector shown', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      showRunOnSelector: true,
    }) as Node;

    expect(findElementByType(element, 'NewSessionPrompt')).not.toBeNull();
    expect(findElementByType(element, 'NewSessionRepositorySection')).not.toBeNull();
    expect(findElementByType(element, 'NewSessionRunTarget')).toMatchObject({
      showRunOnSelector: true,
    });
  });

  // ── Case 1b: ordered repository array passes through unchanged ──
  it('passes the ordered repository array unchanged into NewSessionRepositorySection', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    const orderedRepositories: NewSessionRepository[] = [
      { platform: 'github', fullName: 'Kilo-Org/cloud', isPrivate: true },
      { platform: 'github', fullName: 'octocat/Hello-World', isPrivate: false },
      { platform: 'gitlab', fullName: 'acme/widgets', isPrivate: true },
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

  // ── Case 1c: recents pass through unchanged ──
  it('passes the recents array unchanged into NewSessionRepositorySection', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    const recentRows: NewSessionRepository[] = [
      { platform: 'github', fullName: 'Kilo-Org/cloud', isPrivate: true },
      { platform: 'gitlab', fullName: 'acme/widgets', isPrivate: true },
    ];

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      recents: recentRows,
    }) as Node;

    const section = findElementByType(element, 'NewSessionRepositorySection');
    expect(section).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(section!.recents).toEqual(recentRows);
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
  it('shows prompt and the run-target block, hides repo section, when remote target with selector shown', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: INSTANCE,
      showRunOnSelector: true,
    }) as Node;

    expect(findElementByType(element, 'NewSessionPrompt')).not.toBeNull();
    expect(findElementByType(element, 'NewSessionRepositorySection')).toBeNull();
    expect(findElementByType(element, 'NewSessionRunTarget')).toMatchObject({
      showRunOnSelector: true,
      runOnInstance: INSTANCE,
    });
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
    expect(findElementByType(element, 'NewSessionRunTarget')).toMatchObject({
      showRunOnSelector: false,
      runOnInstance: INSTANCE,
    });
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

    const startButton = findElementByType(element, 'NewSessionStartButton');
    expect(startButton?.isStarting).toBe(true);
  });

  it('shows spinner for cloud session creation', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      isCreating: true,
    }) as Node;

    const startButton = findElementByType(element, 'NewSessionStartButton');
    expect(startButton?.isStarting).toBe(true);
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

    const startButton = findElementByType(element, 'NewSessionStartButton');
    expect(startButton?.isStarting).toBe(false);
  });

  // ── Case 7: remote target keeps its context in the selector value ──
  it('passes the remote target and loading flag to the run-target block', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: INSTANCE,
      showRunOnSelector: true,
      isLoadingInstances: true,
    }) as Node;

    const runTarget = findElementByType(element, 'NewSessionRunTarget');
    expect(runTarget).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(runTarget!.runOnInstance).toBe(INSTANCE);
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion
    expect(runTarget!.isLoadingInstances).toBe(true);
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

  it('explains the pending environment request without hiding the form or showing a default', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      isProfileLoading: true,
      isStartDisabled: true,
    }) as Node;

    expect(findTextContent(element, t => t === 'Environment')).toBe(true);
    expect(findTextContent(element, t => t === 'Loading…')).toBe(true);
    expect(findTextContent(element, t => t === 'Default environment')).toBe(false);
    expect(findElementByType(element, 'Skeleton')).not.toBeNull();
    expect(findElementByType(element, 'NewSessionPrompt')?.isCreating).toBe(false);
    expect(findElementByType(element, 'NewSessionStartButton')?.isStartDisabled).toBe(true);
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
    // The help draws the commands as prose: the authoring markers must not
    // reach the screen.
    expect(findTextContent(cloud, t => t.includes('`'))).toBe(false);

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const remote = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: INSTANCE,
      showRunOnSelector: false,
    }) as Node;
    expect(findTextContent(remote, t => t.includes('kilo remote') && t.includes('/remote'))).toBe(
      true
    );
    expect(findTextContent(remote, t => t.includes('`'))).toBe(false);
  });

  // ── Case 14: reorder wiring lock ──
  it('wires onMoveAttachment and onReorderAttachments through to NewSessionPrompt', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');

    const onMoveAttachment = vi.fn<(id: string, direction: 'left' | 'right') => void>();
    const onReorderAttachments = vi.fn<(fromIndex: number, toIndex: number) => void>();
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionConfigureForm({
      ...defaultProps(),
      onMoveAttachment,
      onReorderAttachments,
    }) as Node;

    const prompt = findElementByType(element, 'NewSessionPrompt');
    expect(prompt).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(prompt!.onMoveAttachment).toBe(onMoveAttachment);
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(prompt!.onReorderAttachments).toBe(onReorderAttachments);
  });

  // ── Case 14: a cloud-create failure belongs to the cloud target only ──
  it('renders the cloud-create error on the cloud target but not on a remote one', async () => {
    const { NewSessionConfigureForm } = await import('./new-session-configure-form');
    const cloudCreateError = { retryable: true, message: 'prepare failed' };

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const cloud = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: null,
      cloudCreateError,
    }) as Node;
    expect(findElementByType(cloud, 'NewSessionCloudCreateError')).not.toBeNull();

    // Switching the target to a computer must not surface the stale failure.
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const remote = NewSessionConfigureForm({
      ...defaultProps(),
      runOnInstance: INSTANCE,
      cloudCreateError,
    }) as Node;
    expect(findElementByType(remote, 'NewSessionCloudCreateError')).toBeNull();
  });
});
