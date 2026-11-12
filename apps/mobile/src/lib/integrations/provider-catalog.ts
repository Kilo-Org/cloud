import {
  ORGANIZATION_BILLING_ROLES,
  ORGANIZATION_MANAGE_ROLES,
  type OrganizationRole,
} from '@kilocode/app-shared/organizations';

/**
 * The services the mobile hub shows, in the order `apps/web`'s integrations
 * hub lists them (`PLATFORM_DEFINITIONS`). DoltHub is web-only for now.
 */
export const INTEGRATION_PROVIDERS = [
  'github',
  'slack',
  'gitlab',
  'discord',
  'linear',
  'bitbucket',
] as const;

export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export type IntegrationScope = 'personal' | 'organization';

type ProviderDefinition = {
  scope: readonly IntegrationScope[];
  /**
   * Mirrors `hiddenUnlessInstalled` in apps/web's platform definitions: Discord
   * is not offered as a new connection from the hub, so it only appears once
   * a server already has it.
   */
  hiddenUnlessInstalled: boolean;
  /** The org roles the web offers connect and disconnect to, per platform. */
  organizationRoles: readonly OrganizationRole[];
};

const PROVIDERS = {
  github: {
    scope: ['personal', 'organization'],
    hiddenUnlessInstalled: false,
    organizationRoles: ORGANIZATION_MANAGE_ROLES,
  },
  slack: {
    scope: ['personal', 'organization'],
    hiddenUnlessInstalled: false,
    organizationRoles: ORGANIZATION_MANAGE_ROLES,
  },
  gitlab: {
    scope: ['personal', 'organization'],
    hiddenUnlessInstalled: false,
    organizationRoles: ORGANIZATION_BILLING_ROLES,
  },
  discord: {
    scope: ['personal', 'organization'],
    hiddenUnlessInstalled: true,
    organizationRoles: ORGANIZATION_BILLING_ROLES,
  },
  linear: {
    scope: ['personal', 'organization'],
    hiddenUnlessInstalled: false,
    organizationRoles: ORGANIZATION_BILLING_ROLES,
  },
  // Bitbucket is org-only, and its web controls are shown to owners and billing
  // managers (see `BitbucketIntegrationControls` and the server's `canManage`).
  bitbucket: {
    scope: ['organization'],
    hiddenUnlessInstalled: false,
    organizationRoles: ['owner', 'billing_manager'],
  },
} satisfies Record<IntegrationProvider, ProviderDefinition>;

export function integrationScope(organizationId?: string): IntegrationScope {
  return organizationId == null ? 'personal' : 'organization';
}

/** The providers a scope offers, minus the ones only shown once installed. */
export function visibleIntegrationProviders(
  scope: IntegrationScope,
  installed: Partial<Record<IntegrationProvider, boolean>>
): IntegrationProvider[] {
  return INTEGRATION_PROVIDERS.filter(provider => {
    const definition: ProviderDefinition = PROVIDERS[provider];
    if (!definition.scope.includes(scope)) {
      return false;
    }
    return !definition.hiddenUnlessInstalled || installed[provider] === true;
  });
}

/**
 * Whether the viewer may connect or disconnect this provider's org connection.
 * The personal scope belongs to the viewer, so it is always theirs to manage.
 * The roles mirror what apps/web offers, so the app never shows an action the
 * server rejects.
 */
export function canManageProvider(
  provider: IntegrationProvider,
  scope: IntegrationScope,
  role: string | undefined
): boolean {
  if (scope === 'personal') {
    return true;
  }
  return PROVIDERS[provider].organizationRoles.some(allowedRole => allowedRole === role);
}

/**
 * The catalog key naming a provider. Brand names live under their existing
 * keys: the catalogs keep one key per copy, so the hub points at the key the
 * rest of the app already uses rather than adding a second spelling.
 */
export function providerLabelKey(provider: IntegrationProvider): string {
  const keys = {
    github: 'common.github',
    slack: 'agentChat.sessionFilter.platformSlack',
    gitlab: 'common.gitlab',
    discord: 'profile.providerDiscord',
    linear: 'agentChat.sessionFilter.platformLinear',
    bitbucket: 'agentChat.repoPicker.platformBitbucket',
  } satisfies Record<IntegrationProvider, string>;
  return keys[provider];
}
