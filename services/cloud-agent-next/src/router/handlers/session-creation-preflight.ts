import { TRPCError } from '@trpc/server';
import type { WorkerDb } from '@kilocode/db/client';
import {
  loadEnvironmentForSession,
  mergeProfileConfiguration,
  profileMcpServersToClientRecord,
  ProfileNotFoundError,
  type EnvironmentForSession,
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
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { withDORetry } from '../../utils/do-retry.js';
import { validateBalanceOnly } from '../../balance-validation.js';
import { timingSafeEqual } from '@kilocode/encryption';

const IMPLICIT_PROFILE_RESOLUTION_ORIGINS: ReadonlySet<string> = new Set([
  'cloud-agent-web',
  'slack',
  'github',
  'linear',
  'discord',
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

/** The identity an environment is keyed by; none for a generic git repository. */
function environmentRepositoryIdentity(
  repository: SessionRepositoryRequest
): EnvironmentRepositoryIdentity | undefined {
  switch (repository.type) {
    case 'github':
      return { platform: 'github', repoFullName: repository.repo };
    case 'gitlab': {
      const cloneUrl = canonicalGitLabCloneUrl(repository.url);
      return cloneUrl ? { platform: 'gitlab', cloneUrl } : undefined;
    }
    case 'bitbucket':
      return {
        platform: 'bitbucket',
        workspaceUuid: repository.workspaceUuid,
        repositoryUuid: repository.repositoryUuid,
      };
    case 'git':
      return undefined;
  }
}

/**
 * The environment of the session's repository. It applies on the same origins
 * as the implicit profile defaults; other origins (for example code review and
 * the security agent) run without it.
 */
async function resolveEnvironment(
  ctx: Pick<TRPCContext, 'env' | 'userId'>,
  input: SessionCreateRequest,
  policy: ProfileResolutionPolicy,
  db?: WorkerDb
): Promise<EnvironmentForSession | null> {
  if (policy.defaultProfileResolution !== 'include-web-defaults') return null;
  const repository = environmentRepositoryIdentity(input.repository);
  if (!repository) return null;

  return loadEnvironmentForSession(db ?? getPgDb(ctx.env), {
    owner: environmentOwnerForSession(ctx, input),
    repository,
  });
}

function inlineOverridesForResolution(input: SessionCreateRequest): EnvironmentInlineArgs {
  const overrides = input.profile?.overrides;
  return {
    envVars: overrides?.envVars,
    setupCommands: overrides?.setupCommands,
    encryptedSecrets: overrides?.encryptedSecrets,
    mcpServers: overrides?.mcpServers,
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
  const environment = await resolveEnvironment(ctx, input, policy, db);
  // An environment resolves only under the implicit-defaults policy, so the
  // profile path always runs when one exists.
  const resolved = shouldResolveProfile(input, policy)
    ? await resolveProfileForSessionCreateRequest(ctx, input, environment?.layer, db)
    : null;

  const resolvedRequest = applyProfileResolution(input, resolved);
  assertResolvedConfigurationWithinSessionLimits(resolvedRequest.profile?.resolved);
  // The allocation travels beside the merged configuration; a client cannot
  // set it.
  const { environmentSandboxAllocation: _clientAllocation, ...withoutEnvironment } =
    resolvedRequest;
  if (!environment?.sandboxAllocation) return withoutEnvironment;
  return { ...withoutEnvironment, environmentSandboxAllocation: environment.sandboxAllocation };
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

type SessionCreationContext = Pick<
  TRPCContext,
  'env' | 'userId' | 'authToken' | 'cloudAgentAuthority'
> &
  Partial<Pick<TRPCContext, 'request'>>;
type EndpointValidator = (request: SessionCreateRequest) => void | Promise<void>;

export async function preflightSessionCreation(
  request: SessionCreateRequest,
  ctx: SessionCreationContext,
  procedure: string,
  validateEndpoint?: EndpointValidator
): Promise<SessionCreateRequest> {
  if (ctx.cloudAgentAuthority) {
    const authority = ctx.cloudAgentAuthority;
    if (
      request.parentCloudAgentSessionId !== authority.parentSessionId ||
      authority.ownerId !== ctx.userId ||
      (request.options?.kilocodeOrganizationId ?? null) !== authority.organizationId
    ) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Cloud Agent parent binding mismatch' });
    }
    let token: string;
    try {
      token = await withDORetry(
        () => getSandboxSessionStub(ctx.env, ctx.userId, authority.parentSessionId),
        stub => stub.getCloudAgentSpawnRuntimeToken(authority),
        'getCloudAgentSpawnRuntimeToken'
      );
    } catch {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Cloud Agent parent authorization unavailable',
      });
    }
    const internalApiKey = ctx.request?.headers.get('x-internal-api-key');
    const skipBalance =
      ctx.request?.headers.get('x-skip-balance-check') === 'true' &&
      typeof ctx.env.INTERNAL_API_SECRET === 'string' &&
      internalApiKey !== undefined &&
      internalApiKey !== null &&
      timingSafeEqual(internalApiKey, ctx.env.INTERNAL_API_SECRET);
    if (!skipBalance) {
      const balance = await validateBalanceOnly(
        token,
        authority.organizationId ?? undefined,
        ctx.env
      );
      if (!balance.success)
        throw new TRPCError({
          code: balance.status === 402 ? 'PAYMENT_REQUIRED' : 'INTERNAL_SERVER_ERROR',
          message: balance.message,
        });
    }
  }
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
