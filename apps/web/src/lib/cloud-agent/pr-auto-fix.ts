import 'server-only';

import { and, eq, isNull, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  cli_sessions_v2,
  cloud_agent_pr_watches,
  cloud_agent_user_settings,
  cloud_agent_worktrees,
  kilocode_users,
} from '@kilocode/db/schema';
import {
  pullRequestAutoFixSettingsSchema,
  watchPrMaintenancePolicySchema,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { sessionAssociatedPr } from '@/lib/session-associated-pr';
import { enableWatchPr, getPrWatchOptions, type watchPrQuerySchema } from './watch-pr';
import type { z } from 'zod';

export async function enablePullRequestAutoFix(
  ctx: Parameters<typeof enableWatchPr>[0],
  input: z.infer<typeof watchPrQuerySchema>
) {
  const saved = await db.query.cloud_agent_user_settings.findFirst({
    where: eq(cloud_agent_user_settings.kilo_user_id, ctx.user.id),
    columns: { pull_request_auto_fix: true },
  });
  const settings = pullRequestAutoFixSettingsSchema.safeParse(saved?.pull_request_auto_fix);
  if (!settings.success) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Configure pull request auto-fix in your personal Cloud Agent settings first.',
    });
  }
  const options = await getPrWatchOptions(ctx, input);
  if (!options.canEnable) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: options.unavailableReason ?? 'This workspace is not eligible for auto-fix.',
    });
  }
  const integrationId =
    options.defaultIntegrationId ?? options.integrationOptions[0]?.integrationId;
  if (!integrationId) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: options.unavailableReason ?? 'No eligible GitHub connection is available.',
    });
  }
  return enableWatchPr(ctx, {
    ...input,
    integrationId,
    policy: watchPrMaintenancePolicySchema.parse({
      model: settings.data.model,
      variant: settings.data.variant,
      categories: settings.data.categories,
      trustedBotLogins: settings.data.trustedBotLogins,
      automaticWritesConsent: settings.data.automaticWritesConsent,
      historyRewriteConsent: settings.data.historyRewriteConsent,
      noHardSpendCapConsent: settings.data.noHardSpendCapConsent,
      version: 2,
      profileId: options.defaults.profileId,
      environmentId: options.defaults.environmentId,
    }),
  });
}

export async function enablePullRequestAutoFixWorkspaces() {
  const eligible = db
    .selectDistinctOn([cli_sessions_v2.cloud_agent_worktree_id], {
      sessionId: cli_sessions_v2.session_id,
      userId: cli_sessions_v2.kilo_user_id,
      settings: cloud_agent_user_settings.pull_request_auto_fix,
      repoUrl: sessionAssociatedPr.git_url,
      prNumber: sessionAssociatedPr.pr_number,
    })
    .from(cli_sessions_v2)
    .innerJoin(kilocode_users, eq(kilocode_users.id, cli_sessions_v2.kilo_user_id))
    .innerJoin(
      cloud_agent_user_settings,
      eq(cloud_agent_user_settings.kilo_user_id, cli_sessions_v2.kilo_user_id)
    )
    .innerJoin(
      cloud_agent_worktrees,
      and(
        eq(cloud_agent_worktrees.worktree_id, cli_sessions_v2.cloud_agent_worktree_id),
        eq(cloud_agent_worktrees.kilo_user_id, cli_sessions_v2.kilo_user_id),
        isNull(cloud_agent_worktrees.deletion_started_at)
      )
    )
    .innerJoinLateral(sessionAssociatedPr, sql`true`)
    .where(
      and(
        sql`${cloud_agent_user_settings.pull_request_auto_fix}->>'autoEnable' = 'true'`,
        isNull(kilocode_users.blocked_at),
        isNull(kilocode_users.blocked_reason),
        isNull(cli_sessions_v2.parent_session_id),
        eq(cli_sessions_v2.chat_kind, 'user'),
        sql`${cli_sessions_v2.cloud_agent_session_id} LIKE 'workspace_%'`,
        sql`${sessionAssociatedPr.pr_state} IN ('open', 'draft')`,
        eq(sessionAssociatedPr.pr_from_workspace, true),
        sql`NOT EXISTS (
          SELECT 1 FROM ${cloud_agent_pr_watches}
          WHERE ${cloud_agent_pr_watches.worktree_id} = ${cloud_agent_worktrees.worktree_id}
            AND ${cloud_agent_pr_watches.repo_url} = ${sessionAssociatedPr.git_url}
            AND ${cloud_agent_pr_watches.pr_number} = ${sessionAssociatedPr.pr_number}
        )`
      )
    )
    .orderBy(cli_sessions_v2.cloud_agent_worktree_id, cli_sessions_v2.created_at)
    .as('eligible_auto_fix_workspaces');
  const candidates = await db
    .select()
    .from(eligible)
    .orderBy(sql`random()`)
    .limit(5);

  const startedAt = Date.now();
  let enabled = 0;
  let unavailable = 0;
  const failures: Record<string, number> = {};
  for (const candidate of candidates) {
    if (Date.now() - startedAt >= 30_000) break;
    const settings = pullRequestAutoFixSettingsSchema.safeParse(candidate.settings);
    if (!settings.success || !settings.data.autoEnable || !candidate.repoUrl || !candidate.prNumber)
      continue;
    const user = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, candidate.userId),
    });
    if (!user || user.blocked_at || user.blocked_reason) continue;
    const ctx = { user: { ...user, is_admin: false } };
    const input = {
      sessionId: candidate.sessionId,
      expectedRepoUrl: candidate.repoUrl,
      expectedPrNumber: candidate.prNumber,
    };
    try {
      await enablePullRequestAutoFix(ctx, input);
      enabled += 1;
    } catch (error) {
      unavailable += 1;
      const reason = error instanceof TRPCError ? error.code : 'unexpected_error';
      failures[reason] = (failures[reason] ?? 0) + 1;
    }
  }
  if (unavailable > 0) warnExceptInTest('Pull request auto-fix enrollment deferred', { failures });
  return { enabled, unavailable };
}
