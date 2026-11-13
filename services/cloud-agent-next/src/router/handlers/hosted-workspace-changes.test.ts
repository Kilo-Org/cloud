import type { CloudAgentWorkspaceSummary } from '@kilocode/session-ingest-contracts';
import type { WorktreeChangesSnapshot } from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TRPCContext } from '../../types.js';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getDb: vi.fn(),
  hasOrganizationAccess: vi.fn(),
}));

vi.mock('../../sandbox-session/session-stub', () => ({
  getSandboxSessionStub: mocks.getSession,
}));
vi.mock('../../db/pg', () => ({ getPgDb: mocks.getDb }));
vi.mock('@kilocode/worker-utils', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, hasOrganizationAccess: mocks.hasOrganizationAccess };
});

import { router } from '../auth.js';
import {
  getHostedWorkspaceChangeFile,
  getHostedWorkspaceChanges,
  refreshHostedWorkspaceChanges,
} from './hosted-workspace-changes.js';

const userId = 'usr_owner';
const workspaceId = 'worktree_11111111-1111-4111-8111-111111111111' as const;
const firstSession = 'workspace_11111111-1111-4111-8111-111111111111';
const secondSession = 'workspace_22222222-2222-4222-8222-222222222222';
const capturedAt = '2026-11-13T16:00:00.000Z';
const comparison = {
  baseRef: 'refs/remotes/origin/main',
  mergeBase: 'a'.repeat(40),
  head: 'b'.repeat(40),
};

function workspace(
  overrides: Partial<CloudAgentWorkspaceSummary> = {}
): CloudAgentWorkspaceSummary {
  return {
    workspaceId,
    userId,
    organizationId: null,
    name: null,
    repositoryProvider: 'github',
    gitUrl: 'https://github.com/Kilo-Org/cloud',
    gitBranch: 'feature/diffs',
    profileId: null,
    deletionState: 'active',
    created: 1_760_000_000_000,
    updated: 1_760_000_001_000,
    lastActivity: 1_760_000_002_000,
    sessions: [
      {
        kiloSessionId: 'ses_11111111111111111111111111',
        cloudAgentSessionId: firstSession,
        workspaceId,
        userId,
        organizationId: null,
        title: null,
        gitUrl: null,
        gitBranch: null,
        profileId: null,
        createdOnPlatform: 'cloud-agent-web',
        created: 1_760_000_000_000,
        updated: 1_760_000_001_000,
      },
      {
        kiloSessionId: 'ses_22222222222222222222222222',
        cloudAgentSessionId: secondSession,
        workspaceId,
        userId,
        organizationId: null,
        title: null,
        gitUrl: null,
        gitBranch: null,
        profileId: null,
        createdOnPlatform: 'cloud-agent-web',
        created: 1_760_000_000_000,
        updated: 1_760_000_001_000,
      },
    ],
    nextSessionCursor: null,
    ...overrides,
  };
}

function snapshot(
  files: WorktreeChangesSnapshot['files'],
  overrides: Partial<WorktreeChangesSnapshot> = {}
): WorktreeChangesSnapshot {
  return {
    schemaVersion: 2,
    revision: 7,
    capturedAt,
    comparison,
    files,
    truncated: false,
    ...overrides,
  };
}

function savedFile(
  path: string,
  overrides: Partial<WorktreeChangesSnapshot['files'][number]> = {}
): WorktreeChangesSnapshot['files'][number] {
  return {
    path,
    revision: 7,
    status: 'modified',
    additions: 1,
    deletions: 1,
    tracked: true,
    binary: false,
    countsComplete: true,
    ...overrides,
  };
}

function statesFor(files: WorktreeChangesSnapshot['files']) {
  return files.map(file => ({
    path: file.path,
    ...(file.scope === undefined ? {} : { scope: file.scope }),
    revision: file.revision,
    diff: { status: 'available' as const },
    content: { status: 'available' as const, source: 'current' as const },
  }));
}

function stub(overrides: Record<string, unknown> = {}) {
  return {
    getWorktreeChangeStates: vi.fn().mockResolvedValue({ snapshot: null, states: [] }),
    getWorktreeFile: vi.fn(),
    refreshWorktreeChanges: vi.fn(),
    ...overrides,
  };
}

function fixture(
  options: {
    workspace?: CloudAgentWorkspaceSummary | null;
    stubs?: Record<string, ReturnType<typeof stub>>;
    organizationAccess?: boolean;
  } = {}
) {
  const getCloudAgentWorkspace = vi.fn(async () =>
    options.workspace === undefined ? workspace() : options.workspace
  );
  const stubs = options.stubs ?? { [firstSession]: stub(), [secondSession]: stub() };
  mocks.getSession.mockImplementation((_env, _owner, sessionId: string) => {
    const selected = stubs[sessionId];
    if (!selected) throw new Error(`unexpected session ${sessionId}`);
    return selected;
  });
  mocks.getDb.mockReturnValue({});
  mocks.hasOrganizationAccess.mockResolvedValue(options.organizationAccess ?? true);
  const context = {
    env: { SESSION_INGEST: { getCloudAgentWorkspace } } as never,
    userId,
    authToken: 'test-token',
    request: new Request('https://worker.test/trpc'),
  } satisfies TRPCContext;
  const caller = router({
    getHostedWorkspaceChanges,
    refreshHostedWorkspaceChanges,
    getHostedWorkspaceChangeFile,
  }).createCaller(context);
  return { caller, getCloudAgentWorkspace, stubs };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getHostedWorkspaceChanges', () => {
  it('reads one canonical snapshot from a sibling session without preparing compute', async () => {
    const files = [savedFile('src/app.ts')];
    const second = stub({
      getWorktreeChangeStates: vi
        .fn()
        .mockResolvedValue({ snapshot: snapshot(files), states: statesFor(files) }),
    });
    const test = fixture({
      stubs: { [firstSession]: stub(), [secondSession]: second },
    });

    const result = await test.caller.getHostedWorkspaceChanges({ workspaceId });

    expect(test.stubs[firstSession]?.getWorktreeChangeStates).toHaveBeenCalledTimes(1);
    expect(second.getWorktreeChangeStates).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 'captured',
      workspaceId,
      revision: 7,
      capturedAt,
      truncated: false,
      comparisons: [
        {
          repository: null,
          comparison,
          truncated: false,
          files: [
            {
              path: 'src/app.ts',
              status: 'modified',
              additions: 1,
              deletions: 1,
              tracked: true,
              binary: false,
              countsComplete: true,
              revision: 7,
              repository: null,
              diff: { status: 'available' },
              content: { status: 'available', source: 'current' },
            },
          ],
        },
      ],
    });
  });

  it('returns a flat not-captured envelope when no root has a saved snapshot', async () => {
    const test = fixture();

    await expect(test.caller.getHostedWorkspaceChanges({ workspaceId })).resolves.toEqual({
      status: 'not_captured',
      workspaceId,
      revision: null,
      capturedAt: null,
      truncated: false,
      comparisons: null,
    });
  });

  it('keeps multi-repository comparisons separate instead of merging files', async () => {
    const files = [savedFile('src/app.ts'), savedFile('web/src/page.tsx')];
    const saved: WorktreeChangesSnapshot = snapshot(files, {
      repositories: [
        { path: '', repoFullName: 'acme/mono', comparison, truncated: false },
        { path: 'web', repoFullName: 'acme/web', comparison, truncated: false },
      ],
    });
    const test = fixture({
      stubs: {
        [firstSession]: stub({
          getWorktreeChangeStates: vi
            .fn()
            .mockResolvedValue({ snapshot: saved, states: statesFor(files) }),
        }),
      },
    });

    const result = await test.caller.getHostedWorkspaceChanges({ workspaceId });

    expect(result.status).toBe('captured');
    expect(result.comparisons).toHaveLength(2);
    expect(result.comparisons?.[0]).toMatchObject({
      repository: { path: '', repoFullName: 'acme/mono' },
      files: [{ path: 'src/app.ts' }],
    });
    expect(result.comparisons?.[1]).toMatchObject({
      repository: { path: 'web', repoFullName: 'acme/web' },
      files: [{ path: 'web/src/page.tsx' }],
    });
  });

  it('fails closed when a multi-repository file matches no repository', async () => {
    const files = [savedFile('outside.ts')];
    const saved = snapshot(files, {
      repositories: [{ path: 'web', repoFullName: 'acme/web', comparison, truncated: false }],
    });
    const test = fixture({
      stubs: {
        [firstSession]: stub({
          getWorktreeChangeStates: vi
            .fn()
            .mockResolvedValue({ snapshot: saved, states: statesFor(files) }),
        }),
      },
    });

    await expect(test.caller.getHostedWorkspaceChanges({ workspaceId })).resolves.toMatchObject({
      status: 'inconsistent',
      comparisons: null,
    });
  });

  it('falls back to a healthy sibling when one root read fails', async () => {
    const files = [savedFile('src/app.ts')];
    const test = fixture({
      stubs: {
        [firstSession]: stub({
          getWorktreeChangeStates: vi.fn().mockRejectedValue(new Error('DO unavailable')),
        }),
        [secondSession]: stub({
          getWorktreeChangeStates: vi
            .fn()
            .mockResolvedValue({ snapshot: snapshot(files), states: statesFor(files) }),
        }),
      },
    });

    await expect(test.caller.getHostedWorkspaceChanges({ workspaceId })).resolves.toMatchObject({
      status: 'captured',
      comparisons: [{ files: [{ path: 'src/app.ts' }] }],
    });
  });

  it('propagates a read failure instead of reporting an empty workspace', async () => {
    const failing = stub({
      getWorktreeChangeStates: vi.fn().mockRejectedValue(new Error('DO unavailable')),
    });
    const test = fixture({
      stubs: { [firstSession]: failing, [secondSession]: failing },
    });

    await expect(test.caller.getHostedWorkspaceChanges({ workspaceId })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });

  it('rejects a workspace owned by another user as not found', async () => {
    const test = fixture({ workspace: null });

    await expect(test.caller.getHostedWorkspaceChanges({ workspaceId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(test.stubs[firstSession]?.getWorktreeChangeStates).not.toHaveBeenCalled();
  });

  it('rejects an organization scope that names another tenant', async () => {
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const otherOrganizationId = '22222222-2222-4222-8222-222222222222';
    const test = fixture({ workspace: workspace({ organizationId }) });

    await expect(
      test.caller.getHostedWorkspaceChanges({
        workspaceId,
        kilocodeOrganizationId: otherOrganizationId,
      })
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      test.caller.getHostedWorkspaceChanges({
        workspaceId,
        kilocodeOrganizationId: otherOrganizationId,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(test.stubs[firstSession]?.getWorktreeChangeStates).not.toHaveBeenCalled();
  });
});

describe('getHostedWorkspaceChangeFile', () => {
  it('proxies the revision-fenced file read from the canonical session', async () => {
    const file = {
      schemaVersion: 1 as const,
      revision: 7,
      path: 'src/app.ts',
      diff: { status: 'available' as const, patch: 'diff --git a b\n' },
      content: { status: 'available' as const, source: 'current' as const, text: 'x' },
    };
    const first = stub({
      getWorktreeChangeStates: vi
        .fn()
        .mockResolvedValue({ snapshot: snapshot([savedFile('src/app.ts')]), states: [] }),
      getWorktreeFile: vi
        .fn()
        .mockResolvedValue({ status: 'available', file, capturedAt, comparison }),
    });
    const test = fixture({ stubs: { [firstSession]: first } });

    const result = await test.caller.getHostedWorkspaceChangeFile({
      workspaceId,
      path: 'src/app.ts',
      expectedRevision: 7,
    });

    expect(first.getWorktreeFile).toHaveBeenCalledWith({
      path: 'src/app.ts',
      expectedRevision: 7,
    });
    expect(result).toEqual({
      status: 'available',
      file,
      capturedAt,
      comparison,
      currentRevision: null,
    });
  });

  it('returns a distinct stale result with the current revision', async () => {
    const first = stub({
      getWorktreeChangeStates: vi
        .fn()
        .mockResolvedValue({ snapshot: snapshot([savedFile('src/app.ts')]), states: [] }),
      getWorktreeFile: vi.fn().mockResolvedValue({ status: 'stale', currentRevision: 9 }),
    });
    const test = fixture({ stubs: { [firstSession]: first } });

    await expect(
      test.caller.getHostedWorkspaceChangeFile({
        workspaceId,
        path: 'src/app.ts',
        expectedRevision: 7,
      })
    ).resolves.toEqual({
      status: 'stale',
      file: null,
      capturedAt: null,
      comparison: null,
      currentRevision: 9,
    });
  });
});

describe('refreshHostedWorkspaceChanges', () => {
  it('keeps the previous snapshot and reports offline when compute is stopped', async () => {
    const files = [savedFile('src/app.ts')];
    const saved = snapshot(files);
    const first = stub({
      getWorktreeChangeStates: vi
        .fn()
        .mockResolvedValueOnce({ snapshot: saved, states: statesFor(files) })
        .mockResolvedValueOnce({ snapshot: saved, states: statesFor(files) }),
      refreshWorktreeChanges: vi.fn().mockResolvedValue({ status: 'offline', snapshot: saved }),
    });
    const test = fixture({ stubs: { [firstSession]: first } });

    const result = await test.caller.refreshHostedWorkspaceChanges({ workspaceId });

    expect(result.status).toBe('offline');
    expect(result.changes.status).toBe('captured');
    expect(result.changes.revision).toBe(7);
    expect(first.refreshWorktreeChanges).toHaveBeenCalledTimes(1);
  });
});
