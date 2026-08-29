/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount the hook under vitest (node env, no jsdom) */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake mutate/outbox factories settle without await */
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';

import { type NewSessionRepository } from '@/components/agents/new-session-repository-state';
import { useContinueCloudCreate } from './use-continue-cloud-create';

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));

const prepareSessionMutate = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const captureEventMock = vi.hoisted(() => vi.fn());
const invalidateAgentSessionQueries = vi.hoisted(() => vi.fn(async () => undefined));

const operationKeyMock = vi.hoisted(() => ({
  getKey: vi.fn((_fingerprint: string): string => 'op-key-1'),
  rotateKey: vi.fn(),
}));

const outboxMock = vi.hoisted(() => ({
  getStoredOperationKey: vi.fn((_fingerprint: string): string | null => null),
  writeSafeRetry: vi.fn(async (): Promise<void> => undefined),
  remove: vi.fn(async (): Promise<void> => undefined),
  whenLoaded: vi.fn(async (): Promise<boolean> => true),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: routerReplace, push: routerPush }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({}),
}));

vi.mock('expo-haptics', () => ({
  notificationAsync: async (): Promise<void> => undefined,
  NotificationFeedbackType: { Success: 'success' },
}));

vi.mock('@/lib/agent-session-cache', () => ({
  invalidateAgentSessionQueries,
}));

vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: captureEventMock,
  SESSION_CREATED_EVENT: 'session_created',
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: { prepareSession: { mutate: prepareSessionMutate } },
    organizations: { cloudAgentNext: { prepareSession: { mutate: prepareSessionMutate } } },
  },
  useTRPC: () => ({}),
}));

vi.mock('@/lib/operation-key', () => ({
  useHoistedOperationKey: () => operationKeyMock,
}));

vi.mock('@/lib/persist/use-mutation-outbox', () => ({
  useMutationOutbox: () => outboxMock,
}));

// Mirror of the real retryability predicate (covered by its own suite); this
// test only needs to distinguish one retryable and one terminal shape so the
// hook's key/outbox behavior is exercised per branch.
vi.mock('@/components/agents/mobile-session-manager', () => ({
  isCloudPrepareRetryableError: (error: unknown) => {
    const record = error as { data?: { code?: string }; code?: string; message?: string };
    const code = record.data?.code ?? record.code;
    if (code === undefined) {
      return true;
    }
    if (code === 'CONFLICT') {
      return record.message === 'creation_in_progress';
    }
    return new Set([
      'INTERNAL_SERVER_ERROR',
      'BAD_GATEWAY',
      'SERVICE_UNAVAILABLE',
      'GATEWAY_TIMEOUT',
      'TIMEOUT',
      'TOO_MANY_REQUESTS',
    ]).has(code);
  },
}));

type RunContinue = ReturnType<typeof useContinueCloudCreate>;

function Harness({
  organizationId,
  onCreated,
  resultRef,
}: {
  organizationId: string | undefined;
  onCreated: (() => void) | undefined;
  resultRef: { current: RunContinue | null };
}) {
  const run = useContinueCloudCreate(organizationId, onCreated);
  resultRef.current = run;
  return null;
}

function mountContinue(organizationId?: string, onCreated?: () => void): RunContinue {
  const resultRef: { current: RunContinue | null } = { current: null };
  act(() => {
    TestRenderer.create(React.createElement(Harness, { organizationId, onCreated, resultRef }));
  });
  const run = resultRef.current;
  if (run === null) {
    throw new Error('useContinueCloudCreate did not run');
  }
  return run;
}

const SOURCE_SESSION = 'ses_source' as KiloSessionId;
// The resolved repository row, never the `platform:fullName` picker key. The
// happy-path assertion pins `githubRepo` to the bare fullName, so a regression
// that reintroduces a picker key (`github:owner/repo`) fails.
const GITHUB_REPO: NewSessionRepository = {
  platform: 'github',
  fullName: 'owner/repo',
  isPrivate: false,
};
const GITLAB_REPO: NewSessionRepository = {
  platform: 'gitlab',
  fullName: 'group/project',
  isPrivate: false,
};
const DEST = { repository: GITHUB_REPO, model: 'claude-x', variant: 'high' };
const SESSION_RESULT = { kiloSessionId: 'ses_12345678901234567890123456' };

function creationInProgressError(): Error {
  return Object.assign(new Error('creation_in_progress'), { data: { code: 'CONFLICT' } });
}

function badRequestError(): Error {
  return Object.assign(new Error('session_creation_failed'), { data: { code: 'BAD_REQUEST' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  prepareSessionMutate.mockResolvedValue(SESSION_RESULT);
  invalidateAgentSessionQueries.mockResolvedValue(undefined);
  operationKeyMock.getKey.mockReturnValue('op-key-1');
  outboxMock.getStoredOperationKey.mockReturnValue(null);
  outboxMock.writeSafeRetry.mockResolvedValue(undefined);
  outboxMock.remove.mockResolvedValue(undefined);
  outboxMock.whenLoaded.mockResolvedValue(true);
});

describe('useContinueCloudCreate', () => {
  const repository: NewSessionRepository = {
    platform: 'bitbucket',
    fullName: 'workspace/repo',
    isPrivate: true,
    workspaceUuid: 'workspace-1',
    repositoryUuid: 'repository-1',
  };
  const reference = {
    repository: {
      provider: 'bitbucket' as const,
      fullName: 'workspace/repo',
      instanceUrl: 'https://bitbucket.org',
      repositoryId: 'repository-1',
      workspaceUuid: 'workspace-1',
      defaultBranch: 'develop',
    },
    authorization: {
      kind: 'ownerIntegration' as const,
      owner: { type: 'org' as const, id: 'org-1' },
      integrationId: 'integration-1',
    },
  };
  it('pins Bitbucket continue launches and separates changed branch retries', async () => {
    const run = mountContinue('org-1');
    operationKeyMock.getKey.mockImplementation(fingerprint => fingerprint);
    prepareSessionMutate.mockRejectedValue(creationInProgressError());
    await Promise.all(
      ['release', 'release', 'other'].map(async upstreamBranch =>
        expect(
          run(
            SOURCE_SESSION,
            { ...DEST, repository, launchSelection: { reference, upstreamBranch } },
            'code'
          )
        ).rejects.toThrow('creation_in_progress')
      )
    );
    const inputs = prepareSessionMutate.mock.calls.map(call => call[0] as Record<string, unknown>);
    expect(inputs[0]).toMatchObject({
      bitbucketRepo: {
        fullName: 'workspace/repo',
        workspaceUuid: 'workspace-1',
        repositoryUuid: 'repository-1',
      },
      bitbucketIntegrationId: 'integration-1',
      upstreamBranch: 'release',
      cloneFromKiloSessionId: 'ses_source',
    });
    expect(inputs[0]).not.toHaveProperty('prompt');
    expect(inputs[1]?.operationKey).toBe(inputs[0]?.operationKey);
    expect(inputs[2]?.operationKey).not.toBe(inputs[0]?.operationKey);
  });

  it('keeps an empty continue destination inert and rejects a stale owner without a retry key', async () => {
    const run = mountContinue('org-2');
    await run(SOURCE_SESSION, { ...DEST, repository: null }, 'code');
    await expect(
      run(SOURCE_SESSION, { ...DEST, repository, launchSelection: { reference } }, 'code')
    ).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } });
    expect(prepareSessionMutate.mock.calls).toEqual([]);
  });

  it('recovers the same clone after a lost response and remount', async () => {
    const stored = new Map<string, string>();
    const sessions = new Map<string, string>();
    let loseResponse = true;
    outboxMock.getStoredOperationKey.mockImplementation(
      fingerprint => stored.get(fingerprint) ?? null
    );
    outboxMock.writeSafeRetry.mockImplementation(async (...args: unknown[]) => {
      const row = args[0] as { fingerprint: string; operationKey: string };
      stored.set(row.fingerprint, row.operationKey);
    });
    prepareSessionMutate.mockImplementation(async (payload: { operationKey: string }) => {
      expect([...stored.values()]).toContain(payload.operationKey);
      sessions.set(payload.operationKey, 'ses_recovered');
      if (loseResponse) {
        throw new Error('Lost response');
      }
      return { kiloSessionId: sessions.get(payload.operationKey) };
    });
    await expect(mountContinue('org-1')(SOURCE_SESSION, DEST, 'code')).rejects.toThrow(
      'Lost response'
    );
    loseResponse = false;
    operationKeyMock.getKey.mockReturnValue('replacement-key');
    await mountContinue('org-1')(SOURCE_SESSION, DEST, 'code');
    expect(sessions.size).toBe(1);
    expect(routerReplace.mock.calls.at(-1)?.[0]).toContain('agent-chat/ses_recovered');
  });

  it('success replaces the route (replaceWithAgentSession, never push)', async () => {
    const run = mountContinue('org-1');

    await act(async () => {
      await run(SOURCE_SESSION, DEST, 'code');
    });

    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenCalledWith(
      expect.stringContaining('agent-chat/ses_12345678901234567890123456')
    );
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('runs a clone-only prepare: no prompt or initialMessageId', async () => {
    const run = mountContinue('org-1');

    await act(async () => {
      await run(SOURCE_SESSION, DEST, 'code');
    });

    const input = prepareSessionMutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({
      mode: 'code',
      model: 'claude-x',
      variant: 'high',
      githubRepo: 'owner/repo',
      autoCommit: false,
      autoInitiate: true,
      cloneFromKiloSessionId: 'ses_source',
      operationKey: 'op-key-1',
      organizationId: 'org-1',
    });
    expect(input).not.toHaveProperty('prompt');
    expect(input).not.toHaveProperty('initialMessageId');
  });

  it('writes gitlabProject (never githubRepo) for a GitLab repository', async () => {
    const run = mountContinue('org-1');

    await act(async () => {
      await run(SOURCE_SESSION, { ...DEST, repository: GITLAB_REPO }, 'code');
    });

    const input = prepareSessionMutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({ gitlabProject: 'group/project' });
    expect(input).not.toHaveProperty('githubRepo');
  });

  it('rethrows a retryable prepare error without rotating the key or removing the row (route toasts cloneFailedRetry and re-enables)', async () => {
    prepareSessionMutate.mockRejectedValueOnce(creationInProgressError());
    const run = mountContinue('org-1');

    await act(async () => {
      await expect(run(SOURCE_SESSION, DEST, 'code')).rejects.toThrow('creation_in_progress');
    });

    // The retry keeps the same operation key and the safe-retry row, so the
    // next Start tap replays the intent instead of minting a duplicate.
    expect(operationKeyMock.rotateKey).not.toHaveBeenCalled();
    expect(outboxMock.remove).not.toHaveBeenCalled();
  });

  it('rethrows a non-retryable prepare error after rotating the key and removing the row (route toasts the message)', async () => {
    prepareSessionMutate.mockRejectedValueOnce(badRequestError());
    const run = mountContinue('org-1');

    await act(async () => {
      await expect(run(SOURCE_SESSION, DEST, 'code')).rejects.toThrow('session_creation_failed');
    });

    expect(operationKeyMock.rotateKey).toHaveBeenCalledTimes(1);
    expect(outboxMock.remove).toHaveBeenCalledTimes(1);
  });

  it('fires the onCreated bypass right before the success replace', async () => {
    const onCreated = vi.fn(() => undefined);
    const run = mountContinue('org-1', onCreated);

    await act(async () => {
      await run(SOURCE_SESSION, DEST, 'code');
    });

    expect(onCreated).toHaveBeenCalledTimes(1);
    // The route arms its busy leave-lock bypass before the replace lands.
    expect(routerReplace).toHaveBeenCalledTimes(1);
  });

  it('prepares against the personal router when no organization is scoped', async () => {
    const run = mountContinue(undefined);

    await act(async () => {
      await run(SOURCE_SESSION, DEST, 'code');
    });

    const input = prepareSessionMutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).not.toHaveProperty('organizationId');
    expect(input).toMatchObject({ cloneFromKiloSessionId: 'ses_source' });
  });
});
