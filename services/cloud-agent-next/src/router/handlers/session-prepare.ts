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
import type * as z from 'zod';
import { logger, withLogTags } from '../../logger.js';
import { resolveSessionStub } from '../../sandbox-session/session-stub.js';

import { internalApiProtectedProcedure } from '../auth.js';
import {
  PrepareSessionInput,
  PrepareSessionOutput,
  UpdateSessionInput,
  UpdateSessionOutput,
} from '../schemas.js';
import {
  registerNewSession,
  startNewSession,
  createSessionWithLedger,
} from '../../session/session-registration.js';
import type { SessionCreateRequest } from '../../session/session-requests.js';
import { preflightSessionCreation } from './session-creation-preflight.js';

type SessionPrepareHandlers = {
  prepareSession: typeof prepareSessionHandler;
  updateSession: typeof updateSessionHandler;
};

type PrepareInput = z.infer<typeof PrepareSessionInput>;

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
      ...(input.githubIntegrationId ? { githubIntegrationId: input.githubIntegrationId } : {}),
      branch: input.upstreamBranch,
    };
  } else {
    if (!gitUrl) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Must provide either githubRepo or gitUrl',
      });
    }
    if (input.platform === 'gitlab') {
      repository = {
        type: 'gitlab',
        url: gitUrl,
        branch: input.upstreamBranch,
      };
    } else if (
      input.platform === 'bitbucket' &&
      input.bitbucketWorkspaceUuid &&
      input.bitbucketRepositoryUuid
    ) {
      repository = {
        type: 'bitbucket',
        url: gitUrl,
        workspaceUuid: input.bitbucketWorkspaceUuid,
        repositoryUuid: input.bitbucketRepositoryUuid,
        bitbucketIntegrationId: input.bitbucketIntegrationId,
        branch: input.upstreamBranch,
      };
    } else {
      repository = {
        type: 'git',
        url: gitUrl,
        token: input.gitToken,
        branch: input.upstreamBranch,
      };
    }
  }

  const initialTurn: SessionCreateRequest['initialTurn'] =
    input.cloneFromKiloSessionId !== undefined
      ? undefined
      : input.initialPayload?.type === 'command'
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
    runtime:
      input.devcontainer || input.sandboxAllocation
        ? {
            ...(input.devcontainer ? { devcontainer: true } : {}),
            ...(input.sandboxAllocation ? { sandboxAllocation: input.sandboxAllocation } : {}),
          }
        : undefined,
    clone: input.cloneFromKiloSessionId
      ? { cloneFromKiloSessionId: input.cloneFromKiloSessionId }
      : undefined,
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
      clientProvenance: input.clientProvenance,
      shallow: input.shallow,
      operationKey: input.operationKey,
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
      const requestWithProfile = await preflightSessionCreation(
        prepareInputToSessionCreateRequest(input),
        ctx,
        'prepareSession',
        resolvedRequest => {
          if (
            resolvedRequest.initialTurn !== undefined &&
            resolvedRequest.initialTurn.type === 'command' &&
            resolvedRequest.initialTurn.attachments !== undefined
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
        }
      );

      const operationKey = requestWithProfile.options?.operationKey;
      const registrationContext = {
        env: ctx.env,
        userId: ctx.userId,
        authToken: ctx.authToken,
        botId: ctx.botId,
      };
      const billingOrigin = { billingOrigin: input.createdOnPlatform };
      // Admit into the operation ledger only when the client supplied an
      // `operationKey` AND the effective `autoInitiate` is true. Otherwise the
      // key is ignored and the legacy split-flow behavior is preserved.
      const result =
        input.autoInitiate === true && operationKey
          ? await createSessionWithLedger(requestWithProfile, registrationContext, {
              ...billingOrigin,
              operationKey,
              startedAt: Date.now(),
            })
          : input.autoInitiate === true
            ? await startNewSession(requestWithProfile, registrationContext, billingOrigin)
            : await registerNewSession(requestWithProfile, registrationContext, billingOrigin);

      const response = {
        cloudAgentSessionId: result.cloudAgentSessionId,
        kiloSessionId: result.kiloSessionId,
      };
      if ('replayed' in result && result.replayed === true) {
        return { ...response, replayed: true };
      }
      return response;
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

      const stub = resolveSessionStub(ctx.env, ctx.userId, input.cloudAgentSessionId);

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
