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
  /** Roles the provider's connect flow accepts, first connect and replacement alike. */
  connectRoles: readonly OrganizationRole[];
  /** Roles the provider's disconnect procedure accepts. */
  disconnectRoles: readonly OrganizationRole[];
};

/** Bitbucket's hub page gate: `organizationBitbucketRouter.getStatus.canManage`. */
const BITBUCKET_ROLES = ['owner', 'billing_manager'] as const satisfies readonly OrganizationRole[];

/**
 * Mirrors the server, per action, instead of one role set per provider. The
 * Slack connect, the Slack uninstall and the GitHub uninstall ask for
 * `ORGANIZATION_MANAGE_ROLES`. The Linear, Discord and GitLab connects and the
 * `gitlab`/`discord`/`linear` disconnects ask for `ORGANIZATION_BILLING_ROLES`.
 * Every organization GitLab connect starts at `resolveGitLabOAuthOwner`, which
 * requires `ORGANIZATION_BILLING_ROLES` at the OAuth start and at the callback,
 * for a first connect and for a replacement.
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
    connectRoles: ORGANIZATION_BILLING_ROLES,
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
  // Bitbucket is org-only and web-managed: the row opens the web page, so the
  // page's own gate is the rule. `organizationBitbucketRouter.getStatus`
  // computes `canManage = role === 'owner' || role === 'billing_manager'`, and
  // that flag is what renders its Connect form and its management controls —
  // admins land on a read-only notice, so they get no mobile action either.
  bitbucket: {
    scope: ['organization'],
    hiddenUnlessInstalled: false,
    connectRoles: BITBUCKET_ROLES,
    disconnectRoles: BITBUCKET_ROLES,
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
  action: IntegrationAction
): readonly OrganizationRole[] {
  if (action === 'disconnect') {
    return definition.disconnectRoles;
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
  /** The caller's organization role. An unresolved role (`undefined`) offers nothing. */
  role: string | undefined;
  action: IntegrationAction;
}): boolean {
  if (input.scope === 'personal') {
    return true;
  }
  const allowedRoles = rolesFor(PROVIDERS[input.provider], input.action);
  return allowedRoles.some(allowedRole => allowedRole === input.role);
}

/**
 * Whether the row offers the viewer no action at all. It asks the same question
 * the trailing button asks, with the action that row would show, so the answer
 * can never disagree with the control beside it. The hub names the roles that
 * can change such a row once, above the list, instead of under every row.
 */
export function providerRowBlocked(input: {
  provider: IntegrationProvider;
  scope: IntegrationScope;
  role: string | undefined;
  installed?: boolean;
}): boolean {
  return !canManageProvider({
    provider: input.provider,
    scope: input.scope,
    role: input.role,
    action: input.installed ? 'disconnect' : 'connect',
  });
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
