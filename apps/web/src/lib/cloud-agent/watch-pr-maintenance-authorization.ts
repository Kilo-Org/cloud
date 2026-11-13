import 'server-only';
import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  agent_environment_profiles,
  cloud_agent_environments,
  cloud_agent_worktrees,
  kilocode_users,
  organization_memberships,
  organizations,
  platform_integrations,
  type CloudAgentPrWatch,
} from '@kilocode/db/schema';
import type { WatchPrMaintenancePolicy } from '@kilocode/db/cloud-agent-pr-maintenance';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import {
  createRuntimeAuthorization,
  sealRuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import {
  assertGitHubInstallationRuntimeAuthorized,
  GitHubRuntimeAuthorizationError,
} from '@/lib/integrations/github/runtime-authorization';
import { computeCloudAgentNextBalanceCheckEligibility } from '@/lib/cloud-agent-next/balance-check-eligibility';
import { getBalanceForUser } from '@kilocode/web-shared/lib/user/balance';
import { getBalanceForOrganizationUser } from '@kilocode/web-shared/lib/organizations/organization-usage';

export class MaintenanceSettingsError extends TRPCError {
  readonly maintenanceReason = 'maintenance_workspace_settings_changed';
}

export class MaintenanceBalanceError extends TRPCError {
  readonly maintenanceReason = 'maintenance_balance_unavailable';
}

export async function validateMaintenanceSettings(input: {
  userId: string;
  organizationId: string | null;
  policy: WatchPrMaintenancePolicy;
  repoUrl: string;
}) {
  const { policy } = input;
  const profile = policy.profileId
    ? await db.query.agent_environment_profiles.findFirst({
        where: eq(agent_environment_profiles.id, policy.profileId),
      })
    : null;
  const environment = policy.environmentId
    ? await db.query.cloud_agent_environments.findFirst({
        where: eq(cloud_agent_environments.id, policy.environmentId),
      })
    : null;
  const owns = (row: {
    owned_by_user_id: string | null;
    owned_by_organization_id: string | null;
  }) =>
    input.organizationId
      ? row.owned_by_organization_id === input.organizationId && row.owned_by_user_id === null
      : row.owned_by_user_id === input.userId && row.owned_by_organization_id === null;
  if (policy.profileId && (!profile || !owns(profile))) {
    throw new MaintenanceSettingsError({
      code: 'FORBIDDEN',
      message: 'Selected maintenance profile is unavailable',
    });
  }
  if (policy.environmentId && (!environment || !owns(environment))) {
    throw new MaintenanceSettingsError({
      code: 'FORBIDDEN',
      message: 'Selected maintenance environment is unavailable',
    });
  }
  if (environment) {
    const fullName = input.repoUrl.slice('https://github.com/'.length);
    const members = Array.isArray(environment.repositories) ? environment.repositories : [];
    const matches =
      (environment.platform === 'github' &&
        environment.repo_full_name?.toLowerCase() === fullName) ||
      members.some(
        member =>
          typeof member === 'object' &&
          member !== null &&
          'platform' in member &&
          member.platform === 'github' &&
          'repoFullName' in member &&
          typeof member.repoFullName === 'string' &&
          member.repoFullName.toLowerCase() === fullName
      );
    if (!matches)
      throw new MaintenanceSettingsError({
        code: 'PRECONDITION_FAILED',
        message: 'Maintenance environment does not contain the watched repository',
      });
  }
  const catalog = await getEnhancedOpenRouterModels({ countryCode: null });
  const models = Array.isArray(catalog.data) ? catalog.data : [];
  const model = models.find(entry => entry.id === policy.model);
  if (
    !model ||
    (policy.variant !== null && !(policy.variant in (model.opencode?.variants ?? {})))
  ) {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Selected maintenance model or variant is unavailable',
    });
  }
  if (input.organizationId) {
    const decision = await resolveOrganizationMemberModelDecision({
      organizationId: input.organizationId,
      kiloUserId: input.userId,
      modelId: policy.model,
    });
    if (!decision.decision.allowed)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Organization policy does not permit the maintenance model',
      });
  }
  return { profile, environment };
}

export async function authorizeMaintenanceWatch(watch: CloudAgentPrWatch) {
  const user = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, watch.kilo_user_id),
  });
  if (!user || user.blocked_at || user.blocked_reason) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Maintenance owner is unavailable or blocked',
    });
  }
  if (watch.organization_id) {
    const [membership] = await db
      .select({ role: organization_memberships.role, deletedAt: organizations.deleted_at })
      .from(organization_memberships)
      .innerJoin(organizations, eq(organization_memberships.organization_id, organizations.id))
      .where(
        and(
          eq(organization_memberships.kilo_user_id, user.id),
          eq(organization_memberships.organization_id, watch.organization_id)
        )
      );
    if (
      !membership ||
      membership.deletedAt ||
      !['owner', 'admin', 'member'].includes(membership.role)
    ) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Maintenance requires current organization membership',
      });
    }
  }
  const worktree = await db.query.cloud_agent_worktrees.findFirst({
    where: eq(cloud_agent_worktrees.worktree_id, watch.worktree_id),
  });
  if (
    !worktree ||
    worktree.deletion_started_at ||
    worktree.kilo_user_id !== user.id ||
    worktree.organization_id !== watch.organization_id
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Maintenance workspace is unavailable',
    });
  }
  const integration = await db.query.platform_integrations.findFirst({
    where: eq(platform_integrations.id, watch.integration_id),
  });
  if (
    !integration ||
    integration.platform_installation_id !== watch.installation_id ||
    (integration.github_app_type ?? 'standard') !== watch.github_app_type ||
    integration.permissions?.contents !== 'write' ||
    (watch.organization_id
      ? integration.owned_by_organization_id !== watch.organization_id
      : integration.owned_by_user_id !== user.id) ||
    (integration.repository_access !== 'all' &&
      !integration.repositories?.some(repo => String(repo.id) === watch.repository_id))
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Maintenance GitHub access is unavailable' });
  }
  try {
    await assertGitHubInstallationRuntimeAuthorized(
      watch.installation_id,
      watch.github_app_type,
      watch.integration_id,
      'agent'
    );
  } catch (error) {
    if (error instanceof GitHubRuntimeAuthorizationError)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Maintenance GitHub access is no longer authorized',
      });
    throw error;
  }
  return { user, worktree };
}

export async function authorizeMaintenanceExecution(watch: CloudAgentPrWatch) {
  const authorized = await authorizeMaintenanceWatch(watch);
  const { user } = authorized;
  const organizationId = watch.organization_id ?? undefined;
  const eligibility = await computeCloudAgentNextBalanceCheckEligibility({
    fromDb: db,
    user,
    modelId: watch.policy.model,
    organizationId,
  });
  if (!eligibility.isFree && !eligibility.hasUserByokAvailable) {
    const { balance } = organizationId
      ? await getBalanceForOrganizationUser(organizationId, user.id)
      : await getBalanceForUser(user, { quiet: true });
    if (balance < 1)
      throw new MaintenanceBalanceError({
        code: 'PRECONDITION_FAILED',
        message: 'Maintenance requires at least $1 credit or an eligible BYOK model',
      });
  }
  return authorized;
}

export async function mintMaintenanceAuthorization(
  watch: CloudAgentPrWatch,
  cloudAgentSessionId: string
) {
  const { user } = await authorizeMaintenanceExecution(watch);
  const organizationId = watch.organization_id ?? undefined;
  const admission = await signModernKiloToken({
    userId: user.id,
    pepper: user.api_token_pepper,
    secret: NEXTAUTH_SECRET,
    expiresInSeconds: 300,
    env: process.env.NODE_ENV,
    audience: 'cloud-agent-next',
    tokenPurpose: 'internal-service',
    credentialExchange: false,
    extra: {
      organizationId,
      tokenSource: 'cloud-agent',
      createdOnPlatform: 'cloud-agent',
      internalApiUse: true,
      runtimeAdmission: {
        source: 'automation',
        authorizationUserId: user.id,
        authorizationPepper: user.api_token_pepper,
      },
    },
  });
  const issued = await createRuntimeAuthorization({
    token: admission.token,
    secret: NEXTAUTH_SECRET,
    connectionString: '',
    resourceKind: 'cloud-agent-next',
    resourceId: cloudAgentSessionId,
    organizationId,
    adapters: {
      getPrincipal: async ({ userId }) => {
        const row = await db.query.kilocode_users.findFirst({
          where: eq(kilocode_users.id, userId),
        });
        return row
          ? {
              id: row.id,
              apiTokenPepper: row.api_token_pepper,
              blockedAt: row.blocked_at,
              blockedReason: row.blocked_reason,
              isBot: row.is_bot,
            }
          : null;
      },
      getMembership: async ({ userId, organizationId }) => {
        const [row] = await db
          .select({
            id: organization_memberships.id,
            role: organization_memberships.role,
            organizationDeletedAt: organizations.deleted_at,
          })
          .from(organization_memberships)
          .innerJoin(organizations, eq(organization_memberships.organization_id, organizations.id))
          .where(
            and(
              eq(organization_memberships.kilo_user_id, userId),
              eq(organization_memberships.organization_id, organizationId)
            )
          );
        return row ?? null;
      },
    },
  });
  return {
    runtimeToken: issued.token,
    runtimeAuthorizationSeal: await sealRuntimeAuthorization(issued.authorization, NEXTAUTH_SECRET),
  };
}
