import 'server-only';

import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { cloud_agent_pr_watch_activity, type CloudAgentPrWatch } from '@kilocode/db/schema';
import {
  watchPrMaintenanceDefaults,
  type WatchPrProblem,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { toGitHubRateLimitError } from '@/lib/integrations/platforms/github/adapter';
import {
  deferPrRefresh,
  PrMaintenanceDeferredError,
  recordPrMaintenanceApiCall,
} from '@/lib/integrations/platforms/github/pr-refresh-budget';
import { watchPrRepository } from './watch-pr-assessment';
import { assertWatchPrGitHubCall, watchPrGitHubClient } from './watch-pr-github-client';
import { hydrateWatchPrFeedbackThreads } from './watch-pr-feedback-threads';
import { truncateWatchPrBody } from './watch-pr-events';

export { publishWatchPrReplies } from './watch-pr-replies';

export async function prepareWatchPrProblems(input: {
  watch: CloudAgentPrWatch;
  problems: readonly WatchPrProblem[];
}): Promise<WatchPrProblem[]> {
  const problems = await hydrateWatchPrFeedbackThreads(input);
  return readWatchPrFailingLogs({ watch: input.watch, problems });
}

const logRecordSchema = z.object({
  log: z.string().max(12_000).nullable(),
  reason: z.string().nullable(),
});
const logRateLimitSchema = z.object({
  state: z.literal('rate_limited'),
  retryAt: z.string().datetime(),
});

export function watchPrFailingJobId(
  watch: { repo_url: string },
  problem: WatchPrProblem
): number | null {
  if (problem.kind !== 'failed_check' || !problem.detailsUrl) return null;
  const { owner, repo } = watchPrRepository(watch);
  try {
    const url = new URL(problem.detailsUrl);
    if (url.origin !== 'https://github.com') return null;
    const match = /^\/([^/]+)\/([^/]+)\/actions\/runs\/\d+\/job\/(\d+)\/?$/.exec(url.pathname);
    if (!match || match[1]?.toLowerCase() !== owner || match[2]?.toLowerCase() !== repo)
      return null;
    const id = Number(match[3]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export async function readWatchPrFailingLogs(input: {
  watch: CloudAgentPrWatch;
  problems: readonly WatchPrProblem[];
}): Promise<WatchPrProblem[]> {
  const { watch } = input;
  const output: WatchPrProblem[] = [];
  let retainedLogs = 0;
  const read = new Map<number, { log: string | null; reason: string | null }>();
  for (const problem of input.problems) {
    if (problem.kind !== 'failed_check' || problem.headSha !== watch.head_sha) {
      output.push(problem);
      continue;
    }
    if (retainedLogs >= watchPrMaintenanceDefaults.maxLogJobs) {
      output.push({
        ...problem,
        log: null,
        logUnavailableReason: 'The three-job diagnostic limit was reached.',
      });
      continue;
    }
    if (problem.log !== null) {
      retainedLogs++;
      output.push({
        ...problem,
        log: truncateWatchPrBody(
          problem.log.slice(-watchPrMaintenanceDefaults.maxLogCharactersPerJob)
        ),
      });
      continue;
    }
    const jobId = watchPrFailingJobId(watch, problem);
    if (!jobId || (!read.has(jobId) && read.size >= watchPrMaintenanceDefaults.maxLogJobs)) {
      output.push({
        ...problem,
        logUnavailableReason: jobId
          ? 'The three-job diagnostic limit was reached.'
          : 'GitHub Actions job logs are not available for this check.',
      });
      continue;
    }
    let record = read.get(jobId);
    if (!record) {
      const deliveryId = `maintenance-log:${createHash('sha256').update(`${watch.generation}:${watch.pending_revision}:${jobId}:${watch.head_sha}`).digest('hex')}`;
      const [existing] = await db
        .select({ id: cloud_agent_pr_watch_activity.id, data: cloud_agent_pr_watch_activity.data })
        .from(cloud_agent_pr_watch_activity)
        .where(
          and(
            eq(cloud_agent_pr_watch_activity.watch_id, watch.id),
            eq(cloud_agent_pr_watch_activity.delivery_id, deliveryId)
          )
        )
        .limit(1);
      const cached = logRecordSchema.safeParse(existing?.data);
      const limitedRead = logRateLimitSchema.safeParse(existing?.data);
      if (limitedRead.success && Date.parse(limitedRead.data.retryAt) > Date.now()) {
        const retryAt = new Date(limitedRead.data.retryAt);
        await deferPrRefresh({
          appType: watch.github_app_type,
          installationId: watch.installation_id,
          resetAt: retryAt,
        });
        throw new PrMaintenanceDeferredError('rate_limited', retryAt);
      }
      if (existing && !limitedRead.success)
        record = cached.success
          ? cached.data
          : {
              log: null,
              reason: 'The prior job log read has an unknown outcome. It will not run twice.',
            };
      else {
        await assertWatchPrGitHubCall(watch);
        const [claimed] =
          existing && limitedRead.success
            ? await db
                .update(cloud_agent_pr_watch_activity)
                .set({ reason: 'reading', data: {} })
                .where(
                  and(
                    eq(cloud_agent_pr_watch_activity.id, existing.id),
                    sql`${cloud_agent_pr_watch_activity.data}->>'state' = 'rate_limited'`,
                    sql`${cloud_agent_pr_watch_activity.data}->>'retryAt' = ${limitedRead.data.retryAt}`
                  )
                )
                .returning({ id: cloud_agent_pr_watch_activity.id })
            : await db
                .insert(cloud_agent_pr_watch_activity)
                .values({
                  watch_id: watch.id,
                  generation: watch.generation,
                  delivery_id: deliveryId,
                  kind: 'job_log',
                  reason: 'reading',
                  data: {},
                })
                .onConflictDoNothing()
                .returning({ id: cloud_agent_pr_watch_activity.id });
        if (!claimed)
          throw new PrMaintenanceDeferredError('unavailable', new Date(Date.now() + 15_000));
        else {
          try {
            const octokit = await watchPrGitHubClient(watch);
            await recordPrMaintenanceApiCall({
              appType: watch.github_app_type,
              installationId: watch.installation_id,
              endpoint: 'job_logs',
              reason: 'current_head_failure',
            });
            const response = await octokit.actions.downloadJobLogsForWorkflowRun({
              ...watchPrRepository(watch),
              job_id: jobId,
            });
            await recordPrMaintenanceApiCall({
              appType: watch.github_app_type,
              installationId: watch.installation_id,
              endpoint: 'job_logs',
              reason: 'current_head_failure',
              headers: response.headers,
              calls: 0,
            });
            const log = typeof response.data === 'string' ? response.data : null;
            record = log
              ? {
                  log: truncateWatchPrBody(
                    log
                      .replaceAll('\u0000', '')
                      .slice(-watchPrMaintenanceDefaults.maxLogCharactersPerJob)
                  ),
                  reason: null,
                }
              : { log: null, reason: 'GitHub did not return text logs for this job.' };
          } catch (error) {
            const limited = toGitHubRateLimitError(error);
            if (limited) {
              const retryAt =
                limited.resetAt.getTime() > Date.now()
                  ? limited.resetAt
                  : new Date(Date.now() + 60_000);
              await deferPrRefresh({
                appType: watch.github_app_type,
                installationId: watch.installation_id,
                resetAt: retryAt,
              });
              await db
                .update(cloud_agent_pr_watch_activity)
                .set({
                  reason: 'rate_limited',
                  data: { state: 'rate_limited', retryAt: retryAt.toISOString() },
                })
                .where(eq(cloud_agent_pr_watch_activity.id, claimed.id));
              throw new PrMaintenanceDeferredError('rate_limited', retryAt);
            }
            record = {
              log: null,
              reason:
                'GitHub job logs are unavailable. Check Actions permissions, retention, or approval requirements.',
            };
          }
          await db
            .update(cloud_agent_pr_watch_activity)
            .set({ reason: record.log ? 'read' : 'unavailable', data: record })
            .where(eq(cloud_agent_pr_watch_activity.id, claimed.id));
        }
      }
      read.set(jobId, record);
    }
    if (record.log !== null) retainedLogs++;
    output.push({
      ...problem,
      log: record.log,
      logUnavailableReason:
        [problem.logUnavailableReason, record.reason].filter(Boolean).join('\n').slice(0, 2000) ||
        null,
    });
  }
  return output;
}
