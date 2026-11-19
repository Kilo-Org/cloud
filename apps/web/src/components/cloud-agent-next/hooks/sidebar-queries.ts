import { startOfDay, subDays } from 'date-fns';
import type { TRPCQueryKey } from '@trpc/tanstack-react-query';
import { WORKSPACE_LIST_SEARCH_MAX_LENGTH } from '@/lib/cloud-agent/workspace-folders';

export const SIDEBAR_LIST_LIMIT = 200;
export const SIDEBAR_WORKSPACE_PAGE_LIMIT = 200;
export const DEFAULT_SIDEBAR_PLATFORM_FILTER = ['cloud-agent'];

export function sidebarUpdatedSince(now: Date): string {
  return startOfDay(subDays(now, 5)).toISOString();
}

export function createdOnPlatformForFilter(
  platformFilter: readonly string[]
): string[] | undefined {
  if (platformFilter.length === 0) return undefined;
  return platformFilter.flatMap(platform => {
    switch (platform) {
      case 'cloud-agent':
        return ['cloud-agent', 'cloud-agent-web'];
      case 'extension':
        return ['vscode', 'agent-manager'];
      default:
        return [platform];
    }
  });
}

type SidebarFilters = {
  organizationId?: string | null;
  createdOnPlatform?: string | string[];
  gitUrl?: string | string[];
};

export function sidebarListInput({
  updatedSince,
  organizationId,
  createdOnPlatform,
  gitUrl,
}: SidebarFilters & { updatedSince: string }) {
  return {
    updatedSince,
    limit: SIDEBAR_LIST_LIMIT,
    orderBy: 'activity' as const,
    organizationId,
    createdOnPlatform,
    gitUrl,
    fetchReviewDecision: true,
    standaloneOnly: true,
  };
}

export function sidebarWorkspaceListInput({
  organizationId,
  createdOnPlatform,
  gitUrl,
  search,
}: SidebarFilters & { search?: string }) {
  return {
    organizationId: organizationId ?? null,
    createdOnPlatform,
    gitUrl,
    search: search?.trim().slice(0, WORKSPACE_LIST_SEARCH_MAX_LENGTH) || undefined,
    limit: SIDEBAR_WORKSPACE_PAGE_LIMIT,
  };
}

export function sidebarScopeKey(filters: SidebarFilters): string {
  return JSON.stringify([
    filters.organizationId ?? null,
    filters.createdOnPlatform,
    filters.gitUrl,
  ]);
}

export function sidebarQueryScopeKey(queryKey: readonly unknown[]): string | null {
  const options = queryKey[1];
  if (!options || typeof options !== 'object' || !('input' in options)) return null;
  const input = options.input;
  if (!input || typeof input !== 'object') return null;
  return JSON.stringify([
    'organizationId' in input ? (input.organizationId ?? null) : null,
    'createdOnPlatform' in input ? input.createdOnPlatform : undefined,
    'gitUrl' in input ? input.gitUrl : undefined,
  ]);
}

export function workspaceFoldersQueryKey(baseKey: TRPCQueryKey, userId: string): TRPCQueryKey {
  const options = { ...baseKey[1], userId };
  return [baseKey[0], options];
}
