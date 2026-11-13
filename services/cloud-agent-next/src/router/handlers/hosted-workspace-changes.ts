import type {
  CloudAgentWorkspaceSummary,
  CloudAgentWorktreeId,
} from '@kilocode/session-ingest-contracts';
import {
  getWorktreeFileOutputSchema,
  refreshWorktreeChangesOutputSchema,
  worktreeFileIdentity,
  type GetWorktreeFileOutput,
  type WorktreeChangesSnapshot,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import {
  getHostedWorkspaceChangeFileInput,
  getHostedWorkspaceChangeFileOutput,
  getHostedWorkspaceChangesInput,
  getHostedWorkspaceChangesOutput,
  refreshHostedWorkspaceChangesOutput,
  type HostedWorkspaceChangeComparison,
  type HostedWorkspaceChangeFile,
  type HostedWorkspaceChangeState,
} from '../../shared/hosted-workspace-changes.js';
import type { TRPCContext } from '../../types.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure } from '../auth.js';
import { getAuthorizedHostedWorkspace } from './hosted-workspace-access.js';

const CHANGE_STATES_OPERATION = 'getHostedWorkspaceChangeStates';
const CHANGE_REFRESH_OPERATION = 'refreshHostedWorkspaceChanges';

type WorkspaceRootSession = CloudAgentWorkspaceSummary['sessions'][number];
type SnapshotFile = WorktreeChangesSnapshot['files'][number];

type WorkspaceChangeStates = {
  snapshot: WorktreeChangesSnapshot | null;
  states: HostedWorkspaceChangeState[];
};

function sessionStub(
  ctx: Pick<TRPCContext, 'env'>,
  workspace: CloudAgentWorkspaceSummary,
  session: WorkspaceRootSession
) {
  return getSandboxSessionStub(ctx.env, workspace.userId, session.cloudAgentSessionId);
}

async function readSessionChangeStates(
  ctx: Pick<TRPCContext, 'env'>,
  workspace: CloudAgentWorkspaceSummary,
  session: WorkspaceRootSession
): Promise<WorkspaceChangeStates> {
  return await withDORetry(
    () => sessionStub(ctx, workspace, session),
    async stub => await stub.getWorktreeChangeStates(),
    CHANGE_STATES_OPERATION
  );
}

/**
 * The workspace's shared checkout is stored once per `worktreeId`, so every
 * root session reads the same durable snapshot. Any root with a saved capture
 * is therefore canonical; a sibling that has not reported yet is skipped
 * rather than treated as an empty workspace. The first session is the
 * refresh target when no root has a snapshot.
 */
async function resolveWorkspaceChangeStates(
  ctx: Pick<TRPCContext, 'env'>,
  workspace: CloudAgentWorkspaceSummary
): Promise<{ session: WorkspaceRootSession; result: WorkspaceChangeStates | null } | null> {
  let lastError: unknown;
  for (const session of workspace.sessions) {
    try {
      const result = await readSessionChangeStates(ctx, workspace, session);
      if (result.snapshot) return { session, result };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError !== undefined) throw lastError;
  const [session] = workspace.sessions;
  return session === undefined ? null : { session, result: null };
}

function repositoryIdentity(
  repository: NonNullable<WorktreeChangesSnapshot['repositories']>[number]
) {
  return { path: repository.path, repoFullName: repository.repoFullName };
}

function projectFile(
  file: SnapshotFile,
  state: HostedWorkspaceChangeState | undefined,
  repository: HostedWorkspaceChangeComparison['repository']
): HostedWorkspaceChangeFile {
  return {
    path: file.path,
    status: file.status,
    ...(file.scope === undefined ? {} : { scope: file.scope }),
    additions: file.additions,
    deletions: file.deletions,
    tracked: file.tracked,
    binary: file.binary,
    countsComplete: file.countsComplete,
    revision: file.revision,
    repository,
    diff: state?.diff ?? { status: 'omitted', reason: 'inconsistent' },
    content: state?.content ?? { status: 'unavailable', reason: 'inconsistent' },
  };
}

function comparisonFiles(
  snapshot: WorktreeChangesSnapshot,
  states: ReadonlyMap<string, HostedWorkspaceChangeState>
): HostedWorkspaceChangeFile[] {
  return snapshot.files.map(file =>
    projectFile(file, states.get(worktreeFileIdentity(file)), null)
  );
}

function buildComparisons(
  snapshot: WorktreeChangesSnapshot,
  states: HostedWorkspaceChangeState[]
): HostedWorkspaceChangeComparison[] | null {
  const byIdentity = new Map(states.map(state => [worktreeFileIdentity(state), state]));
  if (snapshot.repositories === undefined) {
    return [
      {
        repository: null,
        comparison: snapshot.comparison,
        truncated: snapshot.truncated,
        files: comparisonFiles(snapshot, byIdentity),
      },
    ];
  }
  const groups = snapshot.repositories.map(repository => ({
    repository,
    files: [] as SnapshotFile[],
  }));
  for (const file of snapshot.files) {
    const owner = snapshot.repositories
      .filter(repository => repository.path === '' || file.path.startsWith(`${repository.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    const group = groups.find(candidate => candidate.repository === owner);
    if (owner === undefined || group === undefined) return null;
    group.files.push(file);
  }
  return groups.map(({ repository, files }) => ({
    repository: repositoryIdentity(repository),
    comparison: repository.comparison,
    truncated: repository.truncated,
    files: files.map(file =>
      projectFile(file, byIdentity.get(worktreeFileIdentity(file)), repositoryIdentity(repository))
    ),
  }));
}

function emptyChanges(workspaceId: CloudAgentWorktreeId, status: 'not_captured' | 'inconsistent') {
  return {
    status,
    workspaceId,
    revision: null,
    capturedAt: null,
    truncated: false,
    comparisons: null,
  };
}

function buildChanges(workspaceId: CloudAgentWorktreeId, result: WorkspaceChangeStates | null) {
  if (result?.snapshot == null) return emptyChanges(workspaceId, 'not_captured');
  const comparisons = buildComparisons(result.snapshot, result.states);
  if (comparisons === null) return emptyChanges(workspaceId, 'inconsistent');
  return {
    status: 'captured' as const,
    workspaceId,
    revision: result.snapshot.revision,
    capturedAt: result.snapshot.capturedAt,
    truncated: comparisons.some(comparison => comparison.truncated),
    comparisons,
  };
}

async function readWorkspaceChanges(
  ctx: Pick<TRPCContext, 'env'>,
  workspace: CloudAgentWorkspaceSummary
) {
  const resolved = await resolveWorkspaceChangeStates(ctx, workspace);
  return buildChanges(workspace.workspaceId, resolved?.result ?? null);
}

function projectFileResult(result: GetWorktreeFileOutput) {
  switch (result.status) {
    case 'available':
    case 'omitted':
      return {
        status: result.status,
        file: result.file,
        capturedAt: result.capturedAt,
        comparison: result.comparison,
        currentRevision: null,
      };
    case 'not_captured':
      return {
        status: result.status,
        file: null,
        capturedAt: null,
        comparison: null,
        currentRevision: null,
      };
    case 'no_longer_listed':
    case 'stale':
      return {
        status: result.status,
        file: null,
        capturedAt: null,
        comparison: null,
        currentRevision: result.currentRevision,
      };
  }
}

export const getHostedWorkspaceChanges = protectedProcedure
  .input(getHostedWorkspaceChangesInput)
  .output(getHostedWorkspaceChangesOutput)
  .query(async ({ input, ctx }) => {
    const workspace = await getAuthorizedHostedWorkspace(ctx, input);
    return await readWorkspaceChanges(ctx, workspace);
  });

export const getHostedWorkspaceChangeFile = protectedProcedure
  .input(getHostedWorkspaceChangeFileInput)
  .output(getHostedWorkspaceChangeFileOutput)
  .query(async ({ input, ctx }) => {
    const workspace = await getAuthorizedHostedWorkspace(ctx, input);
    const resolved = await resolveWorkspaceChangeStates(ctx, workspace);
    if (resolved === null) {
      return {
        status: 'not_captured' as const,
        file: null,
        capturedAt: null,
        comparison: null,
        currentRevision: null,
      };
    }
    const result = getWorktreeFileOutputSchema.parse(
      await withDORetry(
        () => sessionStub(ctx, workspace, resolved.session),
        async stub =>
          await stub.getWorktreeFile({
            path: input.path,
            ...(input.scope === undefined ? {} : { scope: input.scope }),
            expectedRevision: input.expectedRevision,
          }),
        'getHostedWorkspaceChangeFile'
      )
    );
    return projectFileResult(result);
  });

export const refreshHostedWorkspaceChanges = protectedProcedure
  .input(getHostedWorkspaceChangesInput)
  .output(refreshHostedWorkspaceChangesOutput)
  .mutation(async ({ input, ctx }) => {
    const workspace = await getAuthorizedHostedWorkspace(ctx, input);
    const resolved = await resolveWorkspaceChangeStates(ctx, workspace);
    if (resolved === null) {
      return {
        status: 'failed' as const,
        changes: emptyChanges(workspace.workspaceId, 'not_captured'),
      };
    }
    const refresh = refreshWorktreeChangesOutputSchema.parse(
      await withDORetry(
        () => sessionStub(ctx, workspace, resolved.session),
        async stub => await stub.refreshWorktreeChanges(),
        CHANGE_REFRESH_OPERATION
      )
    );
    const states = await readSessionChangeStates(ctx, workspace, resolved.session);
    return {
      status: refresh.status,
      changes: buildChanges(workspace.workspaceId, states),
    };
  });
