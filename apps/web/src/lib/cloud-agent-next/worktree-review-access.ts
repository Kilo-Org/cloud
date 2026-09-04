import 'server-only';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { db } from '@/lib/drizzle';

export async function assertSessionWorktree(
  fromDb: typeof db,
  input: { kiloSessionId: string; cloudAgentSessionId: string; expectedWorktreeId: string }
): Promise<void> {
  const [session] = await fromDb
    .select({ sessionId: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.session_id, input.kiloSessionId),
        eq(cli_sessions_v2.cloud_agent_session_id, input.cloudAgentSessionId),
        eq(cli_sessions_v2.cloud_agent_worktree_id, input.expectedWorktreeId)
      )
    )
    .limit(1);
  if (!session) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The destination chat is no longer in this worktree',
    });
  }
}
