/**
 * Session creation helpers for the grouped `start` path and retained legacy
 * `prepareSession` path.
 *
 * Both paths allocate canonical IDs and create the session report row before
 * creating the external `cli_sessions_v2` ownership row required
 * by stream-ticket authorization. `start` then asks its Durable Object to
 * register metadata and durably admit the already accepted initial turn through
 * one grouped operation. Legacy
 * `prepareSession` retains registration-only behavior and can queue later.
 *
 * Managed git-token resolution (GitHub App installation, managed GitLab) is
 * NOT performed here; it happens lazily in the flusher's workspace preparation
 * path. Provider credentials are intentionally not stored in registration
 * metadata; generic git repositories may still carry an explicit token.
 */
import { TRPCError } from '@trpc/server';

import type { Env } from '../types.js';
import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import { logger } from '../logger.js';
import { withDORetry } from '../utils/do-retry.js';
import { generateSessionId, SessionService } from '../session-service.js';
import {
  createCloudAgentSessionReport,
  recordCloudAgentSandboxIdentity,
  recordCloudAgentSessionFailure,
} from '../telemetry/session-reports.js';
import { generateSandboxId } from '../sandbox-id.js';
import { generateKiloSessionId } from '../utils/kilo-session-id.js';
import { createMessageId } from './message-id.js';
import type {
  AcceptedExecutionTurn,
  ExecutionTurnSubmission,
  SessionMessageAdmissionResult,
} from '../execution/types.js';
import { throwAdmissionError } from './queue-message.js';
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
  sandboxId: Awaited<ReturnType<typeof generateSandboxId>>;
  /**
   * Canonical initial turn reserved for a later legacy initiation request.
   */
  initialTurn: AcceptedExecutionTurn;
};

export type StartedSessionResult = Omit<SessionRegistrationResult, 'initialTurn'> & {
  admission: Extract<SessionMessageAdmissionResult, { success: true }>;
};

function acceptInitialTurn(initialTurn: ExecutionTurnSubmission): AcceptedExecutionTurn {
  const messageId = initialTurn.id ?? createMessageId();
  return initialTurn.type === 'prompt'
    ? {
        type: 'prompt',
        messageId,
        prompt: initialTurn.prompt,
        attachments: initialTurn.attachments,
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
        attachments: turn.attachments,
      }
    : {
        type: 'command',
        id: turn.messageId,
        command: turn.command,
        arguments: turn.arguments,
      };
}

type SessionEstablishmentFailure =
  | { stage: 'sandbox_identity'; code: 'sandbox_id_derivation_failed' }
  | { stage: 'registration'; code: 'do_registration_rejected' }
  | {
      stage: 'initial_admission';
      code: 'initial_admission_rejected' | 'initial_queue_full' | 'invalid_initial_intent';
    }
  | { stage: 'transport'; code: 'do_rpc_outcome_unknown' };

type NewSessionAllocation = SessionRegistrationResult & {
  sessionService: SessionService;
  rollbackCliSession: () => Promise<void>;
};

function initialAdmissionFailure(
  result: Extract<SessionMessageAdmissionResult, { success: false }>
): Extract<SessionEstablishmentFailure, { stage: 'initial_admission' }> {
  if (result.code === 'PENDING_QUEUE_FULL') {
    return { stage: 'initial_admission', code: 'initial_queue_full' };
  }
  if (result.code === 'BAD_REQUEST') {
    return { stage: 'initial_admission', code: 'invalid_initial_intent' };
  }
  return { stage: 'initial_admission', code: 'initial_admission_rejected' };
}

async function recordPostSetupFailure(record: () => Promise<void>): Promise<void> {
  try {
    await record();
  } catch {
    logger.warn('Failed to record Cloud Agent setup failure after Durable Object outcome');
  }
}

async function allocateNewSession(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext
): Promise<NewSessionAllocation> {
  const sessionService = new SessionService();
  const initialTurn = acceptInitialTurn(input.initialTurn);
  const cloudAgentSessionId = generateSessionId();
  const kiloSessionId = generateKiloSessionId();
  const createdOnPlatform = input.options?.createdOnPlatform ?? 'cloud-agent';

  await createCloudAgentSessionReport(
    { cloudAgentSessionId, kiloSessionId, initialMessageId: initialTurn.messageId },
    ctx.env
  );

  let sandboxId: Awaited<ReturnType<typeof generateSandboxId>>;
  try {
    sandboxId = await generateSandboxId(
      ctx.env.PER_SESSION_SANDBOX_ORG_IDS,
      input.options?.kilocodeOrganizationId,
      ctx.userId,
      cloudAgentSessionId,
      ctx.botId,
      input.runtime?.devcontainer
    );
  } catch (error) {
    await recordCloudAgentSessionFailure(
      {
        cloudAgentSessionId,
        failure: { stage: 'sandbox_identity', code: 'sandbox_id_derivation_failed' },
      },
      ctx.env
    );
    throw error;
  }

  await recordCloudAgentSandboxIdentity({ cloudAgentSessionId, sandboxId }, ctx.env);

  logger.setTags({
    cloudAgentSessionId,
    kiloSessionId,
    userId: ctx.userId,
    orgId: input.options?.kilocodeOrganizationId ?? '(personal)',
    sandboxId,
  });
  logger.info('Creating new session ownership row');

  const defaultTitle = `New session - ${new Date().toISOString()}`;
  try {
    await sessionService.createCliSessionViaSessionIngest(
      kiloSessionId,
      cloudAgentSessionId,
      ctx.userId,
      ctx.env,
      input.options?.kilocodeOrganizationId,
      createdOnPlatform,
      defaultTitle
    );
  } catch (error) {
    await recordCloudAgentSessionFailure(
      {
        cloudAgentSessionId,
        failure: { stage: 'transport', code: 'do_rpc_outcome_unknown' },
      },
      ctx.env
    );
    throw error;
  }

  return {
    cloudAgentSessionId,
    kiloSessionId,
    sandboxId,
    initialTurn,
    sessionService,
    rollbackCliSession: async () => {
      try {
        await sessionService.deleteCliSessionViaSessionIngest(kiloSessionId, ctx.userId, ctx.env, {
          onlyIfEmpty: true,
        });
      } catch (rollbackError: unknown) {
        logger
          .withFields({
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          })
          .error('Failed to rollback cli_sessions_v2 record');
      }
    },
  };
}

function buildSessionRegistrationCommand(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext,
  allocation: SessionRegistrationResult
) {
  return {
    identity: {
      sessionId: allocation.cloudAgentSessionId,
      userId: ctx.userId,
      orgId: input.options?.kilocodeOrganizationId,
      botId: ctx.botId,
      createdOnPlatform: input.options?.createdOnPlatform,
    },
    auth: {
      kiloSessionId: allocation.kiloSessionId,
      kilocodeToken: ctx.authToken,
    },
    message: {
      initialMessageId: allocation.initialTurn.messageId,
      turn: executionTurnSubmissionFromAcceptedTurn(allocation.initialTurn),
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
      sandboxId: allocation.sandboxId,
      shallow: input.options?.shallow,
      ...(input.runtime?.devcontainer ? { devcontainerRequested: true } : {}),
    },
  };
}

/**
 * Register a new cloud-agent session for a retained legacy preparation flow.
 * No initial turn is admitted until a subsequent initiation request queues it.
 * This non-idempotent RPC is issued once: explicit rejection triggers best-effort
 * empty ownership-row compensation, while thrown/unknown outcomes retain the
 * ownership row because the metadata write may have committed.
 */
export async function registerNewSession(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext
): Promise<SessionRegistrationResult> {
  const allocation = await allocateNewSession(input, ctx);
  const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(
    `${ctx.userId}:${allocation.cloudAgentSessionId}`
  );
  const stub = ctx.env.CLOUD_AGENT_SESSION.get(doId);
  let registerResult: Awaited<ReturnType<typeof stub.registerSession>>;
  try {
    registerResult = await stub.registerSession(
      buildSessionRegistrationCommand(input, ctx, allocation)
    );
  } catch (error) {
    await recordPostSetupFailure(() =>
      recordCloudAgentSessionFailure(
        {
          cloudAgentSessionId: allocation.cloudAgentSessionId,
          failure: { stage: 'transport', code: 'do_rpc_outcome_unknown' },
        },
        ctx.env
      )
    );
    throw error;
  }

  if (!registerResult.success) {
    const failure = { stage: 'registration', code: 'do_registration_rejected' } as const;
    await recordPostSetupFailure(() =>
      recordCloudAgentSessionFailure(
        { cloudAgentSessionId: allocation.cloudAgentSessionId, failure },
        ctx.env
      )
    );
    await allocation.rollbackCliSession();
    logger.withFields({ error: registerResult.error }).error('Failed to register session in DO');
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: registerResult.error ?? 'Failed to register session',
    });
  }

  logger.info('Session registered for lazy preparation');
  return allocation;
}

/**
 * Create a new session and ask its Durable Object to register metadata and
 * durably admit the canonical initial turn. The ownership row is an external
 * prerequisite; an explicit Durable Object rejection triggers best-effort
 * `onlyIfEmpty` deletion of that row. RPC retries use the same DO key and
 * canonical message identity; an unrecovered transport error leaves the row in
 * place because the Durable Object commit outcome is unknown and may require
 * later operational cleanup.
 */
export async function startNewSession(
  input: SessionRegistrationInput,
  ctx: SessionRegistrationContext
): Promise<StartedSessionResult> {
  const allocation = await allocateNewSession(input, ctx);
  const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(
    `${ctx.userId}:${allocation.cloudAgentSessionId}`
  );
  let admission: SessionMessageAdmissionResult;
  try {
    admission = await withDORetry<
      DurableObjectStub<CloudAgentSession>,
      SessionMessageAdmissionResult
    >(
      () => ctx.env.CLOUD_AGENT_SESSION.get(doId),
      stub =>
        stub.createSessionWithInitialAdmission({
          ...buildSessionRegistrationCommand(input, ctx, allocation),
          message: { initialTurn: allocation.initialTurn },
        }),
      'createSessionWithInitialAdmission'
    );
  } catch (error) {
    await recordPostSetupFailure(() =>
      recordCloudAgentSessionFailure(
        {
          cloudAgentSessionId: allocation.cloudAgentSessionId,
          failure: { stage: 'transport', code: 'do_rpc_outcome_unknown' },
        },
        ctx.env
      )
    );
    throw error;
  }

  if (!admission.success) {
    const failure =
      admission.failureBoundary === 'registration'
        ? ({ stage: 'registration', code: 'do_registration_rejected' } as const)
        : initialAdmissionFailure(admission);
    await recordPostSetupFailure(() =>
      recordCloudAgentSessionFailure(
        { cloudAgentSessionId: allocation.cloudAgentSessionId, failure },
        ctx.env
      )
    );
    await allocation.rollbackCliSession();
    logger
      .withFields({ error: admission.error, resultCode: admission.code })
      .error('Failed to register session and admit initial turn in DO');
    throwAdmissionError(admission);
  }

  logger.info('Session registered with initial message admitted');
  return {
    cloudAgentSessionId: allocation.cloudAgentSessionId,
    kiloSessionId: allocation.kiloSessionId,
    sandboxId: allocation.sandboxId,
    admission,
  };
}
