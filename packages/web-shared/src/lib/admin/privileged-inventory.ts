import type { AdminActionAuditAction } from '@kilocode/db/schema-types';
import type {
  PrivilegedActionClass,
  PrivilegedTargetKind,
} from '@kilocode/web-shared/lib/admin/privileged-access';

export type PrivilegedSurface = 'rest' | 'trpc' | 'server-component' | 'worker';

export const PRIVILEGED_GUARD_TIER = Symbol.for('kilocode.privilegedGuardTier');

export type PrivilegedGuardTier =
  | 'admin'
  | 'superadmin'
  | 'credit_manager'
  | 'session_viewer'
  | 'api_request_log_exporter';

type GuardTagged = { [PRIVILEGED_GUARD_TIER]?: PrivilegedGuardTier };

/** Tags a guard middleware so tests can derive which procedures it protects. */
export function markPrivilegedGuard<T>(guard: T, tier: PrivilegedGuardTier): T {
  (guard as GuardTagged)[PRIVILEGED_GUARD_TIER] = tier;
  return guard;
}

export function privilegedGuardTiers(middlewares: readonly unknown[]): PrivilegedGuardTier[] {
  return middlewares.flatMap(middleware => {
    const tier = (middleware as GuardTagged | null)?.[PRIVILEGED_GUARD_TIER];
    return tier === undefined ? [] : [tier];
  });
}

export type PrivilegedAccessKind = 'read' | 'write';

export type PrivilegedInventoryEntry = {
  id: string;
  surface: PrivilegedSurface;
  /** Exact path/procedure, or a prefix ending in `*`. */
  route: string;
  /** Action class for a read. Required when the surface serves reads. */
  read?: PrivilegedActionClass;
  /** Action class for a write. Required when the surface serves writes. */
  write?: PrivilegedActionClass;
  /** Used by surfaces without a read/write split (e.g. Worker admin gates). */
  actionClass?: PrivilegedActionClass;
  target: PrivilegedTargetKind;
};

type AdminAreaPolicy = {
  read: PrivilegedActionClass;
  write: PrivilegedActionClass;
  target: PrivilegedTargetKind;
};

const platform: AdminAreaPolicy = {
  read: 'platform_read',
  write: 'platform_write',
  target: 'none',
};

const support: AdminAreaPolicy = {
  read: 'support_read',
  write: 'support_write',
  target: 'organization',
};

const sensitiveWrite: AdminAreaPolicy = {
  read: 'platform_read',
  write: 'sensitive_write',
  target: 'user',
};

/**
 * One policy per mounted `admin.<area>` router. A new area with no policy makes
 * the inventory coverage test fail; a new procedure inside an existing area
 * inherits the area's read/write class.
 */
const adminAreaPolicies: Record<string, AdminAreaPolicy> = {
  actionAuditLogs: { read: 'support_read', write: 'support_write', target: 'none' },
  aiAttribution: platform,
  alerting: platform,
  apiRequestLog: { read: 'support_read', write: 'support_write', target: 'user' },
  autoFreeConfig: platform,
  blacklistDomains: { read: 'platform_read', write: 'sensitive_write', target: 'none' },
  botRequests: platform,
  bulkBlock: { read: 'platform_read', write: 'sensitive_write', target: 'user' },
  bulkUserCredits: { read: 'platform_read', write: 'sensitive_write', target: 'user' },
  cloudAgentNext: support,
  cloudBillingSkus: platform,
  codeReviews: support,
  contributorChampions: { read: 'platform_read', write: 'sensitive_write', target: 'user' },
  creditCampaigns: { read: 'platform_read', write: 'sensitive_write', target: 'user' },
  customLlm: platform,
  customPricing: platform,
  disputes: sensitiveWrite,
  earlyFraudWarnings: sensitiveWrite,
  emailTesting: platform,
  enkryptCalls: platform,
  enrichmentData: { read: 'platform_read', write: 'platform_write', target: 'none' },
  extendClawTrial: platform,
  featureInterest: platform,
  gatewayConfig: platform,
  gatewayModelLists: platform,
  github: platform,
  impactReferrals: { read: 'platform_read', write: 'sensitive_write', target: 'user' },
  internalBotUsers: { read: 'platform_read', write: 'sensitive_write', target: 'user' },
  kiloclawCreditRenewals: { read: 'platform_read', write: 'sensitive_write', target: 'none' },
  kiloclawInstances: platform,
  kiloclawProviders: platform,
  kiloclawRegions: platform,
  kiloclawStripeRenewals: { read: 'platform_read', write: 'sensitive_write', target: 'none' },
  kiloclawVersions: platform,
  kiloPass: sensitiveWrite,
  modelEvalIngest: platform,
  modelStats: platform,
  modelTraffic: platform,
  ossSponsorship: { read: 'platform_read', write: 'sensitive_write', target: 'organization' },
  preferredProviderOrder: platform,
  requestLoggingOptIns: platform,
  salesDemo: { read: 'platform_read', write: 'sensitive_write', target: 'user' },
  serviceFeeRollback: { read: 'platform_read', write: 'sensitive_write', target: 'none' },
  securityAdvisorContent: support,
  sessionTraces: { read: 'support_read', write: 'support_write', target: 'user' },
  supportAccess: support,
  syncProviders: platform,
  userDataExports: { read: 'support_read', write: 'support_write', target: 'user' },
  userDeletionQueue: { read: 'platform_read', write: 'sensitive_write', target: 'user' },
  users: sensitiveWrite,
  vercelModelIdOverrides: platform,
  webhookTriggers: platform,
};

const adminRootPolicies: Record<string, AdminAreaPolicy> = {
  getPermissions: { read: 'platform_read', write: 'platform_write', target: 'none' },
};

function adminEntry(id: string, route: string, policy: AdminAreaPolicy): PrivilegedInventoryEntry {
  return {
    id,
    surface: 'trpc',
    route,
    read: policy.read,
    write: policy.write,
    target: policy.target,
  };
}

export const ADMIN_AREA_POLICIES = adminAreaPolicies;

/**
 * Admin procedures that resolve their own step-up inside the resolver, because
 * the guard middleware cannot see the organization the operation acts on. Each
 * one must call `supportStepUpPort.requireFresh` with a concrete organization.
 * The inventory coverage test asserts this list is exactly the set of
 * procedures whose source does that, and that each still has an entry.
 */
export const ADMIN_STEP_UP_SELF_GUARDED_ROUTES: readonly string[] = [
  'admin.supportAccess.request',
  'admin.supportAccess.approve',
  'admin.supportAccess.emergencyIssue',
];

export function resolvesOwnStepUp(path: string): boolean {
  return ADMIN_STEP_UP_SELF_GUARDED_ROUTES.includes(path);
}

const trpcEntries: PrivilegedInventoryEntry[] = [
  ...Object.entries(adminRootPolicies).map(([area, policy]) =>
    adminEntry(`trpc.admin.${area}`, `admin.${area}`, policy)
  ),
  ...Object.entries(adminAreaPolicies).map(([area, policy]) =>
    adminEntry(`trpc.admin.${area}`, `admin.${area}.*`, policy)
  ),
  {
    id: 'trpc.stepUp.getStatus',
    surface: 'trpc',
    route: 'stepUp.getStatus',
    read: 'platform_read',
    target: 'none',
  },
  adminEntry('trpc.organizations', 'organizations.*', support),
  adminEntry('trpc.organizations.admin', 'organizations.admin.*', support),
  adminEntry('trpc.organizations.sso', 'organizations.sso.*', support),
  {
    id: 'trpc.organizations.seatPurchases',
    surface: 'trpc',
    route: 'organizations.seatPurchases',
    read: 'support_read',
    target: 'organization',
  },
  {
    id: 'trpc.organizations.updatePlan',
    surface: 'trpc',
    route: 'organizations.updatePlan',
    write: 'support_write',
    target: 'organization',
  },
  {
    id: 'trpc.organizations.updateSeatsRequired',
    surface: 'trpc',
    route: 'organizations.updateSeatsRequired',
    write: 'support_write',
    target: 'organization',
  },
  adminEntry('trpc.codeIndexing.admin', 'codeIndexing.admin.*', {
    read: 'platform_read',
    write: 'support_write',
    target: 'user',
  }),
  {
    id: 'trpc.codingPlans.adminAvailabilityIntentCounts',
    surface: 'trpc',
    route: 'codingPlans.adminAvailabilityIntentCounts',
    read: 'platform_read',
    target: 'user',
  },
  {
    id: 'trpc.codingPlans.adminInsights',
    surface: 'trpc',
    route: 'codingPlans.adminInsights',
    read: 'platform_read',
    target: 'user',
  },
  {
    id: 'trpc.codingPlans.adminKeyInventory',
    surface: 'trpc',
    route: 'codingPlans.adminKeyInventory',
    read: 'platform_read',
    target: 'user',
  },
  {
    id: 'trpc.codingPlans.adminListSubscriptions',
    surface: 'trpc',
    route: 'codingPlans.adminListSubscriptions',
    read: 'platform_read',
    target: 'user',
  },
  {
    id: 'trpc.codingPlans.adminRevocationQueue',
    surface: 'trpc',
    route: 'codingPlans.adminRevocationQueue',
    read: 'platform_read',
    target: 'user',
  },
  {
    id: 'trpc.codingPlans.adminSubscriptionOverview',
    surface: 'trpc',
    route: 'codingPlans.adminSubscriptionOverview',
    read: 'platform_read',
    target: 'user',
  },
  {
    id: 'trpc.codingPlans.adminCancelSubscription',
    surface: 'trpc',
    route: 'codingPlans.adminCancelSubscription',
    write: 'sensitive_write',
    target: 'user',
  },
  {
    id: 'trpc.codingPlans.adminExtendSubscriptionPeriod',
    surface: 'trpc',
    route: 'codingPlans.adminExtendSubscriptionPeriod',
    write: 'sensitive_write',
    target: 'user',
  },
  {
    id: 'trpc.codingPlans.adminMarkRevocationComplete',
    surface: 'trpc',
    route: 'codingPlans.adminMarkRevocationComplete',
    write: 'sensitive_write',
    target: 'user',
  },
  {
    id: 'trpc.codingPlans.adminMarkRevocationFailed',
    surface: 'trpc',
    route: 'codingPlans.adminMarkRevocationFailed',
    write: 'sensitive_write',
    target: 'user',
  },
  {
    id: 'trpc.codingPlans.adminReassignSubscriptionCredential',
    surface: 'trpc',
    route: 'codingPlans.adminReassignSubscriptionCredential',
    write: 'sensitive_write',
    target: 'user',
  },
  {
    id: 'trpc.codingPlans.adminReduceInventory',
    surface: 'trpc',
    route: 'codingPlans.adminReduceInventory',
    write: 'sensitive_write',
    target: 'user',
  },
  {
    id: 'trpc.codingPlans.adminReplaceInventoryCredential',
    surface: 'trpc',
    route: 'codingPlans.adminReplaceInventoryCredential',
    write: 'sensitive_write',
    target: 'user',
  },
  {
    id: 'trpc.codingPlans.adminReplaceRevocationCredential',
    surface: 'trpc',
    route: 'codingPlans.adminReplaceRevocationCredential',
    write: 'sensitive_write',
    target: 'user',
  },
  {
    id: 'trpc.codingPlans.adminRequeueRevocation',
    surface: 'trpc',
    route: 'codingPlans.adminRequeueRevocation',
    write: 'sensitive_write',
    target: 'user',
  },
  {
    id: 'trpc.codingPlans.adminTerminateSubscription',
    surface: 'trpc',
    route: 'codingPlans.adminTerminateSubscription',
    write: 'sensitive_write',
    target: 'user',
  },
  {
    id: 'trpc.codingPlans.adminUploadKeys',
    surface: 'trpc',
    route: 'codingPlans.adminUploadKeys',
    write: 'sensitive_write',
    target: 'user',
  },
  {
    id: 'trpc.debug.badInputError',
    surface: 'trpc',
    route: 'debug.badInputError',
    read: 'platform_read',
    target: 'none',
  },
  {
    id: 'trpc.debug.badInputObjectError',
    surface: 'trpc',
    route: 'debug.badInputObjectError',
    read: 'platform_read',
    target: 'none',
  },
  {
    id: 'trpc.debug.handledTrpcError',
    surface: 'trpc',
    route: 'debug.handledTrpcError',
    read: 'platform_read',
    target: 'none',
  },
  {
    id: 'trpc.debug.unhandledError',
    surface: 'trpc',
    route: 'debug.unhandledError',
    read: 'platform_read',
    target: 'none',
  },
  {
    id: 'trpc.test.adminHello',
    surface: 'trpc',
    route: 'test.adminHello',
    read: 'platform_read',
    target: 'none',
  },
  {
    id: 'trpc.cliSessionsV2.list',
    surface: 'trpc',
    route: 'cliSessionsV2.list',
    read: 'support_read',
    target: 'none',
  },
  {
    id: 'trpc.cliSessionsV2.search',
    surface: 'trpc',
    route: 'cliSessionsV2.search',
    read: 'support_read',
    target: 'none',
  },
  adminEntry('trpc.codeIndexing', 'codeIndexing.*', {
    read: 'support_read',
    write: 'support_write',
    target: 'user',
  }),
  adminEntry('trpc.githubApps', 'githubApps.*', {
    read: 'support_read',
    write: 'support_write',
    target: 'organization',
  }),
  {
    id: 'trpc.securityAgent.getAuditReport',
    surface: 'trpc',
    route: 'securityAgent.getAuditReport',
    read: 'support_read',
    target: 'user',
  },
  {
    id: 'trpc.organizations.securityAgent.getAuditReport',
    surface: 'trpc',
    route: 'organizations.securityAgent.getAuditReport',
    read: 'support_read',
    target: 'organization',
  },
];

const restEntries: PrivilegedInventoryEntry[] = [
  {
    id: 'rest.admin.users',
    surface: 'rest',
    route: '/admin/api/users*',
    read: 'support_read',
    write: 'sensitive_write',
    target: 'user',
  },
  {
    id: 'rest.admin.enrichmentData',
    surface: 'rest',
    route: '/admin/api/enrichment-data*',
    write: 'platform_write',
    target: 'none',
  },
  {
    id: 'rest.admin.apiRequestLog',
    surface: 'rest',
    route: '/admin/api/api-request-log*',
    read: 'support_read',
    target: 'user',
  },
  {
    id: 'rest.admin.organizations',
    surface: 'rest',
    route: '/admin/api/organizations*',
    read: 'support_read',
    write: 'support_write',
    target: 'organization',
  },
  {
    id: 'rest.admin.abuse',
    surface: 'rest',
    route: '/admin/api/abuse*',
    read: 'platform_read',
    write: 'sensitive_write',
    target: 'user',
  },
  {
    id: 'rest.admin.providerMetadata',
    surface: 'rest',
    route: '/admin/api/provider-metadata*',
    read: 'support_read',
    target: 'none',
  },
  {
    id: 'rest.admin.backfills',
    surface: 'rest',
    route: '/admin/api/backfills*',
    read: 'platform_read',
    write: 'sensitive_write',
    target: 'none',
  },
  {
    id: 'rest.admin.accountDeduplication',
    surface: 'rest',
    route: '/admin/api/account-deduplication*',
    read: 'platform_read',
    write: 'sensitive_write',
    target: 'user',
  },
  {
    id: 'rest.admin.safetyIdentifiers',
    surface: 'rest',
    route: '/admin/api/safety-identifiers*',
    read: 'platform_read',
    write: 'sensitive_write',
    target: 'user',
  },
  {
    id: 'rest.admin.autoRouting',
    surface: 'rest',
    route: '/admin/api/auto-routing*',
    read: 'platform_read',
    write: 'platform_write',
    target: 'none',
  },
  {
    id: 'rest.admin.kiloclawAnalytics',
    surface: 'rest',
    route: '/admin/api/kiloclaw-analytics*',
    read: 'platform_read',
    target: 'none',
  },
  {
    id: 'rest.admin.kiloclawControllerTelemetry',
    surface: 'rest',
    route: '/admin/api/kiloclaw-controller-telemetry*',
    read: 'platform_read',
    target: 'none',
  },
  {
    id: 'rest.admin.slackBot',
    surface: 'rest',
    route: '/admin/api/slack-bot*',
    read: 'platform_read',
    target: 'none',
  },
  {
    id: 'rest.admin.creditCategories',
    surface: 'rest',
    route: '/admin/api/credit-categories*',
    read: 'platform_read',
    write: 'platform_write',
    target: 'none',
  },
  {
    id: 'rest.admin.revenue',
    surface: 'rest',
    route: '/admin/api/revenue*',
    read: 'platform_read',
    target: 'none',
  },
  {
    id: 'rest.private.users',
    surface: 'rest',
    route: '/api/private/users*',
    read: 'support_read',
    target: 'user',
  },
  {
    id: 'rest.orgRoutes',
    surface: 'rest',
    route: '/api/organizations*',
    read: 'support_read',
    write: 'support_write',
    target: 'organization',
  },
  {
    id: 'rest.orgPages',
    surface: 'rest',
    route: '/organizations*',
    read: 'support_read',
    write: 'support_write',
    target: 'organization',
  },
  {
    id: 'rest.codeIndexing',
    surface: 'rest',
    route: '/api/code-indexing*',
    read: 'support_read',
    target: 'user',
  },
  {
    id: 'rest.integrations',
    surface: 'rest',
    route: '/api/integrations*',
    read: 'support_read',
    write: 'support_write',
    target: 'organization',
  },
  {
    id: 'rest.cloudAgent',
    surface: 'rest',
    route: '/api/cloud-agent*',
    read: 'support_read',
    write: 'support_write',
    target: 'organization',
  },
  {
    id: 'rest.autoRouting',
    surface: 'rest',
    route: '/api/auto-routing*',
    read: 'support_read',
    write: 'support_write',
    target: 'organization',
  },
  {
    id: 'rest.claw',
    surface: 'rest',
    route: '/api/claw*',
    read: 'support_read',
    write: 'support_write',
    target: 'organization',
  },
  {
    id: 'rest.internal',
    surface: 'rest',
    route: '/api/internal*',
    read: 'support_read',
    write: 'support_write',
    target: 'none',
  },
  {
    id: 'rest.payments.topup',
    surface: 'rest',
    route: '/payments/topup*',
    write: 'support_write',
    target: 'user',
  },
  {
    id: 'rest.organizationTokens',
    surface: 'rest',
    route: '/api/organizations/[id]/user-tokens',
    write: 'support_write',
    target: 'organization',
  },
  {
    id: 'rest.stepUp',
    surface: 'rest',
    route: '/api/auth/step-up',
    write: 'sensitive_write',
    target: 'none',
  },
  {
    id: 'rest.passkeyEnrollment',
    surface: 'rest',
    route: '/api/auth/passkey/register*',
    write: 'sensitive_write',
    target: 'user',
  },
];

const serverComponentEntries: PrivilegedInventoryEntry[] = [
  {
    id: 'serverComponent.admin',
    surface: 'server-component',
    route: '/admin*',
    read: 'platform_read',
    write: 'sensitive_write',
    target: 'none',
  },
  {
    id: 'serverComponent.organizations',
    surface: 'server-component',
    route: '/organizations*',
    read: 'support_read',
    write: 'support_write',
    target: 'organization',
  },
];

export const privilegedInventory: readonly PrivilegedInventoryEntry[] = [
  ...trpcEntries,
  ...restEntries,
  ...serverComponentEntries,
];

/**
 * Server-side files that read `is_admin` outside the checked-in route/procedure
 * inventory (shared helpers, token issuance, and branch-level bypasses).
 * `occurrences` records the reviewed count per file, so a new branch in an
 * already-listed file fails until it is reviewed. `file` is repository-relative.
 */
export type InternalElevationSite = {
  id: string;
  file: string;
  actionClass: PrivilegedActionClass;
  surface: PrivilegedSurface;
  occurrences: number;
};

export const internalElevationSites: readonly InternalElevationSite[] = [
  {
    id: 'internal.app.organizations.welcome',
    file: 'apps/web/src/app/(app)/organizations/[id]/welcome/layout.tsx',
    actionClass: 'support_read',
    surface: 'server-component',
    occurrences: 1,
  },
  {
    id: 'internal.app.auth.passkeyRegister',
    file: 'apps/web/src/app/api/auth/passkey/register/route.ts',
    actionClass: 'sensitive_write',
    surface: 'rest',
    occurrences: 1,
  },
  {
    id: 'internal.lib.admin.requirePrivilegedActor',
    file: 'apps/web/src/lib/admin/require-privileged-actor.ts',
    actionClass: 'platform_read',
    surface: 'trpc',
    occurrences: 2,
  },
  {
    id: 'internal.lib.auth.sessionStepUp',
    file: 'apps/web/src/lib/auth/session-step-up.ts',
    actionClass: 'sensitive_write',
    surface: 'rest',
    occurrences: 1,
  },
  {
    id: 'internal.lib.auth.signInMethodChange',
    file: 'apps/web/src/lib/auth/sign-in-method-change.ts',
    actionClass: 'sensitive_write',
    surface: 'trpc',
    occurrences: 1,
  },
  {
    id: 'internal.components.adminUserStatusBadge',
    file: 'apps/web/src/components/admin/UserStatusBadge.tsx',
    actionClass: 'platform_read',
    surface: 'server-component',
    occurrences: 1,
  },
  {
    id: 'internal.components.organizationByPageLayout',
    file: 'apps/web/src/components/organizations/OrganizationByPageLayout.tsx',
    actionClass: 'support_read',
    surface: 'server-component',
    occurrences: 2,
  },
  {
    id: 'internal.app.admin.creditCategories',
    file: 'apps/web/src/app/admin/api/credit-categories/[key]/route.ts',
    actionClass: 'platform_write',
    surface: 'rest',
    occurrences: 2,
  },
  {
    id: 'internal.abuse.blockBlacklistedDomains',
    file: 'apps/web/src/lib/abuse/block-blacklisted-domains.ts',
    actionClass: 'sensitive_write',
    surface: 'rest',
    occurrences: 1,
  },
  {
    id: 'internal.admin.actionAudit',
    file: 'packages/web-shared/src/lib/admin/admin-action-audit.ts',
    actionClass: 'platform_read',
    surface: 'rest',
    occurrences: 1,
  },
  {
    id: 'internal.admin.permissions',
    file: 'apps/web/src/lib/admin/admin-permissions.ts',
    actionClass: 'platform_read',
    surface: 'trpc',
    occurrences: 3,
  },
  {
    id: 'internal.admin.supportAccessResolver',
    file: 'packages/web-shared/src/lib/admin/support-access-resolver.ts',
    actionClass: 'support_read',
    surface: 'trpc',
    occurrences: 1,
  },
  {
    id: 'internal.admin.creditManagement',
    file: 'apps/web/src/lib/admin/credit-management.ts',
    actionClass: 'platform_read',
    surface: 'trpc',
    occurrences: 1,
  },
  {
    id: 'internal.admin.githubInstallationUninstall',
    file: 'apps/web/src/lib/admin/github-installation-uninstall.ts',
    actionClass: 'support_write',
    surface: 'trpc',
    occurrences: 1,
  },
  {
    id: 'internal.codeIndexing.util',
    file: 'apps/web/src/lib/code-indexing/util.ts',
    actionClass: 'platform_read',
    surface: 'trpc',
    occurrences: 1,
  },
  {
    id: 'internal.bitbucket.credentials',
    file: 'apps/web/src/lib/integrations/platforms/bitbucket/credentials.ts',
    actionClass: 'support_write',
    surface: 'rest',
    occurrences: 1,
  },
  {
    id: 'internal.bitbucket.workspaceAccessTokenAuthorization',
    file: 'apps/web/src/lib/integrations/platforms/bitbucket/workspace-access-token-organization-authorization.ts',
    actionClass: 'support_write',
    surface: 'rest',
    occurrences: 1,
  },
  {
    id: 'internal.securityAgent.auditLogService',
    file: 'apps/web/src/lib/security-agent/services/audit-log-service.ts',
    actionClass: 'platform_read',
    surface: 'trpc',
    occurrences: 1,
  },
  {
    id: 'internal.securityAgent.sharedHandlers',
    file: 'apps/web/src/lib/security-agent/router/shared-handlers.ts',
    actionClass: 'support_read',
    surface: 'trpc',
    occurrences: 3,
  },
  {
    id: 'internal.user.deletionLegacyBackfill',
    file: 'apps/web/src/lib/user/deletion-queue/deletion-legacy-backfill.ts',
    actionClass: 'sensitive_write',
    surface: 'rest',
    occurrences: 2,
  },
  {
    id: 'internal.user.nextAuthOptions',
    file: 'apps/web/src/lib/user/next-auth-options.ts',
    actionClass: 'platform_read',
    surface: 'server-component',
    occurrences: 3,
  },
  {
    id: 'internal.routers.adminKiloclawInstances',
    file: 'apps/web/src/routers/admin-kiloclaw-instances-router.ts',
    actionClass: 'platform_write',
    surface: 'trpc',
    occurrences: 3,
  },
  {
    id: 'internal.routers.admin',
    file: 'apps/web/src/routers/admin-router.ts',
    actionClass: 'platform_write',
    surface: 'trpc',
    occurrences: 10,
  },
  {
    id: 'internal.routers.cliSessionsV2',
    file: 'apps/web/src/routers/cli-sessions-v2-router.ts',
    actionClass: 'support_read',
    surface: 'trpc',
    occurrences: 1,
  },
  {
    id: 'internal.routers.codeIndexing',
    file: 'apps/web/src/routers/code-indexing/code-indexing-router.ts',
    actionClass: 'support_read',
    surface: 'trpc',
    occurrences: 1,
  },
  {
    id: 'internal.routers.githubApps',
    file: 'apps/web/src/routers/github-apps-router.ts',
    actionClass: 'support_write',
    surface: 'trpc',
    occurrences: 3,
  },
  {
    id: 'internal.routers.organizationCodeReviews',
    file: 'apps/web/src/routers/organizations/organization-code-reviews-router.ts',
    actionClass: 'support_read',
    surface: 'trpc',
    occurrences: 2,
  },
  {
    id: 'internal.routers.organizationMembers',
    file: 'apps/web/src/routers/organizations/organization-members-router.ts',
    actionClass: 'support_write',
    surface: 'trpc',
    occurrences: 2,
  },
  {
    id: 'internal.routers.organizationSubOrganizations',
    file: 'apps/web/src/routers/organizations/organization-sub-organizations-router.ts',
    actionClass: 'support_write',
    surface: 'trpc',
    occurrences: 1,
  },
  {
    id: 'internal.routers.user',
    file: 'apps/web/src/routers/user-router.ts',
    actionClass: 'platform_read',
    surface: 'trpc',
    occurrences: 1,
  },
  {
    id: 'internal.user.nextAuthOptions',
    file: 'apps/web/src/lib/user/next-auth-options.ts',
    actionClass: 'platform_read',
    surface: 'server-component',
    occurrences: 3,
  },
  {
    id: 'internal.webShared.trpcInit',
    file: 'packages/web-shared/src/lib/trpc/init.ts',
    actionClass: 'platform_read',
    surface: 'trpc',
    occurrences: 1,
  },
  {
    id: 'internal.webShared.userServer',
    file: 'packages/web-shared/src/lib/user/server.ts',
    actionClass: 'platform_read',
    surface: 'rest',
    occurrences: 1,
  },
  {
    id: 'internal.admin.supportAccessService',
    file: 'apps/web/src/lib/admin/support-access-service.ts',
    actionClass: 'support_write',
    surface: 'trpc',
    occurrences: 2,
  },
  {
    id: 'internal.organizations.organizationAuth',
    file: 'apps/web/src/lib/organizations/organization-auth.ts',
    actionClass: 'support_read',
    surface: 'rest',
    occurrences: 4,
  },
  {
    id: 'internal.webShared.organizationsUtils',
    file: 'packages/web-shared/src/routers/organizations/utils.ts',
    actionClass: 'support_write',
    surface: 'trpc',
    occurrences: 5,
  },
];

/** Admin console GET handlers that write, and so must be audited like a write. */
export const ADMIN_REST_WRITING_GET_ROUTES: readonly string[] = [
  '/admin/api/api-request-log/download',
  '/admin/api/provider-metadata/download',
];

export type OrganizationElevationAudit =
  | { kind: 'recorded'; actions: readonly [AdminActionAuditAction, ...AdminActionAuditAction[]] }
  | { kind: 'skipped'; reason: string };

/**
 * Route handlers that can write to an organization through the admin bypass of
 * getAuthorizedOrgContext / ensureOrganizationAccess, directly or through a
 * helper, with how a Kilo admin's elevated write is audited: the actions the
 * handler records through runElevatedOrganizationWrite, or why it records
 * nothing. Every GET handler behind such a guard is listed too, since a GET
 * can write (an OAuth callback); one that only reads is skipped with that
 * reason. `route` is the App Router path, as in the REST inventory.
 */
export type OrganizationElevationWriteSite = {
  route: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  audit: OrganizationElevationAudit;
};

const STATE_ONLY_CONNECT =
  'starts the OAuth flow: signs state and reserves the attempt; the callback records the connection';

const READ_ONLY_GET = 'reads organization data only; writes nothing';

export const organizationElevationWriteSites: readonly OrganizationElevationWriteSite[] = [
  {
    route: '/api/organizations/[id]/user-tokens',
    method: 'POST',
    audit: { kind: 'recorded', actions: ['organization.token.mint'] },
  },
  {
    route: '/api/organizations/[id]/guardrails/mcp-connections',
    method: 'POST',
    audit: { kind: 'recorded', actions: ['organization.mcp_connections.report'] },
  },
  {
    route: '/api/auto-routing/mode',
    method: 'PUT',
    audit: { kind: 'recorded', actions: ['organization.auto_routing_mode.set'] },
  },
  {
    route: '/api/auto-routing/custom-routers',
    method: 'POST',
    audit: { kind: 'recorded', actions: ['organization.custom_router.create'] },
  },
  {
    route: '/api/auto-routing/custom-routers/[scope]/[slug]',
    method: 'PATCH',
    audit: { kind: 'recorded', actions: ['organization.custom_router.update'] },
  },
  {
    route: '/api/auto-routing/custom-routers/[scope]/[slug]',
    method: 'DELETE',
    audit: { kind: 'recorded', actions: ['organization.custom_router.delete'] },
  },
  {
    route: '/api/auto-routing/custom-routers/[scope]/[slug]/client-entries',
    method: 'POST',
    audit: { kind: 'recorded', actions: ['organization.custom_router.client_entry.register'] },
  },
  {
    route: '/api/auto-routing/custom-routers/[scope]/[slug]/client-entries',
    method: 'DELETE',
    audit: { kind: 'recorded', actions: ['organization.custom_router.client_entry.remove'] },
  },
  {
    route: '/api/integrations/github/callback',
    method: 'GET',
    audit: { kind: 'recorded', actions: ['organization.github.connect'] },
  },
  {
    route: '/api/integrations/github/connection/callback',
    method: 'GET',
    audit: { kind: 'recorded', actions: ['organization.github.connect'] },
  },
  {
    route: '/api/integrations/google/callback',
    method: 'GET',
    audit: { kind: 'recorded', actions: ['organization.google.connect'] },
  },
  {
    route: '/api/integrations/google/disconnect',
    method: 'POST',
    audit: { kind: 'recorded', actions: ['organization.google.disconnect'] },
  },
  {
    route: '/api/integrations/[platform]/callback',
    method: 'GET',
    audit: {
      kind: 'recorded',
      actions: [
        'organization.bitbucket.update',
        'organization.discord.connect',
        'organization.dolthub.connect',
        'organization.gitlab.connect',
        'organization.linear.connect',
        'organization.slack.connect',
      ],
    },
  },
  {
    route: '/payments/topup',
    method: 'POST',
    audit: { kind: 'recorded', actions: ['organization.topup_checkout.create'] },
  },
  {
    route: '/api/claw/openclaw-export',
    method: 'POST',
    audit: { kind: 'recorded', actions: ['organization.kiloclaw_workspace.export'] },
  },
  {
    route: '/api/cloud-agent/sessions/stream-ticket',
    method: 'POST',
    audit: { kind: 'recorded', actions: ['organization.cloud_agent_session.stream_ticket'] },
  },
  {
    route: '/api/integrations/google/connect',
    method: 'GET',
    audit: {
      kind: 'skipped',
      reason: 'signs OAuth state only; the callback records the connection',
    },
  },
  {
    route: '/api/integrations/[platform]/connect',
    method: 'GET',
    audit: { kind: 'skipped', reason: STATE_ONLY_CONNECT },
  },
  {
    route: '/api/integrations/[platform]/connect',
    method: 'POST',
    audit: { kind: 'skipped', reason: STATE_ONLY_CONNECT },
  },
  {
    route: '/app-shell/connect/[platform]',
    method: 'GET',
    audit: { kind: 'skipped', reason: STATE_ONLY_CONNECT },
  },
  {
    route: '/app-shell/connect/[platform]',
    method: 'POST',
    audit: { kind: 'skipped', reason: STATE_ONLY_CONNECT },
  },
  {
    route: '/organizations/[id]/integrations/linear/reinstall',
    method: 'GET',
    audit: { kind: 'skipped', reason: 'redirects to the connect flow; writes nothing' },
  },
  {
    route: '/organizations/[id]/integrations/slack/reinstall',
    method: 'GET',
    audit: { kind: 'skipped', reason: 'redirects to the connect flow; writes nothing' },
  },
  {
    route: '/api/internal/glanceable-agents-snapshot',
    method: 'POST',
    audit: {
      kind: 'skipped',
      reason: 'membership-only guard (ensureMemberOrganizationAccess) with no admin bypass',
    },
  },
  {
    route: '/api/auto-routing/mode',
    method: 'GET',
    audit: { kind: 'skipped', reason: READ_ONLY_GET },
  },
  {
    route: '/api/code-indexing/enabled',
    method: 'GET',
    audit: { kind: 'skipped', reason: READ_ONLY_GET },
  },
  {
    route: '/api/integrations/google/disconnect',
    method: 'GET',
    audit: { kind: 'skipped', reason: 'redirects with method_not_allowed; writes nothing' },
  },
  {
    route: '/api/organizations/[id]/browser-policy',
    method: 'GET',
    audit: { kind: 'skipped', reason: READ_ONLY_GET },
  },
  {
    route: '/api/organizations/[id]/defaults',
    method: 'GET',
    audit: { kind: 'skipped', reason: READ_ONLY_GET },
  },
  {
    route: '/api/organizations/[id]/guardrails',
    method: 'GET',
    audit: { kind: 'skipped', reason: READ_ONLY_GET },
  },
  {
    route: '/api/organizations/[id]/modes',
    method: 'GET',
    audit: { kind: 'skipped', reason: READ_ONLY_GET },
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesRoute(pattern: string, route: string): boolean {
  if (pattern.includes('[')) {
    const expression = escapeRegExp(pattern).replace(/\\\[[^\]]+\\\]/g, '[^/]+');
    return new RegExp(`^${expression}$`).test(route);
  }
  if (!pattern.endsWith('*')) return route === pattern;
  const prefix = pattern.slice(0, -1);
  if (prefix.startsWith('/')) {
    return route === prefix || route.startsWith(`${prefix}/`);
  }
  return route.startsWith(prefix);
}

function matchScore(pattern: string): number {
  return pattern.endsWith('*') ? pattern.length - 1 : Number.MAX_SAFE_INTEGER;
}

export function findPrivilegedInventoryEntry(params: {
  surface: PrivilegedSurface;
  route: string;
  access?: PrivilegedAccessKind;
}): PrivilegedInventoryEntry | undefined {
  const candidates = privilegedInventory.filter(
    entry =>
      entry.surface === params.surface &&
      matchesRoute(entry.route, params.route) &&
      (params.access === undefined || entry[params.access] !== undefined)
  );
  return candidates.sort((a, b) => matchScore(b.route) - matchScore(a.route))[0];
}

export function actionClassForEntry(
  entry: PrivilegedInventoryEntry | undefined,
  access: PrivilegedAccessKind
): PrivilegedActionClass {
  return (
    entry?.[access] ??
    entry?.actionClass ??
    (access === 'read' ? 'platform_read' : 'platform_write')
  );
}

/**
 * The target kind the inventory expects for this entry. A generic guard reads
 * no row, so it binds the kind the route policy names and leaves the id null.
 */
export function targetKindForEntry(
  entry: PrivilegedInventoryEntry | undefined
): PrivilegedTargetKind {
  return entry?.target ?? 'none';
}

/**
 * The one input field the resolver of each account-area admin procedure reads
 * to name the account it acts on. Every procedure in the area takes `userId`
 * except the two listed here, so the binding always names the value the
 * resolver acts on and no other key in the body can name a target.
 */
const ACCOUNT_AREA_ID_FIELD = 'userId';

/**
 * Per-procedure overrides: the field the resolver reads, or `null` for a
 * procedure in an account area that acts on another record and so names no
 * target. A procedure absent from this map and outside the account area names
 * no target either.
 */
export const TARGET_ID_FIELD_BY_ADMIN_PROCEDURE: Record<string, string | null> = {
  'admin.users.addNote': 'kilo_user_id',
  'admin.users.deleteNote': null,
  'admin.internalBotUsers.create': 'organizationId',
  'admin.salesDemo.reset': 'organizationId',
  'admin.ossSponsorship.addExistingOrgToOss': 'organizationId',
  'admin.supportAccess.request': 'organizationId',
  'admin.supportAccess.emergencyIssue': 'organizationId',
};

/** The input field that procedure's resolver reads, or null when it has none. */
export function targetIdFieldForAdminProcedure(path: string): string | null {
  if (Object.hasOwn(TARGET_ID_FIELD_BY_ADMIN_PROCEDURE, path)) {
    return TARGET_ID_FIELD_BY_ADMIN_PROCEDURE[path] ?? null;
  }
  return path.startsWith('admin.users.') ? ACCOUNT_AREA_ID_FIELD : null;
}

/**
 * The target kind an input field names. The binding records the kind of the
 * value it holds, so a field that names an organization is not reported as an
 * account.
 */
export function targetKindForInputField(field: string): PrivilegedTargetKind {
  return field === 'organizationId' ? 'organization' : 'user';
}

function readInputField(input: object, field: string): unknown {
  if (typeof FormData !== 'undefined' && input instanceof FormData) return input.get(field);
  return (input as Record<string, unknown>)[field];
}

/**
 * The target id the request input names. The admin guard binds an operation
 * proof to it, so the confirmation names the record the request acts on. It
 * reads only `field`, the one the procedure's resolver reads. Returns null when
 * `field` is null, the input names no such field, is not a plain object or
 * `FormData`, or names it as anything but a non-empty string. Never throws.
 */
export function targetIdFromInput(field: string | null, input: unknown): string | null {
  if (field === null) return null;
  const isFormData = typeof FormData !== 'undefined' && input instanceof FormData;
  if (!isFormData && (typeof input !== 'object' || input === null || Array.isArray(input))) {
    return null;
  }
  const value = readInputField(input, field);
  // The client schema that echoes a binding back bounds the id at 200
  // characters, so an id outside that bound names no target here.
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}

export function actionClassForAdminProcedure(
  path: string,
  type: string
): {
  actionClass: PrivilegedActionClass;
  inventoryId: string | null;
  targetKind: PrivilegedTargetKind;
} {
  const access: PrivilegedAccessKind = type === 'mutation' ? 'write' : 'read';
  const entry = findPrivilegedInventoryEntry({ surface: 'trpc', route: path, access });
  return {
    actionClass: actionClassForEntry(entry, access),
    inventoryId: entry?.id ?? null,
    targetKind: targetKindForEntry(entry),
  };
}

export function actionClassForRoute(params: {
  surface: Exclude<PrivilegedSurface, 'trpc' | 'worker'>;
  route: string;
  method: string | null;
}): {
  actionClass: PrivilegedActionClass;
  inventoryId: string | null;
  targetKind: PrivilegedTargetKind;
} {
  const access: PrivilegedAccessKind =
    params.method === 'GET' || params.method === 'HEAD' ? 'read' : 'write';
  const entry = findPrivilegedInventoryEntry({
    surface: params.surface,
    route: params.route,
    access,
  });
  return {
    actionClass: actionClassForEntry(entry, access),
    inventoryId: entry?.id ?? null,
    targetKind: targetKindForEntry(entry),
  };
}
