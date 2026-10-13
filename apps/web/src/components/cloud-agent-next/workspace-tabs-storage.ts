import { z } from 'zod';

import {
  CHAT_TAB_ID,
  WORKTREE_FILE_VIEW_MODES,
  createWorkspaceTabsState,
  fileTabId,
  terminalTabId,
  type WorkspaceTabsState,
  type WorkspaceTabId,
} from './workspace-tabs';

const WORKSPACE_TABS_STORAGE_KEY_PREFIX = 'cloud-agent:workspace-tabs';

const workspaceTabScopeSchema = z.string().regex(/^(?:worktree|session):.+$/);
const fileModeSchema = z.enum(WORKTREE_FILE_VIEW_MODES);
const terminalTabSchema = z.object({
  id: z.string(),
  title: z.string(),
  cloudAgentSessionId: z.string(),
});
const fileTabSchema = z.object({
  path: z.string(),
  mode: fileModeSchema.optional(),
});
const workspaceTabsStateSchema = z.object({
  activeTabId: z.string(),
  terminals: z.array(terminalTabSchema),
  files: z.array(fileTabSchema),
  nextTerminalNumber: z.number(),
});

type StoredWorkspaceTabsState = z.infer<typeof workspaceTabsStateSchema>;

export type WorkspaceTabsByScope = Record<string, WorkspaceTabsState>;

export function getWorkspaceTabsStorageKey(
  userId: string | null | undefined,
  organizationId?: string | null
): string | null {
  if (!userId) return null;

  const scope = organizationId ? `organization:${encodeURIComponent(organizationId)}` : 'personal';
  return `${WORKSPACE_TABS_STORAGE_KEY_PREFIX}:user:${encodeURIComponent(userId)}:${scope}`;
}

export function isDefaultWorkspaceTabs(tabs: WorkspaceTabsState): boolean {
  return (
    tabs.activeTabId === CHAT_TAB_ID &&
    tabs.terminals.length === 0 &&
    tabs.files.length === 0 &&
    tabs.nextTerminalNumber === 1
  );
}

export function normalizeStoredWorkspaceTabs(tabs: StoredWorkspaceTabsState): WorkspaceTabsState {
  const seenTerminalIds = new Set<string>();
  const terminals = tabs.terminals.filter(tab => {
    if (seenTerminalIds.has(tab.id)) return false;
    seenTerminalIds.add(tab.id);
    return true;
  });

  const seenPaths = new Set<string>();
  const files = tabs.files.filter(file => {
    if (seenPaths.has(file.path)) return false;
    seenPaths.add(file.path);
    return true;
  });

  const activeTabExists =
    tabs.activeTabId === CHAT_TAB_ID ||
    terminals.some(tab => terminalTabId(tab.id) === tabs.activeTabId) ||
    files.some(file => fileTabId(file.path) === tabs.activeTabId);

  const titleNumbers = terminals
    .map(tab => /^Terminal (\d+)$/.exec(tab.title)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .filter(Number.isFinite);
  const highestTitleNumber = Math.max(0, ...titleNumbers);
  const nextTerminalNumber = Math.max(
    Number.isInteger(tabs.nextTerminalNumber) ? tabs.nextTerminalNumber : 1,
    terminals.length + 1,
    highestTitleNumber + 1,
    1
  );

  return {
    activeTabId: (activeTabExists ? tabs.activeTabId : CHAT_TAB_ID) as WorkspaceTabId,
    terminals,
    files,
    nextTerminalNumber,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWorkspaceTabsByScope(rawValue: string | null): WorkspaceTabsByScope {
  if (!rawValue) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return {};
  }

  if (!isRecord(parsed) || !isRecord(parsed.tabsByScope)) return {};

  const tabsByScope: WorkspaceTabsByScope = {};
  for (const [scope, value] of Object.entries(parsed.tabsByScope)) {
    if (!workspaceTabScopeSchema.safeParse(scope).success) continue;

    const tabs = workspaceTabsStateSchema.safeParse(value);
    if (!tabs.success) continue;

    tabsByScope[scope] = normalizeStoredWorkspaceTabs(tabs.data);
  }

  return tabsByScope;
}

export function getWorkspaceTabsForScope(
  tabsByScope: WorkspaceTabsByScope,
  scope: string | null | undefined
): WorkspaceTabsState {
  if (!scope) return createWorkspaceTabsState();
  return tabsByScope[scope] ?? createWorkspaceTabsState();
}

export function setWorkspaceTabsForScope(
  tabsByScope: WorkspaceTabsByScope,
  scope: string | null | undefined,
  tabs: WorkspaceTabsState
): WorkspaceTabsByScope {
  if (!scope) return tabsByScope;

  if (isDefaultWorkspaceTabs(tabs)) {
    if (!(scope in tabsByScope)) return tabsByScope;
    return Object.fromEntries(Object.entries(tabsByScope).filter(([key]) => key !== scope));
  }

  return { ...tabsByScope, [scope]: tabs };
}
