import { TRPCError } from '@trpc/server';
import { cli_sessions_v2, cloud_agent_worktrees } from '@kilocode/db/schema';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';
import { rootRouter } from '@/routers/root-router';

export const maxDuration = 120;

const CANDIDATE_SESSIONS = 1;

const requestSchema = z
  .object({
    workspaceId: cloudAgentWorktreeIdSchema,
    userId: z.string().min(1),
    organizationId: z.uuid().nullable(),
  })
  .strict();

// Mirrors the hosted workspace refresh status contract in cloud-agent-next.
const refreshStatusSchema = z.enum([
  'refreshed',
  'no_pr',
  'no_integration',
  'rate_limited',
  'throttled',
  'unavailable',
  'failed',
]);

type RefreshStatus = z.infer<typeof refreshStatusSchema>;
type RefreshResult = { status: RefreshStatus; retryAt: string | null };

const createCaller = createCallerFactory(rootRouter);

export async function POST(request: Request) {
  const unauthorized = authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { workspaceId, userId, organizationId } = parsed.data;

  const sessions = await db
    .select({ sessionId: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .innerJoin(
      cloud_agent_worktrees,
      and(
        eq(cloud_agent_worktrees.worktree_id, cli_sessions_v2.cloud_agent_worktree_id),
        eq(cloud_agent_worktrees.kilo_user_id, cli_sessions_v2.kilo_user_id),
        sql`${cloud_agent_worktrees.organization_id} is not distinct from ${cli_sessions_v2.organization_id}`
      )
    )
    .where(
      and(
        eq(cli_sessions_v2.cloud_agent_worktree_id, workspaceId),
        eq(cli_sessions_v2.kilo_user_id, userId),
        organizationId === null
          ? isNull(cli_sessions_v2.organization_id)
          : eq(cli_sessions_v2.organization_id, organizationId),
        isNull(cli_sessions_v2.parent_session_id),
        isNull(cloud_agent_worktrees.deletion_completed_at)
      )
    )
    .orderBy(
      sql`${cli_sessions_v2.pr_link_verified_at} is not null desc`,
      desc(cli_sessions_v2.updated_at)
    )
    .limit(CANDIDATE_SESSIONS);

  const [candidate] = sessions;
  if (!candidate) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const user = await findUserById(userId);
  if (!user) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  const caller = createCaller({ user, headersList: new Headers(), internalApiUse: true });

  try {
    const result = await caller.cliSessionsV2.refreshAssociatedPullRequest({
      sessionId: candidate.sessionId,
    });
    return NextResponse.json<RefreshResult>({
      status: result.associatedPr === null ? 'no_pr' : 'refreshed',
      retryAt: null,
    });
  } catch (error) {
    const failure = mapRefreshFailure(error);
    if (failure !== null) return NextResponse.json<RefreshResult>(failure);
    throw error;
  }
}

function mapRefreshFailure(error: unknown): RefreshResult | null {
  if (!(error instanceof TRPCError)) return null;
  const cause = error.cause as { reason?: string; retryAt?: string } | undefined;

  switch (error.code) {
    case 'NOT_FOUND':
      return { status: 'failed', retryAt: null };
    case 'BAD_REQUEST':
      return cause?.reason === 'no_integration'
        ? { status: 'no_integration', retryAt: null }
        : { status: 'failed', retryAt: null };
    case 'TOO_MANY_REQUESTS':
      return {
        status: cause?.reason === 'throttled' ? 'throttled' : 'rate_limited',
        retryAt: cause?.retryAt ?? null,
      };
    case 'SERVICE_UNAVAILABLE':
      return { status: 'unavailable', retryAt: cause?.retryAt ?? null };
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
      return { status: 'failed', retryAt: null };
    case 'INTERNAL_SERVER_ERROR':
      return { status: 'failed', retryAt: null };
    default:
      return { status: 'failed', retryAt: null };
  }
}
