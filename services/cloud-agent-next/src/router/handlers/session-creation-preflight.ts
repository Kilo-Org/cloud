import { TRPCError } from '@trpc/server';
import type { WorkerDb } from '@kilocode/db/client';
import {
  loadEnvironmentForSession,
  mergeEnvironmentWithInline,
  mergeProfileConfiguration,
  profileMcpServersToClientRecord,
  ProfileNotFoundError,
  type ClientMcpServerValue,
  type EnvironmentInlineArgs,
  type EnvironmentOwner,
  type EnvironmentRepositoryIdentity,
  type EnvironmentSessionLayer,
  type InlineAgentInput,
  type MergeProfileConfigurationResult,
  type ProfileOwner,
} from '@kilocode/cloud-agent-profile';
import { canonicalGitLabCloneUrl, repoFullNameFromGitUrl } from '@kilocode/worker-utils/git-url';
import { getPgDb } from '../../db/pg.js';
import { assertKiloModelAvailable } from '../../model-validation.js';
import { SessionProfileBundleSchema } from '../../persistence/schemas.js';
import type { SessionProfileBundle } from '../../session-profile.js';
import type {
  SessionCreateRequest,
  SessionRepositoryRequest,
} from '../../session/session-requests.js';
import { isPolicyBearingAuthToken } from '../../session/policy-bearing-token.js';
import { assertRepositoryAccessBeforeSessionCreation } from '../../session/validate-repository-access.js';
import type { TRPCContext } from '../../types.js';
import { isBuiltinMode } from '../schemas.js';
import { assertOrganizationMembership } from './organization-membership.js';

const IMPLICIT_PROFILE_RESOLUTION_ORIGINS: ReadonlySet<string> = new Set([
  'cloud-agent-web',
  'slack',
  'github',
  'linear',
  'discord',
  'app-builder',
  'webhook',
  'scheduled',
]);

export type ProfileResolutionPolicy = {
  defaultProfileResolution: 'explicit-profile-only' | 'include-web-defaults';
};

export function profileResolutionPolicyForSessionCreateOrigin(
  createdOnPlatform: string | undefined
): ProfileResolutionPolicy {
  return {
    defaultProfileResolution:
      createdOnPlatform !== undefined && IMPLICIT_PROFILE_RESOLUTION_ORIGINS.has(createdOnPlatform)
        ? 'include-web-defaults'
        : 'explicit-profile-only',
  };
}

function repoFullNameForBindingLookup(input: SessionCreateRequest): string | undefined {
  if (input.repository.type === 'github') return input.repository.repo;
  if (input.repository.type === 'gitlab') {
    // The repository discriminator establishes this host as GitLab, including self-hosted instances.
    return repoFullNameFromGitUrl(input.repository.url, input.repository.url);
  }
  return undefined;
}

function environmentOwnerForSession(
  ctx: Pick<TRPCContext, 'userId'>,
  input: SessionCreateRequest
): EnvironmentOwner {
  const organizationId = input.options?.kilocodeOrganizationId;
  return organizationId
    ? { type: 'organization', id: organizationId }
    : { type: 'user', id: ctx.userId };
}

function environmentRepositoryIdentity(
  repository: SessionRepositoryRequest
): EnvironmentRepositoryIdentity {
  switch (repository.type) {
    case 'github':
      return { platform: 'github', repoFullName: repository.repo };
    case 'gitlab': {
      const cloneUrl = canonicalGitLabCloneUrl(repository.url);
      if (!cloneUrl) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid GitLab repository URL' });
      }
      return { platform: 'gitlab', cloneUrl };
    }
    case 'bitbucket':
      return {
        platform: 'bitbucket',
        workspaceUuid: repository.workspaceUuid,
        repositoryUuid: repository.repositoryUuid,
      };
    case 'git':
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Repository environments are not supported for generic git repositories',
      });
  }
}

/**
 * Load and authorize the explicitly selected environment, independent of the
 * origin-based profile gate. A foreign owner, a missing owner, or a
 * soft-deleted owning organization throws NOT_FOUND; a repository mismatch
 * throws BAD_REQUEST.
 */
async function resolveEnvironmentLayer(
  ctx: Pick<TRPCContext, 'env' | 'userId'>,
  input: SessionCreateRequest,
  db?: WorkerDb
): Promise<EnvironmentSessionLayer | undefined> {
  const environmentId = input.environmentId;
  if (!environmentId) return undefined;

  return loadEnvironmentForSession(db ?? getPgDb(ctx.env), {
    owner: environmentOwnerForSession(ctx, input),
    environmentId,
    repository: environmentRepositoryIdentity(input.repository),
  });
}

function inlineOverridesForResolution(input: SessionCreateRequest): EnvironmentInlineArgs {
  const overrides = input.profile?.overrides;
  return {
    envVars: overrides?.envVars,
    setupCommands: overrides?.setupCommands,
    encryptedSecrets: overrides?.encryptedSecrets,
    mcpServers: overrides?.mcpServers as Record<string, ClientMcpServerValue> | undefined,
    runtimeSkills: overrides?.runtimeSkills,
    runtimeAgents: overrides?.runtimeAgents as InlineAgentInput[] | undefined,
  };
}

function shouldResolveProfile(
  input: SessionCreateRequest,
  policy: ProfileResolutionPolicy
): boolean {
  return (
    input.profile?.id !== undefined || policy.defaultProfileResolution === 'include-web-defaults'
  );
}

async function resolveProfileForSessionCreateRequest(
  ctx: Pick<TRPCContext, 'env' | 'userId'>,
  input: SessionCreateRequest,
  environment: EnvironmentSessionLayer | undefined,
  db?: WorkerDb
): Promise<MergeProfileConfigurationResult> {
  const owner: ProfileOwner = environmentOwnerForSession(ctx, input);
  const userId = input.options?.kilocodeOrganizationId ? ctx.userId : undefined;

  try {
    return await mergeProfileConfiguration(db ?? getPgDb(ctx.env), {
      profileId: input.profile?.id,
      owner,
      userId,
      repoFullName: repoFullNameForBindingLookup(input),
      platform:
        input.repository.type === 'gitlab'
          ? 'gitlab'
          : input.repository.type === 'github'
            ? 'github'
            : undefined,
      environment,
      ...inlineOverridesForResolution(input),
    });
  } catch (err) {
    if (err instanceof ProfileNotFoundError) {
      throw new TRPCError({ code: 'NOT_FOUND', message: err.message });
    }
    throw err;
  }
}

function applyProfileResolution(
  input: SessionCreateRequest,
  resolved: MergeProfileConfigurationResult | null
): SessionCreateRequest {
  if (!resolved) {
    return {
      ...input,
      profile: {
        ...input.profile,
        resolved: {
          ...input.profile?.resolved,
          envVars: input.profile?.overrides?.envVars,
          encryptedSecrets: input.profile?.overrides?.encryptedSecrets,
          setupCommands: input.profile?.overrides?.setupCommands,
          mcpServers: input.profile?.overrides?.mcpServers,
          runtimeSkills: input.profile?.overrides?.runtimeSkills,
          runtimeAgents: input.profile?.overrides?.runtimeAgents,
        },
      },
    };
  }

  return {
    ...input,
    profile: {
      ...input.profile,
      // The resolved active profile id. Absent when no profile applied, so a
      // session that runs on no profile records none rather than the client's
      // requested id.
      ...(resolved.resolvedProfileId ? { resolvedProfileId: resolved.resolvedProfileId } : {}),
      resolved: {
        envVars: resolved.envVars,
        setupCommands: resolved.setupCommands,
        encryptedSecrets: resolved.encryptedSecrets,
        mcpServers: profileMcpServersToClientRecord(resolved.mcpServers),
        runtimeSkills: resolved.skills,
        runtimeAgents: resolved.agents,
        kiloCommands: resolved.kiloCommands ?? input.profile?.resolved?.kiloCommands,
        runtimeInstructions: resolved.instructions ?? input.profile?.resolved?.runtimeInstructions,
      },
    },
  };
}

function assertResolvedConfigurationWithinSessionLimits(
  resolved: SessionProfileBundle | undefined
): void {
  const parsed = SessionProfileBundleSchema.safeParse({
    envVars: resolved?.envVars,
    encryptedSecrets: resolved?.encryptedSecrets,
    setupCommands: resolved?.setupCommands,
  });
  if (!parsed.success) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'resolved configuration exceeds session limits',
    });
  }
}

export async function resolveEffectiveSessionConfiguration(
  ctx: Pick<TRPCContext, 'env' | 'userId'>,
  input: SessionCreateRequest,
  policy: ProfileResolutionPolicy,
  db?: WorkerDb
): Promise<SessionCreateRequest> {
  const environment = await resolveEnvironmentLayer(ctx, input, db);
  let resolved: MergeProfileConfigurationResult | null = null;
  if (shouldResolveProfile(input, policy)) {
    resolved = await resolveProfileForSessionCreateRequest(ctx, input, environment, db);
  } else if (environment) {
    resolved = mergeEnvironmentWithInline(environment, inlineOverridesForResolution(input));
  }

  const resolvedRequest = applyProfileResolution(input, resolved);
  assertResolvedConfigurationWithinSessionLimits(resolvedRequest.profile?.resolved);
  return resolvedRequest;
}

export function assertModeAvailableForProfile(mode: string, profile: SessionProfileBundle): void {
  if (isBuiltinMode(mode)) return;
  const slugs = new Set((profile.runtimeAgents ?? []).map(a => a.slug));
  if (slugs.has(mode)) return;

  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: `Mode "${mode}" is not a built-in slug and does not match any runtimeAgents on this session`,
  });
}

type SessionCreationContext = Pick<TRPCContext, 'env' | 'userId' | 'authToken'>;
type EndpointValidator = (request: SessionCreateRequest) => void | Promise<void>;

export async function preflightSessionCreation(
  request: SessionCreateRequest,
  ctx: SessionCreationContext,
  procedure: string,
  validateEndpoint?: EndpointValidator
): Promise<SessionCreateRequest> {
  const organizationId = request.options?.kilocodeOrganizationId;
  let db: WorkerDb | undefined;
  if (organizationId) {
    db = getPgDb(ctx.env);
    await assertOrganizationMembership(db, ctx.userId, organizationId);
  }

  await assertRepositoryAccessBeforeSessionCreation({
    env: ctx.env,
    userId: ctx.userId,
    orgId: organizationId,
    repository: request.repository,
  });

  const policy = profileResolutionPolicyForSessionCreateOrigin(request.options?.createdOnPlatform);
  const resolvedRequest = await resolveEffectiveSessionConfiguration(ctx, request, policy, db);
  assertModeAvailableForProfile(
    resolvedRequest.agent.mode,
    resolvedRequest.profile?.resolved ?? {}
  );
  await validateEndpoint?.(resolvedRequest);

  if (resolvedRequest.initialTurn?.type === 'prompt' && !isPolicyBearingAuthToken(ctx.authToken)) {
    await assertKiloModelAvailable({
      env: ctx.env,
      submittedModel: resolvedRequest.agent.model,
      originalToken: ctx.authToken,
      originalOrganizationId: resolvedRequest.options?.kilocodeOrganizationId,
      createdOnPlatform: resolvedRequest.options?.createdOnPlatform,
      procedure,
    });
  }

  return resolvedRequest;
}
