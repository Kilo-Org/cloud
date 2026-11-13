import 'server-only';
import { and, asc, eq, ne, isNotNull, lte, or, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  cli_sessions_v2,
  cloud_agent_pr_maintenance_attempts,
  cloud_agent_pr_watch_activity,
  cloud_agent_pr_watches,
  type CloudAgentPrMaintenanceAttempt,
  type CloudAgentPrWatch,
} from '@kilocode/db/schema';
import {
  hasWatchPrAutomaticWriteConsent,
  watchPrPolicySchema,
  watchPrMaintenanceDefaults,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  authorizeMaintenanceWatch,
  mintMaintenanceAuthorization,
  MaintenanceSettingsError,
  MaintenanceBalanceError,
} from './watch-pr-maintenance-authorization';
import {
  maintenanceChatStatus,
  startMaintenanceChat,
  stopMaintenanceChat,
} from './watch-pr-maintenance-client';
import {
  buildMaintenanceBrief,
  maintenanceStartAfter,
  verifiedMaintenanceResult,
  verifiedMaintenancePublication,
} from './watch-pr-maintenance-decisions';
import {
  finishMaintenanceAttempt,
  liveAttemptCondition,
  pauseMaintenance,
  reserveMaintenanceAttempt,
  selectWatchMaintenanceRepair,
  setMaintenanceDue,
  tagMaintenanceSession,
  recordMaintenanceRebase,
} from './watch-pr-maintenance-store';
import { assessWatchPr } from './watch-pr-assessment';
import { publishWatchPrReplies, prepareWatchPrProblems } from './watch-pr-github';
import { processWatchPrConflictBatch } from './watch-pr-conflicts';
import { watchPrProjectionSchema } from './watch-pr-events';
import {
  watchPrBatchSchedule,
  deriveWatchPrObservationExecutionStatus,
} from './watch-pr-observation';
import { PrMaintenanceDeferredError } from '@/lib/integrations/platforms/github/pr-refresh-budget';
import {
  normalizeMaintenanceDue,
  scheduleMaintenanceTimer,
} from './watch-pr-maintenance-scheduling';
import { finishExpiredLegacyWatches } from './watch-pr-legacy-expiry';
import {
  maintenanceExecutionReadiness,
  MaintenanceReadinessError,
} from './watch-pr-maintenance-readiness';
import { getMaintenanceRecoveryAction } from './watch-pr-maintenance-reasons';

const inThirtySeconds = () => new Date(Date.now() + 30_000).toISOString();
const elapsed = (dueAt: string | null) => dueAt !== null && Date.parse(dueAt) <= Date.now();
const owner = (watch: CloudAgentPrWatch) => ({
  userId: watch.kilo_user_id,
  organizationId: watch.organization_id ?? undefined,
});

function maintenanceBlockedReason(error: TRPCError) {
  if (error instanceof MaintenanceSettingsError) return error.maintenanceReason;
  if (error instanceof MaintenanceBalanceError) return error.maintenanceReason;
  if (error instanceof MaintenanceReadinessError) return error.maintenanceReason;
  return error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED'
    ? 'maintenance_access_unavailable'
    : 'maintenance_precondition_changed';
}

async function settleReplies(watch: CloudAgentPrWatch, attemptId: string) {
  const replies = await publishWatchPrReplies({ watch, attemptId });
  if (replies.status === 'deferred') {
    await setMaintenanceDue(watch, replies.retryAt.toISOString(), replies.reason);
    return false;
  }
  if (replies.status === 'blocked') {
    await pauseMaintenance(watch, 'maintenance_github_action_blocked');
    return false;
  }
  return true;
}

export async function assessAndScheduleWatchPr(
  watch: CloudAgentPrWatch,
  reason: 'enable' | 'recheck' = 'enable'
): Promise<CloudAgentPrWatch> {
  const current = await assessWatchPrMaintenance(watch, reason);
  if (current.next_run_at) await scheduleMaintenanceTimer(current.id, current.next_run_at);
  return current;
}

async function assessWatchPrMaintenance(
  watch: CloudAgentPrWatch,
  reason: 'enable' | 'recheck'
): Promise<CloudAgentPrWatch> {
  try {
    return await recordWatchPrAssessment(watch, reason);
  } catch (error) {
    const failures = await db.query.cloud_agent_pr_watch_activity.findMany({
      where: and(
        eq(cloud_agent_pr_watch_activity.watch_id, watch.id),
        eq(cloud_agent_pr_watch_activity.generation, watch.generation),
        eq(cloud_agent_pr_watch_activity.kind, 'assessment_retry')
      ),
      limit: 5,
    });
    if (
      error instanceof TRPCError &&
      ['FORBIDDEN', 'UNAUTHORIZED', 'PRECONDITION_FAILED', 'BAD_REQUEST'].includes(error.code)
    ) {
      const reason = maintenanceBlockedReason(error);
      await pauseMaintenance(watch, reason);
      await stopWatchPrAttempts({ ...watch, lifecycle_reason: reason });
    } else if (failures.length >= 5) {
      await pauseMaintenance(watch, 'pr_assessment_unavailable');
    } else {
      await db
        .update(cloud_agent_pr_watches)
        .set({
          last_assessed_at: null,
          next_run_at: watch.status === 'paused' ? null : inThirtySeconds(),
          lifecycle_reason:
            watch.status === 'paused' ? 'pr_assessment_unavailable' : 'pr_assessment_retry',
          updated_at: new Date().toISOString(),
        })
        .where(
          and(
            eq(cloud_agent_pr_watches.id, watch.id),
            eq(cloud_agent_pr_watches.generation, watch.generation)
          )
        );
      await db.insert(cloud_agent_pr_watch_activity).values({
        watch_id: watch.id,
        generation: watch.generation,
        kind: 'assessment_retry',
        reason: 'pr_assessment_unavailable',
      });
    }
    const current = await db.query.cloud_agent_pr_watches.findFirst({
      where: eq(cloud_agent_pr_watches.id, watch.id),
    });
    if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Watch no longer exists' });
    return current;
  }
}

async function recordWatchPrAssessment(
  watch: CloudAgentPrWatch,
  reason: 'enable' | 'recheck'
): Promise<CloudAgentPrWatch> {
  await authorizeMaintenanceWatch(watch);
  const assessment = await assessWatchPr(watch, reason);
  const active = await db.query.cloud_agent_pr_maintenance_attempts.findFirst({
    where: and(eq(cloud_agent_pr_maintenance_attempts.watch_id, watch.id), liveAttemptCondition),
  });
  const now = new Date().toISOString();
  const [updated] = await db
    .update(cloud_agent_pr_watches)
    .set(
      assessment.status === 'deferred'
        ? {
            next_run_at: watch.status === 'paused' ? null : assessment.retryAt.toISOString(),
            last_assessed_at: null,
            lifecycle_reason:
              watch.status === 'paused' ? 'pr_assessment_unavailable' : assessment.reason,
            updated_at: now,
          }
        : {
            head_sha: assessment.state.head_sha,
            base_sha: assessment.state.base_sha,
            head_ref: assessment.state.head_ref,
            base_ref: assessment.state.base_ref,
            status: assessment.state.status,
            generation: assessment.state.generation,
            lifecycle_reason: assessment.state.lifecycle_reason,
            projection: assessment.state.projection,
            pending_revision: assessment.state.pending_revision,
            ...watchPrBatchSchedule(watch, assessment.state, new Date(now)),
            execution_status:
              assessment.state.status !== 'watching'
                ? 'watching'
                : active?.status === 'needs_input'
                  ? 'needs_input'
                  : active
                    ? 'fixing'
                    : deriveWatchPrObservationExecutionStatus({ ...watch, ...assessment.state }),
            last_assessed_at: now,
            finished_at: assessment.state.status === 'finished' ? now : null,
            updated_at: now,
          }
    )
    .where(
      and(
        eq(cloud_agent_pr_watches.id, watch.id),
        eq(cloud_agent_pr_watches.generation, watch.generation),
        eq(cloud_agent_pr_watches.updated_at, watch.updated_at)
      )
    )
    .returning();
  let current =
    updated ??
    (await db.query.cloud_agent_pr_watches.findFirst({
      where: eq(cloud_agent_pr_watches.id, watch.id),
    }));
  if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Watch no longer exists' });
  if (updated)
    await db.insert(cloud_agent_pr_watch_activity).values({
      watch_id: watch.id,
      generation: updated.generation,
      kind: 'manual_recheck',
      reason: assessment.status === 'deferred' ? assessment.reason : 'current_pr_state',
    });
  if (current.status === 'finished') await stopWatchPrAttempts(current);
  if (
    assessment.status === 'assessed' &&
    reason === 'recheck' &&
    current.status === 'paused' &&
    getMaintenanceRecoveryAction(current.lifecycle_reason) === 'recheck_after_fix' &&
    current.policy.version === 2
  ) {
    await maintenanceExecutionReadiness(current, current.policy);
    const [ready] = await db
      .update(cloud_agent_pr_watches)
      .set({
        lifecycle_reason: 'ready_to_resume',
        execution_status: 'watching',
        updated_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(cloud_agent_pr_watches.id, current.id),
          eq(cloud_agent_pr_watches.generation, current.generation),
          eq(cloud_agent_pr_watches.status, 'paused')
        )
      )
      .returning();
    if (ready) current = ready;
  }
  return current;
}

export async function stopWatchPrAttempts(watch: CloudAgentPrWatch) {
  const attempts = await db.query.cloud_agent_pr_maintenance_attempts.findMany({
    where: and(eq(cloud_agent_pr_maintenance_attempts.watch_id, watch.id), liveAttemptCondition),
  });
  for (const attempt of attempts) {
    try {
      if (attempt.cloud_agent_session_id)
        await stopMaintenanceChat({
          ...owner(watch),
          cloudAgentSessionId: attempt.cloud_agent_session_id,
          messageId: attempt.message_id,
          watchId: watch.id,
          attemptId: attempt.id,
        });
      await db
        .update(cloud_agent_pr_maintenance_attempts)
        .set({
          status: 'stopped',
          reason: watch.lifecycle_reason ?? 'watch_invalidated',
          finished_at: new Date().toISOString(),
          next_run_at: null,
          updated_at: new Date().toISOString(),
        })
        .where(and(eq(cloud_agent_pr_maintenance_attempts.id, attempt.id), liveAttemptCondition));
    } catch {
      await db
        .update(cloud_agent_pr_maintenance_attempts)
        .set({
          reason: 'stop_delivery_pending',
          next_run_at: inThirtySeconds(),
          updated_at: new Date().toISOString(),
        })
        .where(eq(cloud_agent_pr_maintenance_attempts.id, attempt.id));
    }
  }
}

async function deliverAttempt(watch: CloudAgentPrWatch, attempt: CloudAgentPrMaintenanceAttempt) {
  if (!attempt.session_id || !attempt.cloud_agent_session_id) {
    await finishMaintenanceAttempt(watch, attempt, null, 'missing_stable_session_identity');
    await pauseMaintenance(watch, 'missing_stable_session_identity');
    return;
  }
  if (attempt.delivery_attempts >= watchPrMaintenanceDefaults.maxDeliveryAttempts) {
    await finishMaintenanceAttempt(watch, attempt, null, 'delivery_attempt_limit');
    await pauseMaintenance(watch, 'delivery_attempt_limit');
    return;
  }
  const now = new Date().toISOString();
  const [claimed] = await db
    .update(cloud_agent_pr_maintenance_attempts)
    .set({
      delivery_attempts: attempt.delivery_attempts + 1,
      last_delivery_at: now,
      next_run_at: inThirtySeconds(),
      updated_at: now,
    })
    .where(
      and(
        eq(cloud_agent_pr_maintenance_attempts.id, attempt.id),
        eq(cloud_agent_pr_maintenance_attempts.delivery_attempts, attempt.delivery_attempts),
        eq(cloud_agent_pr_maintenance_attempts.status, 'creating')
      )
    )
    .returning();
  if (!claimed) return;
  const authorization = await mintMaintenanceAuthorization(watch, attempt.cloud_agent_session_id);
  const current = await db.query.cloud_agent_pr_watches.findFirst({
    where: eq(cloud_agent_pr_watches.id, watch.id),
  });
  if (!current || current.status !== 'watching' || current.generation !== attempt.generation)
    return;
  const request = {
    ...owner(watch),
    ...authorization,
    worktreeId: watch.worktree_id,
    watchId: watch.id,
    attemptId: attempt.id,
    creationOperationKey: attempt.creation_operation_key,
    kiloSessionId: attempt.session_id,
    cloudAgentSessionId: attempt.cloud_agent_session_id,
    messageId: attempt.message_id,
    prompt: buildMaintenanceBrief(attempt.input),
    model: attempt.input.policy.model,
    allowRebase: attempt.input.policy.categories.conflicts,
    parentCommitSha: attempt.input.repository.parentCommitSha,
    recoverableAttemptIds: (
      await db.query.cloud_agent_pr_maintenance_attempts.findMany({
        where: and(
          eq(cloud_agent_pr_maintenance_attempts.watch_id, watch.id),
          ne(cloud_agent_pr_maintenance_attempts.id, attempt.id)
        ),
        columns: { id: true },
        limit: 10,
      })
    )
      .map(item => item.id)
      .sort(),
    ...(attempt.input.policy.variant ? { variant: attempt.input.policy.variant } : {}),
    profileId: attempt.input.policy.profileId,
    environmentId: attempt.input.policy.environmentId,
    publication: {
      repoUrl: attempt.input.repository.repoUrl,
      headRef: attempt.input.repository.headRef,
      baseRef: attempt.input.repository.baseRef,
      observedHeadSha: attempt.input.repository.headSha,
      baseSha: attempt.input.repository.baseSha,
    },
  };
  const compensateInvalidAdmission = async () => {
    const [currentWatch, currentAttempt] = await Promise.all([
      db.query.cloud_agent_pr_watches.findFirst({ where: eq(cloud_agent_pr_watches.id, watch.id) }),
      db.query.cloud_agent_pr_maintenance_attempts.findFirst({
        where: eq(cloud_agent_pr_maintenance_attempts.id, attempt.id),
      }),
    ]);
    if (
      currentWatch?.status === 'watching' &&
      currentWatch.generation === attempt.generation &&
      currentAttempt &&
      ['creating', 'running', 'needs_input'].includes(currentAttempt.status)
    )
      return false;
    await stopMaintenanceChat({
      ...owner(watch),
      cloudAgentSessionId: request.cloudAgentSessionId,
      messageId: attempt.message_id,
      watchId: watch.id,
      attemptId: attempt.id,
    });
    return true;
  };
  try {
    await startMaintenanceChat(request);
  } catch (error) {
    if (await compensateInvalidAdmission()) return;
    throw error;
  }
  if (await compensateInvalidAdmission()) return;
  await tagMaintenanceSession(watch, attempt);
  await db
    .update(cloud_agent_pr_maintenance_attempts)
    .set({ status: 'running', started_at: now, next_run_at: inThirtySeconds(), updated_at: now })
    .where(
      and(
        eq(cloud_agent_pr_maintenance_attempts.id, attempt.id),
        eq(cloud_agent_pr_maintenance_attempts.status, 'creating')
      )
    );
  await setMaintenanceDue(watch, inThirtySeconds(), null, 'fixing');
}

async function reconcileAttempt(watch: CloudAgentPrWatch, attempt: CloudAgentPrMaintenanceAttempt) {
  if (watch.status !== 'watching' || watch.generation !== attempt.generation) {
    await stopWatchPrAttempts(watch);
    return;
  }
  if (
    watch.repo_url !== attempt.input.repository.repoUrl ||
    watch.head_ref !== attempt.input.repository.headRef ||
    watch.base_ref !== attempt.input.repository.baseRef
  ) {
    await pauseMaintenance(watch, 'maintenance_pr_identity_changed');
    await stopWatchPrAttempts({ ...watch, lifecycle_reason: 'maintenance_pr_identity_changed' });
    return;
  }
  if (!attempt.cloud_agent_session_id) return deliverAttempt(watch, attempt);
  const state = await maintenanceChatStatus({
    ...owner(watch),
    cloudAgentSessionId: attempt.cloud_agent_session_id,
    messageId: attempt.message_id,
  });
  if (!state) {
    if (attempt.status === 'creating') await deliverAttempt(watch, attempt);
    else await pauseMaintenance(watch, 'maintenance_runtime_state_unavailable');
    return;
  }
  if (state.stoppedAt !== null) {
    await pauseMaintenance(watch, 'maintenance_chat_stopped');
    await stopWatchPrAttempts({ ...watch, lifecycle_reason: 'maintenance_chat_stopped' });
    return;
  }
  await authorizeMaintenanceWatch(watch);
  const publication = verifiedMaintenancePublication({
    snapshot: attempt.input,
    publication: state.publication,
    startedAt: attempt.started_at ?? attempt.created_at,
  });
  await recordMaintenanceRebase(watch, attempt, publication);
  if (state.lastPublished)
    await recordMaintenanceRebase(
      watch,
      attempt,
      verifiedMaintenancePublication({
        snapshot: attempt.input,
        publication: state.lastPublished.publication,
        startedAt: attempt.started_at ?? attempt.created_at,
      })
    );
  if (!state.message && !state.latestMessage && attempt.status === 'creating')
    return deliverAttempt(watch, attempt);
  const message = state.latestMessage ?? state.message;
  if (
    state.waitingForInput ||
    (message?.failureCode === 'sandbox_stopped' && attempt.status === 'needs_input')
  ) {
    await db
      .update(cloud_agent_pr_maintenance_attempts)
      .set({
        status: 'needs_input',
        needs_input_at: attempt.needs_input_at ?? new Date().toISOString(),
        next_run_at: inThirtySeconds(),
        updated_at: new Date().toISOString(),
      })
      .where(and(eq(cloud_agent_pr_maintenance_attempts.id, attempt.id), liveAttemptCondition));
    await setMaintenanceDue(watch, inThirtySeconds(), 'maintenance_question', 'needs_input');
    return;
  }
  if (message && ['completed', 'failed', 'interrupted', 'cancelled'].includes(message.status)) {
    const result = verifiedMaintenanceResult({
      snapshot: attempt.input,
      result: state.result,
      publication: state.publication,
      startedAt: attempt.started_at ?? attempt.created_at,
    });
    if (!result && publication.status === 'published') {
      await finishMaintenanceAttempt(
        watch,
        attempt,
        {
          version: 1,
          summary:
            'The runtime verified publication, but the agent did not provide a valid structured result.',
          changedFiles: [],
          verification: [],
          publication,
          problems: [],
          needsInput: null,
        },
        'maintenance_result_unavailable_after_publication'
      );
      await pauseMaintenance(watch, 'maintenance_result_unavailable_after_publication');
      return;
    }
    if (
      message.status === 'completed' &&
      result?.needsInput &&
      state.resultMessageId &&
      state.resultMessageId !== message.messageId
    ) {
      await finishMaintenanceAttempt(
        watch,
        attempt,
        {
          version: 1,
          summary:
            'The answer completed without an updated structured maintenance result. Review this chat before resuming automatic repairs.',
          changedFiles: [],
          verification: [],
          publication,
          problems: [],
          needsInput: null,
        },
        publication.status === 'published'
          ? 'maintenance_result_unavailable_after_publication'
          : 'maintenance_result_unavailable_after_answer'
      );
      return;
    }
    if (result?.needsInput) {
      await db
        .update(cloud_agent_pr_maintenance_attempts)
        .set({
          status: 'needs_input',
          result,
          needs_input_at: new Date().toISOString(),
          next_run_at: inThirtySeconds(),
          updated_at: new Date().toISOString(),
        })
        .where(and(eq(cloud_agent_pr_maintenance_attempts.id, attempt.id), liveAttemptCondition));
      await setMaintenanceDue(watch, inThirtySeconds(), 'maintenance_question', 'needs_input');
      return;
    }
    const completed = await finishMaintenanceAttempt(
      watch,
      attempt,
      result,
      result ? null : (message.failureCode ?? 'maintenance_result_unavailable')
    );
    if (result && completed) await settleReplies(watch, attempt.id);
    return;
  }
  if (
    Date.now() - Date.parse(attempt.created_at) > 24 * 60 * 60_000 &&
    attempt.status !== 'needs_input'
  ) {
    await pauseMaintenance(watch, 'maintenance_attempt_timeout');
    await stopWatchPrAttempts({ ...watch, lifecycle_reason: 'maintenance_attempt_timeout' });
    return;
  }
  await db
    .update(cloud_agent_pr_maintenance_attempts)
    .set({
      status: 'running',
      next_run_at: inThirtySeconds(),
      updated_at: new Date().toISOString(),
    })
    .where(and(eq(cloud_agent_pr_maintenance_attempts.id, attempt.id), liveAttemptCondition));
  await tagMaintenanceSession(watch, attempt);
  await setMaintenanceDue(watch, inThirtySeconds(), null, 'fixing');
}

async function dispatchWatch(
  watch: CloudAgentPrWatch,
  active: CloudAgentPrMaintenanceAttempt | undefined,
  installations: Set<string>
) {
  if (active) {
    if (
      watch.status === 'watching' &&
      watch.generation === active.generation &&
      active.next_run_at &&
      Date.parse(active.next_run_at) > Date.now()
    )
      return;
    return reconcileAttempt(watch, active);
  }
  const policy = watchPrPolicySchema.parse(watch.policy);
  if (watch.status !== 'watching' || !hasWatchPrAutomaticWriteConsent(policy)) return;
  if (watch.next_run_at && Date.parse(watch.next_run_at) > Date.now()) return;
  if (watch.last_attempt_id) {
    await authorizeMaintenanceWatch(watch);
    if (!(await settleReplies(watch, watch.last_attempt_id))) return;
  }
  const installation = `${watch.github_app_type}:${watch.installation_id}`;
  if (!installations.has(installation)) {
    installations.add(installation);
    await processWatchPrConflictBatch({
      appType: watch.github_app_type,
      installationId: watch.installation_id,
    });
    const current = await db.query.cloud_agent_pr_watches.findFirst({
      where: eq(cloud_agent_pr_watches.id, watch.id),
    });
    if (!current || current.status !== 'watching' || current.generation !== watch.generation)
      return;
    watch = current;
    if (watch.next_run_at && Date.parse(watch.next_run_at) > Date.now()) return;
  }
  if (!watch.last_assessed_at) {
    await assessWatchPrMaintenance(watch, 'enable');
    return;
  }
  const selected = await selectWatchMaintenanceRepair(watch, policy);
  if (!selected.problems.length) {
    const projection = watchPrProjectionSchema.parse(watch.projection);
    if (projection.conflict?.dueAt && Date.parse(projection.conflict.dueAt) > Date.now()) {
      await setMaintenanceDue(watch, projection.conflict.dueAt, 'conflict_state_pending');
      return;
    }
    if (
      projection.conflict?.state === 'UNKNOWN' &&
      projection.conflict.retries === 1 &&
      !projection.conflict.dueAt &&
      projection.needsAttention
    ) {
      await pauseMaintenance(watch, 'conflict_state_unknown');
      return;
    }
    if (projection.ambiguous || projection.truncated) {
      await pauseMaintenance(watch, 'pr_observation_incomplete');
      return;
    }
    const checksPending = projection.evidence.some(
      item =>
        (item.kind === 'check' || item.kind === 'status') &&
        item.sha === watch.head_sha &&
        !['completed', 'success', 'failure', 'error'].includes(item.state)
    );
    await db
      .update(cloud_agent_pr_watches)
      .set({
        next_run_at: null,
        pending_since: null,
        execution_status: checksPending ? 'waiting_for_checks' : 'watching',
        lifecycle_reason: selected.exhausted
          ? 'problem_attempt_limit'
          : projection.pending.some(item => item.reason === 'review_blocker')
            ? 'reviewer_approval_required'
            : null,
        updated_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(cloud_agent_pr_watches.id, watch.id),
          eq(cloud_agent_pr_watches.generation, watch.generation),
          eq(cloud_agent_pr_watches.pending_revision, watch.pending_revision)
        )
      );
    return;
  }
  if (!selected.startable) {
    await pauseMaintenance(watch, 'total_attempt_limit');
    return;
  }
  const sessions = await db.query.cli_sessions_v2.findMany({
    where: and(
      eq(cli_sessions_v2.cloud_agent_worktree_id, watch.worktree_id),
      eq(cli_sessions_v2.kilo_user_id, watch.kilo_user_id)
    ),
    columns: { chat_kind: true, status: true, status_updated_at: true },
  });
  const after = maintenanceStartAfter(sessions, policy.quietPeriodSeconds, Date.now());
  if (after) {
    await setMaintenanceDue(
      watch,
      new Date(after).toISOString(),
      'user_session_active',
      'waiting_for_session'
    );
    return;
  }
  const other = await db.query.cloud_agent_pr_maintenance_attempts.findFirst({
    where: and(
      eq(cloud_agent_pr_maintenance_attempts.worktree_id, watch.worktree_id),
      liveAttemptCondition
    ),
  });
  if (other) {
    await setMaintenanceDue(
      watch,
      inThirtySeconds(),
      'maintenance_session_active',
      'waiting_for_session'
    );
    return;
  }
  const { worktree, purpose, constraints } = await maintenanceExecutionReadiness(watch, policy);
  const problems = await prepareWatchPrProblems({ watch, problems: selected.problems });
  if (!problems.length) {
    const current = await db.query.cloud_agent_pr_watches.findFirst({
      where: eq(cloud_agent_pr_watches.id, watch.id),
    });
    if (
      current &&
      current.pending_revision === watch.pending_revision &&
      current.updated_at === watch.updated_at
    ) {
      await db
        .update(cloud_agent_pr_watches)
        .set({ next_run_at: null, pending_since: null })
        .where(
          and(
            eq(cloud_agent_pr_watches.id, watch.id),
            eq(cloud_agent_pr_watches.updated_at, watch.updated_at)
          )
        );
    }
    return;
  }
  const attempt = await reserveMaintenanceAttempt({
    watch,
    policy,
    problems,
    purpose,
    constraints,
    parentCommitSha: worktree.parent_worktree_id ? worktree.base_sha : null,
  });
  if (attempt?.status === 'creating') await deliverAttempt(watch, attempt);
  else if (attempt) await reconcileAttempt(watch, attempt);
}

export async function dispatchWatchPrMaintenance(
  input: { watchId?: string; limit?: number } = {}
): Promise<{ scheduled: { watchId: string; dueAt: string }[]; nextDueAt?: string }> {
  await finishExpiredLegacyWatches(input.watchId);
  const startedAt = Date.now();
  const limit = Math.min(input.limit ?? 20, 20);
  const liveWatch = sql`EXISTS (SELECT 1 FROM ${cloud_agent_pr_maintenance_attempts} WHERE ${cloud_agent_pr_maintenance_attempts.watch_id} = ${cloud_agent_pr_watches.id} AND ${liveAttemptCondition} AND (
    ${cloud_agent_pr_maintenance_attempts.next_run_at} IS NULL OR ${cloud_agent_pr_maintenance_attempts.next_run_at} <= now()
    OR ${cloud_agent_pr_watches.status} != 'watching' OR ${cloud_agent_pr_maintenance_attempts.generation} != ${cloud_agent_pr_watches.generation}
  ))`;
  const watches = await db
    .select()
    .from(cloud_agent_pr_watches)
    .where(
      and(
        input.watchId ? eq(cloud_agent_pr_watches.id, input.watchId) : undefined,
        or(
          and(
            eq(cloud_agent_pr_watches.status, 'watching'),
            isNotNull(cloud_agent_pr_watches.next_run_at),
            lte(cloud_agent_pr_watches.next_run_at, new Date().toISOString())
          ),
          liveWatch
        )
      )
    )
    .orderBy(
      sql`coalesce(${cloud_agent_pr_watches.next_run_at}, (SELECT min(${cloud_agent_pr_maintenance_attempts.next_run_at}) FROM ${cloud_agent_pr_maintenance_attempts} WHERE ${cloud_agent_pr_maintenance_attempts.watch_id} = ${cloud_agent_pr_watches.id} AND ${liveAttemptCondition}), ${cloud_agent_pr_watches.updated_at})`,
      asc(cloud_agent_pr_watches.id)
    )
    .limit(limit);
  const installations = new Set<string>();
  for (const watch of watches) {
    if (Date.now() - startedAt > 30_000) break;
    let consumedTimer = false;
    try {
      const [current, active] = await Promise.all([
        db.query.cloud_agent_pr_watches.findFirst({
          where: eq(cloud_agent_pr_watches.id, watch.id),
        }),
        db.query.cloud_agent_pr_maintenance_attempts.findFirst({
          where: and(
            eq(cloud_agent_pr_maintenance_attempts.watch_id, watch.id),
            liveAttemptCondition
          ),
        }),
      ]);
      if (current) {
        // Only the run that consumes the due timer schedules the next queue message.
        consumedTimer =
          elapsed(current.next_run_at) ||
          (active !== undefined && (active.next_run_at === null || elapsed(active.next_run_at)));
        await dispatchWatch(current, active, installations);
      }
    } catch (error) {
      if (error instanceof PrMaintenanceDeferredError) {
        await setMaintenanceDue(watch, error.retryAt.toISOString(), error.reason);
      } else if (
        error instanceof TRPCError &&
        ['FORBIDDEN', 'UNAUTHORIZED', 'PRECONDITION_FAILED', 'BAD_REQUEST'].includes(error.code)
      ) {
        const reason = maintenanceBlockedReason(error);
        await pauseMaintenance(watch, reason);
        await stopWatchPrAttempts({ ...watch, lifecycle_reason: reason });
      } else await setMaintenanceDue(watch, inThirtySeconds(), 'maintenance_delivery_retry');
    } finally {
      const nextRunAt = await normalizeMaintenanceDue(watch.id);
      if (consumedTimer && nextRunAt) await scheduleMaintenanceTimer(watch.id, nextRunAt);
    }
  }
  return { scheduled: [] };
}
