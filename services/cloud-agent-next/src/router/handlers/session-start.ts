/**
 * New primary public surface for creating a cloud-agent session.
 *
 * `start` registers a session, schedules async preparation, AND queues the
 * initial user message atomically. Callers no longer need to chain
 * `prepareSession` → `initiateFromKilocodeSessionV2` — a single call sets up
 * the entire delivery pipeline. The alarm-driven flusher delivers the queued
 * message once preparation completes.
 *
 * Auth: user-token only (`protectedProcedure`). The entire lifecycle
 * (register + queue) is user-scoped and safe to expose to authenticated
 * browser clients, matching the auth surface of `send`.
 */
import { protectedProcedure } from '../auth.js';
import { logger, withLogTags } from '../../logger.js';
import type * as z from 'zod';
import { StartSessionInput, StartSessionOutput } from '../schemas.js';
import {
  ensureSessionRegistered,
  promptSubmissionFromAcceptedTurn,
} from '../../session/session-registration.js';
import { queueMessage } from '../../session/queue-message.js';
import {
  applyProfileResolution,
  assertModeAvailableForProfile,
  resolveProfileForSessionCreateRequest,
} from './session-prepare.js';
import type { SessionCreateRequest } from '../../session/session-requests.js';

type SessionStartHandlers = {
  start: typeof startSessionHandler;
};

export function createSessionStartHandlers(): SessionStartHandlers {
  return { start: startSessionHandler };
}

function startInputToSessionCreateRequest(
  input: z.infer<typeof StartSessionInput>
): SessionCreateRequest {
  const repo = input.repository;
  const profile = input.profile;

  return {
    initialPrompt: input.message,
    agent: input.agent,
    repository:
      repo.type === 'github'
        ? { type: 'github', repo: repo.repo, branch: repo.branch }
        : repo.type === 'gitlab'
          ? { type: 'gitlab', url: repo.url, branch: repo.branch }
          : { type: 'git', url: repo.url, token: repo.token, branch: repo.branch },
    profile: profile
      ? {
          id: profile.id,
          overrides: profile.overrides,
        }
      : undefined,
    finalization: input.finalization,
    options: input.options,
  };
}

const startSessionHandler = protectedProcedure
  .input(StartSessionInput)
  .output(StartSessionOutput)
  .mutation(async ({ input, ctx }) => {
    return withLogTags({ source: 'start' }, async () => {
      const request = startInputToSessionCreateRequest(input);
      const resolved = await resolveProfileForSessionCreateRequest(ctx, request);
      const requestWithProfile = applyProfileResolution(request, resolved);
      assertModeAvailableForProfile(
        requestWithProfile.agent.mode,
        requestWithProfile.profile?.resolved ?? {}
      );

      const registration = await ensureSessionRegistered(requestWithProfile, {
        env: ctx.env,
        userId: ctx.userId,
        authToken: ctx.authToken,
        botId: ctx.botId,
      });

      const ack = await queueMessage(
        {
          // Unified start queues its accepted turn directly; only the legacy prepare flow uses registered-initial.
          kind: 'user-message',
          cloudAgentSessionId: registration.cloudAgentSessionId,
          message: promptSubmissionFromAcceptedTurn(registration.initialTurn),
          agent: requestWithProfile.agent,
          finalization: requestWithProfile.finalization,
        },
        { env: ctx.env, userId: ctx.userId, botId: ctx.botId }
      );

      if (ack.delivery !== 'queued') {
        logger
          .withFields({ delivery: ack.delivery })
          .warn('Unexpected delivery state for initial message on fresh session');
      }

      logger
        .withFields({
          cloudAgentSessionId: registration.cloudAgentSessionId,
          kiloSessionId: registration.kiloSessionId,
          messageId: ack.messageId,
          delivery: ack.delivery,
          wrapperRunId: ack.wrapperRunId,
        })
        .info('Session started, initial message queued');

      return {
        cloudAgentSessionId: registration.cloudAgentSessionId,
        kiloSessionId: registration.kiloSessionId,
        messageId: ack.messageId,
        delivery: ack.delivery,
        wrapperRunId: ack.wrapperRunId,
      };
    });
  });
