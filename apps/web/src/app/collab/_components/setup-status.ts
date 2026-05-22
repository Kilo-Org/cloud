import type { PlatformId } from './platforms';

export type PlatformInstallation = {
  installed: boolean;
  installation: {
    accountLogin?: string | null;
    guildName?: string | null;
    teamName?: string | null;
    workspaceName?: string | null;
  } | null;
};

export type PlatformInstallationQueryState = {
  data: PlatformInstallation | undefined;
  isError: boolean;
  isFetching?: boolean;
  isLoading: boolean;
};

export type PlatformSetupStatus =
  | { kind: 'connected'; label: 'Already set up'; detail?: string }
  | { kind: 'not_connected'; label: 'Not set up' }
  | { kind: 'checking'; label: 'Checking' }
  | { kind: 'unavailable'; label: 'Not available yet' }
  | { kind: 'unknown'; label: 'Could not check' };

export type PlatformSetupStatusMap = Record<PlatformId, PlatformSetupStatus>;

type PlatformInstallationQueries = Partial<Record<PlatformId, PlatformInstallationQueryState>>;

const PLATFORM_ORDER: PlatformId[] = [
  'slack',
  'discord',
  'microsoft-teams',
  'google-chat',
  'github',
  'gitlab',
  'linear',
];

function getConnectedAccountLabel(
  platformId: PlatformId,
  installation: PlatformInstallation['installation']
): string | undefined {
  if (!installation) return undefined;

  if (platformId === 'slack') return installation.teamName ?? undefined;
  if (platformId === 'discord') return installation.guildName ?? undefined;
  if (platformId === 'linear') return installation.workspaceName ?? undefined;
  if (platformId === 'github' || platformId === 'gitlab') {
    return installation.accountLogin ?? undefined;
  }

  return undefined;
}

export function getPlatformSetupStatus(
  platformId: PlatformId,
  query: PlatformInstallationQueryState | undefined
): PlatformSetupStatus {
  if (platformId === 'microsoft-teams' || platformId === 'google-chat') {
    return { kind: 'unavailable', label: 'Not available yet' };
  }

  if (query?.isLoading || query?.isFetching) return { kind: 'checking', label: 'Checking' };
  if (query?.isError) return { kind: 'unknown', label: 'Could not check' };

  if (query?.data?.installed) {
    const detail = getConnectedAccountLabel(platformId, query.data.installation);
    return detail
      ? { kind: 'connected', label: 'Already set up', detail }
      : { kind: 'connected', label: 'Already set up' };
  }

  return { kind: 'not_connected', label: 'Not set up' };
}

export function buildPlatformSetupStatuses(
  queries: PlatformInstallationQueries
): PlatformSetupStatusMap {
  return {
    slack: getPlatformSetupStatus('slack', queries.slack),
    discord: getPlatformSetupStatus('discord', queries.discord),
    'microsoft-teams': getPlatformSetupStatus('microsoft-teams', queries['microsoft-teams']),
    'google-chat': getPlatformSetupStatus('google-chat', queries['google-chat']),
    github: getPlatformSetupStatus('github', queries.github),
    gitlab: getPlatformSetupStatus('gitlab', queries.gitlab),
    linear: getPlatformSetupStatus('linear', queries.linear),
  };
}

export function canSelectPlatform(status: PlatformSetupStatus): boolean {
  return status.kind === 'not_connected' || status.kind === 'unknown';
}

export function getConnectedPlatformIds(statuses: PlatformSetupStatusMap): PlatformId[] {
  return PLATFORM_ORDER.filter(platformId => statuses[platformId].kind === 'connected');
}

export function getSelectedServiceIdsToAuthorize(
  selectedIds: Iterable<PlatformId>,
  statuses: PlatformSetupStatusMap
): PlatformId[] {
  return Array.from(selectedIds).filter(platformId => canSelectPlatform(statuses[platformId]));
}

export function hasAnyConfiguredOrSelectedPlatform(
  platformIds: ReadonlySet<PlatformId>,
  selectedIds: Iterable<PlatformId>,
  statuses: PlatformSetupStatusMap
): boolean {
  const selected = new Set(selectedIds);
  return Array.from(platformIds).some(
    platformId => selected.has(platformId) || statuses[platformId].kind === 'connected'
  );
}

export function isCheckingPlatformSetup(statuses: PlatformSetupStatusMap): boolean {
  return PLATFORM_ORDER.some(platformId => statuses[platformId].kind === 'checking');
}
