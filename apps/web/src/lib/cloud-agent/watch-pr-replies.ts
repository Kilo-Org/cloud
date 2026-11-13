import 'server-only';

import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  cloud_agent_pr_feedback_dispositions,
  cloud_agent_pr_maintenance_attempts,
  cloud_agent_pr_watch_activity,
  type CloudAgentPrFeedbackDisposition,
  type CloudAgentPrMaintenanceAttempt,
  type CloudAgentPrWatch,
} from '@kilocode/db/schema';
import {
  watchPrDefaultTrustedBotLogins,
  watchPrMaintenanceDefaults,
  watchPrMaintenanceReplyMarker,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { toGitHubRateLimitError } from '@/lib/integrations/platforms/github/adapter';
import {
  claimPrMaintenanceCall,
  completePrMaintenanceWrite,
  deferPrRefresh,
  PrMaintenanceDeferredError,
  recordPrMaintenanceApiCall,
} from '@/lib/integrations/platforms/github/pr-refresh-budget';
import { gitHubGraphQlAuthorSchema } from '@/lib/integrations/platforms/github/pr-maintenance-feedback';
import { isRateLimitGraphQlError } from '@/lib/integrations/platforms/github/pr-status';
import { assertWatchPrGitHubCall, watchPrGitHubClient } from './watch-pr-github-client';
import { watchPrRepository, type WatchPrAssessmentDeferred } from './watch-pr-assessment';
import { watchPrProjectionSchema } from './watch-pr-events';

const ledgerSchema = z.object({
  state: z.enum(['ready', 'posting', 'unknown', 'posted']),
  marker: z.string(),
  body: z.string(),
  commentId: z.string().nullable(),
  reconciliations: z.number().int().min(0).max(2),
  retryAt: z.string().datetime().optional(),
  retryReason: z.enum(['write_pacing', 'rate_limited', 'low_budget', 'unavailable']).optional(),
});
const graphResponseSchema = z.object({
  data: z.record(z.string(), z.unknown()).nullish(),
  errors: z.array(z.unknown()).optional(),
});
const commentsSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      fullDatabaseId: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
      databaseId: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
      body: z.string(),
      author: gitHubGraphQlAuthorSchema.nullable(),
    })
  ),
});
const rateSchema = z.object({
  cost: z.number(),
  limit: z.number(),
  remaining: z.number(),
  resetAt: z.string(),
});
type PublicationResult =
  | { status: 'completed' }
  | WatchPrAssessmentDeferred
  | { status: 'blocked'; reason: string };

function isGitHubAccessDenied(error: unknown) {
  const parsed = z.object({ status: z.number().int() }).safeParse(error);
  return parsed.success && [401, 403, 404].includes(parsed.data.status);
}

function parseGraphResponse(data: unknown, headers: unknown) {
  const parsed = graphResponseSchema.parse(data);
  if (parsed.errors?.some(isRateLimitGraphQlError)) {
    throw { status: 429, response: { headers } };
  }
  return parsed;
}

export function watchPrReplyBody(text: string, key: string) {
  const marker = `<!-- kilo-pr-maintenance-reply:${createHash('sha256').update(key).digest('hex')} -->`;
  return { marker, body: `${text.slice(0, 3800)}\n\n${watchPrMaintenanceReplyMarker}\n${marker}` };
}

async function recordReply(rows: CloudAgentPrFeedbackDisposition[], commentId: string) {
  const now = new Date().toISOString();
  await db
    .update(cloud_agent_pr_feedback_dispositions)
    .set({ reply_comment_id: commentId, replied_at: now, updated_at: now })
    .where(
      inArray(
        cloud_agent_pr_feedback_dispositions.id,
        rows.map(row => row.id)
      )
    );
}

async function reconcileReply(
  watch: CloudAgentPrWatch,
  threadId: string | null,
  marker: string,
  octokit: Awaited<ReturnType<typeof watchPrGitHubClient>>
) {
  const { owner, repo } = watchPrRepository(watch);
  const query = threadId
    ? `query { rateLimit {cost limit remaining resetAt} node(id:${JSON.stringify(threadId)}) { ...on PullRequestReviewThread { comments(last:100) { nodes {id fullDatabaseId body author {login __typename}} } } } }`
    : `query { rateLimit {cost limit remaining resetAt} repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { pullRequest(number:${watch.pr_number}) { comments(last:100) { nodes {id fullDatabaseId body author {login __typename}} } } } }`;
  await recordPrMaintenanceApiCall({
    appType: watch.github_app_type,
    installationId: watch.installation_id,
    endpoint: 'reconcile',
    reason: 'unknown_reply',
  });
  const response = await octokit.request('POST /graphql', { query });
  const parsed = parseGraphResponse(response.data, response.headers);
  const rate = rateSchema.safeParse(parsed.data?.rateLimit);
  await recordPrMaintenanceApiCall({
    appType: watch.github_app_type,
    installationId: watch.installation_id,
    endpoint: 'reconcile',
    reason: 'unknown_reply',
    headers: response.headers,
    calls: 0,
    graphqlCost: rate.success ? rate.data.cost : undefined,
    graphqlBudget: rate.success ? rate.data : undefined,
  });
  if (parsed.errors?.length) {
    throw new Error('GitHub reply reconciliation is unavailable');
  }
  const container = threadId
    ? z.object({ comments: commentsSchema }).safeParse(parsed.data?.node)
    : z
        .object({ repository: z.object({ pullRequest: z.object({ comments: commentsSchema }) }) })
        .transform(value => value.repository.pullRequest)
        .safeParse(parsed.data);
  if (!container.success)
    throw new Error('GitHub did not return comments for reply reconciliation');
  const found = container.data.comments.nodes.find(
    comment =>
      comment.author?.__typename === 'Bot' &&
      watchPrDefaultTrustedBotLogins.some(login => login === comment.author?.login.toLowerCase()) &&
      comment.body.includes(marker)
  );
  return found ? (found.fullDatabaseId ?? found.databaseId ?? found.id) : null;
}

async function publishReply(
  watch: CloudAgentPrWatch,
  attempt: Pick<CloudAgentPrMaintenanceAttempt, 'id' | 'generation'>,
  rows: CloudAgentPrFeedbackDisposition[]
): Promise<PublicationResult> {
  const first = rows[0];
  if (!first) return { status: 'completed' };
  await assertWatchPrGitHubCall(watch);
  const octokit = await watchPrGitHubClient(watch);
  await assertWatchPrGitHubCall(watch);
  const attemptId = attempt.id;
  const key = `${attemptId}:${first.thread_id ?? 'summary'}`;
  const deliveryId = `maintenance-reply:${createHash('sha256').update(key).digest('hex')}`;
  const reply = watchPrReplyBody(rows.map(row => row.reply_body ?? row.reason).join('\n\n'), key);
  const [existing] = await db
    .select()
    .from(cloud_agent_pr_watch_activity)
    .where(
      and(
        eq(cloud_agent_pr_watch_activity.watch_id, watch.id),
        eq(cloud_agent_pr_watch_activity.generation, attempt.generation),
        eq(cloud_agent_pr_watch_activity.delivery_id, deliveryId)
      )
    )
    .limit(1);
  const saved = existing ? ledgerSchema.safeParse(existing.data) : null;
  if (saved && !saved.success)
    return {
      status: 'blocked',
      reason: 'Saved GitHub reply state is invalid. Check the PR before posting another reply.',
    };
  if (existing && saved?.success && saved.data.state !== 'ready') {
    const ledger = saved.data;
    if (ledger.commentId) {
      await recordReply(rows, ledger.commentId);
      return { status: 'completed' };
    }
    if (Date.now() - Date.parse(existing.created_at) < 30_000)
      return {
        status: 'deferred',
        reason: 'write_pacing',
        retryAt: new Date(Date.parse(existing.created_at) + 30_000),
      };
    if (ledger.reconciliations >= 2)
      return {
        status: 'blocked',
        reason: 'The GitHub reply outcome is unknown. Recheck the PR before posting another reply.',
      };
    if (ledger.retryAt && Date.parse(ledger.retryAt) > Date.now())
      return {
        status: 'deferred',
        reason: ledger.retryReason ?? 'write_pacing',
        retryAt: new Date(ledger.retryAt),
      };
    const retryAt = new Date(Date.now() + 30_000);
    const [claimed] = await db
      .update(cloud_agent_pr_watch_activity)
      .set({
        data: {
          ...ledger,
          reconciliations: ledger.reconciliations + 1,
          retryAt: retryAt.toISOString(),
          retryReason: 'write_pacing',
        },
      })
      .where(
        and(
          eq(cloud_agent_pr_watch_activity.id, existing.id),
          sql`(${cloud_agent_pr_watch_activity.data}->>'reconciliations')::int = ${ledger.reconciliations}`
        )
      )
      .returning({ id: cloud_agent_pr_watch_activity.id });
    if (!claimed) return { status: 'deferred', reason: 'write_pacing', retryAt };
    let commentId: string | null;
    try {
      commentId = await reconcileReply(watch, first.thread_id, ledger.marker, octokit);
    } catch (error) {
      const limited = toGitHubRateLimitError(error);
      const accessDenied = isGitHubAccessDenied(error);
      if (limited || error instanceof PrMaintenanceDeferredError || accessDenied) {
        const retry = limited
          ? limited.resetAt.getTime() > Date.now()
            ? limited.resetAt
            : new Date(Date.now() + 60_000)
          : error instanceof PrMaintenanceDeferredError
            ? error.retryAt
            : new Date(Date.now() + 30_000);
        const retryReason = limited
          ? 'rate_limited'
          : error instanceof PrMaintenanceDeferredError
            ? error.reason
            : 'unavailable';
        await db
          .update(cloud_agent_pr_watch_activity)
          .set({
            data: {
              ...ledger,
              reconciliations: ledger.reconciliations,
              retryAt: retry.toISOString(),
              retryReason,
            },
          })
          .where(
            and(
              eq(cloud_agent_pr_watch_activity.id, existing.id),
              sql`(${cloud_agent_pr_watch_activity.data}->>'reconciliations')::int = ${ledger.reconciliations + 1}`
            )
          );
        if (limited) {
          await deferPrRefresh({
            appType: watch.github_app_type,
            installationId: watch.installation_id,
            resetAt: retry,
          });
          throw new PrMaintenanceDeferredError('rate_limited', retry);
        }
        if (accessDenied)
          return {
            status: 'blocked',
            reason:
              'GitHub reply reconciliation is unavailable. Restore PR access, then resume maintenance.',
          };
      }
      throw error;
    }
    if (commentId) {
      await db
        .update(cloud_agent_pr_watch_activity)
        .set({
          reason: 'reconciled',
          data: {
            ...ledger,
            state: 'posted',
            commentId,
            reconciliations: ledger.reconciliations + 1,
          },
        })
        .where(eq(cloud_agent_pr_watch_activity.id, existing.id));
      await recordReply(rows, commentId);
      return { status: 'completed' };
    }
    return ledger.reconciliations === 0
      ? { status: 'deferred', reason: 'write_pacing', retryAt }
      : {
          status: 'blocked',
          reason: 'The GitHub reply outcome is unknown. Check the PR before retrying publication.',
        };
  }
  const budget = await claimPrMaintenanceCall({
    appType: watch.github_app_type,
    installationId: watch.installation_id,
    write: true,
  });
  if (!budget.allowed)
    return { status: 'deferred', reason: budget.reason, retryAt: budget.retryAt };
  const data = { ...reply, state: 'posting', commentId: null, reconciliations: 0 };
  const [intent] = existing
    ? await db
        .update(cloud_agent_pr_watch_activity)
        .set({ data, reason: 'posting' })
        .where(
          and(
            eq(cloud_agent_pr_watch_activity.id, existing.id),
            sql`${cloud_agent_pr_watch_activity.data}->>'state' = 'ready'`
          )
        )
        .returning({ id: cloud_agent_pr_watch_activity.id })
    : await db
        .insert(cloud_agent_pr_watch_activity)
        .values({
          watch_id: watch.id,
          generation: attempt.generation,
          delivery_id: deliveryId,
          kind: 'reply',
          reason: 'posting',
          data: { ...reply, state: 'posting', commentId: null, reconciliations: 0 },
        })
        .onConflictDoNothing()
        .returning({ id: cloud_agent_pr_watch_activity.id });
  if (!intent)
    return { status: 'deferred', reason: 'write_pacing', retryAt: new Date(Date.now() + 30_000) };
  let commentId: string;
  let requestStarted = false;
  try {
    await assertWatchPrGitHubCall(watch);
    if (first.thread_id) {
      await recordPrMaintenanceApiCall({
        appType: watch.github_app_type,
        installationId: watch.installation_id,
        endpoint: 'reply',
        reason: 'review_thread',
      });
      requestStarted = true;
      const response = await octokit.request('POST /graphql', {
        query: `mutation { addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:${JSON.stringify(first.thread_id)},body:${JSON.stringify(reply.body)}}) { comment { id fullDatabaseId } } }`,
      });
      await recordPrMaintenanceApiCall({
        appType: watch.github_app_type,
        installationId: watch.installation_id,
        endpoint: 'reply',
        reason: 'review_thread',
        headers: response.headers,
        calls: 0,
      });
      parseGraphResponse(response.data, response.headers);
      const parsed = z
        .object({
          data: z.object({
            addPullRequestReviewThreadReply: z.object({
              comment: z.object({
                id: z.string(),
                fullDatabaseId: z.union([z.string(), z.number()]).transform(String).nullable(),
              }),
            }),
          }),
        })
        .parse(response.data);
      commentId =
        parsed.data.addPullRequestReviewThreadReply.comment.fullDatabaseId ??
        parsed.data.addPullRequestReviewThreadReply.comment.id;
    } else {
      await recordPrMaintenanceApiCall({
        appType: watch.github_app_type,
        installationId: watch.installation_id,
        endpoint: 'reply',
        reason: 'batch_summary',
      });
      requestStarted = true;
      const response = await octokit.issues.createComment({
        ...watchPrRepository(watch),
        issue_number: watch.pr_number,
        body: reply.body,
      });
      await recordPrMaintenanceApiCall({
        appType: watch.github_app_type,
        installationId: watch.installation_id,
        endpoint: 'reply',
        reason: 'batch_summary',
        headers: response.headers,
        calls: 0,
      });
      commentId = String(response.data.id);
    }
  } catch (error) {
    const state =
      !requestStarted || toGitHubRateLimitError(error) || isGitHubAccessDenied(error)
        ? 'ready'
        : 'unknown';
    await db
      .update(cloud_agent_pr_watch_activity)
      .set({ reason: state, data: { ...reply, state, commentId: null, reconciliations: 0 } })
      .where(eq(cloud_agent_pr_watch_activity.id, intent.id));
    throw error;
  } finally {
    if (budget.writeLease)
      await completePrMaintenanceWrite({
        appType: watch.github_app_type,
        installationId: watch.installation_id,
        writeLease: budget.writeLease,
      });
  }
  await db
    .update(cloud_agent_pr_watch_activity)
    .set({ reason: 'posted', data: { ...reply, state: 'posted', commentId, reconciliations: 0 } })
    .where(eq(cloud_agent_pr_watch_activity.id, intent.id));
  await recordReply(rows, commentId);
  return { status: 'completed' };
}

export async function publishWatchPrReplies(input: {
  watch: CloudAgentPrWatch;
  attemptId: string;
}): Promise<PublicationResult> {
  const { watch, attemptId } = input;
  if (
    watch.status !== 'watching' ||
    watch.policy.version !== 2 ||
    !watch.policy.automaticWritesConsent
  )
    return { status: 'completed' };
  try {
    const [attempt] = await db
      .select()
      .from(cloud_agent_pr_maintenance_attempts)
      .where(
        and(
          eq(cloud_agent_pr_maintenance_attempts.id, attemptId),
          eq(cloud_agent_pr_maintenance_attempts.watch_id, watch.id)
        )
      )
      .limit(1);
    if (!attempt?.result || attempt.status === 'stopped') return { status: 'completed' };
    if (attempt.generation > watch.generation)
      return { status: 'deferred', reason: 'unavailable', retryAt: new Date(Date.now() + 30_000) };
    if (
      attempt.input.repository.repoUrl !== watch.repo_url ||
      attempt.input.repository.prNumber !== watch.pr_number ||
      attempt.input.repository.headRef !== watch.head_ref
    )
      return {
        status: 'blocked',
        reason:
          'The saved repair belongs to a different PR identity. Recheck maintenance before posting replies.',
      };
    const dispositions = await db
      .select()
      .from(cloud_agent_pr_feedback_dispositions)
      .where(eq(cloud_agent_pr_feedback_dispositions.watch_id, watch.id))
      .limit(
        watchPrMaintenanceDefaults.maxTotalAttempts * watchPrMaintenanceDefaults.maxProblemsPerBatch
      );
    const rows = dispositions.filter(row => row.attempt_id === attemptId);
    const groups = new Map<string, CloudAgentPrFeedbackDisposition[]>();
    for (const row of rows) {
      if (row.replied_at || !row.reply_body) continue;
      const source = attempt.input.problems.find(problem => problem.problemKey === row.problem_key);
      if (source?.kind !== 'review') continue;
      const key = row.thread_id ?? 'summary';
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const group of groups.values()) {
      const published = await publishReply(watch, attempt, group);
      if (published.status !== 'completed') return published;
    }
    const resolvable = rows.filter(
      row =>
        row.thread_id &&
        row.resolution_status === 'open' &&
        ['addressed', 'already_addressed'].includes(row.disposition) &&
        attempt.result?.problems.some(
          problem =>
            problem.problemKey === row.problem_key &&
            problem.contentFingerprint === row.content_fingerprint &&
            problem.resolve
        ) &&
        attempt.result.verification.some(check => check.outcome === 'passed') &&
        (attempt.result.publication.status === 'published' ||
          row.disposition === 'already_addressed')
    );
    if (!resolvable.length) return { status: 'completed' };
    const projection = watchPrProjectionSchema.safeParse(watch.projection);
    if (!projection.success || projection.data.ambiguous || projection.data.truncated)
      return {
        status: 'blocked',
        reason: 'PR feedback is incomplete. Recheck the PR before resolving review threads.',
      };
    const ready = resolvable.filter(row => {
      const roots = new Set(
        attempt.input.problems.flatMap(problem =>
          problem.kind === 'review' && problem.threadId === row.thread_id
            ? [
                projection.data.evidence.find(item => item.key === problem.problemKey)?.rootId ??
                  problem.sourceId,
              ]
            : []
        )
      );
      return projection.data.evidence
        .filter(
          item =>
            item.kind === 'feedback' &&
            item.trusted &&
            !item.removed &&
            item.body?.trim() &&
            (item.threadId === row.thread_id || roots.has(item.rootId ?? item.sourceId ?? ''))
        )
        .every(item =>
          dispositions.some(
            disposition =>
              disposition.problem_key === item.key &&
              disposition.content_fingerprint === item.contentFingerprint &&
              ['addressed', 'already_addressed'].includes(disposition.disposition)
          )
        );
    });
    if (!ready.length) return { status: 'completed' };
    const publication = attempt.result.publication;
    if (
      publication.status === 'published' &&
      ![
        publication.pushedHeadSha,
        publication.observedHeadSha,
        attempt.input.repository.headSha,
      ].includes(watch.head_sha)
    ) {
      return {
        status: 'blocked',
        reason:
          'The PR head changed after verification. Recheck the PR before resolving review threads.',
      };
    }
    await assertWatchPrGitHubCall(watch);
    const octokit = await watchPrGitHubClient(watch);
    const budget = await claimPrMaintenanceCall({
      appType: watch.github_app_type,
      installationId: watch.installation_id,
      write: true,
    });
    if (!budget.allowed)
      return { status: 'deferred', reason: budget.reason, retryAt: budget.retryAt };
    const threads = [...new Set(ready.flatMap(row => (row.thread_id ? [row.thread_id] : [])))];
    const response = await Promise.resolve()
      .then(async () => {
        const current = await assertWatchPrGitHubCall(watch);
        if (current.pendingRevision !== watch.pending_revision)
          throw new PrMaintenanceDeferredError('unavailable', new Date(Date.now() + 30_000));
        await recordPrMaintenanceApiCall({
          appType: watch.github_app_type,
          installationId: watch.installation_id,
          endpoint: 'resolve',
          reason: 'verified_feedback',
        });
        return octokit.request('POST /graphql', {
          query: `mutation { ${threads.map((id, index) => `t${index}: resolveReviewThread(input:{threadId:${JSON.stringify(id)}}) { thread { id isResolved } }`).join('\n')} }`,
        });
      })
      .finally(async () => {
        if (budget.writeLease)
          await completePrMaintenanceWrite({
            appType: watch.github_app_type,
            installationId: watch.installation_id,
            writeLease: budget.writeLease,
          });
      });
    await recordPrMaintenanceApiCall({
      appType: watch.github_app_type,
      installationId: watch.installation_id,
      endpoint: 'resolve',
      reason: 'verified_feedback',
      headers: response.headers,
      calls: 0,
    });
    const parsed = parseGraphResponse(response.data, response.headers);
    const resolved = threads.filter((id, index) => {
      const alias = z
        .object({ thread: z.object({ id: z.string(), isResolved: z.literal(true) }) })
        .safeParse(parsed.data?.[`t${index}`]);
      return alias.success && alias.data.thread.id === id;
    });
    if (resolved.length)
      await db
        .update(cloud_agent_pr_feedback_dispositions)
        .set({
          resolution_status: 'resolved',
          resolved_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .where(
          inArray(
            cloud_agent_pr_feedback_dispositions.id,
            ready
              .filter(row => row.thread_id && resolved.includes(row.thread_id))
              .map(row => row.id)
          )
        );
    return resolved.length === threads.length
      ? { status: 'completed' }
      : {
          status: 'blocked',
          reason: 'Some review threads could not be resolved. Recheck their current GitHub state.',
        };
  } catch (error) {
    const limited = toGitHubRateLimitError(error);
    if (limited) {
      await deferPrRefresh({
        appType: watch.github_app_type,
        installationId: watch.installation_id,
        resetAt: limited.resetAt,
      });
      return { status: 'deferred', reason: 'rate_limited', retryAt: limited.resetAt };
    }
    if (error instanceof PrMaintenanceDeferredError)
      return { status: 'deferred', reason: error.reason, retryAt: error.retryAt };
    if (isGitHubAccessDenied(error))
      return {
        status: 'blocked',
        reason:
          'GitHub reply access is unavailable. Restore App and repository access, then resume maintenance.',
      };
    return { status: 'deferred', reason: 'unavailable', retryAt: new Date(Date.now() + 30_000) };
  }
}
