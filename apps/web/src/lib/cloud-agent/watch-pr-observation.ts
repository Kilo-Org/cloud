import {
  watchPrProblemSchema,
  type WatchPrProblem,
  type WatchPrExecutionStatus,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import {
  watchPrContentFingerprint,
  watchPrProjectionSchema,
  type WatchPrObservationState,
} from './watch-pr-events';

export function deriveWatchPrObservationExecutionStatus(
  watch: WatchPrObservationState & { execution_status?: WatchPrExecutionStatus }
): WatchPrExecutionStatus {
  if (watch.status !== 'watching') return 'watching';
  if (watch.lifecycle_reason === 'maintenance_verification_unavailable') return 'needs_input';
  const parsed = watchPrProjectionSchema.safeParse(watch.projection);
  if (!parsed.success) return 'needs_input';
  if (watch.execution_status === 'waiting_for_session' && collectWatchPrProblems(watch).length)
    return 'waiting_for_session';
  const waiting = parsed.data.evidence.some(
    item =>
      item.sha === watch.head_sha &&
      (item.kind === 'check'
        ? item.state !== 'completed' ||
          ![
            'success',
            'neutral',
            'skipped',
            'failure',
            'cancelled',
            'timed_out',
            'action_required',
            'stale',
            'startup_failure',
          ].includes(item.conclusion ?? '')
        : item.kind === 'status' && !['success', 'failure', 'error'].includes(item.state))
  );
  return waiting ? 'waiting_for_checks' : 'watching';
}

export function watchPrBatchSchedule(
  current: WatchPrObservationState & { pending_since?: string | null; next_run_at?: string | null },
  next: WatchPrObservationState,
  now: Date
): { pending_since: string | null; next_run_at: string | null } {
  const projection = watchPrProjectionSchema.parse(next.projection);
  if (next.status !== 'watching' || next.policy?.version !== 2)
    return { pending_since: null, next_run_at: null };
  const conflictDue = next.policy.categories.conflicts ? projection.conflict?.dueAt : null;
  const categories = next.policy.categories;
  const eligible = projection.pending.some(item =>
    ['actionable_review', 'review_blocker'].includes(item.reason)
      ? categories.reviews
      : ['failed_check', 'failed_status'].includes(item.reason)
        ? categories.failedChecks
        : item.reason === 'conflict' && categories.conflicts
  );
  if (!eligible && !projection.ambiguous && !projection.truncated && !projection.needsAttention)
    return { pending_since: null, next_run_at: conflictDue ?? null };
  if (current.pending_revision === next.pending_revision && current.next_run_at) {
    return {
      pending_since: current.pending_since
        ? new Date(current.pending_since).toISOString()
        : now.toISOString(),
      next_run_at: new Date(current.next_run_at).toISOString(),
    };
  }
  const pendingSince = current.pending_since ? new Date(current.pending_since) : now;
  const due = Math.min(
    now.getTime() + next.policy.batchDelaySeconds * 1000,
    pendingSince.getTime() + next.policy.maxBatchWaitSeconds * 1000
  );
  return {
    pending_since: pendingSince.toISOString(),
    next_run_at: new Date(conflictDue ? Math.min(due, Date.parse(conflictDue)) : due).toISOString(),
  };
}

export function collectWatchPrProblems(watch: WatchPrObservationState): WatchPrProblem[] {
  const policy = watch.policy;
  if (policy?.version !== 2) return [];
  const projection = watchPrProjectionSchema.parse(watch.projection);
  if (projection.ambiguous) return [];
  const problems: WatchPrProblem[] = [];
  for (const pending of projection.pending) {
    if (pending.reason === 'conflict') {
      if (
        policy.categories.conflicts &&
        projection.conflict?.state === 'CONFLICTING' &&
        projection.conflict.headSha === watch.head_sha &&
        projection.conflict.baseSha === watch.base_sha
      )
        problems.push(
          watchPrProblemSchema.parse({
            kind: 'conflict',
            problemKey: 'conflict',
            contentFingerprint: watchPrContentFingerprint(`${watch.head_sha}:${watch.base_sha}`),
            headSha: watch.head_sha,
            baseSha: watch.base_sha,
          })
        );
      continue;
    }
    const item = projection.evidence.find(item => item.key === pending.key);
    if (!item || item.removed) continue;
    if (item.kind === 'feedback') {
      if (
        !policy.categories.reviews ||
        !item.trusted ||
        !item.body?.trim() ||
        !item.actorLogin ||
        item.bodyTruncated
      )
        continue;
      const thread = projection.threads.find(
        thread =>
          thread.id === item.threadId || thread.rootIds.includes(item.rootId ?? item.sourceId ?? '')
      );
      if (thread?.resolved) continue;
      problems.push(
        watchPrProblemSchema.parse({
          kind: 'review',
          problemKey: item.key.slice(0, 200),
          contentFingerprint: item.contentFingerprint ?? watchPrContentFingerprint(item.body),
          source: item.source ?? (item.key.startsWith('review:') ? 'review' : 'review_comment'),
          sourceId: item.sourceId ?? item.key.split(':')[1],
          threadId: thread?.id ?? item.threadId ?? null,
          authorLogin: item.actorLogin,
          body: item.body,
          url: item.url ?? null,
          commitSha: item.source === 'conversation_comment' ? null : item.sha,
        })
      );
    } else if (
      policy.categories.failedChecks &&
      item.sha === watch.head_sha &&
      ['failed_check', 'failed_status'].includes(pending.reason)
    ) {
      problems.push(
        watchPrProblemSchema.parse({
          kind: 'failed_check',
          problemKey: `${item.kind}:${item.kind === 'check' ? `${item.key.split(':')[1]}:` : ''}${watchPrContentFingerprint(item.name ?? item.key.replace(/:[a-f0-9]{40}$/, '')).slice(0, 32)}`,
          contentFingerprint: watchPrContentFingerprint(
            `${item.sha}:${item.objectId}:${item.attempt}:${item.state}:${item.conclusion}`
          ),
          headSha: item.sha,
          checkId: item.objectId ?? item.key.slice(0, 200),
          name: (item.name ?? item.key).slice(0, 500),
          detailsUrl: item.detailsUrl ?? null,
          log: null,
          logUnavailableReason:
            item.kind === 'status'
              ? 'External CI logs are not available through GitHub Actions.'
              : null,
        })
      );
    }
  }
  const grouped = new Map<string, WatchPrProblem[]>();
  for (const problem of problems) {
    grouped.set(problem.problemKey, [...(grouped.get(problem.problemKey) ?? []), problem]);
  }
  return [...grouped.values()].flatMap(group => {
    const ordered = group.toSorted((left, right) =>
      left.contentFingerprint.localeCompare(right.contentFingerprint)
    );
    const first = ordered[0];
    if (!first) return [];
    if (first.kind !== 'failed_check' || ordered.length === 1) return [first];
    return [
      {
        ...first,
        contentFingerprint: watchPrContentFingerprint(
          ordered.map(problem => problem.contentFingerprint).join(':')
        ),
        logUnavailableReason: [
          first.logUnavailableReason,
          ...ordered
            .slice(1)
            .flatMap(problem =>
              problem.kind === 'failed_check'
                ? [
                    `Another failing job has this check name: ${problem.detailsUrl ?? problem.checkId}`,
                  ]
                : []
            ),
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 2000),
      },
    ];
  });
}
