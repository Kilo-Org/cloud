/**
 * Explicit support-organization access: vocabulary, mode resolution, and the
 * exact allowlists a support grant can reach.
 *
 * Dependency-free on purpose. `apps/web`, `packages/web-shared`, and tests all
 * import it from any runtime boundary. Database resolution lives in
 * `support-access-resolver.ts` and grant lifecycle in `apps/web`.
 */

export type SupportAccessMode = 'off' | 'observe' | 'enforce';
export type SupportActionClass = 'support_read' | 'support_write';
export type SupportSurface = 'trpc' | 'rest' | 'server-component';

/**
 * Provisional policy values (coordinator decisions, pending product/security
 * sign-off). Named so the PR body and later policy changes reference one place.
 */
export const SUPPORT_WRITE_APPROVAL_POLICY = 'another_requester_permission_holder_or_superadmin';
export const SUPPORT_READ_APPROVAL_POLICY = 'none';
export const SUPPORT_READ_MAX_DURATION_SECONDS = 60 * 60;
export const SUPPORT_WRITE_MAX_DURATION_SECONDS = 15 * 60;
export const SUPPORT_WRITE_REQUEST_TTL_SECONDS = 30 * 60;

export type SupportDecision =
  | 'member'
  | 'support_grant'
  | 'deny_no_grant'
  | 'deny_not_allowlisted'
  | 'deny_action_class'
  | 'deny_never_list'
  | 'deny_actor_permission';

export type SupportContext = {
  kind: 'support';
  grantId: string;
  organizationId: string;
  actionClass: SupportActionClass;
  expiresAt: string;
  supportActionId: string;
  inventoryId: string | null;
};

export type MemberAccess = {
  kind: 'member';
  role: 'owner' | 'admin' | 'billing_manager' | 'member';
};

/**
 * Today's unconditional `is_admin` shortcut, preserved outside enforce mode.
 * `wouldBe` records what enforcement would have decided so observe mode can
 * report the cutover effect without changing behavior.
 */
export type LegacyAdminAccess = {
  kind: 'legacy_admin';
  role: 'owner';
  wouldBe: SupportDecision;
};

export type OrganizationAccess = MemberAccess | SupportContext | LegacyAdminAccess;

export function assertMemberAccess(access: OrganizationAccess): MemberAccess {
  if (access.kind !== 'member') {
    throw new Error('A member organization access context is required');
  }
  return access;
}

export function assertSupportAccess(access: OrganizationAccess): SupportContext {
  if (access.kind !== 'support') {
    throw new Error('A support organization access context is required');
  }
  return access;
}

/** Least-privilege role a support grant may stand in for. Never `owner`. */
export function supportStandInRole(
  entry: SupportAllowEntry
): 'admin' | 'billing_manager' | 'member' {
  switch (entry.standsInFor) {
    case 'manage':
      return 'admin';
    case 'billing':
      return 'billing_manager';
    case 'member':
      return 'member';
  }
}

export type SupportStandIn = 'member' | 'manage' | 'billing';
export type SupportStepUp = 'none' | 'fresh';

export type SupportAllowEntry = {
  surface: SupportSurface;
  /** Exact procedure path, REST route pattern, or named render surface. */
  key: string;
  actionClass: SupportActionClass;
  standsInFor: SupportStandIn;
  stepUp: SupportStepUp;
};

type ReadEntry = readonly [key: string, standsInFor?: SupportStandIn];
type WriteEntry = readonly [key: string, standsInFor?: SupportStandIn];

function readEntries(entries: readonly ReadEntry[]): SupportAllowEntry[] {
  return entries.map(([key, standsInFor]) => ({
    surface: key.startsWith('/') ? 'rest' : 'trpc',
    key,
    actionClass: 'support_read',
    standsInFor: standsInFor ?? 'member',
    stepUp: 'none',
  }));
}

function writeEntries(entries: readonly WriteEntry[]): SupportAllowEntry[] {
  return entries.map(([key, standsInFor]) => ({
    surface: 'trpc',
    key,
    actionClass: 'support_write',
    standsInFor: standsInFor ?? 'manage',
    stepUp: 'fresh',
  }));
}

const ORGANIZATION_READS: readonly ReadEntry[] = [
  ['organizations.withMembers'],
  ['organizations.usageStats'],
  ['organizations.creditTransactions'],
  ['organizations.creditTransactionsPage'],
  ['organizations.getCreditBlocks'],
  ['organizations.seats'],
  ['organizations.subscription.get', 'billing'],
  ['organizations.subscription.getLatestSeatPurchaseStatus'],
  ['organizations.subscription.getBillingHistory', 'billing'],
  ['organizations.settings.listAvailableModels'],
  ['organizations.auditLogs.list', 'billing'],
  ['organizations.auditLogs.getActionTypes', 'billing'],
  ['organizations.auditLogs.getSummary', 'billing'],
  ['organizations.groups.list'],
  ['organizations.groups.get', 'billing'],
  ['organizations.groups.getPolicySettings', 'billing'],
  ['organizations.guardrails.get', 'manage'],
  ['organizations.mcpGuardrails.list', 'manage'],
  ['organizations.modes.list'],
  ['organizations.modes.getById'],
  ['organizations.sso.getConfig'],
  ['organizations.usageDetails.getFeatureAdoption'],
  ['organizations.usageDetails.getRecommendations'],
  ['organizations.usageDetails.getAIAdoptionTimeseries'],
  ['organizations.reviewAgent.getCouncilEntitlement'],
  ['organizations.reviewAgent.getBitbucketReadiness'],
  ['organizations.reviewAgent.getGitHubStatus'],
  ['organizations.reviewAgent.listGitHubRepositories'],
  ['organizations.reviewAgent.getGitLabStatus'],
  ['organizations.reviewAgent.listGitLabRepositories'],
  ['organizations.reviewAgent.getReviewConfig'],
  ['organizations.securityAgent.getPermissionStatus'],
  ['organizations.securityAgent.getConfig'],
  ['organizations.securityAgent.getRepositories'],
  ['organizations.securityAgent.listFindings'],
  ['organizations.securityAgent.getFinding'],
  ['organizations.securityAgent.getStats'],
  ['organizations.securityAgent.getDashboardStats'],
  ['organizations.securityAgent.getLastSyncTime'],
  ['organizations.securityAgent.getAnalysis'],
  ['organizations.securityAgent.getCommandStatus'],
  ['organizations.securityAgent.getCommandStatuses'],
  ['organizations.securityAgent.listActiveCommands'],
  ['organizations.securityAgent.getOrphanedRepositories'],
  ['organizations.securityAgent.getAutoDismissEligible'],
  ['organizations.securityAgent.getAuditReport', 'billing'],
  ['githubApps.listOrganizationInstallations'],
  ['codeIndexing.search'],
  ['codeIndexing.getManifest'],
  ['codeIndexing.getOrganizationStats'],
  ['codeIndexing.getProjectFiles'],
];

const REST_READS: readonly ReadEntry[] = [
  ['/api/organizations/[id]/defaults'],
  ['/api/organizations/[id]/modes'],
  ['/api/organizations/[id]/guardrails'],
];

const SERVER_COMPONENT_READS: readonly ReadEntry[] = [['/organizations/[id]']];

const ORGANIZATION_WRITES: readonly WriteEntry[] = [
  ['organizations.settings.updateAllowLists', 'manage'],
  ['organizations.settings.updateDefaultModel', 'manage'],
  ['organizations.settings.configureOrganizationDefaultBehavior', 'manage'],
  ['organizations.reviewAgent.patchReviewConfig', 'manage'],
  ['organizations.reviewAgent.toggleReviewAgent', 'manage'],
  ['organizations.reviewAgent.triggerBitbucketCodeReview', 'manage'],
  ['organizations.securityAgent.saveConfig', 'billing'],
  ['organizations.securityAgent.setEnabled', 'billing'],
  ['organizations.members.resendInvite', 'manage'],
  ['githubApps.cancelPendingInstallation', 'manage'],
];

export const SUPPORT_READ_ALLOWLIST: readonly SupportAllowEntry[] = [
  ...readEntries(ORGANIZATION_READS),
  ...readEntries(REST_READS),
  ...SERVER_COMPONENT_READS.map(([key]) => ({
    surface: 'server-component' as const,
    key,
    actionClass: 'support_read' as const,
    standsInFor: 'member' as const,
    stepUp: 'none' as const,
  })),
];

export const SUPPORT_WRITE_ALLOWLIST: readonly SupportAllowEntry[] =
  writeEntries(ORGANIZATION_WRITES);

/**
 * Surfaces that never accept a support grant, whatever its action class. Kept
 * disjoint from both allowlists by test. Credential issuers, payments, OAuth
 * connects, and destructive org/account operations belong here.
 */
export const SUPPORT_NEVER_KEYS: readonly string[] = [
  '/api/organizations/[id]/user-tokens',
  '/api/auth/resource-token',
  '/api/cloud-agent/sessions/stream-ticket',
  '/api/claw/openclaw-export',
  '/api/user/exports',
  '/payments/topup',
  '/payments/topup/success',
  'organizations.autoTopUp.setEnabled',
  'organizations.autoTopUp.setPaymentMethod',
  'organizations.subscription.cancel',
  'organizations.subscription.updateSeatCount',
  'organizations.subscription.changeBillingCycle',
  'organizations.subscription.createPortalSession',
  'organizations.subscription.createStripeUrl',
  'organizations.kiloPass.purchase',
  'organizations.kiloPass.cancel',
  'organizations.delete',
  'organizations.bitbucket.connect',
  'organizations.bitbucket.replaceToken',
  'organizations.gitlab.rotateWebhookSecret',
  'organizations.sso.createConfig',
  'organizations.sso.updateConfig',
  'organizations.sso.deleteConfig',
  'organizations.members.invite',
  'organizations.members.updateRole',
  'organizations.members.remove',
  'organizations.members.setChildMemberships',
  'organizations.cloudAgentNext.createSession',
  'organizations.kiloclaw.createInstance',
];

const ALLOWLIST_BY_KEY = new Map(
  [...SUPPORT_READ_ALLOWLIST, ...SUPPORT_WRITE_ALLOWLIST].map(entry => [
    `${entry.surface}:${entry.key}:${entry.actionClass}`,
    entry,
  ])
);

/**
 * Exact-key lookup. REST patterns may contain a bracketed segment such as
 * `[id]`, which matches one concrete segment; there are no wildcards.
 */
export function findSupportAllowEntry(params: {
  surface: SupportSurface;
  key: string;
  actionClass: SupportActionClass;
}): SupportAllowEntry | undefined {
  const direct = ALLOWLIST_BY_KEY.get(`${params.surface}:${params.key}:${params.actionClass}`);
  if (direct) return direct;
  for (const entry of [...SUPPORT_READ_ALLOWLIST, ...SUPPORT_WRITE_ALLOWLIST]) {
    if (entry.surface !== params.surface || entry.actionClass !== params.actionClass) continue;
    if (restPatternMatches(entry.key, params.key)) return entry;
  }
  return undefined;
}

function restPatternMatches(pattern: string, route: string): boolean {
  if (!pattern.includes('[')) return pattern === route;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = escaped.replace(/\\\[[^\]]+\\\]/g, '[^/]+');
  return new RegExp(`^${expression}$`).test(route);
}

export function isSupportNeverKey(key: string): boolean {
  return SUPPORT_NEVER_KEYS.includes(key);
}

export function supportEntrySatisfiesRoles(
  entry: SupportAllowEntry,
  roles: readonly string[] | undefined
): boolean {
  if (!roles || roles.length === 0) return true;
  if (entry.standsInFor === 'member') return roles.includes('member');
  if (entry.standsInFor === 'manage') return roles.includes('owner') || roles.includes('admin');
  return roles.includes('owner') || roles.includes('admin') || roles.includes('billing_manager');
}

export function supportDecisionDenialReason(entry: SupportAllowEntry | undefined): SupportDecision {
  return entry ? 'deny_action_class' : 'deny_not_allowlisted';
}

const SUPPORT_ACCESS_MODES: readonly SupportAccessMode[] = ['off', 'observe', 'enforce'];
let testMode: SupportAccessMode | null = null;

/**
 * `SUPPORT_ACCESS_MODE` defaults to `off`. `enforce` is clamped to `observe`
 * outside the test seam so this PR cannot start enforcing in a deployment.
 */
export function resolveSupportAccessMode(raw: string | undefined): SupportAccessMode {
  if (raw === undefined || raw === '') return 'off';
  if (!SUPPORT_ACCESS_MODES.includes(raw as SupportAccessMode)) return 'off';
  if (raw === 'enforce') return 'observe';
  return raw as SupportAccessMode;
}

export function getSupportAccessMode(): SupportAccessMode {
  if (testMode !== null) return testMode;
  return resolveSupportAccessMode(process.env.SUPPORT_ACCESS_MODE);
}

/**
 * Test seam. Setting `enforce` here is the only way this branch can enforce;
 * the environment variable is always clamped.
 */
export function setSupportAccessModeForTest(mode: SupportAccessMode | null): void {
  testMode = mode;
}

export type AdminStepUpEvidence = { status: 'absent' } | { status: 'fresh'; verifiedAt: string };

/**
 * Narrow step-up port so PR3 stays independent of the session-bound MFA work in
 * PR2. PR5 supplies an adapter over `requirePrivilegedActor`.
 */
export type SupportStepUpPort = {
  requireFresh(params: {
    userId: string;
    action: 'support_read_request' | 'support_write_request' | 'support_approval';
  }): Promise<{ evidence: AdminStepUpEvidence }>;
};

/**
 * Interim adapter: records that no step-up occurred and never blocks. The
 * `evidence` value is shaped like `AdminStepUpState` so PR2 can replace it.
 */
export const observeOnlyStepUp: SupportStepUpPort = {
  async requireFresh() {
    return { evidence: { status: 'absent' } };
  },
};
