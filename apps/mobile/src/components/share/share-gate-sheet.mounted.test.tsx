/* eslint-disable max-lines -- test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx), and this suite's per-state spawn wiring cases exceed the line cap (same carve-out as share-gate-sheet.tsx) */
// P1-A-08b: the share gate must attach one hoisted `operationKey` per
// share-spawn intent (share + instance) to the `spawn` call, keep it across
// retryable outcomes (the relay dedupes the same-key retry), and rotate it
// on a terminal outcome (a `ready` spawn — even when commit navigation is
// suppressed — or a typed non-retryable rejection). This suite mounts the
// real `ShareGateSheet` with every RN-touching dependency stubbed and drives
// the spawn via the list's captured `onSpawnInstance` prop.

import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  remoteSpawnNonRetryableToast,
  remoteSpawnRetryableToast,
} from '@/lib/remote-submit-outcome';
import {
  __resetPendingShareNavigationForTests,
  takePendingShareNavigation,
} from '@/lib/share-navigation';
import { i18n } from '@/i18n';
import {
  __resetSharePayloadStoreForTests,
  peekSharePayload,
  putSharePayload,
} from '@/lib/share-payload';
import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { type CreateSessionOutcome } from '@/lib/hooks/remote-instance-spawn-classifier';
import type * as sharePayloadModule from '@/lib/share-payload';
import { type ShareCliSpawnRow } from './share-cli-spawn';
import { ShareGateSheet } from './share-gate-sheet';

const spawnMock = vi.hoisted(() =>
  vi.fn(
    // eslint-disable-next-line require-await, typescript-eslint/require-await -- mock returns a settled outcome without awaiting
    async (
      _connectionId: string,
      _opts?: unknown,
      _options?: unknown
    ): Promise<CreateSessionOutcome> => ({
      status: 'retryable',
      reason: 'Connection destroyed',
      cause: new Error('Connection destroyed'),
    })
  )
);
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
const toastError = vi.hoisted(() => vi.fn());
const routerBack = vi.hoisted(() => vi.fn());
const refetchInstancesMock = vi.hoisted(() => vi.fn(() => undefined));
const alertMock = vi.hoisted(() => vi.fn());
const shareDestinationListProps = vi.hoisted(() => ({
  current: null as {
    onSpawnInstance: (row: ShareCliSpawnRow) => void;
    instanceRowsDisabled: boolean;
  } | null,
}));
const instanceRows = vi.hoisted((): ShareCliSpawnRow[] => [
  {
    connectionId: 'conn-1',
    name: 'laptop',
    projectName: 'kilo',
    kind: 'cli',
    startedAt: null,
    gitBranch: null,
  },
]);

vi.mock('react-native', () => ({
  Alert: { alert: alertMock },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: routerBack }),
}));
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('@/components/ui/icons', () => ({
  GitPullRequest: 'GitPullRequest',
  Plus: 'Plus',
  X: 'X',
}));
vi.mock('sonner-native', () => ({
  toast: { error: toastError },
}));
vi.mock('@/components/ui/button', () => ({
  Button: 'Button',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({}),
}));
const organizationMock = vi.hoisted(() => ({
  current: { organizationId: null as string | null, isLoaded: true },
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => organizationMock.current,
}));
const organizationsListMock = vi.hoisted(() => ({
  current: {
    data: [{ organizationId: 'org-selected' }] as { organizationId: string }[] | undefined,
    isFetched: true,
    isError: false,
  },
}));
vi.mock('@/lib/hooks/use-organizations-list', () => ({
  useOrganizationsList: () => organizationsListMock.current,
}));
const sessionsMock = vi.hoisted(() => ({
  current: {
    storedSessions: [],
    activeSessionIds: new Set<string>(),
    activeSessions: [],
    storedIsError: false,
    storedIsSuccess: true,
    storedIsPaused: false,
    storedErrorCode: undefined as string | undefined,
    activeIsError: false,
    activeIsPaused: false,
    isLoading: false,
    refetch: vi.fn(),
  },
}));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useAgentSessions: () => sessionsMock.current,
}));
vi.mock('@/lib/hooks/use-remote-instance-spawn', () => ({
  useRemoteInstanceSpawn: () => ({ spawn: spawnMock }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    activeSessions: { listInstances: { queryOptions: () => ({ queryKey: ['instances'] }) } },
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { instances: instanceRows }, refetch: refetchInstancesMock }),
}));
vi.mock('expo-crypto', () => {
  let n = 0;
  return {
    randomUUID: () => {
      n += 1;
      return `uuid-${n}`;
    },
  };
});
// The real `share-payload.ts` pulls `registerTempFile` from
// `@/lib/temp-file-registry`, which imports the modern `expo-file-system` API.
// Mock the main entry so the `importOriginal()` chain in the
// `@/lib/share-payload` mock stays harmless.
vi.mock('expo-file-system', () => {
  const File = vi.fn(function FileMock(_base: unknown, ..._rest: unknown[]) {
    return {
      uri: 'file:///cache/temp-file-registry.json',
      exists: false,
      write: vi.fn(),
      textSync: vi.fn(() => ''),
      delete: vi.fn(),
    };
  });
  return {
    File,
    Paths: { cache: { uri: 'file:///cache' } },
  };
});
vi.mock('expo-share-intent', () => ({}));
// Wrap only `peekSharePayload` so the tests can force a single settle-time
// miss (a cleared payload) while the real store keeps staging. Everything
// else in the module stays the real implementation.
vi.mock('@/lib/share-payload', async importOriginal => {
  const actual = await importOriginal<typeof sharePayloadModule>();
  return {
    ...actual,
    peekSharePayload: vi.fn(actual.peekSharePayload),
  };
});
vi.mock('@/components/agents/session-list-helpers', () => ({
  expandPlatformFilter: (value: unknown) => value,
}));
vi.mock('./share-payload-preview', () => ({
  SharePayloadPreview: 'SharePayloadPreview',
}));
// Deterministic validation: no file measuring, no upload-task dynamic import.
vi.mock('./share-payload-validation', () => ({
  validateSharePayload: () => ({
    kind: 'ok' as const,
    accepted: [],
    rejectedNotes: [],
    truncated: false,
    usable: true,
  }),
}));
// Capture the list props so tests drive `onSpawnInstance` directly.
vi.mock('./share-destination-list', () => ({
  ShareDestinationList: (props: {
    onSpawnInstance: (row: ShareCliSpawnRow) => void;
    instanceRowsDisabled: boolean;
    headerContent: ReactNode;
  }): ReactNode => {
    shareDestinationListProps.current = props;
    return props.headerContent;
  },
}));

const INSTANCE: ShareCliSpawnRow = {
  connectionId: 'conn-1',
  name: 'laptop',
  projectName: 'kilo',
  kind: 'cli',
  startedAt: null,
  gitBranch: null,
};

function retryableOutcome() {
  return {
    status: 'retryable' as const,
    reason: 'Connection destroyed',
    cause: new Error('Connection destroyed'),
  };
}

function readyOutcome(): CreateSessionOutcome {
  return {
    status: 'ready',
    sessionID: 'ses_12345678901234567890123456' as KiloSessionId,
  };
}

function nonRetryableOutcome() {
  return {
    status: 'nonRetryable' as const,
    reason: 'CLI_UPGRADE_REQUIRED',
    cause: new Error('CLI_UPGRADE_REQUIRED'),
  };
}

async function mountGate(shareId: string): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(ShareGateSheet, { shareId }));
  });
  // Flush the async payload-validation effect so `commitEnabled` flips true
  // (and the instance rows stop being disabled) before any press.
  await act(async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function captureListProps(): {
  onSpawnInstance: (row: ShareCliSpawnRow) => void;
  instanceRowsDisabled: boolean;
} {
  const props = shareDestinationListProps.current;
  if (!props) {
    throw new Error('ShareDestinationList was not rendered');
  }
  return props;
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

async function pressSpawn(onSpawnInstance: (row: ShareCliSpawnRow) => void): Promise<void> {
  act(() => {
    onSpawnInstance(INSTANCE);
  });
  await flushAsync();
}

function usedOperationKeys(): (string | undefined)[] {
  return spawnMock.mock.calls.map(
    call => (call[2] as { operationKey?: string } | undefined)?.operationKey
  );
}

describe('ShareGateSheet spawn operationKey wiring', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    spawnMock.mockResolvedValue(retryableOutcome());
    toastError.mockClear();
    routerBack.mockClear();
    refetchInstancesMock.mockClear();
    alertMock.mockClear();
    shareDestinationListProps.current = null;
    vi.mocked(peekSharePayload).mockClear();
    __resetSharePayloadStoreForTests();
    __resetPendingShareNavigationForTests();
  });

  it('passes the hoisted operationKey to spawn on a CLI instance press', async () => {
    const shareId = putSharePayload({ text: 'hello', files: [], failedFiles: [] });
    const renderer = await mountGate(shareId);
    const list = captureListProps();
    expect(list.instanceRowsDisabled).toBe(false);

    await pressSpawn(list.onSpawnInstance);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith('conn-1', undefined, {
      operationKey: expect.any(String),
    });

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the same operationKey across retryable spawn outcomes', async () => {
    const shareId = putSharePayload({ text: 'hello', files: [], failedFiles: [] });
    const renderer = await mountGate(shareId);
    const list = captureListProps();

    await pressSpawn(list.onSpawnInstance);
    await pressSpawn(list.onSpawnInstance);

    const keys = usedOperationKeys();
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
    expect(toastError).toHaveBeenCalledWith(remoteSpawnRetryableToast());
    expect(refetchInstancesMock).toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });

  it('rotates the operationKey after a ready spawn commit navigation', async () => {
    const shareId = putSharePayload({ text: 'hello', files: [], failedFiles: [] });
    const renderer = await mountGate(shareId);
    const list = captureListProps();

    spawnMock
      .mockResolvedValueOnce(retryableOutcome())
      .mockResolvedValueOnce(readyOutcome())
      .mockResolvedValueOnce(retryableOutcome());

    await pressSpawn(list.onSpawnInstance);
    await pressSpawn(list.onSpawnInstance);
    await pressSpawn(list.onSpawnInstance);

    const keys = usedOperationKeys();
    // The ready attempt rides the key from the retryable attempt.
    expect(keys[1]).toBe(keys[0]);
    // The press after ready is a fresh intent with a fresh key.
    expect(keys[2]).not.toBe(keys[0]);
    expect(routerBack).toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });

  it('rotates the operationKey on a suppressed ready spawn before a later eligible spawn', async () => {
    const shareId = putSharePayload({ text: 'hello', files: [], failedFiles: [] });
    const renderer = await mountGate(shareId);
    const list = captureListProps();

    // 19b: the user dismissed mid-spawn, so the settle-time payload lookup
    // misses even though the ready outcome arrived. Navigation is suppressed.
    spawnMock.mockResolvedValueOnce(readyOutcome());
    vi.mocked(peekSharePayload).mockReturnValueOnce(null);
    await pressSpawn(list.onSpawnInstance);
    expect(routerBack).not.toHaveBeenCalled();

    // A later eligible spawn (payload staged again) must be a fresh intent
    // with a fresh key, not a replay of the settled key.
    spawnMock.mockResolvedValueOnce(readyOutcome());
    await pressSpawn(list.onSpawnInstance);

    const keys = usedOperationKeys();
    expect(keys[0]).toBeDefined();
    expect(keys[1]).not.toBe(keys[0]);
    expect(routerBack).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('rotates the operationKey after a typed non-retryable spawn rejection', async () => {
    const shareId = putSharePayload({ text: 'hello', files: [], failedFiles: [] });
    const renderer = await mountGate(shareId);
    const list = captureListProps();

    spawnMock
      .mockResolvedValueOnce(nonRetryableOutcome())
      .mockResolvedValueOnce(nonRetryableOutcome());

    await pressSpawn(list.onSpawnInstance);
    await pressSpawn(list.onSpawnInstance);

    const keys = usedOperationKeys();
    expect(keys[0]).toBeDefined();
    expect(keys[1]).not.toBe(keys[0]);
    expect(toastError).toHaveBeenCalledWith(remoteSpawnNonRetryableToast());
    // A non-retryable rejection must not refetch or navigate.
    expect(refetchInstancesMock).not.toHaveBeenCalled();
    expect(routerBack).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });

  it('numbers a staged GitLab merge request with the provider separator', async () => {
    const shareId = putSharePayload({
      text: 'https://gitlab.com/group/sub/repo/-/merge_requests/7',
      files: [],
      failedFiles: [],
    });
    const renderer = await mountGate(shareId);

    // The Review PR row is the row whose subtitle is the destination identity.
    const subtitles = renderer.root
      .findAllByType('Text')
      .filter(node => node.props.className === 'text-sm text-muted-foreground')
      .map(node => node.children.filter(child => typeof child === 'string').join(''));
    expect(subtitles).toEqual(['group/sub/repo!7']);

    act(() => {
      renderer.unmount();
    });
  });
});

describe('ShareGateSheet new-session organization', () => {
  beforeEach(() => {
    routerBack.mockClear();
    shareDestinationListProps.current = null;
    organizationMock.current = { organizationId: 'org-selected', isLoaded: true };
    organizationsListMock.current = {
      data: [{ organizationId: 'org-selected' }],
      isFetched: true,
      isError: false,
    };
    sessionsMock.current = {
      ...sessionsMock.current,
      storedErrorCode: undefined,
    };
    __resetSharePayloadStoreForTests();
    __resetPendingShareNavigationForTests();
  });

  async function commitNewSession(shareId: string): Promise<string> {
    const renderer = await mountGate(shareId);
    const row = renderer.root.find(
      node =>
        node.props.accessibilityRole === 'button' &&
        node.props.accessibilityLabel === i18n.t('common.newSession')
    );
    const onPress: unknown = row.props.onPress;
    if (typeof onPress !== 'function') {
      throw new TypeError('the New session row has no press handler');
    }
    act(() => {
      (onPress as () => void)();
    });
    await flushAsync();
    const pending = takePendingShareNavigation();
    act(() => {
      renderer.unmount();
    });
    if (pending === null) {
      throw new TypeError('the gate did not commit a destination');
    }
    return pending.href;
  }

  it('commits into the selected organization while the account holds it', async () => {
    const shareId = putSharePayload({ text: 'hello', files: [], failedFiles: [] });

    const href = await commitNewSession(shareId);

    expect(href).toContain('/agent-chat/new?organizationId=org-selected');
    expect(href).toContain(`shareId=${shareId}`);
  });

  it('commits into the account default when the selected organization denies access', async () => {
    organizationMock.current = { organizationId: 'org-lost', isLoaded: true };
    organizationsListMock.current = {
      data: [{ organizationId: 'org-first' }, { organizationId: 'org-second' }],
      isFetched: true,
      isError: false,
    };
    sessionsMock.current = { ...sessionsMock.current, storedErrorCode: 'UNAUTHORIZED' };
    const shareId = putSharePayload({ text: 'hello', files: [], failedFiles: [] });

    const href = await commitNewSession(shareId);

    expect(href).toContain('organizationId=org-first');
    expect(href).not.toContain('org-lost');
  });

  it('commits personal when the account holds no other organization', async () => {
    organizationMock.current = { organizationId: 'org-lost', isLoaded: true };
    organizationsListMock.current = { data: [], isFetched: true, isError: false };
    sessionsMock.current = { ...sessionsMock.current, storedErrorCode: 'FORBIDDEN' };
    const shareId = putSharePayload({ text: 'hello', files: [], failedFiles: [] });

    const href = await commitNewSession(shareId);

    expect(href).toContain('/agent-chat/new?shareId=');
    expect(href).not.toContain('organizationId=');
  });

  it('keeps the selection on a membership list miss without an access denial', async () => {
    organizationMock.current = { organizationId: 'org-selected', isLoaded: true };
    organizationsListMock.current = { data: [], isFetched: true, isError: false };
    sessionsMock.current = { ...sessionsMock.current, storedErrorCode: 'INTERNAL_SERVER_ERROR' };
    const shareId = putSharePayload({ text: 'hello', files: [], failedFiles: [] });

    const href = await commitNewSession(shareId);

    expect(href).toContain('organizationId=org-selected');
  });

  it('keeps the selection while the membership list is unsettled', async () => {
    organizationMock.current = { organizationId: 'org-lost', isLoaded: true };
    organizationsListMock.current = { data: undefined, isFetched: false, isError: false };
    sessionsMock.current = { ...sessionsMock.current, storedErrorCode: 'UNAUTHORIZED' };
    const shareId = putSharePayload({ text: 'hello', files: [], failedFiles: [] });

    const href = await commitNewSession(shareId);

    expect(href).toContain('organizationId=org-lost');
  });
});
