import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { isCancelledError, QueryClient, type QueryKey } from '@tanstack/react-query';
import { createTRPCClient } from '@trpc/client';
import type { inferRouterOutputs } from '@trpc/server';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { createStore } from 'jotai/vanilla';
import {
  WORKSPACE_REQUIRES_ROOT_SESSION,
  WORKTREE_MEMBERSHIP_CHANGED,
} from '@kilocode/session-ingest-contracts';
import type { RootRouter } from '@/routers/root-router';
import { apiSessionToDbSession, dbSessionsAtom } from './store/db-session-atoms';
import {
  createSessionDeletionFlow,
  getDeletionErrorMessage,
  getWorktreeDeletionRedirect,
  invalidateSessionQueries,
  isWorkspaceRequiresRootSessionError,
  isWorktreeMembershipChangedError,
  removeDeletedSession,
  removeDeletedSessions,
  type SessionDeletionConfirmOptions,
  type SessionDeletionEvent,
  type SessionDeletionFlowDependencies,
  type SessionDeletionTarget,
} from './session-deletion';

type DeleteSessionDependency = SessionDeletionFlowDependencies['deleteSession'];
type DeleteWorktreeDependency = SessionDeletionFlowDependencies['deleteWorktree'];
type ConfirmDependency = SessionDeletionFlowDependencies['confirm'];

function trpcCodeError(code: string, message = code): Error {
  return Object.assign(new Error(message), { data: { code } });
}

function createDeletionFlowHarness() {
  const confirmCalls: SessionDeletionConfirmOptions[] = [];
  const deleteSessionCalls: Parameters<DeleteSessionDependency>[0][] = [];
  const deleteWorktreeCalls: Parameters<DeleteWorktreeDependency>[0][] = [];
  const deletedEvents: SessionDeletionEvent[] = [];
  const removedBatches: string[][] = [];
  const sessionPending: Array<[string, boolean]> = [];
  const worktreePending: Array<[string, boolean]> = [];
  const droppedOperationKeys: string[] = [];
  const successMessages: string[] = [];
  const warningMessages: string[] = [];
  const errors: Array<{ title: string; description: string }> = [];
  const stats = { invalidations: 0 };
  const operationKeys = new Map<string, string>();
  let confirmImpl: ConfirmDependency = async () => true;
  let deleteSessionImpl: DeleteSessionDependency = async input => ({
    success: true,
    session_id: input.session_id,
    cleanup: 'complete',
  });
  let deleteWorktreeImpl: DeleteWorktreeDependency = async () => ({
    success: true,
    deletedSessionIds: [],
    cleanup: 'complete',
  });

  const deps: SessionDeletionFlowDependencies = {
    organizationId: null,
    confirm: options => {
      confirmCalls.push(options);
      return confirmImpl(options);
    },
    deleteSession: input => {
      deleteSessionCalls.push(input);
      return deleteSessionImpl(input);
    },
    deleteWorktree: input => {
      deleteWorktreeCalls.push(input);
      return deleteWorktreeImpl(input);
    },
    removeDeletedSessions: async sessionIds => {
      removedBatches.push([...sessionIds]);
    },
    invalidateQueries: async () => {
      stats.invalidations += 1;
    },
    notifyDeleted: event => {
      deletedEvents.push(event);
    },
    setSessionPending: (sessionId, pending) => {
      sessionPending.push([sessionId, pending]);
    },
    setWorktreePending: (worktreeId, pending) => {
      worktreePending.push([worktreeId, pending]);
    },
    getOperationKey: sessionId => {
      const existing = operationKeys.get(sessionId);
      if (existing) return existing;
      const key = `key-${sessionId}`;
      operationKeys.set(sessionId, key);
      return key;
    },
    dropOperationKey: sessionId => {
      droppedOperationKeys.push(sessionId);
      operationKeys.delete(sessionId);
    },
    notifySuccess: message => {
      successMessages.push(message);
    },
    notifyWarning: message => {
      warningMessages.push(message);
    },
    notifyError: (title, description) => {
      errors.push({ title, description });
    },
  };

  return {
    flow: createSessionDeletionFlow(),
    deps,
    confirmCalls,
    deleteSessionCalls,
    deleteWorktreeCalls,
    deletedEvents,
    removedBatches,
    sessionPending,
    worktreePending,
    droppedOperationKeys,
    successMessages,
    warningMessages,
    errors,
    stats,
    setConfirmImpl: (impl: ConfirmDependency) => {
      confirmImpl = impl;
    },
    setDeleteSessionImpl: (impl: DeleteSessionDependency) => {
      deleteSessionImpl = impl;
    },
    setDeleteWorktreeImpl: (impl: DeleteWorktreeDependency) => {
      deleteWorktreeImpl = impl;
    },
  };
}

const deletionTarget: SessionDeletionTarget = {
  sessionId: 'ses_00000000000000000000000001',
  title: 'Fix auth',
  worktreeId: 'worktree_12345678-1234-4234-9234-123456789abc',
};

type ApiSession = inferRouterOutputs<RootRouter>['cliSessionsV2']['list']['cliSessions'][number];

function makeSession(session_id: string): ApiSession {
  return {
    session_id,
    title: session_id,
    cloud_agent_session_id: null,
    cloud_agent_worktree_id: null,
    created_on_platform: 'cloud-agent',
    organization_id: null,
    git_url: null,
    git_branch: null,
    parent_session_id: null,
    created_at: '2026-08-26T12:00:00.000Z',
    updated_at: '2026-08-26T12:00:00.000Z',
    version: 2,
    status: 'busy',
    status_updated_at: null,
    latest_run_status: null,
    latest_run_failure_kind: null,
    latest_run_terminal_at: null,
    associatedPr: null,
    total_cost_microdollars: null,
  };
}

function createFixture() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const trpc = createTRPCOptionsProxy<RootRouter>({
    client: createTRPCClient<RootRouter>({ links: [] }),
    queryClient,
  });
  const store = createStore();
  const listKeys = [
    trpc.cliSessionsV2.list.queryKey({}),
    trpc.cliSessionsV2.list.queryKey({ createdOnPlatform: 'cli' }),
  ];
  const searchKeys = ['matching', 'other'].map(search_string =>
    trpc.cliSessionsV2.search.queryKey({ search_string })
  );
  const activeKey = trpc.activeSessions.list.queryKey();
  const recentKey = trpc.cliSessionsV2.recentRepositories.queryKey({
    updatedSince: '2026-08-01T00:00:00.000Z',
  });
  const foldersKey = trpc.workspaceFolders.list.queryKey({ organizationId: null });
  const worktreeDetailsKey = trpc.cliSessionsV2.worktreeDetails.queryKey({
    worktreeIds: ['worktree_12345678-1234-4234-9234-123456789abc'],
    organizationId: null,
  });
  const parentKey = trpc.cliSessionsV2.worktreeParent.queryKey({
    worktreeId: 'worktree_12345678-1234-4234-9234-123456789abc',
    organizationId: null,
  });
  const worktreeParentKey = [[...parentKey[0], 'owner'], parentKey[1]];
  const sessions = ['ses_a', 'ses_b', 'ses_c'].map(makeSession);
  const persisted = new Set(sessions.map(session => session.session_id));
  const seedSessions = (rows: ApiSession[]) => {
    store.set(dbSessionsAtom, rows.map(apiSessionToDbSession));
    for (const key of listKeys) {
      queryClient.setQueryData(key, { cliSessions: rows, nextCursor: 'next-page' });
    }
    for (const key of searchKeys) {
      queryClient.setQueryData(key, { results: rows, limit: 20, offset: 0, nextCursor: 20 });
    }
    queryClient.setQueryData(activeKey, {
      sessions: rows.map(session => ({
        id: session.session_id,
        title: session.title ?? '',
        status: 'busy',
        connectionId: 'connection',
      })),
    });
  };
  seedSessions(sessions);
  queryClient.setQueryData(recentKey, { repositories: [] });
  queryClient.setQueryData(foldersKey, { folders: [] });
  queryClient.setQueryData(worktreeDetailsKey, {
    worktrees: {
      'worktree_12345678-1234-4234-9234-123456789abc': {
        name: null,
        defaultTitle: sessions[0].title,
        prSession: null,
        sessions: sessions.map(session => ({
          sessionId: session.session_id,
          sessionStatus: session.status,
          sessionStatusUpdatedAt: session.status_updated_at,
          latest_run_status: session.latest_run_status,
          latest_run_failure_kind: session.latest_run_failure_kind,
          latest_run_terminal_at: session.latest_run_terminal_at,
          updatedAt: session.updated_at,
        })),
      },
    },
  });
  queryClient.setQueryData(['unrelated'], { cliSessions: sessions });
  queryClient.setQueryData(worktreeParentKey, {
    session_id: 'ses_parent',
    title: 'Parent workspace',
    organization_id: null,
  });

  const context = {
    queryClient,
    trpc,
    setDbSessions: update => store.set(dbSessionsAtom, update),
    deleteSessionFromStore: async sessionId => {
      persisted.delete(sessionId);
    },
  } satisfies Omit<Parameters<typeof removeDeletedSession>[0], 'sessionId'>;
  return {
    context,
    store,
    sessions,
    persisted,
    listKeys,
    searchKeys,
    activeKey,
    recentKey,
    worktreeDetailsKey,
    worktreeParentKey,
    foldersKey,
    seedSessions,
  };
}

let fixture: ReturnType<typeof createFixture>;

function expectCachedSessions(ids: string[]) {
  const {
    context: { queryClient },
    store,
    listKeys,
    searchKeys,
    activeKey,
  } = fixture;
  expect(store.get(dbSessionsAtom).map(session => session.session_id)).toEqual(ids);
  for (const key of listKeys) {
    expect(queryClient.getQueryData(key)?.cliSessions.map(session => session.session_id)).toEqual(
      ids
    );
  }
  for (const key of searchKeys) {
    expect(queryClient.getQueryData(key)?.results.map(session => session.session_id)).toEqual(ids);
  }
  expect(queryClient.getQueryData(activeKey)?.sessions.map(session => session.id)).toEqual(ids);
}

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.context.queryClient.clear();
  jest.restoreAllMocks();
});

describe('worktree deletion navigation', () => {
  it.each([
    ['/cloud/chat?worktreeId=worktree_a', undefined, '/cloud'],
    ['/cloud/chat?sessionId=ses_a', undefined, '/cloud'],
    ['/cloud/chat?worktreeId=worktree_b', undefined, null],
    ['/cloud/chat?sessionId=ses_b', undefined, null],
    ['/cloud/chat?sessionId=ses_b&worktreeId=worktree_a', undefined, null],
    ['/cloud/chat', undefined, null],
    ['/cloud', undefined, null],
    ['/settings?sessionId=ses_a', undefined, null],
    [
      '/organizations/org_a/cloud/chat?worktreeId=worktree_a',
      'org_a',
      '/organizations/org_a/cloud',
    ],
    ['/organizations/org_a/cloud/chat?sessionId=ses_a', 'org_a', '/organizations/org_a/cloud'],
    ['/organizations/org_b/cloud/chat?sessionId=ses_a', 'org_a', null],
    ['/cloud/chat?sessionId=ses_a', 'org_a', null],
    ['/organizations/org_a/cloud/chat?sessionId=ses_a', undefined, null],
  ] as const)(
    'checks the current URL %s in scope %s before redirecting',
    (path, organizationId, expected) => {
      expect(
        getWorktreeDeletionRedirect(
          new URL(path, 'https://app.kilo.ai'),
          'worktree_a',
          ['ses_a'],
          organizationId
        )
      ).toBe(expected);
    }
  );
});

describe('session deletion conflicts', () => {
  it('escalates only the exact final-root conflict to deleting the workspace', () => {
    expect(isWorkspaceRequiresRootSessionError(new Error(WORKSPACE_REQUIRES_ROOT_SESSION))).toBe(
      true
    );
    expect(
      isWorkspaceRequiresRootSessionError(new Error(`${WORKSPACE_REQUIRES_ROOT_SESSION}: details`))
    ).toBe(false);
    expect(isWorkspaceRequiresRootSessionError(new Error('session_deletion_conflict'))).toBe(false);
    expect(isWorkspaceRequiresRootSessionError(undefined)).toBe(false);
  });

  it('recognizes a membership change without treating it as a final-root conflict', () => {
    expect(isWorktreeMembershipChangedError(new Error(WORKTREE_MEMBERSHIP_CHANGED))).toBe(true);
    expect(
      isWorktreeMembershipChangedError(new Error('worktree_membership_changed elsewhere'))
    ).toBe(false);
    expect(isWorkspaceRequiresRootSessionError(new Error(WORKTREE_MEMBERSHIP_CHANGED))).toBe(false);
  });
});

describe('session deletion', () => {
  it('removes confirmed rows from all caches before persistence finishes, preserving metadata and unrelated data', async () => {
    const { context, persisted, listKeys, searchKeys } = fixture;
    const persistence = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const unrelated = context.queryClient.getQueryData(['unrelated']);
    const deletion = removeDeletedSession({
      ...context,
      sessionId: 'ses_a',
      deleteSessionFromStore: async sessionId => {
        started.resolve();
        await persistence.promise;
        persisted.delete(sessionId);
      },
    });
    await started.promise;

    expectCachedSessions(['ses_b', 'ses_c']);
    expect(persisted.has('ses_a')).toBe(true);
    for (const key of listKeys) {
      expect(context.queryClient.getQueryData(key)?.nextCursor).toBe('next-page');
    }
    for (const key of searchKeys) {
      expect(context.queryClient.getQueryData(key)).toMatchObject({
        limit: 20,
        offset: 0,
        nextCursor: 20,
      });
    }
    expect(context.queryClient.getQueryData(['unrelated'])).toBe(unrelated);

    persistence.resolve();
    await deletion;
    expect([...persisted]).toEqual(['ses_b', 'ses_c']);
  });

  it('removes every returned deleted id', async () => {
    const { context, persisted } = fixture;

    await removeDeletedSessions({ ...context, sessionIds: ['ses_a', 'ses_c'] });

    expectCachedSessions(['ses_b']);
    expect([...persisted]).toEqual(['ses_b']);
  });

  it('cancels stale list, search and active-session responses so they cannot restore a deleted row', async () => {
    const { context, listKeys, searchKeys, activeKey } = fixture;
    const response = Promise.withResolvers<void>();
    const keys: QueryKey[] = [...listKeys, ...searchKeys, activeKey];
    const requests = keys.map(queryKey => {
      const staleData = context.queryClient.getQueryData(queryKey);
      return context.queryClient
        .query({
          queryKey,
          queryFn: async () => {
            await response.promise;
            return staleData;
          },
        })
        .catch(error => {
          if (!isCancelledError(error)) throw error;
        });
    });

    await removeDeletedSession({ ...context, sessionId: 'ses_a' });
    response.resolve();
    await Promise.all(requests);

    expectCachedSessions(['ses_b', 'ses_c']);
  });

  it('keeps overlapping deletions independent without losing newer rows or live updates', async () => {
    const { context, sessions, seedSessions, store, persisted } = fixture;
    const deletions = Promise.all(
      ['ses_a', 'ses_b'].map(sessionId => removeDeletedSession({ ...context, sessionId }))
    );
    seedSessions([
      sessions[0],
      sessions[1],
      { ...sessions[2], title: 'New live title' },
      makeSession('ses_new'),
    ]);
    await deletions;

    expectCachedSessions(['ses_c', 'ses_new']);
    expect(store.get(dbSessionsAtom)[0].title).toBe('New live title');
    expect([...persisted]).toEqual(['ses_c']);
  });

  it('reconciles queries without rolling back current data or another successful deletion', async () => {
    const {
      context,
      sessions,
      seedSessions,
      listKeys,
      searchKeys,
      activeKey,
      recentKey,
      worktreeDetailsKey,
      worktreeParentKey,
      foldersKey,
    } = fixture;
    await removeDeletedSession({ ...context, sessionId: 'ses_b' });
    seedSessions([
      { ...sessions[0], title: 'New live title' },
      sessions[2],
      makeSession('ses_new'),
    ]);
    const keys: QueryKey[] = [
      ...listKeys,
      ...searchKeys,
      activeKey,
      recentKey,
      worktreeDetailsKey,
      worktreeParentKey,
      foldersKey,
    ];
    const currentData = keys.map(key => context.queryClient.getQueryData(key));

    await invalidateSessionQueries(context);

    expectCachedSessions(['ses_a', 'ses_c', 'ses_new']);
    keys.forEach((key, index) => {
      expect(context.queryClient.getQueryData(key)).toBe(currentData[index]);
      expect(context.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    });
    expect(context.queryClient.getQueryState(['unrelated'])?.isInvalidated).toBe(false);
  });

  it('does not undo a confirmed deletion when local persistence fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      removeDeletedSession({
        ...fixture.context,
        sessionId: 'ses_a',
        deleteSessionFromStore: async () => {
          throw new Error('IndexedDB unavailable');
        },
      })
    ).resolves.toBeUndefined();

    expectCachedSessions(['ses_b', 'ses_c']);
    expect(fixture.persisted.has('ses_a')).toBe(true);
  });
});

describe('session deletion flow', () => {
  it('escalates only the exact final-root conflict and deletes the guarded workspace', async () => {
    const harness = createDeletionFlowHarness();
    harness.setDeleteSessionImpl(async () => {
      throw trpcCodeError('CONFLICT', WORKSPACE_REQUIRES_ROOT_SESSION);
    });
    harness.setDeleteWorktreeImpl(async () => ({
      success: true,
      deletedSessionIds: [deletionTarget.sessionId, 'ses_descendant'],
      cleanup: 'pending',
    }));

    await expect(harness.flow.deleteSession(deletionTarget, harness.deps)).resolves.toBe(true);

    expect(harness.confirmCalls).toHaveLength(2);
    expect(harness.confirmCalls[0]).toMatchObject({
      title: 'Delete session?',
      queue: true,
    });
    expect(harness.confirmCalls[0].description).toContain(deletionTarget.sessionId);
    expect(harness.confirmCalls[0].description).toContain(deletionTarget.title ?? '');
    expect(harness.confirmCalls[1]).toMatchObject({
      title: 'Delete workspace and last session?',
      queue: true,
    });
    expect(harness.confirmCalls[1].description).toContain(deletionTarget.sessionId);
    expect(harness.confirmCalls[1].description).toContain(deletionTarget.worktreeId ?? '');
    expect(harness.deleteSessionCalls).toEqual([
      {
        session_id: deletionTarget.sessionId,
        operationKey: `key-${deletionTarget.sessionId}`,
      },
    ]);
    expect(harness.deleteWorktreeCalls).toEqual([
      {
        worktreeId: deletionTarget.worktreeId,
        organizationId: null,
        onlyIfSoleSessionId: deletionTarget.sessionId,
      },
    ]);
    expect(harness.worktreePending).toEqual([
      [deletionTarget.worktreeId, true],
      [deletionTarget.worktreeId, false],
    ]);
    expect(harness.deletedEvents).toEqual([
      {
        scope: 'workspace',
        deletedSessionIds: [deletionTarget.sessionId, 'ses_descendant'],
        worktreeId: deletionTarget.worktreeId,
        cleanup: 'pending',
      },
    ]);
    expect(harness.warningMessages).toEqual(['Workspace removed; runtime cleanup is incomplete.']);
    expect(harness.droppedOperationKeys).toContain(deletionTarget.sessionId);
    expect(harness.droppedOperationKeys).toContain('ses_descendant');
  });

  it.each(['session', 'workspace'] as const)(
    'preserves confirmed %s deletion when client reconciliation fails',
    async scope => {
      for (const step of ['removeDeletedSessions', 'notifyDeleted', 'invalidateQueries'] as const) {
        const harness = createDeletionFlowHarness();
        if (scope === 'workspace') {
          harness.setDeleteSessionImpl(async () => {
            throw trpcCodeError('CONFLICT', WORKSPACE_REQUIRES_ROOT_SESSION);
          });
          harness.setDeleteWorktreeImpl(async () => ({
            success: true,
            deletedSessionIds: [deletionTarget.sessionId, 'ses_descendant'],
            cleanup: 'pending',
          }));
        }
        harness.deps[step] = () => {
          throw new Error('Client reconciliation failed');
        };

        await expect(harness.flow.deleteSession(deletionTarget, harness.deps)).resolves.toBe(true);

        expect(harness.errors).toEqual([]);
        expect(harness.warningMessages).toContain(
          'History deleted, but the page could not update completely. Refresh the page.'
        );
        if (step !== 'notifyDeleted') expect(harness.deletedEvents).toHaveLength(1);
        if (step !== 'invalidateQueries') expect(harness.stats.invalidations).toBe(1);
        if (scope === 'workspace') {
          expect(harness.droppedOperationKeys).toContain('ses_descendant');
          expect(harness.warningMessages).toContain(
            'Workspace removed; runtime cleanup is incomplete.'
          );
        }
        expect(harness.flow.isActive()).toBe(false);
        expect(harness.sessionPending.at(-1)).toEqual([deletionTarget.sessionId, false]);
      }
    }
  );

  it('cancels workspace escalation without deleting anything', async () => {
    const harness = createDeletionFlowHarness();
    harness.setConfirmImpl(async () => harness.confirmCalls.length === 1);
    harness.setDeleteSessionImpl(async () => {
      throw trpcCodeError('CONFLICT', WORKSPACE_REQUIRES_ROOT_SESSION);
    });

    await expect(harness.flow.deleteSession(deletionTarget, harness.deps)).resolves.toBe(false);

    expect(harness.confirmCalls).toHaveLength(2);
    expect(harness.deleteWorktreeCalls).toHaveLength(0);
    expect(harness.deletedEvents).toHaveLength(0);
    expect(harness.removedBatches).toHaveLength(0);
  });

  it('cancels the initial confirmation without contacting the server', async () => {
    const harness = createDeletionFlowHarness();
    harness.setConfirmImpl(async () => false);

    await expect(harness.flow.deleteSession(deletionTarget, harness.deps)).resolves.toBe(false);

    expect(harness.deleteSessionCalls).toHaveLength(0);
    expect(harness.deleteWorktreeCalls).toHaveLength(0);
  });

  it('treats a typed NOT_FOUND retry as removed with pending cleanup', async () => {
    const harness = createDeletionFlowHarness();
    harness.setDeleteSessionImpl(async () => {
      throw trpcCodeError('NOT_FOUND');
    });

    await expect(harness.flow.deleteSession(deletionTarget, harness.deps)).resolves.toBe(true);

    expect(harness.confirmCalls).toHaveLength(1);
    expect(harness.deleteWorktreeCalls).toHaveLength(0);
    expect(harness.removedBatches).toEqual([[deletionTarget.sessionId]]);
    expect(harness.deletedEvents).toEqual([
      {
        scope: 'session',
        deletedSessionIds: [deletionTarget.sessionId],
        worktreeId: deletionTarget.worktreeId,
        cleanup: 'pending',
      },
    ]);
    expect(harness.warningMessages).toEqual(['Session removed; runtime cleanup is incomplete.']);
    expect(harness.droppedOperationKeys).toContain(deletionTarget.sessionId);
  });

  it('treats a typed workspace NOT_FOUND retry as removed with pending cleanup', async () => {
    const harness = createDeletionFlowHarness();
    harness.setDeleteSessionImpl(async () => {
      throw trpcCodeError('CONFLICT', WORKSPACE_REQUIRES_ROOT_SESSION);
    });
    harness.setDeleteWorktreeImpl(async () => {
      throw trpcCodeError('NOT_FOUND');
    });

    await expect(harness.flow.deleteSession(deletionTarget, harness.deps)).resolves.toBe(true);

    expect(harness.deleteWorktreeCalls).toHaveLength(1);
    expect(harness.deletedEvents).toEqual([
      {
        scope: 'workspace',
        deletedSessionIds: [deletionTarget.sessionId],
        worktreeId: deletionTarget.worktreeId,
        cleanup: 'pending',
      },
    ]);
    expect(harness.warningMessages).toEqual(['Workspace removed; runtime cleanup is incomplete.']);
  });

  it('refreshes and reports a workspace membership race without falling back to an unguarded delete', async () => {
    const harness = createDeletionFlowHarness();
    harness.setDeleteSessionImpl(async () => {
      throw trpcCodeError('CONFLICT', WORKSPACE_REQUIRES_ROOT_SESSION);
    });
    harness.setDeleteWorktreeImpl(async () => {
      throw trpcCodeError('CONFLICT', WORKTREE_MEMBERSHIP_CHANGED);
    });

    await expect(harness.flow.deleteSession(deletionTarget, harness.deps)).resolves.toBe(false);

    expect(harness.deleteSessionCalls).toHaveLength(1);
    expect(harness.deleteWorktreeCalls).toHaveLength(1);
    expect(harness.stats.invalidations).toBeGreaterThan(0);
    expect(harness.errors).toEqual([
      {
        title: 'Could not delete the workspace',
        description: 'The workspace changed. Refresh the list and try again.',
      },
    ]);
  });

  it('does not escalate a generic conflict and drops the settled operation key', async () => {
    const harness = createDeletionFlowHarness();
    harness.setDeleteSessionImpl(async () => {
      throw trpcCodeError('CONFLICT', 'session_deletion_conflict');
    });

    await expect(harness.flow.deleteSession(deletionTarget, harness.deps)).resolves.toBe(false);

    expect(harness.deleteWorktreeCalls).toHaveLength(0);
    expect(harness.droppedOperationKeys).toContain(deletionTarget.sessionId);
    expect(harness.errors[0]?.title).toBe('Could not delete the session');
  });

  it('retains the operation key for an ambiguous failure', async () => {
    const harness = createDeletionFlowHarness();
    harness.setDeleteSessionImpl(async () => {
      throw trpcCodeError('INTERNAL_SERVER_ERROR');
    });

    await expect(harness.flow.deleteSession(deletionTarget, harness.deps)).resolves.toBe(false);

    expect(harness.droppedOperationKeys).toHaveLength(0);
    expect(harness.errors[0]?.description).toBe(
      'Deletion could not be confirmed. Refresh the list before retrying.'
    );
  });

  it('reuses an ambiguous failure operation key on retry and drops it after success', async () => {
    const harness = createDeletionFlowHarness();
    let attempts = 0;
    harness.setDeleteSessionImpl(async input => {
      attempts += 1;
      if (attempts === 1) throw trpcCodeError('INTERNAL_SERVER_ERROR');
      return { success: true, session_id: input.session_id, cleanup: 'complete' };
    });

    await expect(harness.flow.deleteSession(deletionTarget, harness.deps)).resolves.toBe(false);
    await expect(harness.flow.deleteSession(deletionTarget, harness.deps)).resolves.toBe(true);

    expect(harness.deleteSessionCalls).toHaveLength(2);
    expect(harness.deleteSessionCalls[0].operationKey).toBe(
      harness.deleteSessionCalls[1].operationKey
    );
    expect(harness.droppedOperationKeys).toContain(deletionTarget.sessionId);
  });

  it('uses the latest deleted callback after the request settles', async () => {
    const harness = createDeletionFlowHarness();
    const deletedWithLatestValue: string[] = [];
    let latestValue = 'before';
    harness.deps.notifyDeleted = () => {
      deletedWithLatestValue.push(latestValue);
    };
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Awaited<ReturnType<DeleteSessionDependency>>>();
    harness.setDeleteSessionImpl(() => {
      started.resolve();
      return response.promise;
    });

    const deletion = harness.flow.deleteSession(deletionTarget, harness.deps);
    await started.promise;
    latestValue = 'after';
    response.resolve({
      success: true,
      session_id: deletionTarget.sessionId,
      cleanup: 'complete',
    });

    await expect(deletion).resolves.toBe(true);
    expect(deletedWithLatestValue).toEqual(['after']);
  });

  it('rejects a second destructive flow while one is still confirming', async () => {
    const harness = createDeletionFlowHarness();
    const confirmation = Promise.withResolvers<boolean>();
    harness.setConfirmImpl(() => confirmation.promise);

    const first = harness.flow.deleteSession(deletionTarget, harness.deps);
    const second = harness.flow.deleteSession(
      { ...deletionTarget, sessionId: 'ses_00000000000000000000000002' },
      harness.deps
    );

    await expect(second).resolves.toBe(false);
    expect(harness.confirmCalls).toHaveLength(1);

    confirmation.resolve(true);
    await expect(first).resolves.toBe(true);
  });

  it('maps known deletion failure codes and falls back safely', () => {
    expect(getDeletionErrorMessage(trpcCodeError('FORBIDDEN'))).toBe(
      'You do not have permission to delete this.'
    );
    expect(getDeletionErrorMessage(trpcCodeError('CONFLICT'))).toBe(
      'This item changed while it was being deleted. Refresh and try again.'
    );
    expect(getDeletionErrorMessage(new Error('unexpected'))).toBe(
      'Could not delete this item. Please try again.'
    );
  });
});
