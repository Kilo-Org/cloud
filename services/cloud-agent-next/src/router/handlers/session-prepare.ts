/**
 * Legacy session preparation handlers - kept as thin proxies for existing
 * callers that still chain `prepareSession` + `initiateFromKilocodeSessionV2`,
 * or that pass `autoInitiate: true` to enqueue the initial message in one
 * call (apps/web NewSessionPanel, mobile session manager).
 *
 * `prepareSession` registers full session metadata and returns immediately in
 * the retained split flow. When `autoInitiate: true`, it delegates creation and
 * canonical initial admission to the same grouped primitive used by `start`.
 *
 * `updateSession` is retained because `services/code-review-infra` still
 * uses it to rewrite `callbackTarget` before a session-continuation
 * `sendMessageV2`. It will be removed once that flow migrates to an
 * execution-scoped callback target override on `send`.
 */
import { TRPCError } from '@trpc/server';
import type { WorkerDb } from '@kilocode/db/client';
import type * as z from 'zod';
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
import { logger, withLogTags } from '../../logger.js';

import { internalApiProtectedProcedure } from '../auth.js';
import {
  PrepareSessionInput,
  PrepareSessionOutput,
  UpdateSessionInput,
  UpdateSessionOutput,
  isBuiltinMode,
} from '../schemas.js';
import { registerNewSession, startNewSession } from '../../session/session-registration.js';
import { getPgDb } from '../../db/pg.js';
import type { Env } from '../../types.js';
import type { SessionProfileBundle } from '../../session-profile.js';
import type { SessionCreateRequest } from '../../session/session-requests.js';
import { assertKiloModelAvailable } from '../../model-validation.js';

type SessionPrepareHandlers = {
  prepareSession: typeof prepareSessionHandler;
  updateSession: typeof updateSessionHandler;
};

const CLOUD_AGENT_WEB_PLATFORM = 'cloud-agent-web';

export type ProfileResolutionPolicy = {
  defaultProfileResolution: 'explicit-profile-only' | 'include-web-defaults';
};

export function profileResolutionPolicyForSessionCreateOrigin(
  createdOnPlatform: string | undefined
): ProfileResolutionPolicy {
  return {
    defaultProfileResolution:
      createdOnPlatform === CLOUD_AGENT_WEB_PLATFORM
        ? 'include-web-defaults'
        : 'explicit-profile-only',
  };
}

type PrepareInput = z.infer<typeof PrepareSessionInput>;

function repoFullNameForBindingLookup(input: SessionCreateRequest): string | undefined {
  if (input.repository.type === 'github') return input.repository.repo;
  if (input.repository.type === 'gitlab') {
    return repoFullNameFromGitUrl(input.repository.url);
  }
  return undefined;
}

async function resolveProfileForSessionCreateRequest(
  ctx: { env: Pick<Env, 'HYPERDRIVE'>; userId: string },
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
  ctx: { env: Pick<Env, 'HYPERDRIVE'>; userId: string },
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

export function prepareInputToSessionCreateRequest(input: PrepareInput): SessionCreateRequest {
  const gitUrl = input.gitUrl;
  if (!input.githubRepo && !gitUrl) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Must provide either githubRepo or gitUrl',
    });
  }
  let repository: SessionCreateRequest['repository'];
  if (input.githubRepo) {
    repository = {
      type: 'github',
      repo: input.githubRepo,
      branch: input.upstreamBranch,
    };
  } else {
    if (!gitUrl) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Must provide either githubRepo or gitUrl',
      });
    }
    repository =
      input.platform === 'gitlab'
        ? {
            type: 'gitlab',
            url: gitUrl,
            branch: input.upstreamBranch,
          }
        : {
            type: 'git',
            url: gitUrl,
            token: input.gitToken,
            branch: input.upstreamBranch,
          };
  }

  const initialTurn: SessionCreateRequest['initialTurn'] =
    input.initialPayload?.type === 'command'
      ? {
          type: 'command',
          id: input.initialMessageId,
          command: input.initialPayload.command,
          arguments: input.initialPayload.arguments,
          attachments: input.attachments ?? input.images,
        }
      : {
          type: 'prompt',
          prompt: input.prompt,
          attachments: input.attachments ?? input.images,
          id: input.initialMessageId,
        };

  return {
    initialTurn,
    agent: {
      mode: input.mode,
      model: input.model,
      variant: input.variant,
    },
    repository,
    runtime: input.devcontainer ? { devcontainer: true } : undefined,
    profile: {
      id: input.profileId,
      overrides: {
        envVars: input.envVars,
        encryptedSecrets: input.encryptedSecrets,
        setupCommands: input.setupCommands,
        mcpServers: input.mcpServers,
        runtimeSkills: input.runtimeSkills,
        runtimeAgents: input.runtimeAgents,
        appendSystemPrompt: input.appendSystemPrompt,
      },
      ...(input.kiloCommands ? { resolved: { kiloCommands: input.kiloCommands } } : {}),
    },
    finalization: {
      autoCommit: input.autoCommit,
      condenseOnComplete: input.condenseOnComplete,
      gateThreshold: input.gateThreshold,
    },
    options: {
      callbackTarget: input.callbackTarget,
      kilocodeOrganizationId: input.kilocodeOrganizationId,
      createdOnPlatform: input.createdOnPlatform,
      shallow: input.shallow,
    },
  };
}

export function createSessionPrepareHandlers(): SessionPrepareHandlers {
  return {
    prepareSession: prepareSessionHandler,
    updateSession: updateSessionHandler,
  };
}

/**
 * Prepare a new session for later initiation.
 *
 * Registers session metadata in the DO for lazy preparation.
 * Returns immediately; the caller is expected to follow up with
 * `initiateFromKilocodeSessionV2` to queue the initial message - or switch
 * to the unified `start` endpoint which does both in one call.
 */
const prepareSessionHandler = internalApiProtectedProcedure
  .input(PrepareSessionInput)
  .output(PrepareSessionOutput)
  .mutation(async ({ input, ctx }) => {
    return withLogTags({ source: 'prepareSession' }, async () => {
      const request = prepareInputToSessionCreateRequest(input);
      const policy = profileResolutionPolicyForSessionCreateOrigin(input.createdOnPlatform);
      const requestWithProfile = await resolveEffectiveSessionConfiguration(ctx, request, policy);
      assertModeAvailableForProfile(
        requestWithProfile.agent.mode,
        requestWithProfile.profile?.resolved ?? {}
      );

      if (
        requestWithProfile.initialTurn.type === 'command' &&
        requestWithProfile.initialTurn.attachments !== undefined
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Attachments cannot be attached to slash commands',
        });
      }

      if (input.devcontainer && !input.autoInitiate) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'devcontainer sessions must use autoInitiate',
        });
      }

      if (requestWithProfile.initialTurn.type === 'prompt') {
        await assertKiloModelAvailable({
          env: ctx.env,
          submittedModel: requestWithProfile.agent.model,
          originalToken: ctx.authToken,
          originalOrganizationId: requestWithProfile.options?.kilocodeOrganizationId,
          createdOnPlatform: requestWithProfile.options?.createdOnPlatform,
          procedure: 'prepareSession',
        });
      }

      const result =
        input.autoInitiate === true
          ? await startNewSession(requestWithProfile, {
              env: ctx.env,
              userId: ctx.userId,
              authToken: ctx.authToken,
              botId: ctx.botId,
            })
          : await registerNewSession(requestWithProfile, {
              env: ctx.env,
              userId: ctx.userId,
              authToken: ctx.authToken,
              botId: ctx.botId,
            });

      return {
        cloudAgentSessionId: result.cloudAgentSessionId,
        kiloSessionId: result.kiloSessionId,
      };
    });
  });

/**
 * Update a prepared (but not yet initiated) session.
 *
 * Retained for `services/code-review-infra` which rewrites `callbackTarget`
 * on session continuation. Not used by any apps/web flow.
 *
 * Protected by internal API authentication.
 */
const updateSessionHandler = internalApiProtectedProcedure
  .input(UpdateSessionInput)
  .output(UpdateSessionOutput)
  .mutation(async ({ input, ctx }) => {
    return withLogTags({ source: 'updateSession' }, async () => {
      logger.setTags({
        cloudAgentSessionId: input.cloudAgentSessionId,
        userId: ctx.userId,
      });
      logger.info('Updating session');

      const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(
        `${ctx.userId}:${input.cloudAgentSessionId}`
      );
      const stub = ctx.env.CLOUD_AGENT_SESSION.get(doId);

      const result = await stub.tryUpdate({ callbackTarget: input.callbackTarget });

      if (!result.success) {
        logger.withFields({ error: result.error }).error('Failed to update session');
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error ?? 'Failed to update session',
        });
      }

      logger.info('Session updated successfully');

      return { success: true };
    });
  });
