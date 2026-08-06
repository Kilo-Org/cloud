/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
// P1-A-08b: the share gate must attach one hoisted `operationKey` per
// share-spawn intent (share + instance) to the `spawn` call, keep it across
// retryable outcomes (the relay dedupes the same-key retry), and rotate it
// on a terminal outcome (`ready` commit navigation or a typed non-retryable
// rejection). This suite mounts the real `ShareGateSheet` with every
// RN-touching dependency stubbed and drives the spawn via the list's
// captured `onSpawnInstance` prop.

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REMOTE_SPAWN_NON_RETRYABLE_TOAST,
  REMOTE_SPAWN_RETRYABLE_TOAST,
} from '@/lib/remote-submit-outcome';
import { __resetPendingShareNavigationForTests } from '@/lib/share-navigation';
import { __resetSharePayloadStoreForTests, putSharePayload } from '@/lib/share-payload';
import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { type CreateSessionOutcome } from '@/lib/hooks/remote-instance-spawn-classifier';
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
const instanceRows = vi.hoisted(() => [
  { connectionId: 'conn-1', name: 'laptop', projectName: 'kilo' },
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
vi.mock('lucide-react-native', () => ({
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
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null, isLoaded: true }),
}));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useAgentSessions: () => ({
    storedSessions: [],
    activeSessionIds: new Set(),
    activeSessions: [],
    storedIsError: false,
    storedIsSuccess: true,
    activeIsError: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
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
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: null,
  copyAsync: vi.fn().mockResolvedValue('/tmp/copy'),
  deleteAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-share-intent', () => ({}));
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
  }) => {
    shareDestinationListProps.current = props;
    return null;
  },
}));

const INSTANCE: ShareCliSpawnRow = {
  connectionId: 'conn-1',
  name: 'laptop',
  projectName: 'kilo',
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
    expect(toastError).toHaveBeenCalledWith(REMOTE_SPAWN_RETRYABLE_TOAST);
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
    expect(toastError).toHaveBeenCalledWith(REMOTE_SPAWN_NON_RETRYABLE_TOAST);
    // A non-retryable rejection must not refetch or navigate.
    expect(refetchInstancesMock).not.toHaveBeenCalled();
    expect(routerBack).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });
});
