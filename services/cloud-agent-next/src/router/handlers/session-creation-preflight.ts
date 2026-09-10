import { TRPCError } from '@trpc/server';
import type { WorkerDb } from '@kilocode/db/client';
import {
  mergeProfileConfiguration,
  profileMcpServersToClientRecord,
  ProfileNotFoundError,
  type ClientMcpServerValue,
  type InlineAgentInput,
  type MergeProfileConfigurationResult,
  type ProfileOwner,
} from '@kilocode/cloud-agent-profile';
import { repoFullNameFromGitUrl } from '@kilocode/worker-utils/git-url';
import { getPgDb } from '../../db/pg.js';
import { assertKiloModelAvailable } from '../../model-validation.js';
import type { SessionProfileBundle } from '../../session-profile.js';
import type { SessionCreateRequest } from '../../session/session-requests.js';
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

async function resolveProfileForSessionCreateRequest(
  ctx: Pick<TRPCContext, 'env' | 'userId'>,
  input: SessionCreateRequest,
  policy: ProfileResolutionPolicy,
  db?: WorkerDb
): Promise<MergeProfileConfigurationResult | null> {
  const shouldResolve =
    input.profile?.id !== undefined || policy.defaultProfileResolution === 'include-web-defaults';
  if (!shouldResolve) return null;

  const owner: ProfileOwner = input.options?.kilocodeOrganizationId
    ? { type: 'organization', id: input.options.kilocodeOrganizationId }
    : { type: 'user', id: ctx.userId };
  const userId = input.options?.kilocodeOrganizationId ? ctx.userId : undefined;
  const overrides = input.profile?.overrides;

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
      envVars: overrides?.envVars,
      setupCommands: overrides?.setupCommands,
      encryptedSecrets: overrides?.encryptedSecrets,
      mcpServers: overrides?.mcpServers as Record<string, ClientMcpServerValue> | undefined,
      runtimeSkills: overrides?.runtimeSkills,
      runtimeAgents: overrides?.runtimeAgents as InlineAgentInput[] | undefined,
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
      resolved: {
        envVars: resolved.envVars,
        setupCommands: resolved.setupCommands,
        encryptedSecrets: resolved.encryptedSecrets,
        mcpServers: profileMcpServersToClientRecord(resolved.mcpServers),
        runtimeSkills: resolved.skills,
        runtimeAgents: resolved.agents,
        kiloCommands: resolved.kiloCommands ?? input.profile?.resolved?.kiloCommands,
      },
    },
  };
}

export async function resolveEffectiveSessionConfiguration(
  ctx: Pick<TRPCContext, 'env' | 'userId'>,
  input: SessionCreateRequest,
  policy: ProfileResolutionPolicy,
  db?: WorkerDb
): Promise<SessionCreateRequest> {
  const resolved = await resolveProfileForSessionCreateRequest(ctx, input, policy, db);
  return applyProfileResolution(input, resolved);
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

  if (resolvedRequest.initialTurn?.type === 'prompt') {
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
