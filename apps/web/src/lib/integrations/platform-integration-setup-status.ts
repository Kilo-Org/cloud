import type { PlatformIntegration } from '@kilocode/db/schema';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';

export const SETUP_STATUS_PLATFORMS = [
  PLATFORM.SLACK,
  PLATFORM.DISCORD,
  PLATFORM.GITHUB,
  PLATFORM.GITLAB,
  PLATFORM.LINEAR,
  PLATFORM.DOLTHUB,
] as const;

export type SetupStatusPlatform = (typeof SETUP_STATUS_PLATFORMS)[number];

export type PlatformIntegrationSetupStatus = {
  platform: SetupStatusPlatform;
  installed: boolean;
  installation: {
    accountLogin?: string | null;
    guildName?: string | null;
    teamName?: string | null;
    workspaceName?: string | null;
  } | null;
};

function isSetupStatusPlatform(platform: string): platform is SetupStatusPlatform {
  return SETUP_STATUS_PLATFORMS.some(setupPlatform => setupPlatform === platform);
}

function buildInstallationSummary(
  integration: PlatformIntegration
): PlatformIntegrationSetupStatus['installation'] {
  if (integration.platform === PLATFORM.SLACK) {
    return { teamName: integration.platform_account_login };
  }
  if (integration.platform === PLATFORM.DISCORD) {
    return { guildName: integration.platform_account_login };
  }
  if (integration.platform === PLATFORM.LINEAR) {
    return { workspaceName: integration.platform_account_login };
  }
  if (
    integration.platform === PLATFORM.GITHUB ||
    integration.platform === PLATFORM.GITLAB ||
    integration.platform === PLATFORM.DOLTHUB
  ) {
    return { accountLogin: integration.platform_account_login };
  }

  return null;
}

function toSetupStatus(integration: PlatformIntegration): PlatformIntegrationSetupStatus | null {
  if (!isSetupStatusPlatform(integration.platform)) return null;

  return {
    platform: integration.platform,
    installed: integration.integration_status === INTEGRATION_STATUS.ACTIVE,
    installation: buildInstallationSummary(integration),
  };
}

function hasDisplayLabel(status: PlatformIntegrationSetupStatus): boolean {
  return Boolean(
    status.installation?.accountLogin ||
    status.installation?.guildName ||
    status.installation?.teamName ||
    status.installation?.workspaceName
  );
}

function shouldPreferStatus(
  current: PlatformIntegrationSetupStatus,
  candidate: PlatformIntegrationSetupStatus
): boolean {
  if (candidate.installed !== current.installed) return candidate.installed;
  return !hasDisplayLabel(current) && hasDisplayLabel(candidate);
}

export function summarizePlatformIntegrationsForSetupStatus(
  integrations: PlatformIntegration[]
): PlatformIntegrationSetupStatus[] {
  const byPlatform = new Map<SetupStatusPlatform, PlatformIntegrationSetupStatus>();

  for (const integration of integrations) {
    const status = toSetupStatus(integration);
    if (!status) continue;

    const current = byPlatform.get(status.platform);
    if (!current || shouldPreferStatus(current, status)) {
      byPlatform.set(status.platform, status);
    }
  }

  return SETUP_STATUS_PLATFORMS.flatMap(platform => {
    const status = byPlatform.get(platform);
    return status ? [status] : [];
  });
}
