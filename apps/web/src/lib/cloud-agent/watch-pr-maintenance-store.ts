import 'server-only';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildMessageId } from '@kilocode/session-ingest-contracts';
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import {
  cli_sessions_v2,
  cloud_agent_pr_feedback_dispositions,
  cloud_agent_pr_maintenance_attempts,
  cloud_agent_pr_watch_activity,
  cloud_agent_pr_watches,
  cloud_agent_worktrees,
  type CloudAgentPrMaintenanceAttempt,
  type CloudAgentPrWatch,
} from '@kilocode/db/schema';
import {
  watchPrLiveAttemptStatuses,
  type WatchPrMaintenancePolicy,
  type WatchPrMaintenanceResult,
  type WatchPrProblem,
  type WatchPrPublicationEvidence,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  boundedMaintenanceInput,
  maintenanceStartAfter,
  maintenanceProblemIdentity,
  selectMaintenanceProblems,
} from './watch-pr-maintenance-decisions';
import { collectWatchPrProblems } from './watch-pr-observation';

export const liveAttemptCondition = inArray(cloud_agent_pr_maintenance_attempts.status, [
  ...watchPrLiveAttemptStatuses,
]);

export function watchMaintenanceHistory(watchId: string) {
  return Promise.all([
    db.query.cloud_agent_pr_maintenance_attempts.findMany({
      where: eq(cloud_agent_pr_maintenance_attempts.watch_id, watchId),
      orderBy: desc(cloud_agent_pr_maintenance_attempts.ordinal),
      limit: 10,
    }),
    db.query.cloud_agent_pr_feedback_dispositions.findMany({
      where: eq(cloud_agent_pr_feedback_dispositions.watch_id, watchId),
      orderBy: desc(cloud_agent_pr_feedback_dispositions.updated_at),
      limit: 500,
    }),
  ]);
}

export async function selectWatchMaintenanceRepair(
  watch: CloudAgentPrWatch,
  policy: WatchPrMaintenancePolicy
) {
  const problems = collectWatchPrProblems(watch);
  const [attempts, dispositions] = problems.length
    ? await watchMaintenanceHistory(watch.id)
    : [[], []];
  const selection = selectMaintenanceProblems({
    problems,
    policy,
    headSha: watch.head_sha,
    attempts,
    dispositions,
  });
  return {
    ...selection,
    startable: selection.problems.length > 0 && watch.total_attempts < policy.maxTotalAttempts,
  };
}

export async function reserveMaintenanceAttempt(input: {
  watch: CloudAgentPrWatch;
  policy: WatchPrMaintenancePolicy;
  problems: WatchPrProblem[];
  purpose: string;
  constraints: string[];
  parentCommitSha: string | null;
}) {
  return db.transaction(async tx => {
    const [current] = await tx
      .select()
      .from(cloud_agent_pr_watches)
      .where(eq(cloud_agent_pr_watches.id, input.watch.id))
      .for('update');
    if (
      !current ||
      current.status !== 'watching' ||
      current.generation !== input.watch.generation ||
      current.pending_revision !== input.watch.pending_revision ||
      current.updated_at !== input.watch.updated_at
    )
      return null;
    const sessions = await tx.query.cli_sessions_v2.findMany({
      where: and(
        eq(cli_sessions_v2.cloud_agent_worktree_id, current.worktree_id),
        eq(cli_sessions_v2.kilo_user_id, current.kilo_user_id)
      ),
      columns: { chat_kind: true, status: true, status_updated_at: true },
    });
    const startAfter = maintenanceStartAfter(sessions, input.policy.quietPeriodSeconds, Date.now());
    if (startAfter) {
      await tx
        .update(cloud_agent_pr_watches)
        .set({
          execution_status: 'waiting_for_session',
          lifecycle_reason: 'user_session_active',
          next_run_at: new Date(startAfter).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .where(eq(cloud_agent_pr_watches.id, current.id));
      return null;
    }
    const live = await tx.query.cloud_agent_pr_maintenance_attempts.findFirst({
      where: and(
        eq(cloud_agent_pr_maintenance_attempts.worktree_id, current.worktree_id),
        liveAttemptCondition
      ),
    });
    if (live) return live.watch_id === current.id ? live : null;
    const attempts = await tx.query.cloud_agent_pr_maintenance_attempts.findMany({
      where: eq(cloud_agent_pr_maintenance_attempts.watch_id, current.id),
      orderBy: desc(cloud_agent_pr_maintenance_attempts.ordinal),
      limit: 10,
    });
    const dispositions = await tx.query.cloud_agent_pr_feedback_dispositions.findMany({
      where: eq(cloud_agent_pr_feedback_dispositions.watch_id, current.id),
      orderBy: desc(cloud_agent_pr_feedback_dispositions.updated_at),
      limit: 500,
    });
    const selection = selectMaintenanceProblems({
      ...input,
      headSha: current.head_sha,
      attempts,
      dispositions,
    });
    if (current.total_attempts >= input.policy.maxTotalAttempts) {
      await tx
        .update(cloud_agent_pr_watches)
        .set({
          status: 'paused',
          lifecycle_reason: 'total_attempt_limit',
          generation: current.generation + 1,
          next_run_at: null,
          updated_at: new Date().toISOString(),
        })
        .where(eq(cloud_agent_pr_watches.id, current.id));
      return null;
    }
    if (!selection.problems.length) {
      await tx
        .update(cloud_agent_pr_watches)
        .set({
          next_run_at: null,
          lifecycle_reason: selection.exhausted ? 'problem_attempt_limit' : null,
          updated_at: new Date().toISOString(),
        })
        .where(eq(cloud_agent_pr_watches.id, current.id));
      return null;
    }
    let revision = current.pending_revision;
    while (
      attempts.some(
        attempt =>
          attempt.generation === current.generation && attempt.pending_revision === revision
      )
    )
      revision++;
    const snapshot = boundedMaintenanceInput({
      version: 1,
      purpose: input.purpose.slice(0, 8_000),
      constraints: input.constraints.slice(0, 20).map(value => value.slice(0, 2_000)),
      repository: {
        repositoryId: current.repository_id,
        repoUrl: current.repo_url,
        prNumber: current.pr_number,
        headRef: current.head_ref,
        baseRef: current.base_ref,
        headSha: current.head_sha,
        baseSha: current.base_sha,
        parentCommitSha: input.parentCommitSha,
      },
      policy: input.policy,
      ordinal: current.total_attempts + 1,
      problems: selection.problems,
      problemAttempts: selection.problems.map(problem => ({
        problemKey: problem.problemKey,
        attempts: selection.counts.get(maintenanceProblemIdentity(problem)) ?? 0,
      })),
      priorDispositions: dispositions
        .filter(item => selection.problems.some(problem => problem.problemKey === item.problem_key))
        .slice(0, 50)
        .map(item => ({
          problemKey: item.problem_key,
          contentFingerprint: item.content_fingerprint,
          disposition: item.disposition,
          reason: item.reason,
          evidence: item.evidence,
          threadId: item.thread_id,
          reply: item.reply_body,
          resolve: item.resolution_status === 'resolved',
        })),
      previousResults: attempts.flatMap(attempt =>
        attempt.result
          ? [
              {
                attemptId: attempt.id,
                summary: attempt.result.summary.slice(0, 4_000),
                verification: attempt.result.verification,
                publication: attempt.result.publication,
              },
            ]
          : []
      ),
      verificationCommands: [
        ...new Set(
          attempts.flatMap(
            attempt =>
              attempt.result?.verification
                .filter(check => check.outcome === 'passed')
                .map(check => check.command) ?? []
          )
        ),
      ].slice(0, 20),
      references: [`${current.repo_url}/pull/${current.pr_number}`],
    });
    const now = new Date().toISOString();
    const [attempt] = await tx
      .insert(cloud_agent_pr_maintenance_attempts)
      .values({
        watch_id: current.id,
        worktree_id: current.worktree_id,
        generation: current.generation,
        pending_revision: revision,
        ordinal: snapshot.ordinal,
        creation_operation_key: randomUUID(),
        message_id: buildMessageId(Date.now(), randomBytes(14)),
        session_id: `ses_${randomUUID().replaceAll('-', '').slice(0, 26)}`,
        cloud_agent_session_id: `workspace_${randomUUID()}`,
        input: snapshot,
        next_run_at: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!attempt) return null;
    await tx
      .update(cloud_agent_pr_watches)
      .set({
        total_attempts: snapshot.ordinal,
        last_attempt_id: attempt.id,
        pending_revision: revision,
        execution_status: 'fixing',
        lifecycle_reason: null,
        pending_since: null,
        next_run_at: now,
        updated_at: now,
      })
      .where(eq(cloud_agent_pr_watches.id, current.id));
    await tx.insert(cloud_agent_pr_watch_activity).values({
      watch_id: current.id,
      generation: current.generation,
      kind: 'repair_queued',
      reason: 'maintenance_batch',
      data: {
        attemptId: attempt.id,
        ordinal: snapshot.ordinal,
        problems: snapshot.problems.map(problem => problem.problemKey),
      },
    });
    return attempt;
  });
}

export async function finishMaintenanceAttempt(
  watch: CloudAgentPrWatch,
  attempt: CloudAgentPrMaintenanceAttempt,
  result: WatchPrMaintenanceResult | null,
  reason: string | null
) {
  return db.transaction(async tx => {
    const [current] = await tx
      .select()
      .from(cloud_agent_pr_watches)
      .where(eq(cloud_agent_pr_watches.id, watch.id))
      .for('update');
    if (!current) return false;
    const now = new Date().toISOString();
    const missingStructuredResult =
      reason === 'maintenance_result_unavailable_after_publication' ||
      reason === 'maintenance_result_unavailable_after_answer';
    if (current.status !== 'watching' || current.generation !== attempt.generation) {
      await tx
        .update(cloud_agent_pr_maintenance_attempts)
        .set({
          status: 'stopped',
          reason: 'watch_invalidated',
          finished_at: now,
          next_run_at: null,
          updated_at: now,
        })
        .where(and(eq(cloud_agent_pr_maintenance_attempts.id, attempt.id), liveAttemptCondition));
      return false;
    }
    const [finished] = await tx
      .update(cloud_agent_pr_maintenance_attempts)
      .set({
        status: result && !missingStructuredResult ? 'completed' : 'failed',
        result,
        reason,
        finished_at: now,
        next_run_at: null,
        updated_at: now,
      })
      .where(and(eq(cloud_agent_pr_maintenance_attempts.id, attempt.id), liveAttemptCondition))
      .returning();
    if (!finished) return false;
    const publicationBlocked =
      result &&
      (result.publication.status === 'unknown' ||
        result.publication.status === 'failed' ||
        (result.changedFiles.length > 0 && result.publication.status !== 'published'));
    const verificationBlocked =
      result?.verification.some(check => check.outcome === 'failed') ?? false;
    if (result) {
      for (const problem of result.problems) {
        if (
          publicationBlocked &&
          problem.reason === 'The repair has no verified publication and passing verification'
        )
          continue;
        await tx
          .insert(cloud_agent_pr_feedback_dispositions)
          .values({
            watch_id: current.id,
            attempt_id: attempt.id,
            problem_key: problem.problemKey,
            content_fingerprint: problem.contentFingerprint,
            disposition: problem.disposition,
            reason: problem.reason,
            evidence: problem.evidence,
            thread_id: problem.threadId,
            reply_body: problem.reply,
            resolution_status: problem.threadId ? 'open' : 'not_applicable',
          })
          .onConflictDoUpdate({
            target: [
              cloud_agent_pr_feedback_dispositions.watch_id,
              cloud_agent_pr_feedback_dispositions.problem_key,
              cloud_agent_pr_feedback_dispositions.content_fingerprint,
            ],
            set: {
              attempt_id: attempt.id,
              disposition: problem.disposition,
              reason: problem.reason,
              evidence: problem.evidence,
              thread_id: problem.threadId,
              reply_body: problem.reply,
              reply_comment_id: sql`CASE WHEN ${cloud_agent_pr_feedback_dispositions.reply_body} IS NOT DISTINCT FROM ${problem.reply} AND ${cloud_agent_pr_feedback_dispositions.thread_id} IS NOT DISTINCT FROM ${problem.threadId} THEN ${cloud_agent_pr_feedback_dispositions.reply_comment_id} ELSE NULL END`,
              replied_at: sql`CASE WHEN ${cloud_agent_pr_feedback_dispositions.reply_body} IS NOT DISTINCT FROM ${problem.reply} AND ${cloud_agent_pr_feedback_dispositions.thread_id} IS NOT DISTINCT FROM ${problem.threadId} THEN ${cloud_agent_pr_feedback_dispositions.replied_at} ELSE NULL END`,
              resolution_status: problem.threadId ? 'open' : 'not_applicable',
              resolved_at: null,
              updated_at: now,
            },
          });
      }
    }
    const stillEnabled = current.status === 'watching' && current.generation === attempt.generation;
    const newerEvents =
      !current.last_assessed_at ||
      current.pending_revision > attempt.pending_revision ||
      collectWatchPrProblems(current).some(
        problem =>
          !attempt.input.problems.some(
            previous =>
              previous.problemKey === problem.problemKey &&
              previous.contentFingerprint === problem.contentFingerprint
          )
      );
    const incomplete =
      !result ||
      result.problems.length < attempt.input.problems.length ||
      result.publication.status === 'unknown' ||
      result.publication.status === 'failed';
    const deferredConflict =
      result?.problems.some(
        problem =>
          problem.disposition === 'deferred' &&
          attempt.input.problems.some(
            source =>
              source.kind === 'conflict' &&
              source.problemKey === problem.problemKey &&
              source.contentFingerprint === problem.contentFingerprint
          )
      ) ?? false;
    const leaseFailure =
      result?.publication.status === 'failed' &&
      result.publication.reason === 'maintenance_exact_lease_push_failed_fetch_and_reassess';
    const publicationPause = publicationBlocked && !leaseFailure;
    const verificationIncomplete =
      result?.publication.status === 'published' &&
      !result.verification.some(check => check.outcome === 'passed');
    await tx
      .update(cloud_agent_pr_watches)
      .set({
        execution_status: missingStructuredResult
          ? 'watching'
          : verificationIncomplete
            ? 'needs_input'
            : result?.publication.status === 'published'
              ? 'waiting_for_checks'
              : 'watching',
        lifecycle_reason: missingStructuredResult
          ? reason
          : leaseFailure
            ? 'remote_head_changed_reassessing'
            : publicationPause
              ? 'publication_unverified'
              : verificationBlocked
                ? 'maintenance_verification_failed'
                : verificationIncomplete
                  ? 'maintenance_verification_unavailable'
                  : deferredConflict
                    ? 'waiting_for_clean_checkout'
                    : reason,
        ...(stillEnabled && (publicationPause || verificationBlocked || missingStructuredResult)
          ? { status: 'paused', generation: current.generation + 1 }
          : {}),
        ...(leaseFailure ? { last_assessed_at: null } : {}),
        ...(stillEnabled && (incomplete || newerEvents || deferredConflict)
          ? { pending_revision: Math.max(current.pending_revision, attempt.pending_revision + 1) }
          : {}),
        next_run_at:
          stillEnabled &&
          !publicationPause &&
          !verificationBlocked &&
          !missingStructuredResult &&
          (newerEvents || incomplete || deferredConflict)
            ? new Date(
                Date.now() +
                  (deferredConflict ? attempt.input.policy.quietPeriodSeconds * 1000 : 30_000)
              ).toISOString()
            : null,
        updated_at: now,
      })
      .where(eq(cloud_agent_pr_watches.id, current.id));
    await tx.insert(cloud_agent_pr_watch_activity).values({
      watch_id: current.id,
      generation: current.generation,
      kind: finished.status === 'completed' ? 'repair_completed' : 'repair_failed',
      reason,
      data: {
        attemptId: attempt.id,
        sessionId: attempt.session_id,
        summary: result?.summary ?? null,
        verification: result?.verification ?? [],
        publication: result?.publication ?? { status: 'unknown' },
      },
    });
    return !publicationPause && !verificationBlocked && !missingStructuredResult;
  });
}

export async function recordMaintenanceRebase(
  watch: CloudAgentPrWatch,
  attempt: CloudAgentPrMaintenanceAttempt,
  publication: WatchPrPublicationEvidence
) {
  if (
    publication.status !== 'published' ||
    !publication.ownedRebase ||
    !attempt.input.repository.parentCommitSha ||
    !attempt.input.policy.categories.conflicts
  )
    return;
  const rebase = publication.ownedRebase;
  if (
    rebase.source !== 'git' ||
    rebase.attemptId !== attempt.id ||
    rebase.baseSha !== publication.baseSha ||
    Date.parse(rebase.completedAt) < Date.parse(attempt.started_at ?? attempt.created_at) ||
    Date.parse(rebase.completedAt) > Date.parse(publication.verifiedAt)
  )
    return;
  await db
    .update(cloud_agent_worktrees)
    .set({ base_sha: rebase.baseSha, updated_at: new Date().toISOString() })
    .where(
      and(
        eq(cloud_agent_worktrees.worktree_id, watch.worktree_id),
        eq(cloud_agent_worktrees.kilo_user_id, watch.kilo_user_id),
        eq(cloud_agent_worktrees.base_sha, attempt.input.repository.parentCommitSha)
      )
    );
}

export function tagMaintenanceSession(
  watch: CloudAgentPrWatch,
  attempt: CloudAgentPrMaintenanceAttempt
) {
  if (!attempt.session_id) return;
  return db
    .update(cli_sessions_v2)
    .set({
      chat_kind: 'maintenance',
      maintenance_watch_id: watch.id,
      maintenance_attempt_id: attempt.id,
    })
    .where(
      and(
        eq(cli_sessions_v2.session_id, attempt.session_id),
        eq(cli_sessions_v2.kilo_user_id, watch.kilo_user_id),
        or(
          ne(cli_sessions_v2.chat_kind, 'maintenance'),
          sql`${cli_sessions_v2.maintenance_watch_id} IS DISTINCT FROM ${watch.id}`,
          sql`${cli_sessions_v2.maintenance_attempt_id} IS DISTINCT FROM ${attempt.id}`
        )
      )
    );
}

export async function setMaintenanceDue(
  watch: CloudAgentPrWatch,
  dueAt: string,
  reason: string | null = null,
  executionStatus?: CloudAgentPrWatch['execution_status']
) {
  await db
    .update(cloud_agent_pr_watches)
    .set({
      next_run_at: new Date(Math.max(Date.parse(dueAt), Date.now() + 5_000)).toISOString(),
      lifecycle_reason: reason,
      ...(executionStatus ? { execution_status: executionStatus } : {}),
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(cloud_agent_pr_watches.id, watch.id),
        eq(cloud_agent_pr_watches.generation, watch.generation),
        eq(cloud_agent_pr_watches.status, 'watching')
      )
    );
}

export async function pauseMaintenance(watch: CloudAgentPrWatch, reason: string) {
  await db
    .update(cloud_agent_pr_watches)
    .set({
      status: 'paused',
      execution_status: 'watching',
      lifecycle_reason: reason,
      generation: sql`${cloud_agent_pr_watches.generation} + 1`,
      next_run_at: null,
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(cloud_agent_pr_watches.id, watch.id),
        eq(cloud_agent_pr_watches.generation, watch.generation)
      )
    );
}
