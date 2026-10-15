import 'server-only';

import { and, eq, inArray, ne, or } from 'drizzle-orm';
import {
  cloud_agent_pr_watch_activity,
  cloud_agent_pr_watches,
  platform_integrations,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
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
import { replayWatchPrCiEvents, retainWatchPrCiEvent } from './watch-pr-ci-inbox';

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
    event.kind === 'pull_request' || event.kind === 'feedback'
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

  for (const candidate of candidates) {
    const { watch } = candidate;
    const ownerMatches = watch.organization_id
      ? candidate.organizationId === watch.organization_id && candidate.userId === null
      : candidate.userId === watch.kilo_user_id && candidate.organizationId === null;
    const repositoryAllowed =
      candidate.repositoryAccess === 'all' ||
      (candidate.repositoryAccess === 'selected' &&
        candidate.repositories?.some(repo => String(repo.id) === event.repositoryId));
    if (
      !ownerMatches ||
      !repositoryAllowed ||
      !(await isReleaseToggleEnabled('cloud-agent-watch-pr', watch.kilo_user_id))
    )
      continue;
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
    await db.transaction(async tx => {
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
      if (!current || !watchPrEventMatches(current, event)) return;
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
      if (receipt) return;
      const now = new Date().toISOString();
      const selfActorIds =
        input.appType === 'standard'
          ? [process.env.NODE_ENV === 'development' ? '242397087' : '240665456']
          : [];
      let next =
        new Date(current.expires_at).getTime() <= Date.now()
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
          : projectWatchPrEvent(current, event, current.generation, selfActorIds);
      if (next.status !== 'finished' && next.head_sha !== current.head_sha) {
        next = await replayWatchPrCiEvents(tx, current, next, input.appType);
      }
      await tx.insert(cloud_agent_pr_watch_activity).values({
        watch_id: current.id,
        generation: current.generation,
        delivery_id: input.deliveryId,
        kind: 'observation',
        reason:
          next.status === 'finished'
            ? next.lifecycle_reason
            : next === current
              ? 'unchanged'
              : 'projected',
        data: event,
      });
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
          last_event_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(cloud_agent_pr_watches.id, current.id),
            eq(cloud_agent_pr_watches.generation, current.generation)
          )
        );
    });
  }
}
