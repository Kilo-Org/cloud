import type { QueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import type { TRPCOptionsProxy } from '@trpc/tanstack-react-query';
import {
  cloudAgentWorktreeIdSchema,
  WORKSPACE_REQUIRES_ROOT_SESSION,
  WORKTREE_MEMBERSHIP_CHANGED,
  type CloudAgentWorktreeId,
} from '@kilocode/session-ingest-contracts';
import type { RootRouter } from '@/routers/root-router';
import type { DbSession, DbSessionV2 } from './store/db-session-atoms';

type SessionQueryContext = {
  queryClient: QueryClient;
  trpc: Pick<TRPCOptionsProxy<RootRouter>, 'cliSessionsV2' | 'activeSessions' | 'workspaceFolders'>;
};
type SessionOutputs = inferRouterOutputs<RootRouter>['cliSessionsV2'];
type DbSessions = (DbSession | DbSessionV2)[];
type RemoveDeletedSessionInput = SessionQueryContext & {
  sessionId: string;
  setDbSessions: (update: (sessions: DbSessions) => DbSessions) => void;
  deleteSessionFromStore: (sessionId: string) => Promise<void>;
};
type RemoveDeletedSessionsInput = Omit<RemoveDeletedSessionInput, 'sessionId'> & {
  sessionIds: readonly string[];
};

export function getWorktreeDeletionRedirect(
  url: URL,
  worktreeId: string,
  deletedSessionIds: readonly string[],
  organizationId?: string
): string | null {
  const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
  if (url.pathname !== `${basePath}/chat`) return null;

  const sessionId = url.searchParams.get('sessionId');
  const isDeletedSelection = sessionId
    ? deletedSessionIds.includes(sessionId)
    : url.searchParams.get('worktreeId') === worktreeId;
  return isDeletedSelection ? basePath : null;
}

/**
 * The only conflict that may offer deleting the whole workspace: the server
 * refused to remove the last root session of a hosted workspace.
 */
export function isWorkspaceRequiresRootSessionError(error: unknown): boolean {
  return error instanceof Error && error.message === WORKSPACE_REQUIRES_ROOT_SESSION;
}

/** A guarded workspace delete lost the race to another root session. */
export function isWorktreeMembershipChangedError(error: unknown): boolean {
  return error instanceof Error && error.message === WORKTREE_MEMBERSHIP_CHANGED;
}

export function invalidateSessionQueries({ queryClient, trpc }: SessionQueryContext) {
  return Promise.all([
    queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter()),
    queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter()),
    queryClient.invalidateQueries(trpc.cliSessionsV2.recentRepositories.pathFilter()),
    queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeDetails.pathFilter()),
    queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeParent.pathFilter()),
    queryClient.invalidateQueries(trpc.activeSessions.list.pathFilter()),
    queryClient.invalidateQueries(trpc.workspaceFolders.list.pathFilter()),
  ]);
}

export async function removeDeletedSessions({
  sessionIds,
  ...input
}: RemoveDeletedSessionsInput): Promise<void> {
  await Promise.all(sessionIds.map(sessionId => removeDeletedSession({ ...input, sessionId })));
}

export async function removeDeletedSession({
  sessionId,
  queryClient,
  trpc,
  setDbSessions,
  deleteSessionFromStore,
}: RemoveDeletedSessionInput): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries(trpc.cliSessionsV2.list.pathFilter()),
    queryClient.cancelQueries(trpc.cliSessionsV2.search.pathFilter()),
    queryClient.cancelQueries(trpc.activeSessions.list.pathFilter()),
  ]);

  setDbSessions(sessions => sessions.filter(session => session.session_id !== sessionId));
  queryClient.setQueriesData<SessionOutputs['list']>(
    trpc.cliSessionsV2.list.pathFilter(),
    current =>
      current && {
        ...current,
        cliSessions: current.cliSessions.filter(session => session.session_id !== sessionId),
      }
  );
  queryClient.setQueriesData<SessionOutputs['search']>(
    trpc.cliSessionsV2.search.pathFilter(),
    current =>
      current && {
        ...current,
        results: current.results.filter(session => session.session_id !== sessionId),
      }
  );
  queryClient.setQueryData(
    trpc.activeSessions.list.queryKey(),
    current =>
      current && {
        ...current,
        sessions: current.sessions.filter(session => session.id !== sessionId),
      }
  );

  try {
    await deleteSessionFromStore(sessionId);
  } catch (error) {
    console.error('Error deleting session from IndexedDB:', error);
  }
}

type TrpcErrorLike = {
  data?: { code?: unknown };
  shape?: { data?: { code?: unknown } };
};

function getTrpcErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const data = (error as TrpcErrorLike).data;
  if (typeof data?.code === 'string') return data.code;
  const shapeData = (error as TrpcErrorLike).shape?.data;
  return typeof shapeData?.code === 'string' ? shapeData.code : undefined;
}

export function isDeletionNotFoundError(error: unknown): boolean {
  return getTrpcErrorCode(error) === 'NOT_FOUND';
}

/** Auth, conflict and validation failures will not change on an immediate retry. */
export function isSettledDeletionFailure(error: unknown): boolean {
  const code = getTrpcErrorCode(error);
  return (
    code === 'UNAUTHORIZED' ||
    code === 'FORBIDDEN' ||
    code === 'CONFLICT' ||
    code === 'PRECONDITION_FAILED' ||
    code === 'BAD_REQUEST'
  );
}

export function getDeletionErrorMessage(error: unknown): string {
  if (isWorktreeMembershipChangedError(error)) {
    return 'The workspace changed. Refresh the list and try again.';
  }
  switch (getTrpcErrorCode(error)) {
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
      return 'You do not have permission to delete this.';
    case 'CONFLICT':
      return 'This item changed while it was being deleted. Refresh and try again.';
    case 'PRECONDITION_FAILED':
      return 'This item is not in a state that can be deleted. Refresh and try again.';
    case 'BAD_REQUEST':
      return 'This item cannot be deleted from here.';
    case 'SERVICE_UNAVAILABLE':
    case 'BAD_GATEWAY':
    case 'GATEWAY_TIMEOUT':
    case 'TIMEOUT':
    case 'INTERNAL_SERVER_ERROR':
      return 'Deletion could not be confirmed. Refresh the list before retrying.';
    default:
      return 'Could not delete this item. Please try again.';
  }
}

export type DeletionCleanup = 'complete' | 'pending';

export type SessionDeletionTarget = {
  sessionId: string;
  title?: string | null;
  worktreeId: string | null;
};

export type SessionDeletionEvent = {
  scope: 'session' | 'workspace';
  deletedSessionIds: readonly string[];
  worktreeId: string | null;
  cleanup: DeletionCleanup;
};

export type SessionDeletionConfirmOptions = {
  title: string;
  description: string;
  confirmLabel: string;
  destructive: true;
  queue: true;
};

export type SessionDeletionFlowDependencies = {
  organizationId?: string | null;
  confirm: (options: SessionDeletionConfirmOptions) => Promise<boolean>;
  deleteSession: (input: {
    session_id: string;
    operationKey: string;
  }) => Promise<{ success: boolean; session_id: string; cleanup?: DeletionCleanup }>;
  deleteWorktree: (input: {
    worktreeId: CloudAgentWorktreeId;
    organizationId: string | null;
    onlyIfSoleSessionId: string;
  }) => Promise<{
    success: true;
    deletedSessionIds: string[];
    cleanup?: DeletionCleanup;
  }>;
  removeDeletedSessions: (sessionIds: readonly string[]) => Promise<void>;
  invalidateQueries: () => Promise<unknown>;
  notifyDeleted: (event: SessionDeletionEvent) => void;
  setSessionPending: (sessionId: string, pending: boolean) => void;
  setWorktreePending: (worktreeId: string, pending: boolean) => void;
  getOperationKey: (sessionId: string) => string;
  dropOperationKey: (sessionId: string) => void;
  notifySuccess: (message: string) => void;
  notifyWarning: (message: string) => void;
  notifyError: (title: string, description: string) => void;
};

export type SessionDeletionFlow = {
  deleteSession: (
    target: SessionDeletionTarget,
    dependencies: SessionDeletionFlowDependencies
  ) => Promise<boolean>;
  isActive: () => boolean;
};

function sessionDeletionLabel(target: SessionDeletionTarget): string {
  const title = target.title?.trim();
  return title ? `"${title}" (${target.sessionId})` : target.sessionId;
}

export function getSessionDeletionConfirmation(
  target: SessionDeletionTarget
): SessionDeletionConfirmOptions {
  return {
    title: 'Delete session?',
    description: `This permanently deletes ${sessionDeletionLabel(target)} and its history.`,
    confirmLabel: 'Delete session',
    destructive: true,
    queue: true,
  };
}

export function getWorkspaceDeletionConfirmation(
  target: SessionDeletionTarget
): SessionDeletionConfirmOptions {
  return {
    title: 'Delete workspace and last session?',
    description: `${sessionDeletionLabel(target)} is the last session in workspace ${target.worktreeId ?? 'this workspace'}. Deleting it permanently deletes the workspace files, all history, and descendant sessions.`,
    confirmLabel: 'Delete workspace and last session',
    destructive: true,
    queue: true,
  };
}

function cleanupWarning(scope: SessionDeletionEvent['scope']): string {
  return scope === 'workspace'
    ? 'Workspace removed; runtime cleanup is incomplete.'
    : 'Session removed; runtime cleanup is incomplete.';
}

function cleanupSuccess(scope: SessionDeletionEvent['scope']): string {
  return scope === 'workspace' ? 'Workspace deleted' : 'Session deleted successfully';
}

async function finishDeletion(
  dependencies: SessionDeletionFlowDependencies,
  event: SessionDeletionEvent
): Promise<void> {
  for (const sessionId of event.deletedSessionIds) {
    dependencies.dropOperationKey(sessionId);
  }

  let pageUpdateFailed = false;
  for (const update of [
    () => dependencies.removeDeletedSessions(event.deletedSessionIds),
    () => dependencies.notifyDeleted(event),
    () => dependencies.invalidateQueries(),
  ]) {
    try {
      await update();
    } catch {
      pageUpdateFailed = true;
    }
  }

  if (event.cleanup === 'pending') {
    dependencies.notifyWarning(cleanupWarning(event.scope));
  } else if (!pageUpdateFailed) {
    dependencies.notifySuccess(cleanupSuccess(event.scope));
  }
  if (pageUpdateFailed) {
    dependencies.notifyWarning(
      'History deleted, but the page could not update completely. Refresh the page.'
    );
  }
}

async function deleteWorkspace(
  target: SessionDeletionTarget,
  dependencies: SessionDeletionFlowDependencies
): Promise<boolean> {
  if (!target.worktreeId) return false;

  const confirmed = await dependencies.confirm(getWorkspaceDeletionConfirmation(target));
  if (!confirmed) return false;

  const worktreeId = target.worktreeId;
  dependencies.setSessionPending(target.sessionId, true);
  dependencies.setWorktreePending(worktreeId, true);
  try {
    const result = await dependencies.deleteWorktree({
      worktreeId: cloudAgentWorktreeIdSchema.parse(worktreeId),
      organizationId: dependencies.organizationId ?? null,
      onlyIfSoleSessionId: target.sessionId,
    });
    await finishDeletion(dependencies, {
      scope: 'workspace',
      deletedSessionIds: result.deletedSessionIds,
      worktreeId,
      cleanup: result.cleanup ?? 'complete',
    });
    return true;
  } catch (error) {
    if (isDeletionNotFoundError(error)) {
      await finishDeletion(dependencies, {
        scope: 'workspace',
        deletedSessionIds: [target.sessionId],
        worktreeId,
        cleanup: 'pending',
      });
      return true;
    }
    await dependencies.invalidateQueries();
    dependencies.notifyError('Could not delete the workspace', getDeletionErrorMessage(error));
    return false;
  } finally {
    dependencies.setSessionPending(target.sessionId, false);
    dependencies.setWorktreePending(worktreeId, false);
  }
}

async function performSessionDeletion(
  target: SessionDeletionTarget,
  dependencies: SessionDeletionFlowDependencies
): Promise<boolean> {
  dependencies.setSessionPending(target.sessionId, true);
  const operationKey = dependencies.getOperationKey(target.sessionId);

  let result: {
    success: boolean;
    session_id: string;
    cleanup?: DeletionCleanup;
  };
  try {
    result = await dependencies.deleteSession({
      session_id: target.sessionId,
      operationKey,
    });
  } catch (error) {
    dependencies.setSessionPending(target.sessionId, false);
    if (isDeletionNotFoundError(error)) {
      await finishDeletion(dependencies, {
        scope: 'session',
        deletedSessionIds: [target.sessionId],
        worktreeId: target.worktreeId,
        cleanup: 'pending',
      });
      return true;
    }
    if (isWorkspaceRequiresRootSessionError(error) && target.worktreeId) {
      dependencies.dropOperationKey(target.sessionId);
      return deleteWorkspace(target, dependencies);
    }
    if (isSettledDeletionFailure(error)) {
      dependencies.dropOperationKey(target.sessionId);
    }
    await dependencies.invalidateQueries();
    dependencies.notifyError('Could not delete the session', getDeletionErrorMessage(error));
    return false;
  }

  dependencies.setSessionPending(target.sessionId, false);
  await finishDeletion(dependencies, {
    scope: 'session',
    deletedSessionIds: [result.session_id],
    worktreeId: target.worktreeId,
    cleanup: result.cleanup ?? 'complete',
  });
  return true;
}

export function createSessionDeletionFlow(): SessionDeletionFlow {
  let active = false;

  return {
    isActive: () => active,
    async deleteSession(target, dependencies) {
      if (active) return false;
      active = true;
      try {
        const confirmed = await dependencies.confirm(getSessionDeletionConfirmation(target));
        if (!confirmed) return false;
        return await performSessionDeletion(target, dependencies);
      } finally {
        active = false;
      }
    },
  };
}
