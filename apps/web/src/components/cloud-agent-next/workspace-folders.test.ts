import { describe, expect, it } from '@jest/globals';
import type { WorkspaceFolder } from '@/lib/cloud-agent/workspace-folders';
import type { SidebarSessionDateGroup, SidebarWorktreeGroup } from './hooks/useSidebarSessions';
import type { StoredSession } from './types';
import {
  getCollapsedWorkspaceFoldersStorageKey,
  getWorkspaceFolderDropAction,
  groupWorkspacesByFolder,
  isFolderWorkspace,
  parseCollapsedWorkspaceFolders,
} from './workspace-folders';

const folderA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const folderB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const folderC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const worktreeA = `worktree_${folderA}`;
const worktreeB = `worktree_${folderB}`;
const hiddenWorktree = `worktree_${folderC}`;

function makeSession(id: string, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    sessionId: id,
    repository: 'kilo/repo',
    prompt: id,
    mode: 'code',
    model: 'kilo/fake-deterministic',
    status: 'active',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    messages: [],
    ...overrides,
  };
}

function makeGroup(worktreeId: string, cloudId = `workspace_${folderA}`): SidebarWorktreeGroup {
  const session = makeSession(`ses_${worktreeId}`, { worktreeId, cloudAgentSessionId: cloudId });
  return { type: 'worktree', worktreeId, sessions: [session], latestSession: session };
}

function makeFolders(): WorkspaceFolder[] {
  return [
    { id: folderA, name: 'Product', color: 'blue', worktreeIds: [worktreeA, hiddenWorktree] },
    { id: folderB, name: 'Research', color: 'purple', worktreeIds: [] },
    { id: folderC, name: 'Backlog', color: 'default', worktreeIds: [] },
  ];
}

const visibleWorktrees = new Set([worktreeA, worktreeB]);

function folderTarget(id: string, placement: 'before' | 'after' = 'before') {
  return { type: 'folder', id, placement } as const;
}

describe('workspace folder grouping', () => {
  it('moves the whole workspace group and keeps unfiled date ordering and standalone sessions', () => {
    const filed = makeGroup(worktreeA);
    const sibling = makeSession('ses_sibling', { worktreeId: worktreeA });
    filed.sessions.push(sibling);
    const unfiled = makeGroup(worktreeB);
    const standalone = makeSession('ses_standalone');
    const dates: SidebarSessionDateGroup[] = [
      { label: 'Today', items: [filed, { type: 'session', session: standalone }] },
      { label: 'Yesterday', items: [unfiled] },
    ];

    const result = groupWorkspacesByFolder(dates, makeFolders());

    expect(result.folderGroups[0].worktrees).toEqual([filed]);
    expect(result.folderGroups[0].worktrees[0].sessions).toContain(sibling);
    expect(result.ungrouped).toEqual([
      { label: 'Today', items: [{ type: 'session', session: standalone }] },
      { label: 'Yesterday', items: [unfiled] },
    ]);
    expect(dates[0].items).toHaveLength(2);
  });

  it('preserves empty folders, invisible membership and the full saved folder order', () => {
    const folders = makeFolders();
    const result = groupWorkspacesByFolder([], folders);

    expect(result.folderGroups.map(group => group.folder)).toEqual(folders);
    expect(result.folderGroups.every(group => group.worktrees.length === 0)).toBe(true);
    expect(result.folderGroups[0].folder.worktreeIds).toEqual([worktreeA, hiddenWorktree]);
  });

  it('returns members to date groups when their folder no longer exists', () => {
    const dates: SidebarSessionDateGroup[] = [{ label: 'Today', items: [makeGroup(worktreeA)] }];
    const result = groupWorkspacesByFolder(dates, []);
    expect(result.folderGroups).toEqual([]);
    expect(result.ungrouped).toEqual(dates);
  });

  it('does not file legacy or malformed workspace rows', () => {
    const legacy = makeGroup(worktreeA, `agent_${folderA}`);
    const malformed = makeGroup('worktree_not-a-uuid');
    const dates: SidebarSessionDateGroup[] = [{ label: 'Today', items: [legacy, malformed] }];

    expect(isFolderWorkspace(legacy)).toBe(false);
    expect(isFolderWorkspace(malformed)).toBe(false);
    expect(isFolderWorkspace(makeGroup(worktreeA, 'workspace_invalid'))).toBe(false);
    expect(groupWorkspacesByFolder(dates, makeFolders()).ungrouped).toEqual(dates);
  });
});

describe('workspace folder drops', () => {
  it('moves an unfiled workspace into an empty folder', () => {
    expect(
      getWorkspaceFolderDropAction(
        { type: 'worktree', id: worktreeB },
        folderTarget(folderB),
        makeFolders(),
        visibleWorktrees
      )
    ).toEqual({ type: 'move-worktree', worktreeId: worktreeB, folderId: folderB });
  });

  it('moves a workspace between folders without changing its identity', () => {
    expect(
      getWorkspaceFolderDropAction(
        { type: 'worktree', id: worktreeA },
        folderTarget(folderB),
        makeFolders(),
        visibleWorktrees
      )
    ).toEqual({ type: 'move-worktree', worktreeId: worktreeA, folderId: folderB });
  });

  it('moves a filed workspace out to Ungrouped', () => {
    expect(
      getWorkspaceFolderDropAction(
        { type: 'worktree', id: worktreeA },
        { type: 'ungrouped' },
        makeFolders(),
        visibleWorktrees
      )
    ).toEqual({ type: 'move-worktree', worktreeId: worktreeA, folderId: null });
  });

  it('ignores cancelled, external, stale and no-op workspace drops', () => {
    const drag = { type: 'worktree', id: worktreeA } as const;
    expect(
      getWorkspaceFolderDropAction(null, folderTarget(folderA), makeFolders(), visibleWorktrees)
    ).toBeNull();
    expect(getWorkspaceFolderDropAction(drag, null, makeFolders(), visibleWorktrees)).toBeNull();
    expect(
      getWorkspaceFolderDropAction(drag, folderTarget(folderA), makeFolders(), visibleWorktrees)
    ).toBeNull();
    expect(
      getWorkspaceFolderDropAction(drag, folderTarget('missing'), makeFolders(), visibleWorktrees)
    ).toBeNull();
    expect(
      getWorkspaceFolderDropAction(
        { type: 'worktree', id: 'ses_legacy' },
        folderTarget(folderB),
        makeFolders(),
        visibleWorktrees
      )
    ).toBeNull();
    expect(
      getWorkspaceFolderDropAction(
        { type: 'worktree', id: worktreeB },
        { type: 'ungrouped' },
        makeFolders(),
        visibleWorktrees
      )
    ).toBeNull();
  });

  it('reorders a folder before an earlier folder while preserving all members', () => {
    const folders = makeFolders();
    expect(
      getWorkspaceFolderDropAction(
        { type: 'folder', id: folderC },
        folderTarget(folderA),
        folders,
        visibleWorktrees
      )
    ).toEqual({ type: 'reorder-folders', folderIds: [folderC, folderA, folderB] });
    expect(folders).toEqual(makeFolders());
  });

  it('reorders a folder after a later folder', () => {
    expect(
      getWorkspaceFolderDropAction(
        { type: 'folder', id: folderA },
        folderTarget(folderC, 'after'),
        makeFolders(),
        visibleWorktrees
      )
    ).toEqual({ type: 'reorder-folders', folderIds: [folderB, folderC, folderA] });
  });

  it('does not nest folders, drop them in Ungrouped, or save unchanged ordering', () => {
    const drag = { type: 'folder', id: folderA } as const;
    expect(
      getWorkspaceFolderDropAction(drag, folderTarget(folderA), makeFolders(), visibleWorktrees)
    ).toBeNull();
    expect(
      getWorkspaceFolderDropAction(drag, { type: 'ungrouped' }, makeFolders(), visibleWorktrees)
    ).toBeNull();
    expect(
      getWorkspaceFolderDropAction(drag, folderTarget(folderB), makeFolders(), visibleWorktrees)
    ).toBeNull();
    expect(
      getWorkspaceFolderDropAction(
        { type: 'folder', id: 'missing' },
        folderTarget(folderB),
        makeFolders(),
        visibleWorktrees
      )
    ).toBeNull();
  });
});

describe('collapsed folder preferences', () => {
  it('isolates users and exact organization contexts, including OAuth user IDs', () => {
    const keys = [
      getCollapsedWorkspaceFoldersStorageKey('oauth/provider/user'),
      getCollapsedWorkspaceFoldersStorageKey('oauth/provider/user', folderA),
      getCollapsedWorkspaceFoldersStorageKey('oauth/provider/user', folderB),
      getCollapsedWorkspaceFoldersStorageKey('another-user'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('round-trips valid state and rejects corrupt local storage', () => {
    expect(parseCollapsedWorkspaceFolders(JSON.stringify([folderA, folderB, folderA]))).toEqual([
      folderA,
      folderB,
    ]);
    for (const value of ['broken json', '{}', 'null', '["not-an-id"]']) {
      expect(parseCollapsedWorkspaceFolders(value)).toEqual([]);
    }
  });
});
