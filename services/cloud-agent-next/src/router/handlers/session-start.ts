/**
 * New primary public surface for creating a cloud-agent session.
 *
 * After its external ownership-row prerequisite is created, `start` sends one
 * grouped command to the session Durable Object to persist registration metadata
 * and durably admit the canonical initial user turn. The alarm-driven flusher
 * delivers that queued message once preparation completes.
 *
 * Auth: user-token only (`protectedProcedure`). Personal sessions are user-scoped;
 * organization context is membership-checked before profile resolution or any
 * session ownership state is created.
 */
import { protectedProcedure } from '../auth.js';
import { logger, withLogTags } from '../../logger.js';
import type * as z from 'zod';
import { StartSessionInput, StartSessionOutput } from '../schemas.js';
import { startNewSession } from '../../session/session-registration.js';
import type { SessionCreateRequest } from '../../session/session-requests.js';
import { preflightSessionCreation } from './session-creation-preflight.js';

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

  let repository: SessionCreateRequest['repository'];
  switch (repo.type) {
    case 'github':
      repository = {
        type: 'github',
        repo: repo.repo,
        ...(repo.githubIntegrationId ? { githubIntegrationId: repo.githubIntegrationId } : {}),
        branch: repo.branch,
      };
      break;
    case 'gitlab':
      repository = { type: 'gitlab', url: repo.url, branch: repo.branch };
      break;
    case 'bitbucket':
      repository = {
        type: 'bitbucket',
        url: repo.url,
        workspaceUuid: repo.workspaceUuid,
        repositoryUuid: repo.repositoryUuid,
        bitbucketIntegrationId: repo.bitbucketIntegrationId,
        branch: repo.branch,
      };
      break;
    case 'git':
      repository = { type: 'git', url: repo.url, token: repo.token, branch: repo.branch };
      break;
  }

  return {
    initialTurn: {
      type: 'prompt',
      id: input.message.id,
      prompt: input.message.prompt,
      attachments: input.message.attachments ?? input.message.images,
    },
    agent: input.agent,
    repository,
    profile: profile
      ? {
          id: profile.id,
          overrides: profile.overrides,
        }
      : undefined,
    finalization: input.finalization,
    options: input.options
      ? {
          kilocodeOrganizationId: input.options.kilocodeOrganizationId,
          createdOnPlatform: input.options.createdOnPlatform,
        }
      : undefined,
  };
}

const startSessionHandler = protectedProcedure
  .input(StartSessionInput)
  .output(StartSessionOutput)
  .mutation(async ({ input, ctx }) => {
    return withLogTags({ source: 'start' }, async () => {
      const request = await preflightSessionCreation(
        startInputToSessionCreateRequest(input),
        ctx,
        'start'
      );

      const registration = await startNewSession(
        request,
        {
          env: ctx.env,
          userId: ctx.userId,
          authToken: ctx.authToken,
          botId: ctx.botId,
        },
        { billingOrigin: 'cloud-agent' }
      );
      const ack = registration.admission;

      logger
        .withFields({
          cloudAgentSessionId: registration.cloudAgentSessionId,
          kiloSessionId: registration.kiloSessionId,
          messageId: ack.messageId,
          delivery: 'queued',
        })
        .info('Session started, initial message queued');

      return {
        cloudAgentSessionId: registration.cloudAgentSessionId,
        kiloSessionId: registration.kiloSessionId,
        messageId: ack.messageId,
        delivery: 'queued',
      };
    });
  });
