import 'server-only';

import { Octokit } from '@octokit/rest';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import * as z from 'zod';
import {
  agent_environment_profiles,
  cli_sessions_v2,
  cloud_agent_pr_watch_activity,
  cloud_agent_pr_watches,
  cloud_agent_worktrees,
  platform_integrations,
  type CliSessionV2,
  type CloudAgentPrWatch,
} from '@kilocode/db/schema';
import { watchPrPolicySchema } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import {
  assertGitHubInstallationRuntimeAuthorized,
  GitHubRuntimeAuthorizationError,
} from '@/lib/integrations/github/runtime-authorization';
import {
  parseRepoReference,
  parsePullRequestUrl,
  verifySessionPullRequestLink,
} from '@/lib/integrations/platforms/github/pr-link-identity';
import {
  emptyWatchPrProjection,
  projectWatchPrEvent,
  watchPrProjectionSchema,
} from './watch-pr-events';
import { replayWatchPrCiEvents } from './watch-pr-ci-inbox';

type WatchContext = Parameters<typeof ensureOrganizationAccess>[0];

export const watchPrQuerySchema = z.object({
  sessionId: z.string().min(1),
  expectedRepoUrl: z.string().refine(value => {
    const repo = parseRepoReference(value);
    return repo?.host === 'github.com' && repo.url === value;
  }, 'Expected a canonical GitHub repository URL'),
  expectedPrNumber: z.number().int().positive(),
});
export const watchPrEnableSchema = watchPrQuerySchema.extend({
  integrationId: z.string().uuid(),
  policy: watchPrPolicySchema,
  expiresAt: z.string().datetime(),
});
export const watchPrMutationSchema = z.object({
  watchId: z.string().uuid(),
  generation: z.number().int().positive(),
});

export const WATCH_PR_REPAIR_UNAVAILABLE_REASON =
  'Automatic repairs are unavailable until worktree reservation and non-bypassable, revocable publication enforcement exist.';

export function serializeWatchPr(watch: CloudAgentPrWatch) {
  return {
    ...watch,
    policy: watchPrPolicySchema.parse(watch.policy),
    projection: watchPrProjectionSchema.parse(watch.projection),
    expires_at: new Date(watch.expires_at).toISOString(),
    last_event_at: watch.last_event_at ? new Date(watch.last_event_at).toISOString() : null,
    created_at: new Date(watch.created_at).toISOString(),
    updated_at: new Date(watch.updated_at).toISOString(),
    mode: 'observation_only' as const,
    automaticRepairsAvailable: false as const,
    automaticRepairsUnavailableReason: WATCH_PR_REPAIR_UNAVAILABLE_REASON,
    observationCoverage: 'future_events_only' as const,
    hardSpendCapAvailable: false as const,
    manualRecheckAvailable: watch.status !== 'finished',
    manualRecheckCoverage: 'pr_identity_and_lifecycle_only' as const,
  };
}

async function requireRelease(ctx: WatchContext) {
  if (!(await isReleaseToggleEnabled('cloud-agent-watch-pr', ctx.user.id))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Watch PR enablement is not available' });
  }
}

async function ownedSession(ctx: WatchContext, sessionId: string) {
  const session = await db.query.cli_sessions_v2.findFirst({
    where: and(
      eq(cli_sessions_v2.session_id, sessionId),
      eq(cli_sessions_v2.kilo_user_id, ctx.user.id)
    ),
  });
  if (!session) throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  if (session.organization_id) await ensureOrganizationAccess(ctx, session.organization_id);
  return session;
}

async function ownedWatch(ctx: WatchContext, watchId: string) {
  const watch = await db.query.cloud_agent_pr_watches.findFirst({
    where: and(
      eq(cloud_agent_pr_watches.id, watchId),
      eq(cloud_agent_pr_watches.kilo_user_id, ctx.user.id)
    ),
  });
  if (!watch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Watch not found' });
  if (watch.organization_id) await ensureOrganizationAccess(ctx, watch.organization_id);
  return watch;
}

export function assertWatchPrSource(session: CliSessionV2) {
  const repo = parseRepoReference(session.git_url);
  const pr = parsePullRequestUrl(session.pr_url);
  if (
    !repo ||
    repo.host !== 'github.com' ||
    !session.cloud_agent_worktree_id ||
    !session.cloud_agent_session_id?.startsWith('workspace_') ||
    session.parent_session_id !== null ||
    session.platform !== 'github' ||
    !session.pr_link_verified_at ||
    !session.pr_url ||
    !session.pr_number ||
    !pr ||
    pr.repoUrl !== repo.url ||
    pr.number !== session.pr_number ||
    !session.git_branch ||
    session.pr_head_ref !== session.git_branch
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Watch PR requires a verified GitHub PR linked to a Cloud Agent worktree',
    });
  }
  return {
    repo,
    worktreeId: session.cloud_agent_worktree_id,
    cloudSessionId: session.cloud_agent_session_id,
    prNumber: session.pr_number,
  };
}

function assertExpectedPr(session: CliSessionV2, input: z.infer<typeof watchPrQuerySchema>) {
  const repo = parseRepoReference(session.git_url);
  const pr = parsePullRequestUrl(session.pr_url);
  if (
    repo?.url !== input.expectedRepoUrl ||
    pr?.repoUrl !== input.expectedRepoUrl ||
    pr.number !== input.expectedPrNumber ||
    session.pr_number !== input.expectedPrNumber
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Session PR changed; refresh the PR badge before retrying',
    });
  }
}

async function verifySource(
  ctx: WatchContext,
  session: CliSessionV2,
  integrationId: string,
  profileId: string | null,
  existingWatch?: CloudAgentPrWatch,
  allowClosed = false
) {
  const source = assertWatchPrSource(session);
  const worktree = await db.query.cloud_agent_worktrees.findFirst({
    where: and(
      eq(cloud_agent_worktrees.worktree_id, source.worktreeId),
      eq(cloud_agent_worktrees.kilo_user_id, ctx.user.id)
    ),
  });
  if (
    !worktree ||
    worktree.organization_id !== session.organization_id ||
    worktree.deletion_started_at
  ) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Source worktree is unavailable' });
  }
  if (profileId !== null) {
    const profile = await db.query.agent_environment_profiles.findFirst({
      where: and(
        eq(agent_environment_profiles.id, profileId),
        session.organization_id
          ? eq(agent_environment_profiles.owned_by_organization_id, session.organization_id)
          : and(
              eq(agent_environment_profiles.owned_by_user_id, ctx.user.id),
              isNull(agent_environment_profiles.owned_by_organization_id)
            )
      ),
    });
    if (!profile)
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Selected profile is unavailable' });
  }
  const integration = await db.query.platform_integrations.findFirst({
    where: and(
      eq(platform_integrations.id, integrationId),
      eq(platform_integrations.platform, 'github'),
      session.organization_id
        ? and(
            eq(platform_integrations.owned_by_organization_id, session.organization_id),
            isNull(platform_integrations.owned_by_user_id)
          )
        : and(
            eq(platform_integrations.owned_by_user_id, ctx.user.id),
            isNull(platform_integrations.owned_by_organization_id)
          )
    ),
  });
  if (!integration?.platform_installation_id)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Selected GitHub connection is unavailable',
    });
  if (integration.permissions?.contents !== 'write') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Watch PR requires a GitHub connection with Contents write permission',
    });
  }
  const appType = integration.github_app_type ?? 'standard';
  if (
    existingWatch &&
    (integration.platform_installation_id !== existingWatch.installation_id ||
      appType !== existingWatch.github_app_type ||
      source.prNumber !== existingWatch.pr_number)
  ) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Watched PR identity changed' });
  }
  let token: Awaited<ReturnType<typeof generateGitHubInstallationToken>>;
  try {
    token = await generateGitHubInstallationToken(
      integration.platform_installation_id,
      appType,
      integration.id,
      'agent'
    );
  } catch (error) {
    if (error instanceof GitHubRuntimeAuthorizationError) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'GitHub connection is no longer authorized for this session',
      });
    }
    throw error;
  }
  const octokit = new Octokit({ auth: token.token });
  const { data: pr } = await octokit.pulls.get({
    owner: source.repo.owner,
    repo: source.repo.repo,
    pull_number: source.prNumber,
  });
  const verificationInput = {
    sessionRepo: { gitUrl: session.git_url, gitBranch: session.git_branch },
    link: {
      prUrl: session.pr_url,
      prNumber: session.pr_number,
      headRef: session.pr_head_ref,
      headSha: existingWatch ? null : session.pr_head_sha,
    },
    pullRequest: {
      number: pr.number,
      baseRepoFullName: pr.base.repo.full_name,
      headRepoFullName: pr.head.repo?.full_name,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
    },
  };
  let verification = verifySessionPullRequestLink(verificationInput);
  if (!verification.verified && verification.reason === 'head_sha_mismatch' && !existingWatch) {
    const commitsPerPage = 100;
    const maxCommitPages = 10;
    for (let page = 1; page <= maxCommitPages; page += 1) {
      const { data: commits } = await octokit.pulls.listCommits({
        owner: source.repo.owner,
        repo: source.repo.repo,
        pull_number: source.prNumber,
        per_page: commitsPerPage,
        page,
      });
      verification = verifySessionPullRequestLink({
        ...verificationInput,
        pullRequest: {
          ...verificationInput.pullRequest,
          commitShas: commits.map(commit => commit.sha),
        },
      });
      if (verification.verified || commits.length < commitsPerPage) break;
    }
  }
  const repositoryAllowed =
    integration.repository_access === 'all' ||
    (integration.repository_access === 'selected' &&
      integration.repositories?.some(
        repo =>
          String(repo.id) === String(pr.base.repo.id) &&
          repo.full_name.toLowerCase() === source.repo.fullName
      ));
  if (
    !repositoryAllowed ||
    !verification.verified ||
    pr.base.repo.archived ||
    (!allowClosed && (pr.state !== 'open' || pr.merged_at)) ||
    pr.head.repo?.id !== pr.base.repo.id ||
    (existingWatch && String(pr.base.repo.id) !== existingWatch.repository_id)
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Watch PR requires current access to an open same-repository linked PR',
    });
  }
  return { source, integration, appType, pr };
}

export async function getPrWatchOptions(
  ctx: WatchContext,
  input: z.infer<typeof watchPrQuerySchema>
) {
  const session = await ownedSession(ctx, input.sessionId);
  assertExpectedPr(session, input);
  const enabled = await isReleaseToggleEnabled('cloud-agent-watch-pr', ctx.user.id);
  const integrationOptions: {
    integrationId: string;
    appType: 'standard' | 'lite';
    accountLogin: string | null;
  }[] = [];
  let unavailableReason: string | null = enabled ? null : 'Watch PR enablement is not available';
  if (enabled) {
    try {
      const source = assertWatchPrSource(session);
      const worktree = await db.query.cloud_agent_worktrees.findFirst({
        where: and(
          eq(cloud_agent_worktrees.worktree_id, source.worktreeId),
          eq(cloud_agent_worktrees.kilo_user_id, ctx.user.id)
        ),
      });
      if (
        !worktree ||
        worktree.organization_id !== session.organization_id ||
        worktree.deletion_started_at
      ) {
        unavailableReason = 'Source worktree is unavailable';
      } else {
        const integrations = await db.query.platform_integrations.findMany({
          where: and(
            eq(platform_integrations.platform, 'github'),
            session.organization_id
              ? and(
                  eq(platform_integrations.owned_by_organization_id, session.organization_id),
                  isNull(platform_integrations.owned_by_user_id)
                )
              : and(
                  eq(platform_integrations.owned_by_user_id, ctx.user.id),
                  isNull(platform_integrations.owned_by_organization_id)
                )
          ),
          orderBy: platform_integrations.id,
        });
        for (const integration of integrations) {
          if (
            !integration.platform_installation_id ||
            integration.permissions?.contents !== 'write' ||
            (integration.repository_access !== 'all' &&
              !(
                integration.repository_access === 'selected' &&
                integration.repositories?.some(
                  repository => repository.full_name.toLowerCase() === source.repo.fullName
                )
              ))
          )
            continue;
          const appType = integration.github_app_type ?? 'standard';
          try {
            await assertGitHubInstallationRuntimeAuthorized(
              integration.platform_installation_id,
              appType,
              integration.id,
              'agent'
            );
          } catch (error) {
            if (error instanceof GitHubRuntimeAuthorizationError) continue;
            throw error;
          }
          integrationOptions.push({
            integrationId: integration.id,
            appType,
            accountLogin: integration.platform_account_login,
          });
        }
        if (!integrationOptions.length)
          unavailableReason = 'No eligible GitHub connection is available';
      }
    } catch (error) {
      if (!(error instanceof TRPCError) || error.code !== 'BAD_REQUEST') throw error;
      unavailableReason = error.message;
    }
  }
  return {
    enabled,
    canEnable: enabled && unavailableReason === null,
    unavailableReason,
    integrationOptions,
    defaultIntegrationId:
      integrationOptions.length === 1 ? (integrationOptions[0]?.integrationId ?? null) : null,
    defaults: { model: null, profileId: session.profile_id ?? null },
    mode: 'observation_only' as const,
    automaticRepairsAvailable: false as const,
    automaticRepairsUnavailableReason: WATCH_PR_REPAIR_UNAVAILABLE_REASON,
    observationCoverage: 'future_events_only' as const,
    hardSpendCapAvailable: false as const,
    manualRecheckCoverage: 'pr_identity_and_lifecycle_only' as const,
  };
}

export function assertWatchPrExpiry(expiresAt: string, now = Date.now()) {
  const expiry = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 24 * 60 * 60 * 1000) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Watch expiry must be in the next 24 hours',
    });
  }
}

export async function enableWatchPr(ctx: WatchContext, input: z.infer<typeof watchPrEnableSchema>) {
  await requireRelease(ctx);
  assertWatchPrExpiry(input.expiresAt);
  const session = await ownedSession(ctx, input.sessionId);
  assertExpectedPr(session, input);
  const { source, integration, appType, pr } = await verifySource(
    ctx,
    session,
    input.integrationId,
    input.policy.profileId
  );
  const watch = await db.transaction(async tx => {
    assertWatchPrExpiry(input.expiresAt);
    const [currentWorktree] = await tx
      .select()
      .from(cloud_agent_worktrees)
      .where(
        and(
          eq(cloud_agent_worktrees.worktree_id, source.worktreeId),
          eq(cloud_agent_worktrees.kilo_user_id, ctx.user.id)
        )
      )
      .for('update');
    if (
      !currentWorktree ||
      currentWorktree.deletion_started_at ||
      currentWorktree.organization_id !== session.organization_id
    ) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Source worktree is unavailable',
      });
    }
    const unavailable = await tx
      .update(cloud_agent_pr_watches)
      .set({
        status: 'finished',
        lifecycle_reason: sql`CASE WHEN ${cloud_agent_pr_watches.expires_at} <= now() THEN 'expired' ELSE 'source_worktree_deleted' END`,
        generation: sql`${cloud_agent_pr_watches.generation} + 1`,
        projection: sql`jsonb_set(jsonb_set(${cloud_agent_pr_watches.projection}, '{pending}', '[]'::jsonb), '{needsAttention}', 'false'::jsonb)`,
        updated_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(cloud_agent_pr_watches.repository_id, String(pr.base.repo.id)),
          eq(cloud_agent_pr_watches.pr_number, pr.number),
          sql`${cloud_agent_pr_watches.status} != 'finished' AND (
            ${cloud_agent_pr_watches.expires_at} <= now() OR (
              ${cloud_agent_pr_watches.kilo_user_id} = ${ctx.user.id}
              AND ${cloud_agent_pr_watches.organization_id} IS NOT DISTINCT FROM ${session.organization_id}
              AND NOT EXISTS (
                SELECT 1 FROM ${cloud_agent_worktrees}
                WHERE ${cloud_agent_worktrees.worktree_id} = ${cloud_agent_pr_watches.worktree_id}
                  AND ${cloud_agent_worktrees.kilo_user_id} = ${cloud_agent_pr_watches.kilo_user_id}
                  AND ${cloud_agent_worktrees.organization_id} IS NOT DISTINCT FROM ${cloud_agent_pr_watches.organization_id}
                  AND ${cloud_agent_worktrees.deletion_started_at} IS NULL
              )
            )
          )`
        )
      )
      .returning();
    for (const previous of unavailable) {
      await tx.insert(cloud_agent_pr_watch_activity).values({
        watch_id: previous.id,
        generation: previous.generation,
        kind: 'finished',
        reason: previous.lifecycle_reason,
      });
    }
    const [created] = await tx
      .insert(cloud_agent_pr_watches)
      .values({
        kilo_user_id: ctx.user.id,
        organization_id: session.organization_id,
        integration_id: integration.id,
        installation_id: integration.platform_installation_id ?? '',
        github_app_type: appType,
        repository_id: String(pr.base.repo.id),
        repo_url: source.repo.url,
        pr_number: pr.number,
        source_session_id: session.session_id,
        source_cloud_agent_session_id: source.cloudSessionId,
        worktree_id: source.worktreeId,
        head_ref: pr.head.ref,
        base_ref: pr.base.ref,
        head_sha: pr.head.sha,
        base_sha: pr.base.sha,
        policy: input.policy,
        projection: emptyWatchPrProjection(pr.updated_at),
        expires_at: input.expiresAt,
      })
      .onConflictDoNothing()
      .returning();
    if (!created)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'An active watch already exists for this pull request',
      });
    await tx.insert(cloud_agent_pr_watch_activity).values({
      watch_id: created.id,
      generation: created.generation,
      kind: 'enabled',
      reason: 'observation_only',
    });
    return created;
  });
  return serializeWatchPr(watch);
}

async function settleUnavailableWatch(watch: CloudAgentPrWatch) {
  if (watch.status === 'finished') return watch;
  const worktree = await db.query.cloud_agent_worktrees.findFirst({
    where: eq(cloud_agent_worktrees.worktree_id, watch.worktree_id),
  });
  const reason =
    new Date(watch.expires_at).getTime() <= Date.now()
      ? 'expired'
      : !worktree || worktree.deletion_started_at
        ? 'source_worktree_deleted'
        : null;
  if (!reason) return watch;
  return db.transaction(async tx => {
    const [updated] = await tx
      .update(cloud_agent_pr_watches)
      .set({
        status: 'finished',
        lifecycle_reason: reason,
        generation: watch.generation + 1,
        projection: sql`jsonb_set(jsonb_set(${cloud_agent_pr_watches.projection}, '{pending}', '[]'::jsonb), '{needsAttention}', 'false'::jsonb)`,
        updated_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(cloud_agent_pr_watches.id, watch.id),
          eq(cloud_agent_pr_watches.generation, watch.generation)
        )
      )
      .returning();
    if (updated) {
      await tx
        .insert(cloud_agent_pr_watch_activity)
        .values({ watch_id: watch.id, generation: updated.generation, kind: 'finished', reason });
      return updated;
    }
    const current = await tx.query.cloud_agent_pr_watches.findFirst({
      where: eq(cloud_agent_pr_watches.id, watch.id),
    });
    if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Watch not found' });
    return current;
  });
}

export async function getWatchPr(ctx: WatchContext, input: z.infer<typeof watchPrQuerySchema>) {
  const session = await ownedSession(ctx, input.sessionId);
  assertExpectedPr(session, input);
  let source: ReturnType<typeof assertWatchPrSource>;
  try {
    source = assertWatchPrSource(session);
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'BAD_REQUEST') return null;
    throw error;
  }
  const identity = and(
    eq(cloud_agent_pr_watches.kilo_user_id, ctx.user.id),
    eq(cloud_agent_pr_watches.worktree_id, source.worktreeId),
    eq(cloud_agent_pr_watches.pr_number, source.prNumber),
    session.organization_id
      ? eq(cloud_agent_pr_watches.organization_id, session.organization_id)
      : isNull(cloud_agent_pr_watches.organization_id)
  );
  let watch = await db.query.cloud_agent_pr_watches.findFirst({
    where: and(identity, eq(cloud_agent_pr_watches.repo_url, source.repo.url)),
    orderBy: desc(cloud_agent_pr_watches.created_at),
  });
  if (!watch) {
    watch = await db.query.cloud_agent_pr_watches.findFirst({
      where: identity,
      orderBy: desc(cloud_agent_pr_watches.created_at),
    });
    if (!watch) return null;
    if (watch.repo_url !== source.repo.url) {
      const [renamed] = await db
        .update(cloud_agent_pr_watches)
        .set({ repo_url: source.repo.url, updated_at: new Date().toISOString() })
        .where(
          and(
            eq(cloud_agent_pr_watches.id, watch.id),
            eq(cloud_agent_pr_watches.repository_id, watch.repository_id)
          )
        )
        .returning();
      if (renamed) watch = renamed;
    }
  }
  const settled = await settleUnavailableWatch(watch);
  const activity = await db
    .select()
    .from(cloud_agent_pr_watch_activity)
    .where(eq(cloud_agent_pr_watch_activity.watch_id, watch.id))
    .orderBy(desc(cloud_agent_pr_watch_activity.created_at))
    .limit(50);
  return {
    ...serializeWatchPr(settled),
    activity: activity.map(item => ({
      ...item,
      created_at: new Date(item.created_at).toISOString(),
    })),
  };
}

export async function changeWatchPr(
  ctx: WatchContext,
  input: z.infer<typeof watchPrMutationSchema>,
  action: 'pause' | 'resume' | 'stop'
) {
  if (action === 'resume') await requireRelease(ctx);
  const watch = await settleUnavailableWatch(await ownedWatch(ctx, input.watchId));
  if (watch.generation !== input.generation)
    throw new TRPCError({ code: 'CONFLICT', message: 'Watch changed; reload before retrying' });
  if (watch.status === 'finished')
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Finished watches cannot be changed',
    });
  let canonicalRepoUrl: string | undefined;
  if (action === 'resume') {
    if (watch.status !== 'paused')
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Only paused watches can resume',
      });
    const session = await ownedSession(ctx, watch.source_session_id);
    if (
      session.cloud_agent_worktree_id !== watch.worktree_id ||
      session.organization_id !== watch.organization_id
    )
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Source worktree changed' });
    const verified = await verifySource(ctx, session, watch.integration_id, null, watch);
    if (
      String(verified.pr.base.repo.id) !== watch.repository_id ||
      verified.pr.number !== watch.pr_number ||
      verified.pr.head.ref !== watch.head_ref ||
      verified.pr.base.ref !== watch.base_ref
    ) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Watched PR identity changed' });
    }
    canonicalRepoUrl = verified.source.repo.url;
  }
  const status = action === 'stop' ? 'finished' : action === 'pause' ? 'paused' : 'watching';
  return db.transaction(async tx => {
    const [updated] = await tx
      .update(cloud_agent_pr_watches)
      .set({
        status,
        ...(canonicalRepoUrl ? { repo_url: canonicalRepoUrl } : {}),
        lifecycle_reason: action === 'resume' ? null : `user_${action}`,
        generation: watch.generation + 1,
        ...(action === 'stop'
          ? {
              projection: sql`jsonb_set(jsonb_set(${cloud_agent_pr_watches.projection}, '{pending}', '[]'::jsonb), '{needsAttention}', 'false'::jsonb)`,
            }
          : {}),
        updated_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(cloud_agent_pr_watches.id, watch.id),
          eq(cloud_agent_pr_watches.kilo_user_id, ctx.user.id),
          eq(cloud_agent_pr_watches.generation, input.generation),
          eq(cloud_agent_pr_watches.status, watch.status),
          sql`${cloud_agent_pr_watches.expires_at} > now()`
        )
      )
      .returning();
    if (!updated)
      throw new TRPCError({ code: 'CONFLICT', message: 'Watch changed; reload before retrying' });
    await tx.insert(cloud_agent_pr_watch_activity).values({
      watch_id: watch.id,
      generation: updated.generation,
      kind: action,
      reason: updated.lifecycle_reason,
    });
    return serializeWatchPr(updated);
  });
}

export async function recheckWatchPr(
  ctx: WatchContext,
  input: z.infer<typeof watchPrMutationSchema>
) {
  const watch = await settleUnavailableWatch(await ownedWatch(ctx, input.watchId));
  if (watch.generation !== input.generation)
    throw new TRPCError({ code: 'CONFLICT', message: 'Watch changed; reload before retrying' });
  if (watch.status === 'finished')
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Finished watches cannot be rechecked',
    });
  const session = await ownedSession(ctx, watch.source_session_id);
  if (
    session.cloud_agent_worktree_id !== watch.worktree_id ||
    session.organization_id !== watch.organization_id
  )
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Source worktree changed' });
  const verified = await verifySource(ctx, session, watch.integration_id, null, watch, true);
  const { pr } = verified;
  return db.transaction(async tx => {
    const [current] = await tx
      .select()
      .from(cloud_agent_pr_watches)
      .where(
        and(
          eq(cloud_agent_pr_watches.id, watch.id),
          eq(cloud_agent_pr_watches.kilo_user_id, ctx.user.id),
          eq(cloud_agent_pr_watches.generation, input.generation),
          sql`${cloud_agent_pr_watches.expires_at} > now()`
        )
      )
      .for('update');
    if (
      !current ||
      current.updated_at !== watch.updated_at ||
      current.status !== watch.status ||
      current.head_sha !== watch.head_sha ||
      current.base_sha !== watch.base_sha ||
      JSON.stringify(current.projection) !== JSON.stringify(watch.projection)
    )
      throw new TRPCError({ code: 'CONFLICT', message: 'Watch changed during recheck; retry' });
    const projection = watchPrProjectionSchema.parse(current.projection);
    if (
      (projection.prUpdatedAt && Date.parse(pr.updated_at) < Date.parse(projection.prUpdatedAt)) ||
      (projection.headPushObserved && pr.head.sha !== current.head_sha) ||
      (projection.basePushObserved &&
        pr.base.ref === current.base_ref &&
        pr.base.sha !== current.base_sha)
    )
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'GitHub read conflicts with newer observations; retry later',
      });
    let next = projectWatchPrEvent(
      {
        ...current,
        projection: {
          ...projection,
          prUpdatedAt: null,
          headPushObserved: false,
          basePushObserved: false,
        },
      },
      {
        kind: 'pull_request',
        installationId: watch.installation_id,
        repositoryId: watch.repository_id,
        prNumber: pr.number,
        action: 'manual_recheck',
        updatedAt: pr.updated_at,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        headRef: pr.head.ref,
        baseRef: pr.base.ref,
        headRepositoryId: String(pr.head.repo?.id),
        baseRepositoryId: String(pr.base.repo.id),
        closed: pr.state === 'closed',
        merged: pr.merged_at !== null,
      },
      current.generation,
      []
    );
    if (next.status !== 'finished' && next.head_sha !== current.head_sha) {
      next = await replayWatchPrCiEvents(tx, current, next, current.github_app_type);
    }
    const [updated] = await tx
      .update(cloud_agent_pr_watches)
      .set({
        repo_url: verified.source.repo.url,
        head_sha: next.head_sha,
        base_sha: next.base_sha,
        head_ref: next.head_ref,
        base_ref: next.base_ref,
        status: next.status,
        generation: current.generation + 1,
        lifecycle_reason: next.lifecycle_reason,
        projection: next.projection,
        pending_revision: next.pending_revision,
        updated_at: new Date().toISOString(),
      })
      .where(eq(cloud_agent_pr_watches.id, current.id))
      .returning();
    if (!updated)
      throw new TRPCError({ code: 'CONFLICT', message: 'Watch changed during recheck; retry' });
    await tx.insert(cloud_agent_pr_watch_activity).values({
      watch_id: current.id,
      generation: updated.generation,
      kind: 'manual_recheck',
      reason: 'pr_identity_and_lifecycle_only',
    });
    return serializeWatchPr(updated);
  });
}
