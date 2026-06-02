import type { PlatformId } from './platforms';

type SetupStatusPlatformId = Exclude<PlatformId, 'microsoft-teams' | 'google-chat'> | 'dolthub';

export type PlatformInstallation = {
  platform: SetupStatusPlatformId;
  installed: boolean;
  installation: {
    accountLogin?: string | null;
    guildName?: string | null;
    teamName?: string | null;
    workspaceName?: string | null;
  } | null;
};

export type PlatformInstallationQueryState = {
  data: readonly PlatformInstallation[] | undefined;
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
  query: PlatformInstallationQueryState
): PlatformSetupStatus {
  if (platformId === 'microsoft-teams' || platformId === 'google-chat') {
    return { kind: 'unavailable', label: 'Not available yet' };
  }

  if (query.isLoading || query.isFetching) return { kind: 'checking', label: 'Checking' };
  if (query.isError) return { kind: 'unknown', label: 'Could not check' };

  const integration = query.data?.find(
    installedIntegration => installedIntegration.platform === platformId
  );

  if (integration?.installed) {
    const detail = getConnectedAccountLabel(platformId, integration.installation);
    return detail
      ? { kind: 'connected', label: 'Already set up', detail }
      : { kind: 'connected', label: 'Already set up' };
  }

  return { kind: 'not_connected', label: 'Not set up' };
}

export function buildPlatformSetupStatuses(
  query: PlatformInstallationQueryState
): PlatformSetupStatusMap {
  return {
    slack: getPlatformSetupStatus('slack', query),
    discord: getPlatformSetupStatus('discord', query),
    'microsoft-teams': getPlatformSetupStatus('microsoft-teams', query),
    'google-chat': getPlatformSetupStatus('google-chat', query),
    github: getPlatformSetupStatus('github', query),
    gitlab: getPlatformSetupStatus('gitlab', query),
    linear: getPlatformSetupStatus('linear', query),
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
