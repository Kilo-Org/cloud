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

/** The two things a row can offer. Each has its own server-side role rule. */
export type IntegrationAction = 'connect' | 'disconnect';

type ProviderDefinition = {
  scope: readonly IntegrationScope[];
  hiddenUnlessInstalled: boolean;
  /**
   * Roles the provider's connect flow accepts; `null` means any organization
   * member, because a first-time OAuth connect only proves membership.
   */
  connectRoles: readonly OrganizationRole[] | null;
  /** Roles the provider's disconnect procedure accepts; `null` means any member. */
  disconnectRoles: readonly OrganizationRole[] | null;
  /** Roles a connect that replaces an existing integration needs. */
  replaceRoles?: readonly OrganizationRole[];
};

/**
 * Mirrors the server, per action, instead of one role set per provider:
 * `githubApps.uninstallApp` and `slack.uninstallApp` name
 * `ORGANIZATION_MANAGE_ROLES`, while `slack`, `linear` and `discord` connects
 * and the `gitlab`/`discord`/`linear` disconnects run through
 * `resolveAuthorizedOwner`, whose default is `ORGANIZATION_BILLING_ROLES`.
 * `resolveGitLabOAuthOwner` only requires billing roles when it replaces an
 * existing integration, so a member may make GitLab's first connect.
 */
const PROVIDERS = {
  github: {
    scope: ['personal', 'organization'],
    hiddenUnlessInstalled: false,
    connectRoles: ORGANIZATION_MANAGE_ROLES,
    disconnectRoles: ORGANIZATION_MANAGE_ROLES,
  },
  slack: {
    scope: ['personal', 'organization'],
    hiddenUnlessInstalled: false,
    connectRoles: ORGANIZATION_MANAGE_ROLES,
    disconnectRoles: ORGANIZATION_MANAGE_ROLES,
  },
  gitlab: {
    scope: ['personal', 'organization'],
    hiddenUnlessInstalled: false,
    connectRoles: null,
    replaceRoles: ORGANIZATION_BILLING_ROLES,
    disconnectRoles: ORGANIZATION_BILLING_ROLES,
  },
  discord: {
    scope: ['personal', 'organization'],
    hiddenUnlessInstalled: true,
    connectRoles: ORGANIZATION_BILLING_ROLES,
    disconnectRoles: ORGANIZATION_BILLING_ROLES,
  },
  linear: {
    scope: ['personal', 'organization'],
    hiddenUnlessInstalled: false,
    connectRoles: ORGANIZATION_BILLING_ROLES,
    disconnectRoles: ORGANIZATION_BILLING_ROLES,
  },
  // Bitbucket is org-only, and its web controls are shown to owners and billing
  // managers (see `BitbucketIntegrationControls` and the server's `canManage`).
  bitbucket: {
    scope: ['organization'],
    hiddenUnlessInstalled: false,
    connectRoles: ORGANIZATION_BILLING_ROLES,
    disconnectRoles: ORGANIZATION_BILLING_ROLES,
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

/** The roles the server procedure behind this action requires. */
function rolesFor(
  definition: ProviderDefinition,
  action: IntegrationAction,
  installed: boolean | undefined
): readonly OrganizationRole[] | null {
  if (action === 'disconnect') {
    return definition.disconnectRoles;
  }
  if (installed === true && definition.replaceRoles) {
    return definition.replaceRoles;
  }
  return definition.connectRoles;
}

/**
 * Whether the viewer may take this action on this provider's connection. The
 * personal scope belongs to the viewer, so every action is theirs. In an
 * organization the answer follows the server procedure that would run, action
 * by action, so the hub never shows a control the server rejects.
 */
export function canManageProvider(input: {
  provider: IntegrationProvider;
  scope: IntegrationScope;
  role: string | undefined;
  action: IntegrationAction;
  /** Whether the connection already exists, so a connect would replace it. */
  installed?: boolean;
}): boolean {
  if (input.scope === 'personal') {
    return true;
  }
  const allowedRoles = rolesFor(PROVIDERS[input.provider], input.action, input.installed);
  // `null` names any member: the connect flow only proves membership. A viewer
  // whose role is not resolved yet gets nothing.
  if (allowedRoles === null) {
    return input.role != null;
  }
  return allowedRoles.some(allowedRole => allowedRole === input.role);
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
