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
import { TRPCError } from '@trpc/server';
import { organization_memberships } from '@kilocode/db/schema';
import type { WorkerDb } from '@kilocode/db/client';
import { and, eq } from 'drizzle-orm';
import { logger, withLogTags } from '../../logger.js';
import { getPgDb } from '../../db/pg.js';
import type * as z from 'zod';
import { StartSessionInput, StartSessionOutput } from '../schemas.js';
import { startNewSession } from '../../session/session-registration.js';
import {
  assertModeAvailableForProfile,
  profileResolutionPolicyForSessionCreateOrigin,
  resolveEffectiveSessionConfiguration,
} from './session-prepare.js';
import type { SessionCreateRequest } from '../../session/session-requests.js';
import { assertKiloModelAvailable } from '../../model-validation.js';

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
    initialTurn: {
      type: 'prompt',
      ...input.message,
    },
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
    options: input.options
      ? {
          kilocodeOrganizationId: input.options.kilocodeOrganizationId,
          createdOnPlatform: input.options.createdOnPlatform,
        }
      : undefined,
  };
}

async function assertOrganizationMembership(
  db: WorkerDb,
  userId: string,
  organizationId: string
): Promise<void> {
  const [membership] = await db
    .select({ id: organization_memberships.id })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, userId)
      )
    )
    .limit(1);

  if (!membership) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have access to this organization',
    });
  }
}

const startSessionHandler = protectedProcedure
  .input(StartSessionInput)
  .output(StartSessionOutput)
  .mutation(async ({ input, ctx }) => {
    return withLogTags({ source: 'start' }, async () => {
      const request = startInputToSessionCreateRequest(input);
      const organizationId = request.options?.kilocodeOrganizationId;
      let db: WorkerDb | undefined;
      if (organizationId) {
        db = getPgDb(ctx.env);
        await assertOrganizationMembership(db, ctx.userId, organizationId);
      }

      const policy = profileResolutionPolicyForSessionCreateOrigin(
        input.options?.createdOnPlatform
      );
      const requestWithProfile = await resolveEffectiveSessionConfiguration(
        ctx,
        request,
        policy,
        db
      );
      assertModeAvailableForProfile(
        requestWithProfile.agent.mode,
        requestWithProfile.profile?.resolved ?? {}
      );
      await assertKiloModelAvailable({
        env: ctx.env,
        submittedModel: requestWithProfile.agent.model,
        originalToken: ctx.authToken,
        originalOrganizationId: requestWithProfile.options?.kilocodeOrganizationId,
        createdOnPlatform: requestWithProfile.options?.createdOnPlatform,
        procedure: 'start',
      });

      const registration = await startNewSession(requestWithProfile, {
        env: ctx.env,
        userId: ctx.userId,
        authToken: ctx.authToken,
        botId: ctx.botId,
      });
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
