import '@/lib/load-env';

import { closeAllDrizzleConnections, db } from '@/lib/drizzle';
import {
  KILOCLAW_COMMIT_SALES_CUTOFF,
  KiloClawCommitRetirementQualificationSource,
  isBeforeKiloClawCommitSalesCutoff,
} from '@kilocode/db';
import {
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';

const isDryRun = !process.argv.includes('--run-actually');
const SCRIPT_ACTOR = 'capture-kiloclaw-commit-qualifications';
const QUALIFICATION_SOURCE =
  KiloClawCommitRetirementQualificationSource.SwitchRequestedBeforeCutoff;

type PendingSwitch = typeof kiloclaw_subscriptions.$inferSelect;

type Classification =
  | { kind: 'already_qualified'; qualifiedAt: string }
  | { kind: 'qualifiable'; qualifiedAt: string; hasExistingEvidence: boolean }
  | { kind: 'unexplained'; reason: string };

async function getDatabaseNow(): Promise<string> {
  const { rows } = await db.execute<{ now: string }>(sql`SELECT now() AS now`);
  const now = rows[0]?.now;
  if (!now) throw new Error('database_now_unavailable');
  return new Date(now).toISOString();
}

async function getPendingStandardToCommitSwitches(): Promise<PendingSwitch[]> {
  return db
    .select({ subscription: kiloclaw_subscriptions })
    .from(kiloclaw_subscriptions)
    .leftJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(
      and(
        eq(kiloclaw_subscriptions.plan, 'standard'),
        eq(kiloclaw_subscriptions.scheduled_plan, 'commit'),
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id),
        isNull(kiloclaw_instances.organization_id)
      )
    )
    .then(rows => rows.map(row => row.subscription));
}

async function getLatestCommitSwitchRequestAt(subscriptionId: string): Promise<string | null> {
  const { rows } = await db.execute<{ requested_at: string }>(sql`
    SELECT created_at AS requested_at
    FROM ${kiloclaw_subscription_change_log}
    WHERE subscription_id = ${subscriptionId}
      AND action = 'schedule_changed'
      AND after_state->>'scheduled_plan' = 'commit'
      AND COALESCE(before_state->>'scheduled_plan', '') <> 'commit'
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const requestedAt = rows[0]?.requested_at;
  return requestedAt ? new Date(requestedAt).toISOString() : null;
}

async function classifySwitch(subscription: PendingSwitch): Promise<Classification> {
  const existingQualifiedAt = subscription.commit_retirement_qualified_at;
  const existingSource = subscription.commit_retirement_qualification_source;

  if (existingQualifiedAt || existingSource || subscription.commit_retirement_state) {
    if (
      existingQualifiedAt &&
      existingSource === QUALIFICATION_SOURCE &&
      isBeforeKiloClawCommitSalesCutoff(existingQualifiedAt)
    ) {
      const qualifiedAt = new Date(existingQualifiedAt).toISOString();
      if (subscription.commit_retirement_state === 'pending_final_term') {
        return { kind: 'already_qualified', qualifiedAt };
      }
      if (subscription.commit_retirement_state === null) {
        return { kind: 'qualifiable', qualifiedAt, hasExistingEvidence: true };
      }
      return { kind: 'unexplained', reason: 'existing_retirement_state_conflicts' };
    }
    return { kind: 'unexplained', reason: 'existing_qualification_conflicts' };
  }

  if (subscription.scheduled_by !== 'user') {
    return { kind: 'unexplained', reason: 'commit_switch_not_user_requested' };
  }

  const requestedAt = await getLatestCommitSwitchRequestAt(subscription.id);
  if (!requestedAt) return { kind: 'unexplained', reason: 'missing_switch_request_audit_time' };
  if (!isBeforeKiloClawCommitSalesCutoff(requestedAt)) {
    return { kind: 'unexplained', reason: 'switch_request_not_before_cutoff' };
  }

  return { kind: 'qualifiable', qualifiedAt: requestedAt, hasExistingEvidence: false };
}

async function captureQualification(
  subscription: PendingSwitch,
  qualifiedAt: string,
  hasExistingEvidence: boolean
): Promise<boolean> {
  return db.transaction(async tx => {
    const [current] = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id))
      .for('update')
      .limit(1);

    if (
      !current ||
      current.plan !== 'standard' ||
      current.scheduled_plan !== 'commit' ||
      current.scheduled_by !== 'user' ||
      current.transferred_to_subscription_id !== null ||
      (current.commit_retirement_state !== null &&
        current.commit_retirement_state !== 'pending_final_term')
    ) {
      return false;
    }

    const normalizedCurrentQualifiedAt = current.commit_retirement_qualified_at
      ? new Date(current.commit_retirement_qualified_at).toISOString()
      : null;
    const hasNoQualificationEvidence =
      normalizedCurrentQualifiedAt === null &&
      current.commit_retirement_qualification_source === null;
    const hasMatchingQualificationEvidence =
      normalizedCurrentQualifiedAt === qualifiedAt &&
      current.commit_retirement_qualification_source === QUALIFICATION_SOURCE;
    if (!hasNoQualificationEvidence && !hasMatchingQualificationEvidence) {
      return false;
    }
    if (
      current.commit_retirement_state === 'pending_final_term' &&
      hasMatchingQualificationEvidence
    ) {
      return true;
    }

    if (!isBeforeKiloClawCommitSalesCutoff(qualifiedAt)) {
      return false;
    }
    if (hasExistingEvidence !== hasMatchingQualificationEvidence) {
      return false;
    }
    if (!hasMatchingQualificationEvidence) {
      const currentRequestAt = await getLatestCommitSwitchRequestAt(current.id);
      if (currentRequestAt !== qualifiedAt) {
        return false;
      }
    }

    const [after] = await tx
      .update(kiloclaw_subscriptions)
      .set({
        commit_retirement_state: 'pending_final_term',
        commit_retirement_qualified_at: qualifiedAt,
        commit_retirement_qualification_source: QUALIFICATION_SOURCE,
      })
      .where(
        and(
          eq(kiloclaw_subscriptions.id, current.id),
          eq(kiloclaw_subscriptions.plan, 'standard'),
          eq(kiloclaw_subscriptions.scheduled_plan, 'commit'),
          eq(kiloclaw_subscriptions.scheduled_by, 'user'),
          isNull(kiloclaw_subscriptions.transferred_to_subscription_id),
          sql`${kiloclaw_subscriptions.commit_retirement_state} IS NOT DISTINCT FROM ${current.commit_retirement_state}`,
          sql`${kiloclaw_subscriptions.commit_retirement_qualified_at} IS NOT DISTINCT FROM ${current.commit_retirement_qualified_at}`,
          sql`${kiloclaw_subscriptions.commit_retirement_qualification_source} IS NOT DISTINCT FROM ${current.commit_retirement_qualification_source}`
        )
      )
      .returning();

    if (!after) return false;

    await tx.insert(kiloclaw_subscription_change_log).values({
      subscription_id: current.id,
      actor_type: 'system',
      actor_id: SCRIPT_ACTOR,
      action: 'commit_retirement_changed',
      reason: 'pre_cutoff_pending_commit_switch_qualification_capture',
      before_state: {
        commit_retirement_state: current.commit_retirement_state,
        commit_retirement_qualified_at: current.commit_retirement_qualified_at,
        commit_retirement_qualification_source: current.commit_retirement_qualification_source,
      },
      after_state: {
        commit_retirement_state: after.commit_retirement_state,
        commit_retirement_qualified_at: after.commit_retirement_qualified_at,
        commit_retirement_qualification_source: after.commit_retirement_qualification_source,
      },
    });

    return true;
  });
}

async function main() {
  const databaseNow = await getDatabaseNow();
  if (!isDryRun && !isBeforeKiloClawCommitSalesCutoff(databaseNow)) {
    throw new Error('qualification_capture_apply_must_run_before_cutoff');
  }

  const switches = await getPendingStandardToCommitSwitches();
  console.log(
    JSON.stringify({
      event: 'kiloclaw_commit_qualification_capture_started',
      mode: isDryRun ? 'dry_run' : 'apply',
      databaseNow,
      cutoff: KILOCLAW_COMMIT_SALES_CUTOFF,
      pendingSwitchCount: switches.length,
    })
  );

  let qualified = 0;
  let alreadyQualified = 0;
  let unexplained = 0;
  let stale = 0;

  for (const subscription of switches) {
    const classification = await classifySwitch(subscription);
    if (classification.kind === 'unexplained') {
      unexplained++;
      console.log(
        JSON.stringify({
          event: 'kiloclaw_commit_qualification_unexplained',
          subscriptionId: subscription.id,
          reason: classification.reason,
        })
      );
      continue;
    }

    if (classification.kind === 'already_qualified') {
      alreadyQualified++;
      console.log(
        JSON.stringify({
          event: 'kiloclaw_commit_qualification_already_captured',
          subscriptionId: subscription.id,
          qualifiedAt: classification.qualifiedAt,
        })
      );
      continue;
    }

    if (isDryRun) {
      qualified++;
      console.log(
        JSON.stringify({
          event: 'kiloclaw_commit_qualification_would_capture',
          subscriptionId: subscription.id,
          retirementState: 'pending_final_term',
          qualifiedAt: classification.qualifiedAt,
          qualificationSource: QUALIFICATION_SOURCE,
        })
      );
      continue;
    }

    if (
      await captureQualification(
        subscription,
        classification.qualifiedAt,
        classification.hasExistingEvidence
      )
    ) {
      qualified++;
      console.log(
        JSON.stringify({
          event: 'kiloclaw_commit_qualification_captured',
          subscriptionId: subscription.id,
          retirementState: 'pending_final_term',
          qualifiedAt: classification.qualifiedAt,
          qualificationSource: QUALIFICATION_SOURCE,
        })
      );
    } else {
      stale++;
      console.log(
        JSON.stringify({
          event: 'kiloclaw_commit_qualification_stale_skip',
          subscriptionId: subscription.id,
        })
      );
    }
  }

  console.log(
    JSON.stringify({
      event: 'kiloclaw_commit_qualification_capture_completed',
      mode: isDryRun ? 'dry_run' : 'apply',
      processed: switches.length,
      qualified,
      alreadyQualified,
      unexplained,
      stale,
    })
  );

  if (unexplained > 0 || stale > 0) process.exitCode = 1;
}

void main()
  .catch(error => {
    console.error(
      JSON.stringify({
        event: 'kiloclaw_commit_qualification_capture_failed',
        error: error instanceof Error ? error.name : 'UnknownError',
      })
    );
    process.exitCode = 1;
  })
  .finally(() => closeAllDrizzleConnections());
