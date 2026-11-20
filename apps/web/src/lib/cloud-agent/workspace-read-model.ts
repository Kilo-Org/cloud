import 'server-only';
import { after } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { cloud_agent_user_settings, cloud_agent_workspace_folders } from '@kilocode/db/schema';
import { isDefaultSessionTitle } from '@kilocode/session-ingest-contracts';
import {
  buildWorkspaceStacks,
  type WorkspaceStackNode,
} from '@/components/cloud-agent-next/workspace-stacks';
import { repositoryKeyFromGitUrl } from '@/components/cloud-agent-next/worktree-meta';
import { formatAssociatedPr } from '@/lib/session-associated-pr';
import { triggerBatchReviewDecisionFetchIfNeeded } from '@/lib/integrations/platforms/github/batch-review-decisions';
import {
  aggregateWorkspaceActivity,
  selectVisibleWorkspaceGroups,
  workspaceDestination,
  type WorkspaceDestination,
} from './workspace-activity';
import { DEFAULT_WORKSPACE_ORDER, type WorkspaceOrder } from './workspace-folders';
import {
  hydrateWorkspaceChats,
  readWorkspaceDirectory,
  readWorkspaceStackDirectory,
  readWorkspaceChatPage,
  type WorkspaceDirectoryRow,
  type WorkspaceStackDirectoryRow,
  type WorkspaceReadScope,
  type WorkspaceChatSummary,
} from './workspace-read-model-queries';

export type { WorkspaceChatSummary } from './workspace-read-model-queries';
export { readWorkspaceChatPage };

type ClassifiedWorkspace = WorkspaceDirectoryRow & {
  status: ReturnType<typeof aggregateWorkspaceActivity>;
  destination: WorkspaceDestination;
  stackRootId: string;
  stackDepth: number;
};

type WorkspaceGroup = { root: ClassifiedWorkspace; layers: ClassifiedWorkspace[] };

async function readWorkspaceFolders(scope: WorkspaceReadScope) {
  return db
    .select({
      id: cloud_agent_workspace_folders.id,
      kind: cloud_agent_workspace_folders.kind,
      smartPreset: cloud_agent_workspace_folders.smart_preset,
    })
    .from(cloud_agent_workspace_folders)
    .where(
      and(
        eq(cloud_agent_workspace_folders.kilo_user_id, scope.userId),
        scope.organizationId === null
          ? isNull(cloud_agent_workspace_folders.organization_id)
          : eq(cloud_agent_workspace_folders.organization_id, scope.organizationId)
      )
    );
}

async function resolveWorkspaceOrder(userId: string, requested?: WorkspaceOrder) {
  if (requested) return requested;
  const [settings] = await db
    .select({ workspaceOrder: cloud_agent_user_settings.workspace_order })
    .from(cloud_agent_user_settings)
    .where(eq(cloud_agent_user_settings.kilo_user_id, userId))
    .limit(1);
  return settings?.workspaceOrder ?? DEFAULT_WORKSPACE_ORDER;
}

function workspaceStackCandidateComponents(rows: WorkspaceStackDirectoryRow[]) {
  const nodes: WorkspaceStackNode[] = rows.map(row => ({
    worktreeId: row.worktreeId,
    parentWorktreeId: row.parentWorktreeId,
    branch: row.branch,
    baseBranch: row.baseBranch,
    repositoryKey: repositoryKeyFromGitUrl(row.gitUrl),
    pr: row.pr
      ? {
          number: row.pr.pr_number,
          url: row.pr.pr_url,
          state: row.pr.pr_state,
          baseRef: row.pr.pr_base_ref,
          stackNumber: row.pr.stack_number,
          stackPosition: row.pr.stack_position,
          stackSize: row.pr.stack_size,
          headSha: row.pr.pr_head_sha,
        }
      : null,
  }));
  const byId = new Map(nodes.map(node => [node.worktreeId, node]));
  const positions = new Map(nodes.map((node, index) => [node.worktreeId, index]));
  const adjacent = new Map(nodes.map(node => [node.worktreeId, new Set<string>()]));
  const link = (a: string, b: string) => {
    if (!byId.has(a) || !byId.has(b) || a === b) return;
    adjacent.get(a)?.add(b);
    adjacent.get(b)?.add(a);
  };
  const stacks = new Map<string, string>();
  const branches = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentWorktreeId) link(node.worktreeId, node.parentWorktreeId);
    if (!node.repositoryKey) continue;
    if (node.branch) {
      const key = `${node.repositoryKey}\0${node.branch}`;
      const members = branches.get(key);
      if (members) members.push(node.worktreeId);
      else branches.set(key, [node.worktreeId]);
    }
    if (node.pr?.stackNumber === null || node.pr?.stackNumber === undefined) continue;
    const key = `${node.repositoryKey}#${node.pr.stackNumber}`;
    const previous = stacks.get(key);
    if (previous) link(node.worktreeId, previous);
    stacks.set(key, node.worktreeId);
  }
  const linkedBranches = new Set<string>();
  for (const node of nodes) {
    if (!node.repositoryKey || !node.pr?.baseRef) continue;
    const key = `${node.repositoryKey}\0${node.pr.baseRef}`;
    const members = branches.get(key);
    const first = members?.[0];
    if (!first) continue;
    link(node.worktreeId, first);
    if (linkedBranches.has(key)) continue;
    linkedBranches.add(key);
    for (const member of members) link(first, member);
  }
  const visited = new Set<string>();
  const components: WorkspaceStackNode[][] = [];
  for (const node of nodes) {
    if (visited.has(node.worktreeId)) continue;
    const pending = [node.worktreeId];
    const component: WorkspaceStackNode[] = [];
    while (pending.length > 0) {
      const id = pending.pop();
      if (!id || visited.has(id)) continue;
      visited.add(id);
      const member = byId.get(id);
      if (member) component.push(member);
      for (const neighbor of adjacent.get(id) ?? []) pending.push(neighbor);
    }
    components.push(
      component.sort(
        (a, b) => (positions.get(a.worktreeId) ?? 0) - (positions.get(b.worktreeId) ?? 0)
      )
    );
  }
  return components;
}

function workspaceStacks(rows: WorkspaceStackDirectoryRow[]) {
  return workspaceStackCandidateComponents(rows).flatMap(buildWorkspaceStacks);
}

function classifyWorkspaces(
  rows: WorkspaceDirectoryRow[],
  folders: Awaited<ReturnType<typeof readWorkspaceFolders>>
): WorkspaceGroup[] {
  const workspaces = new Map<string, ClassifiedWorkspace>(
    rows.map(row => [
      row.worktreeId,
      {
        ...row,
        status: aggregateWorkspaceActivity([
          row.latest,
          ...row.active.filter(session => session.sessionId !== row.latest.sessionId),
        ]),
        destination: { kind: 'ungrouped' },
        stackRootId: row.worktreeId,
        stackDepth: 0,
      },
    ])
  );
  return workspaceStacks(rows).flatMap(stack => {
    const members = stack.entries.flatMap(entry => {
      const row = workspaces.get(entry.node.worktreeId);
      return row ? [{ ...row, stackRootId: stack.rootWorktreeId, stackDepth: entry.depth }] : [];
    });
    const [root, ...layers] = members;
    if (!root) return [];
    const destinationRow = (row: ClassifiedWorkspace) => ({
      folderId: row.folderId,
      prState: row.pr?.pr_state ?? null,
      status: row.status.sessionStatus,
    });
    const destination = workspaceDestination(
      { root: destinationRow(root), layers: layers.map(destinationRow) },
      folders
    );
    return [
      { root: { ...root, destination }, layers: layers.map(row => ({ ...row, destination })) },
    ];
  });
}

function compareText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function workspaceComparator(order: WorkspaceOrder) {
  return (a: ClassifiedWorkspace, b: ClassifiedWorkspace) => {
    if (order === 'manual') {
      const positions =
        Number(a.sidebarPosition !== null) - Number(b.sidebarPosition !== null) ||
        compareText(a.sidebarPosition ?? '', b.sidebarPosition ?? '');
      if (positions !== 0) return positions;
    }
    if (order === 'activity') {
      const activity = Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
      if (activity !== 0) return activity;
    }
    return (
      Date.parse(b.createdAt) - Date.parse(a.createdAt) || compareText(a.worktreeId, b.worktreeId)
    );
  };
}

function activityComparator(a: WorkspaceChatSummary, b: WorkspaceChatSummary) {
  return (
    Date.parse(b.lastActivityAt ?? b.createdAt) - Date.parse(a.lastActivityAt ?? a.createdAt) ||
    b.sessionId.localeCompare(a.sessionId)
  );
}

async function hydrateWorkspaces(scope: WorkspaceReadScope, rows: ClassifiedWorkspace[]) {
  const hydration = new Map(
    (
      await hydrateWorkspaceChats(
        scope,
        rows.map(row => row.worktreeId)
      )
    ).map(row => [row.worktreeId, row])
  );
  const workspaces = rows.flatMap(row => {
    const hydrated = hydration.get(row.worktreeId);
    if (!hydrated) return [];
    const chats = hydrated.chats;
    const root = chats[0];
    if (!root) return [];
    const closedIds = new Set(row.closedSessionIds);
    const tabPositions = new Map(row.tabOrder.map((id, index) => [id, index]));
    const openChats = chats
      .filter(chat => !closedIds.has(chat.sessionId))
      .sort((a, b) => {
        const position =
          (tabPositions.get(a.sessionId) ?? Infinity) - (tabPositions.get(b.sessionId) ?? Infinity);
        return Number.isNaN(position) ? 0 : position;
      });
    const chatsById = new Map(chats.map(chat => [chat.sessionId, chat]));
    const closedChats = [...new Set(row.closedSessionIds)].flatMap(id => {
      const chat = chatsById.get(id);
      return chat ? [chat] : [];
    });
    const latest = [...chats].sort(activityComparator)[0] ?? root;
    const latestOpen = [...openChats].sort(activityComparator)[0];
    const pr = row.pr
      ? formatAssociatedPr(
          {
            platform: null,
            pr_url: null,
            pr_number: null,
            updated_at: null,
            git_url: row.gitUrl,
            pr_link_verified_at: null,
          },
          { ...row.pr, pr_from_workspace: true, pr_observations: hydrated.observations }
        )
      : null;
    return [
      {
        worktreeId: row.worktreeId,
        name: row.name,
        defaultTitle: root.title?.trim() && !isDefaultSessionTitle(root.title) ? root.title : null,
        branch: row.branch,
        createdAt: row.createdAt,
        lastActivityAt: row.lastActivityAt,
        folderId: row.folderId,
        sidebarPosition: row.sidebarPosition,
        parentWorktreeId: row.parentWorktreeId,
        baseBranch: row.baseBranch,
        baseSha: row.baseSha,
        rootSessionId: root.sessionId,
        latestSessionId: latest.sessionId,
        latestOpenSessionId: latestOpen?.sessionId ?? null,
        cloudAgentSessionId: latestOpen?.cloudAgentSessionId ?? latest.cloudAgentSessionId,
        gitUrl: row.gitUrl,
        pr,
        status: row.status,
        sessionStatus: row.status.sessionStatus,
        destination: row.destination,
        stackRootId: row.stackRootId,
        stackDepth: row.stackDepth,
        chatCount: chats.length,
        hasOpenRun: hydrated.hasOpenRun,
        openChats,
        closedChats,
      },
    ];
  });
  if (workspaces.some(workspace => workspace.pr?.reviewDecisionPending)) {
    after(() => triggerBatchReviewDecisionFetchIfNeeded(true, scope));
  }
  return workspaces;
}

export type WorkspaceSummary = Awaited<ReturnType<typeof hydrateWorkspaces>>[number];

function normalizeWorkspaceSearch(search?: string) {
  const value = search?.trim().toLowerCase() ?? '';
  return value.startsWith('#') ? value.slice(1) : value;
}

export async function listWorkspaceSummaries(
  scope: WorkspaceReadScope,
  input: {
    createdOnPlatform?: string | string[];
    gitUrl?: string | string[];
    sortMode?: WorkspaceOrder;
    limit?: number;
    cursor?: number;
    search?: string;
  }
) {
  const search = normalizeWorkspaceSearch(input.search);
  const [rows, folders, workspaceOrder] = await Promise.all([
    readWorkspaceDirectory(scope, { ...input, search }),
    readWorkspaceFolders(scope),
    resolveWorkspaceOrder(scope.userId, input.sortMode),
  ]);
  const groups = classifyWorkspaces(rows, folders);
  const visible = selectVisibleWorkspaceGroups(groups);
  const compare = workspaceComparator(workspaceOrder);
  const offset = input.cursor ?? 0;
  const limit = input.limit ?? 100;
  const matching = search
    ? groups
        .flatMap(group => [group.root, ...group.layers])
        .filter(row => row.searchMatch)
        .sort(compare)
    : [];
  const selected = search
    ? matching.slice(offset, offset + limit)
    : [...visible.groups]
        .sort((a, b) => compare(a.root, b.root))
        .flatMap(group => [group.root, ...group.layers]);
  return {
    workspaces: await hydrateWorkspaces(scope, selected),
    workspaceOrder,
    destinationTotals: visible.totals,
    truncated: !search && visible.groups.length < groups.length,
    nextCursor: search && matching.length > offset + limit ? offset + limit : null,
  };
}

export async function readWorkspaceSummaries(
  scope: WorkspaceReadScope,
  input: {
    worktreeIds: string[];
    includeAncestors?: boolean;
    createdOnPlatform?: string | string[];
    gitUrl?: string | string[];
    search?: string;
  }
) {
  if (input.worktreeIds.length === 0) return { workspaces: [] };
  const [directory, folders] = await Promise.all([
    readWorkspaceStackDirectory(scope, input.worktreeIds, input),
    readWorkspaceFolders(scope),
  ]);
  const requested = new Set(input.worktreeIds);
  const directoryIds = workspaceStackCandidateComponents(directory)
    .filter(component => component.some(node => requested.has(node.worktreeId)))
    .flatMap(buildWorkspaceStacks)
    .flatMap(stack =>
      stack.entries.some(entry => requested.has(entry.node.worktreeId))
        ? stack.entries.map(entry => entry.node.worktreeId)
        : []
    );
  if (directoryIds.length === 0) return { workspaces: [] };
  const rows = await readWorkspaceDirectory(scope, {
    directoryIds,
    createdOnPlatform: input.createdOnPlatform,
    gitUrl: input.gitUrl,
    search: normalizeWorkspaceSearch(input.search),
  });
  const groups = classifyWorkspaces(rows, folders);
  const selected = groups.flatMap(group => {
    const members = [group.root, ...group.layers];
    if (!members.some(row => requested.has(row.worktreeId))) return [];
    return (
      input.includeAncestors ? members : members.filter(row => requested.has(row.worktreeId))
    ).filter(row => row.searchMatch);
  });
  return { workspaces: await hydrateWorkspaces(scope, selected) };
}
