import { PLATFORM } from '@/lib/integrations/core/constants';

export type PlatformType = 'github' | 'gitlab' | 'bitbucket' | 'slack';

export type PlatformStatus = 'installed' | 'not_installed' | 'coming_soon';

export type Platform = {
  id: PlatformType;
  name: string;
  description: string;
  status: PlatformStatus;
  enabled: boolean;
  route?: string;
};

type PlatformDefinition = {
  id: PlatformType;
  name: string;
  description: string;
  enabled: boolean;
  personalRoute?: string;
  orgRoute?: (organizationId: string) => string;
};

export const PLATFORM_DEFINITIONS: PlatformDefinition[] = [
  {
    id: 'github',
    name: 'GitHub',
    description:
      'Integrate your GitHub repositories for AI-powered code reviews, deployments, and intelligent workflows',
    enabled: true,
    personalRoute: '/integrations/github',
    orgRoute: organizationId => `/organizations/${organizationId}/integrations/github`,
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Create PRs, debug code, ask questions about your repos, etc. directly from Slack',
    enabled: true,
    personalRoute: '/integrations/slack',
    orgRoute: organizationId => `/organizations/${organizationId}/integrations/slack`,
  },
  {
    id: PLATFORM.GITLAB,
    name: 'GitLab',
    description: 'Connect GitLab repositories to enable AI code reviews and automated workflows',
    enabled: true,
    personalRoute: '/integrations/gitlab',
    orgRoute: organizationId => `/organizations/${organizationId}/integrations/gitlab`,
  },
  {
    id: 'bitbucket',
    name: 'Bitbucket',
    description: 'Integrate Bitbucket repositories for intelligent code analysis and automation',
    enabled: false,
  },
];

type InstallationStatus = {
  github?: { installed: boolean };
  slack?: { installed: boolean };
  gitlab?: { installed: boolean };
};

function getStatus(id: PlatformType, installations: InstallationStatus): PlatformStatus {
  if (id === 'github') {
    return installations.github?.installed ? 'installed' : 'not_installed';
  }
  if (id === 'slack') {
    return installations.slack?.installed ? 'installed' : 'not_installed';
  }
  if (id === PLATFORM.GITLAB) {
    return installations.gitlab?.installed ? 'installed' : 'not_installed';
  }
  return 'coming_soon';
}

export function buildPlatformsForPersonal(installations: InstallationStatus): Platform[] {
  return PLATFORM_DEFINITIONS.map(def => ({
    id: def.id,
    name: def.name,
    description: def.description,
    status: getStatus(def.id, installations),
    enabled: def.enabled,
    route: def.personalRoute,
  }));
}

export function buildPlatformsForOrg(
  organizationId: string,
  installations: InstallationStatus
): Platform[] {
  return PLATFORM_DEFINITIONS.map(def => ({
    id: def.id,
    name: def.name,
    description: def.description,
    status: getStatus(def.id, installations),
    enabled: def.enabled,
    route: def.orgRoute?.(organizationId),
  }));
}
