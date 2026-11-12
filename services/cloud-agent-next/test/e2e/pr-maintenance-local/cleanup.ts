import assert from 'node:assert/strict';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { deleteProfile } from '@kilocode/cloud-agent-profile';
import {
  agent_environment_profiles,
  cli_sessions_v2,
  cloud_agent_worktrees,
  kilocode_users,
} from '@kilocode/db/schema';
import { LocalApiError, readPrivateJson, type Context } from './context.js';

export async function releaseCleanupGate(context: Pick<Context, 'request' | 'pass'>, tag: string) {
  try {
    await context.request('fake', `/test/release?tag=${encodeURIComponent(tag)}`, {});
  } catch (error) {
    if (
      !(error instanceof LocalApiError) ||
      error.endpoint !== '/test/release' ||
      error.status !== 404 ||
      error.responseError !== `no waiter for tag: ${tag}`
    )
      throw error;
    context.pass('owned cleanup gate has no remaining waiter');
  }
}

const bootstrapSchema = z.object({
  runId: z.string().uuid(),
  tag: z.string().regex(/^[a-z0-9-]+$/),
  userId: z.string(),
  profileId: z.string().uuid(),
  bootstrapOperationKey: z.string().uuid(),
});
type Bootstrap = z.infer<typeof bootstrapSchema>;
type CleanupUser = { id: string; email: string | null; api_token_pepper: string | null };
type CleanupProfile = { owned_by_user_id: string | null; description: string | null };

export function assertBootstrapOwnership(
  bootstrap: Bootstrap,
  user: CleanupUser | undefined,
  profile: CleanupProfile | undefined
) {
  assert(
    user &&
      user.id === bootstrap.userId &&
      user.email === `${bootstrap.tag}@cloud-agent-next-e2e.example.com`,
    'Partial fixture identity ownership changed'
  );
  if (profile)
    assert(
      profile.owned_by_user_id === bootstrap.userId &&
        profile.description === `Synthetic maintenance acceptance ${bootstrap.runId}`,
      'Partial fixture profile ownership changed'
    );
}

export async function cleanupBootstrapOnly(context: Context) {
  const bootstrap = bootstrapSchema.parse(
    await readPrivateJson(path.join(context.out, 'bootstrap.json'))
  );
  const [user] = await context.db
    .select({
      id: kilocode_users.id,
      email: kilocode_users.google_user_email,
      api_token_pepper: kilocode_users.api_token_pepper,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, bootstrap.userId));
  const [profile] = await context.db
    .select()
    .from(agent_environment_profiles)
    .where(eq(agent_environment_profiles.id, bootstrap.profileId));
  assertBootstrapOwnership(bootstrap, user, profile);
  const sessions = await context.db
    .select()
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, bootstrap.userId),
        eq(cli_sessions_v2.profile_id, bootstrap.profileId)
      )
    )
    .limit(2);
  assert(
    sessions.length <= 1,
    'Ambiguous partial workspace creation; inspect the original creation receipt'
  );
  const session = sessions[0];
  if (session) {
    assert(
      profile &&
        session.parent_session_id === null &&
        session.cloud_agent_worktree_id &&
        session.cloud_agent_session_id,
      'Partial fixture has no complete owned root registration'
    );
    const [workspace] = await context.db
      .select()
      .from(cloud_agent_worktrees)
      .where(
        and(
          eq(cloud_agent_worktrees.worktree_id, session.cloud_agent_worktree_id),
          eq(cloud_agent_worktrees.kilo_user_id, bootstrap.userId)
        )
      );
    assert(workspace, 'Partial workspace ownership changed');
    assert(user?.email, 'Partial fixture identity disappeared');
    await context.authenticate({ ...user, email: user.email });
    await context.trpc(
      'deleteWorktree',
      { worktreeId: workspace.worktree_id },
      z.object({ success: z.literal(true) })
    );
  }
  if (profile)
    await deleteProfile(context.db, bootstrap.profileId, { type: 'user', id: bootstrap.userId });
  context.pass(
    'partial prepare resources cleaned from verified private bootstrap and persisted ownership'
  );
}

export async function hasSavedState(context: Pick<Context, 'out'>) {
  try {
    await readPrivateJson(path.join(context.out, 'state.json'));
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
