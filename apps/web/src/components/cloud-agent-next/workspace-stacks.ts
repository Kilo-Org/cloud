import { stackedWorkspacePushReason } from './stacked-workspace-preparation';

/** The PR details a stack node needs; mirrors the flat PR cache fields. */
export type WorkspaceStackPr = {
  number: number | null;
  url: string | null;
  state: string | null;
  baseRef: string | null;
  stackNumber: number | null;
  stackPosition: number | null;
  stackSize: number | null;
  headSha: string | null;
};

export type WorkspaceStackNode = {
  worktreeId: string;
  parentWorktreeId: string | null;
  branch: string | null;
  baseBranch: string | null;
  /** Host-aware repository identity; never just the full name. */
  repositoryKey: string | null;
  pr: WorkspaceStackPr | null;
};

export type WorkspaceStackEntry = {
  node: WorkspaceStackNode;
  depth: number;
};

export type WorkspaceStack = {
  rootWorktreeId: string;
  entries: WorkspaceStackEntry[];
};

export type StackUrgency = 'attention' | 'running' | 'failed' | 'idle';

type ParentEdge = { parentId: string; inferred: boolean };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareStackPosition(a: WorkspaceStackNode, b: WorkspaceStackNode): number {
  const aPosition = a.pr?.stackPosition ?? Number.POSITIVE_INFINITY;
  const bPosition = b.pr?.stackPosition ?? Number.POSITIVE_INFINITY;
  if (aPosition !== bPosition) return aPosition - bPosition;
  return compareText(a.branch ?? '', b.branch ?? '') || compareText(a.worktreeId, b.worktreeId);
}

/**
 * Edges come from the durable stack link first. PR data only fills gaps:
 * a shared GitHub stack number, then a PR whose base is another worktree's
 * branch in the same repository.
 */
function hostIdentity(key: string): string | null {
  return key.split('/', 1)[0]?.includes('.') ? key : null;
}

function sameRepository(a: WorkspaceStackNode, b: WorkspaceStackNode): boolean {
  if (a.repositoryKey === null || b.repositoryKey === null) return true;
  if (a.repositoryKey === b.repositoryKey) return true;
  // A display-name fallback cannot prove a different host, so keep the durable
  // parent link. Two host-qualified git URLs can prove a cross-repository edge.
  return hostIdentity(a.repositoryKey) === null || hostIdentity(b.repositoryKey) === null;
}

function buildParentEdges(
  nodesById: ReadonlyMap<string, WorkspaceStackNode>
): Map<string, ParentEdge> {
  const edges = new Map<string, ParentEdge>();
  const nodes = [...nodesById.values()];

  for (const node of nodes) {
    const parentId = node.parentWorktreeId;
    const parent = parentId ? nodesById.get(parentId) : undefined;
    if (parentId && parentId !== node.worktreeId && parent && sameRepository(node, parent)) {
      edges.set(node.worktreeId, { parentId, inferred: false });
    }
  }

  const stackGroups = new Map<string, WorkspaceStackNode[]>();
  for (const node of nodes) {
    if (edges.has(node.worktreeId)) continue;
    const stackNumber = node.pr?.stackNumber;
    if (stackNumber === null || stackNumber === undefined || !node.repositoryKey) continue;
    const key = `${node.repositoryKey}#${stackNumber}`;
    const group = stackGroups.get(key);
    if (group) group.push(node);
    else stackGroups.set(key, [node]);
  }
  for (const group of stackGroups.values()) {
    const ordered = [...group].sort(compareStackPosition);
    for (let index = 1; index < ordered.length; index++) {
      const node = ordered[index];
      const parent = ordered[index - 1];
      if (!node || !parent || edges.has(node.worktreeId)) continue;
      edges.set(node.worktreeId, { parentId: parent.worktreeId, inferred: true });
    }
  }

  const byBranch = new Map<string, WorkspaceStackNode>();
  for (const node of nodes) {
    if (!node.repositoryKey || !node.branch) continue;
    byBranch.set(`${node.repositoryKey}\0${node.branch}`, node);
  }
  for (const node of nodes) {
    if (edges.has(node.worktreeId)) continue;
    const baseRef = node.pr?.baseRef;
    if (!baseRef || !node.repositoryKey) continue;
    const parent = byBranch.get(`${node.repositoryKey}\0${baseRef}`);
    if (
      !parent ||
      parent.worktreeId === node.worktreeId ||
      (parent.pr?.stackPosition ?? Number.POSITIVE_INFINITY) >
        (node.pr?.stackPosition ?? Number.POSITIVE_INFINITY)
    ) {
      continue;
    }
    edges.set(node.worktreeId, { parentId: parent.worktreeId, inferred: true });
  }

  return edges;
}

function resolveRoot(worktreeId: string, edges: ReadonlyMap<string, ParentEdge>): string {
  const path: string[] = [];
  const seen = new Set<string>();
  let current = worktreeId;
  while (true) {
    const edge = edges.get(current);
    if (!edge) return current;
    if (seen.has(current)) {
      const cycleStart = path.indexOf(current);
      return [...path.slice(Math.max(cycleStart, 0)), current].sort(compareText)[0] ?? current;
    }
    seen.add(current);
    path.push(current);
    current = edge.parentId;
  }
}

export function buildWorkspaceStacks(inputNodes: readonly WorkspaceStackNode[]): WorkspaceStack[] {
  const nodesById = new Map<string, WorkspaceStackNode>();
  for (const node of inputNodes) {
    if (!nodesById.has(node.worktreeId)) nodesById.set(node.worktreeId, node);
  }

  return buildStacks(nodesById, buildParentEdges(nodesById));
}

function buildStacks(
  nodesById: ReadonlyMap<string, WorkspaceStackNode>,
  edges: ReadonlyMap<string, ParentEdge>
): WorkspaceStack[] {
  const children = new Map<string, WorkspaceStackNode[]>();
  for (const node of nodesById.values()) {
    const edge = edges.get(node.worktreeId);
    if (!edge) continue;
    const list = children.get(edge.parentId);
    if (list) list.push(node);
    else children.set(edge.parentId, [node]);
  }
  for (const list of children.values()) list.sort(compareStackPosition);

  const rootByNode = new Map<string, string>();
  const stacksByRoot = new Map<string, WorkspaceStack>();
  const rootOrder: string[] = [];
  for (const node of nodesById.values()) {
    const rootId = resolveRoot(node.worktreeId, edges);
    rootByNode.set(node.worktreeId, rootId);
    if (stacksByRoot.has(rootId)) continue;
    rootOrder.push(rootId);
    stacksByRoot.set(rootId, {
      rootWorktreeId: rootId,
      entries: [],
    });
  }

  // A root that is itself a child (only possible in a cycle) is still emitted
  // once, with the edge that points back at it treated as a root boundary.
  for (const rootId of rootOrder) {
    const stack = stacksByRoot.get(rootId);
    if (!stack) continue;
    const visited = new Set<string>();
    const visit = (worktreeId: string, depth: number) => {
      if (visited.has(worktreeId)) return;
      const node = nodesById.get(worktreeId);
      if (!node) return;
      visited.add(worktreeId);
      stack.entries.push({ node, depth });
      for (const child of children.get(worktreeId) ?? []) {
        if (rootByNode.get(child.worktreeId) !== rootId) continue;
        visit(child.worktreeId, depth + 1);
      }
    };
    visit(rootId, 0);
    for (const node of nodesById.values()) {
      if (rootByNode.get(node.worktreeId) !== rootId || visited.has(node.worktreeId)) continue;
      visit(node.worktreeId, 1);
    }
  }

  return rootOrder.flatMap(rootId => {
    const stack = stacksByRoot.get(rootId);
    return stack && stack.entries.length > 0 ? [stack] : [];
  });
}

export type WorkspaceStackSelection = {
  stack: WorkspaceStack | null;
  /** Root to selected worktree, following the same parent edges as the stack. */
  ancestorIds: string[];
};

export const MAX_STACK_ANCESTRY = 50;

/** Locate the full stack containing a worktree and its own root-to-current path. */
export function selectWorkspaceStack(
  inputNodes: readonly WorkspaceStackNode[],
  worktreeId: string | null | undefined,
  maxAncestry = MAX_STACK_ANCESTRY
): WorkspaceStackSelection {
  if (!worktreeId) return { stack: null, ancestorIds: [] };

  const nodesById = new Map<string, WorkspaceStackNode>();
  for (const node of inputNodes) {
    if (!nodesById.has(node.worktreeId)) nodesById.set(node.worktreeId, node);
  }
  if (!nodesById.has(worktreeId)) return { stack: null, ancestorIds: [] };

  const edges = buildParentEdges(nodesById);
  const stack =
    buildStacks(nodesById, edges).find(candidate =>
      candidate.entries.some(entry => entry.node.worktreeId === worktreeId)
    ) ?? null;

  const ancestorIds: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = worktreeId;
  while (current && !seen.has(current) && ancestorIds.length < maxAncestry) {
    seen.add(current);
    ancestorIds.unshift(current);
    current = edges.get(current)?.parentId;
  }

  return { stack, ancestorIds };
}

export type StackedWorkspaceAvailability = {
  canCreateStackedWorkspace: boolean;
  createStackedWorkspaceDisabledReason: string | null;
};

/**
 * The menu's push preflight is authoritative while the menu is open. Only fall
 * back to the lightweight branch check when no preflight has been requested.
 */
export function resolveStackedWorkspaceAvailability({
  source,
  isPending,
  isError,
  fallbackCanCreate,
  fallbackDisabledReason,
}: {
  source: { basePushed: boolean; branch: string } | null | undefined;
  isPending: boolean;
  isError: boolean;
  fallbackCanCreate: boolean | undefined;
  fallbackDisabledReason: string | null | undefined;
}): StackedWorkspaceAvailability {
  if (source) {
    return source.basePushed
      ? { canCreateStackedWorkspace: true, createStackedWorkspaceDisabledReason: null }
      : {
          canCreateStackedWorkspace: false,
          createStackedWorkspaceDisabledReason: stackedWorkspacePushReason(source.branch),
        };
  }
  if (isPending) {
    return {
      canCreateStackedWorkspace: false,
      createStackedWorkspaceDisabledReason: 'Checking whether the branch is pushed…',
    };
  }
  if (isError) {
    return {
      canCreateStackedWorkspace: false,
      createStackedWorkspaceDisabledReason:
        'Could not verify whether the branch is pushed. Try again.',
    };
  }
  return {
    canCreateStackedWorkspace: fallbackCanCreate ?? false,
    createStackedWorkspaceDisabledReason: fallbackDisabledReason ?? null,
  };
}

const URGENCY_PRIORITY: Record<StackUrgency, number> = {
  idle: 0,
  failed: 1,
  running: 2,
  attention: 3,
};

export function getStackUrgency(status: string | null | undefined): StackUrgency {
  switch (status) {
    case 'question':
    case 'permission':
      return 'attention';
    case 'busy':
    case 'retry':
      return 'running';
    case 'failed':
    case 'system_interrupted':
      return 'failed';
    default:
      return 'idle';
  }
}

export function getMostUrgentStackStatus(
  statuses: Iterable<string | null | undefined>
): StackUrgency {
  let selected: StackUrgency = 'idle';
  for (const status of statuses) {
    const urgency = getStackUrgency(status);
    if (URGENCY_PRIORITY[urgency] > URGENCY_PRIORITY[selected]) selected = urgency;
  }
  return selected;
}
