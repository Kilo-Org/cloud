import 'server-only';

import { and, eq, inArray, ne, or } from 'drizzle-orm';
import {
  cloud_agent_pr_watch_activity,
  cloud_agent_pr_feedback_dispositions,
  cloud_agent_pr_maintenance_attempts,
  cloud_agent_pr_watches,
  platform_integrations,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  assertGitHubInstallationRuntimeAuthorized,
  GitHubRuntimeAuthorizationError,
} from '@/lib/integrations/github/runtime-authorization';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import {
  normalizeWatchPrEvent,
  projectWatchPrEvent,
  watchPrEventMatches,
  watchPrProjectionSchema,
} from './watch-pr-events';
import { isLegacyWatchExpired } from './watch-pr-legacy-expiry';
import {
  deriveWatchPrObservationExecutionStatus,
  watchPrBatchSchedule,
} from './watch-pr-observation';
import { watchPrLiveAttemptStatuses } from '@kilocode/db/cloud-agent-pr-maintenance';
import { runAfterResponse } from '@/lib/after-response';
import { replayWatchPrCiEvents, retainWatchPrCiEvent } from './watch-pr-ci-inbox';
import { scheduleMaintenanceTimer } from './watch-pr-maintenance-scheduling';

export async function observeWatchPrWebhook(input: {
  eventType: string;
  payload: unknown;
  deliveryId: string;
  appType: GitHubAppType;
}): Promise<void> {
  const event = normalizeWatchPrEvent(input.eventType, input.payload);
  if (!event) return;
  if (event.kind === 'check' || event.kind === 'status') {
    await retainWatchPrCiEvent({ event, deliveryId: input.deliveryId, appType: input.appType });
  }
  const target =
    event.kind === 'pull_request' || event.kind === 'feedback' || event.kind === 'thread'
      ? eq(cloud_agent_pr_watches.pr_number, event.prNumber)
      : event.kind === 'push'
        ? or(
            eq(cloud_agent_pr_watches.head_ref, event.ref),
            eq(cloud_agent_pr_watches.base_ref, event.ref)
          )
        : event.kind === 'check' && event.prNumbers.length > 0
          ? or(
              eq(cloud_agent_pr_watches.head_sha, event.sha),
              inArray(cloud_agent_pr_watches.pr_number, event.prNumbers)
            )
          : eq(cloud_agent_pr_watches.head_sha, event.sha);
  const candidates = await db
    .select({
      watch: cloud_agent_pr_watches,
      userId: platform_integrations.owned_by_user_id,
      organizationId: platform_integrations.owned_by_organization_id,
      repositoryAccess: platform_integrations.repository_access,
      repositories: platform_integrations.repositories,
    })
    .from(cloud_agent_pr_watches)
    .innerJoin(
      platform_integrations,
      eq(platform_integrations.id, cloud_agent_pr_watches.integration_id)
    )
    .where(
      and(
        eq(cloud_agent_pr_watches.installation_id, event.installationId),
        eq(cloud_agent_pr_watches.github_app_type, input.appType),
        eq(cloud_agent_pr_watches.repository_id, event.repositoryId),
        ne(cloud_agent_pr_watches.status, 'finished'),
        target
      )
    );

  const timers: { watchId: string; dueAt: string }[] = [];
  for (const candidate of candidates) {
    const { watch } = candidate;
    const ownerMatches = watch.organization_id
      ? candidate.organizationId === watch.organization_id && candidate.userId === null
      : candidate.userId === watch.kilo_user_id && candidate.organizationId === null;
    const repositoryAllowed =
      candidate.repositoryAccess === 'all' ||
      (candidate.repositoryAccess === 'selected' &&
        candidate.repositories?.some(repo => String(repo.id) === event.repositoryId));
    if (!ownerMatches || !repositoryAllowed) continue;
    try {
      await assertGitHubInstallationRuntimeAuthorized(
        event.installationId,
        input.appType,
        watch.integration_id,
        'agent'
      );
    } catch (error) {
      if (error instanceof GitHubRuntimeAuthorizationError) continue;
      throw error;
    }
    const dueAt = await db.transaction(async tx => {
      const [current] = await tx
        .select()
        .from(cloud_agent_pr_watches)
        .where(
          and(
            eq(cloud_agent_pr_watches.id, watch.id),
            ne(cloud_agent_pr_watches.status, 'finished')
          )
        )
        .for('update');
      if (!current || !watchPrEventMatches(current, event)) return null;
      const [receipt] = await tx
        .select({ id: cloud_agent_pr_watch_activity.id })
        .from(cloud_agent_pr_watch_activity)
        .where(
          and(
            eq(cloud_agent_pr_watch_activity.watch_id, current.id),
            eq(cloud_agent_pr_watch_activity.delivery_id, input.deliveryId)
          )
        )
        .limit(1);
      const expired = isLegacyWatchExpired(current);
      if (receipt && !expired) return null;
      const now = new Date().toISOString();
      const replies =
        !expired && event.kind === 'feedback'
          ? await tx
              .select({
                commentId: cloud_agent_pr_feedback_dispositions.reply_comment_id,
                threadId: cloud_agent_pr_feedback_dispositions.thread_id,
              })
              .from(cloud_agent_pr_feedback_dispositions)
              .where(eq(cloud_agent_pr_feedback_dispositions.watch_id, current.id))
          : [];
      let next = expired
        ? {
            ...current,
            status: 'finished' as const,
            generation: current.generation + 1,
            lifecycle_reason: 'expired',
            projection: {
              ...watchPrProjectionSchema.parse(current.projection),
              pending: [],
              needsAttention: false,
            },
          }
        : projectWatchPrEvent(
            current,
            event,
            current.generation,
            [],
            replies.flatMap(reply =>
              reply.commentId
                ? [`${reply.threadId ? 'comment' : 'issue_comment'}:${reply.commentId}`]
                : []
            )
          );
      if (next.status !== 'finished' && next.head_sha !== current.head_sha) {
        next = await replayWatchPrCiEvents(tx, current, next, input.appType);
      }
      const [liveAttempt] = await tx
        .select({ id: cloud_agent_pr_maintenance_attempts.id })
        .from(cloud_agent_pr_maintenance_attempts)
        .where(
          and(
            eq(cloud_agent_pr_maintenance_attempts.watch_id, current.id),
            eq(cloud_agent_pr_maintenance_attempts.generation, next.generation),
            inArray(cloud_agent_pr_maintenance_attempts.status, [...watchPrLiveAttemptStatuses])
          )
        )
        .limit(1);
      await tx.insert(cloud_agent_pr_watch_activity).values({
        watch_id: current.id,
        generation: next.generation,
        delivery_id: input.deliveryId,
        kind: expired ? 'finished' : 'observation',
        reason:
          next.status === 'finished'
            ? next.lifecycle_reason
            : next === current
              ? 'unchanged'
              : 'projected',
        data: expired ? null : event,
      });
      const schedule = watchPrBatchSchedule(current, next, new Date(now));
      await tx
        .update(cloud_agent_pr_watches)
        .set({
          head_ref: next.head_ref,
          base_ref: next.base_ref,
          head_sha: next.head_sha,
          base_sha: next.base_sha,
          status: next.status,
          generation: next.generation,
          lifecycle_reason: next.lifecycle_reason,
          pending_revision: next.pending_revision,
          projection: next.projection,
          execution_status:
            next.status === 'watching' && liveAttempt
              ? current.execution_status
              : deriveWatchPrObservationExecutionStatus({
                  ...next,
                  execution_status: current.execution_status,
                }),
          ...schedule,
          ...(next.status === 'finished' ? { finished_at: now } : {}),
          last_event_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(cloud_agent_pr_watches.id, current.id),
            eq(cloud_agent_pr_watches.generation, current.generation)
          )
        );
      const timerChanged =
        schedule.next_run_at !== null &&
        (current.next_run_at === null ||
          Date.parse(current.next_run_at) !== Date.parse(schedule.next_run_at));
      return timerChanged && !liveAttempt ? schedule.next_run_at : null;
    });
    if (dueAt) timers.push({ watchId: watch.id, dueAt });
  }
  if (timers.length)
    await runAfterResponse(async () => {
      await Promise.all(timers.map(timer => scheduleMaintenanceTimer(timer.watchId, timer.dueAt)));
    });
}
