/**
 * Session registration: the shared preamble run by both `start` (new public
 * API) and the legacy `prepareSession` proxy.
 *
 * Responsibilities:
 *  1. Generate canonical IDs (cloudAgentSessionId, kiloSessionId, sandboxId).
 *  2. Create the `cli_sessions_v2` row via session-ingest (blocking — the
 *     stream ticket endpoint needs it for ownership checks).
 *  3. Register full session metadata in the DO (no `preparedAt`).
 *
 * Managed git-token resolution (GitHub App installation, managed GitLab) is
 * NOT performed here; it happens lazily in the flusher's workspace preparation
 * path. Provider credentials are intentionally not stored in registration
 * metadata; generic git repositories may still carry an explicit token.
 *
 * This function does NOT queue the initial user message. Queueing is the
 * caller's responsibility — `start` calls queueMessage inline, and legacy
 * `prepareSession` either queues inline when `autoInitiate: true` or leaves
 * queueing to a follow-up `initiateFromKilocodeSessionV2` call.
 */
import { TRPCError } from '@trpc/server';

import type { Env } from '../types.js';
import { logger } from '../logger.js';
import { generateSessionId, SessionService } from '../session-service.js';
import { generateSandboxId } from '../sandbox-id.js';
import { generateKiloSessionId } from '../utils/kilo-session-id.js';
import { createMessageId } from './message-id.js';
import type { AcceptedExecutionTurn, ExecutionTurnSubmission } from '../execution/types.js';
import type { SessionCreateRequest } from './session-requests.js';

export type SessionRegistrationInput = SessionCreateRequest;

export type SessionRegistrationContext = {
  env: Env;
  userId: string;
  authToken: string;
  botId?: string;
};

export type SessionRegistrationResult = {
  cloudAgentSessionId: string;
  kiloSessionId: string;
  sandboxId: string;
  /**
   * Canonical initial prompt accepted during registration. First-turn queueing
   * must reuse this full turn so idempotency and attachments stay aligned with
   * the metadata persisted in the Durable Object.
   */
  initialTurn: AcceptedExecutionTurn;
};

function acceptInitialTurn(initialTurn: ExecutionTurnSubmission): AcceptedExecutionTurn {
  const messageId = initialTurn.id ?? createMessageId();
  return initialTurn.type === 'prompt'
    ? {
        type: 'prompt',
        messageId,
        prompt: initialTurn.prompt,
        images: initialTurn.images,
      }
    : {
        type: 'command',
        messageId,
        command: initialTurn.command,
        arguments: initialTurn.arguments,
      };
}

export function executionTurnSubmissionFromAcceptedTurn(
  turn: AcceptedExecutionTurn
): ExecutionTurnSubmission {
  return turn.type === 'prompt'
    ? {
        type: 'prompt',
        id: turn.messageId,
        prompt: turn.prompt,
        images: turn.images,
      }
    : {
        type: 'command',
        id: turn.messageId,
        command: turn.command,
        arguments: turn.arguments,
      };
}

/**
 * Register a new cloud-agent session for lazy workspace preparation.
 *
 * On failure, any rows created in session-ingest are rolled back.
 */
export async function ensureSessionRegistered(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext
): Promise<SessionRegistrationResult> {
  const sessionService = new SessionService();
  // The initial turn is accepted once here, then reused both for durable
  // registration and first-turn queueing. That keeps idempotent retries and
  // completion-time callbacks correlated with the same canonical message ID.
  const initialTurn = acceptInitialTurn(input.initialTurn);

  const cloudAgentSessionId = generateSessionId();
  const sandboxId = await generateSandboxId(
    ctx.env.PER_SESSION_SANDBOX_ORG_IDS,
    input.options?.kilocodeOrganizationId,
    ctx.userId,
    cloudAgentSessionId,
    ctx.botId,
    input.runtime?.devcontainer
  );

  const kiloSessionId = generateKiloSessionId();

  logger.setTags({
    cloudAgentSessionId,
    kiloSessionId,
    userId: ctx.userId,
    orgId: input.options?.kilocodeOrganizationId ?? '(personal)',
    sandboxId,
  });
  logger.info('Registering new session (lazy preparation)');

  // Create cli_sessions_v2 record immediately — stream-ticket ownership checks
  // need it before the first lazy preparation attempt starts.
  const defaultTitle = `New session - ${new Date().toISOString()}`;
  await sessionService.createCliSessionViaSessionIngest(
    kiloSessionId,
    cloudAgentSessionId,
    ctx.userId,
    ctx.env,
    input.options?.kilocodeOrganizationId,
    input.options?.createdOnPlatform ?? 'cloud-agent',
    defaultTitle
  );

  const rollbackCliSession = () =>
    sessionService
      .deleteCliSessionViaSessionIngest(kiloSessionId, ctx.userId, ctx.env, {
        onlyIfEmpty: true,
      })
      .catch((rollbackError: unknown) => {
        logger
          .withFields({
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          })
          .error('Failed to rollback cli_sessions_v2 record');
      });

  const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(`${ctx.userId}:${cloudAgentSessionId}`);
  const stub = ctx.env.CLOUD_AGENT_SESSION.get(doId);

  const registerResult = await stub.registerSession({
    identity: {
      sessionId: cloudAgentSessionId,
      userId: ctx.userId,
      orgId: input.options?.kilocodeOrganizationId,
      botId: ctx.botId,
      createdOnPlatform: input.options?.createdOnPlatform,
    },
    auth: {
      kiloSessionId,
      kilocodeToken: ctx.authToken,
    },
    message: {
      initialMessageId: initialTurn.messageId,
      turn: executionTurnSubmissionFromAcceptedTurn(initialTurn),
    },
    agent: {
      ...input.agent,
      appendSystemPrompt: input.profile?.overrides?.appendSystemPrompt,
    },
    repository: input.repository,
    profile: input.profile?.resolved,
    finalization: input.finalization,
    callback: input.options?.callbackTarget ? { target: input.options.callbackTarget } : undefined,
    workspace: {
      sandboxId,
      shallow: input.options?.shallow,
      ...(input.runtime?.devcontainer ? { devcontainerRequested: true } : {}),
    },
  });

  if (!registerResult.success) {
    await rollbackCliSession();
    logger.withFields({ error: registerResult.error }).error('Failed to register session in DO');
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: registerResult.error ?? 'Failed to register session',
    });
  }

  logger.info('Session registered for lazy preparation');

  return { cloudAgentSessionId, kiloSessionId, sandboxId, initialTurn };
}
