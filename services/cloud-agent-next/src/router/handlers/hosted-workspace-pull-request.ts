import { TRPCError } from '@trpc/server';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { hasOrganizationAccess } from '@kilocode/worker-utils';
import { z } from 'zod';
import { resolveSecret } from '../../auth.js';
import { DEFAULT_BACKEND_URL } from '../../constants.js';
import { getPgDb } from '../../db/pg.js';
import { logger } from '../../logger.js';
import {
  readWorkspacePullRequestSummaries,
  workspacePullRequestSummarySchema,
  type WorkspacePullRequestSummary,
} from '../../session/workspace-pull-request.js';
import type { Env } from '../../types.js';
import { protectedProcedure } from '../auth.js';

const REFRESH_PATH = '/api/internal/cloud-agent-next/hosted-workspace-pull-request/refresh';
const REFRESH_TIMEOUT_MS = 110_000;

const refreshStatusSchema = z.enum([
  'refreshed',
  'no_pr',
  'no_integration',
  'rate_limited',
  'throttled',
  'unavailable',
  'failed',
]);

const internalRefreshResultSchema = z
  .object({
    status: refreshStatusSchema,
    retryAt: z.string().min(1).nullable(),
  })
  .strict();

type RefreshResult = z.infer<typeof internalRefreshResultSchema>;

export const refreshHostedWorkspacePullRequestInput = z
  .object({ workspaceId: cloudAgentWorktreeIdSchema })
  .strict();

export const refreshHostedWorkspacePullRequestOutput = z
  .object({
    workspaceId: cloudAgentWorktreeIdSchema,
    pullRequest: workspacePullRequestSummarySchema.nullable(),
    refresh: z
      .object({
        status: refreshStatusSchema,
        retryAt: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const refreshHostedWorkspacePullRequest = protectedProcedure
  .input(refreshHostedWorkspacePullRequestInput)
  .output(refreshHostedWorkspacePullRequestOutput)
  .mutation(async ({ input, ctx }) => {
    const workspace = await ctx.env.SESSION_INGEST.getCloudAgentWorkspace({
      kiloUserId: ctx.userId,
      workspaceId: input.workspaceId,
      sessionLimit: 1,
    });
    if (!workspace) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
    }
    if (workspace.organizationId !== null) {
      const allowed = await hasOrganizationAccess(getPgDb(ctx.env), {
        kiloUserId: ctx.userId,
        organizationId: workspace.organizationId,
      });
      if (!allowed) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace access denied' });
      }
    }

    const refresh = await requestWorkspacePullRequestRefresh(ctx.env, {
      workspaceId: input.workspaceId,
      userId: workspace.userId,
      organizationId: workspace.organizationId,
    });
    const summaries = await readWorkspacePullRequestSummaries(ctx.env, {
      userId: ctx.userId,
      workspaces: [
        {
          workspaceId: input.workspaceId,
          organizationId: workspace.organizationId,
        },
      ],
    });
    const pullRequest = summaries.get(input.workspaceId) ?? null;

    return {
      workspaceId: input.workspaceId,
      pullRequest,
      refresh: reconcileRefresh(refresh, pullRequest),
    };
  });

async function requestWorkspacePullRequestRefresh(
  env: Env,
  body: { workspaceId: string; userId: string; organizationId: string | null }
): Promise<RefreshResult> {
  const secret = await resolveSecret(env.INTERNAL_API_SECRET);
  if (!secret) {
    logger.error('hosted workspace PR refresh unavailable: internal API secret is not configured');
    return { status: 'unavailable', retryAt: null };
  }

  try {
    const response = await fetch(
      new URL(REFRESH_PATH, env.KILOCODE_BACKEND_BASE_URL ?? DEFAULT_BACKEND_URL),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': secret,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      }
    );

    if (response.status === 404) {
      await response.body?.cancel();
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      logger.withFields({ status: response.status }).error('hosted workspace PR refresh rejected');
      return { status: 'unavailable', retryAt: null };
    }
    if (!response.ok) {
      await response.body?.cancel();
      logger.withFields({ status: response.status }).error('hosted workspace PR refresh failed');
      return { status: 'failed', retryAt: null };
    }

    const parsed = internalRefreshResultSchema.safeParse(await response.json());
    if (!parsed.success) {
      logger.error('hosted workspace PR refresh returned an invalid result');
      return { status: 'failed', retryAt: null };
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error) })
      .error('hosted workspace PR refresh request failed');
    return { status: 'failed', retryAt: null };
  }
}

function reconcileRefresh(
  refresh: RefreshResult,
  pullRequest: WorkspacePullRequestSummary | null
): RefreshResult {
  if (pullRequest !== null && (refresh.status === 'no_pr' || refresh.status === 'refreshed')) {
    return { status: 'refreshed', retryAt: refresh.retryAt };
  }
  if (pullRequest === null && refresh.status === 'refreshed') {
    return { status: 'no_pr', retryAt: refresh.retryAt };
  }
  return refresh;
}
