/**
 * Scheduled-action apply path. Runs inside the kiloclaw instance DO's
 * `alarm()` handler. For each pending target whose stage time has passed
 * (and whose parent action is still actionable), dispatches by
 * action_type and records the outcome.
 *
 * Currently dispatches:
 *   - `scheduled_restart` → existing `restartMachine()` path (no imageTag)
 *   - `version_change`    → pin override + `restartMachine({ imageTag })`
 *                           (delegates to applyVersionChangeForTarget)
 *
 * Coexistence with the existing reconcile alarm: this path runs first
 * (best-effort wrapped in try/catch) so reconciliation continues even if
 * Postgres is unreachable. The existing alarm cadence (5/1/30 min) is
 * the only timing source — there's no separate `nextScheduledActionAt`
 * field. Scheduled actions fire on the next reconcile alarm tick whose
 * `scheduled_at <= now()`. Worst-case latency is one alarm interval.
 */
import type { KiloClawEnv } from '../../types';
import type { InstanceMutableState } from './types';
import {
  getWorkerDb,
  findDueScheduledActionTargetsForInstance,
  claimScheduledActionTarget,
  recordScheduledActionTargetOutcome,
  maybePromoteScheduledActionsToCompleted,
  type DueScheduledActionTarget,
  type WorkerDb,
} from '../../db';
import { kiloclaw_instances, kiloclaw_scheduled_actions } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { doLog, doWarn, toLoggable } from './log';
import { applyVersionChangeForTarget } from './version-change-apply';

type ApplyContext = {
  env: KiloClawEnv;
  state: InstanceMutableState;
  /**
   * Trigger the DO's existing redeploy / restart machinery for the
   * current instance. Optional `imageTag` argument supports the
   * `version_change` apply path (which redeploys on a new tag); a
   * call with no argument is a `scheduled_restart` (redeploy current
   * tag).
   */
  restartCurrentInstance: (imageTag?: string) => Promise<void>;
};

type DispatchOutcome = { kind: 'applied' } | { kind: 'skipped'; reason: string };

export async function runScheduledActionApply(ctx: ApplyContext): Promise<{ processed: number }> {
  const connectionString = ctx.env.HYPERDRIVE?.connectionString;
  if (!connectionString) return { processed: 0 };

  // The DO's identity is keyed off (sandboxId, userId). For the apply
  // query we need the kiloclaw_instances.id, which we resolve via
  // sandboxId since that's what the DO tracks.
  if (!ctx.state.sandboxId) return { processed: 0 };

  let db: ReturnType<typeof getWorkerDb>;
  try {
    db = getWorkerDb(connectionString);
  } catch (err) {
    doWarn(ctx.state, 'scheduled-action-apply: failed to get worker db', {
      error: toLoggable(err),
    });
    return { processed: 0 };
  }

  // Resolve instance id from sandbox id. The DB helper takes an
  // instance id (uuid); the DO tracks sandboxId primarily. Look up
  // kiloclaw_instances by sandbox_id.
  //
  // Index hit: when userId is present we filter on (user_id, sandbox_id,
  // destroyed_at IS NULL) which exactly matches the partial composite
  // UQ_kiloclaw_instances_active index. Without userId there is no
  // standalone sandbox_id index, so we fall back to the bare lookup —
  // that's only legacy DOs without a userId, which shouldn't have
  // scheduled actions anyway.
  let resolvedInstanceId: string | null = null;
  try {
    const where = ctx.state.userId
      ? and(
          eq(kiloclaw_instances.user_id, ctx.state.userId),
          eq(kiloclaw_instances.sandbox_id, ctx.state.sandboxId),
          isNull(kiloclaw_instances.destroyed_at)
        )
      : eq(kiloclaw_instances.sandbox_id, ctx.state.sandboxId);
    const [row] = await db
      .select({ id: kiloclaw_instances.id })
      .from(kiloclaw_instances)
      .where(where)
      .limit(1);
    resolvedInstanceId = row?.id ?? null;
  } catch (err) {
    doWarn(ctx.state, 'scheduled-action-apply: failed to resolve instance id', {
      error: toLoggable(err),
      sandboxId: ctx.state.sandboxId,
    });
    return { processed: 0 };
  }

  if (!resolvedInstanceId) return { processed: 0 };

  let due: DueScheduledActionTarget[];
  try {
    due = await findDueScheduledActionTargetsForInstance(db, resolvedInstanceId);
  } catch (err) {
    doWarn(ctx.state, 'scheduled-action-apply: query failed', {
      error: toLoggable(err),
    });
    return { processed: 0 };
  }

  if (due.length === 0) return { processed: 0 };

  doLog(ctx.state, 'scheduled-action-apply: processing due targets', {
    count: due.length,
    instanceId: resolvedInstanceId,
  });

  // Track parent ids touched so we can promote stage/parent statuses at
  // the end of the pass.
  const touchedActionIds = new Set<string>();

  for (const target of due) {
    touchedActionIds.add(target.scheduled_action_id);

    // Re-fetch parent status right before dispatch. The findDue query's
    // parent_status is from a prior snapshot — by now an admin may have
    // cancelled. The atomic UPDATE in recordScheduledActionTargetOutcome
    // (WHERE status='pending') keeps the audit trail consistent if cancel
    // wins the race, but we'd still fire the side effect (restartMachine)
    // if we relied on the snapshot alone. The fresh SELECT narrows the
    // race window to a single round-trip; truly closing it would require
    // a transaction wrapping the side effect, which we intentionally
    // avoid (long-running tx around restartMachine).
    let currentParentStatus: string | undefined;
    try {
      const [parentRow] = await db
        .select({ status: kiloclaw_scheduled_actions.status })
        .from(kiloclaw_scheduled_actions)
        .where(eq(kiloclaw_scheduled_actions.id, target.scheduled_action_id))
        .limit(1);
      currentParentStatus = parentRow?.status;
    } catch (err) {
      doWarn(ctx.state, 'scheduled-action-apply: parent status re-fetch failed', {
        error: toLoggable(err),
        targetId: target.target_id,
      });
      // Fall through and trust the snapshot. The atomic UPDATE will still
      // refuse to overwrite a non-pending target.
      currentParentStatus = target.parent_status;
    }

    if (
      currentParentStatus === 'cancelled' ||
      currentParentStatus === 'completed' ||
      currentParentStatus === 'failed'
    ) {
      try {
        await recordScheduledActionTargetOutcome(db, {
          target_id: target.target_id,
          scheduled_action_id: target.scheduled_action_id,
          stage_id: target.stage_id,
          outcome: 'skipped',
          // Use the actual terminal status as the skip reason so the
          // audit trail distinguishes "admin cancelled" from "parent
          // already completed/failed before this target's tick".
          skip_reason: currentParentStatus,
        });
      } catch (err) {
        doWarn(ctx.state, 'scheduled-action-apply: record skipped failed', {
          error: toLoggable(err),
          targetId: target.target_id,
        });
      }
      continue;
    }

    // Claim the target before dispatch. Without this, two concurrent
    // waitUntil passes can both find the same due row and both invoke
    // restartMachine — only one wins the final outcome CAS, but both
    // side effects have already started. The atomic pending → running
    // transition makes the dispatch single-writer.
    let claimed = false;
    try {
      claimed = await claimScheduledActionTarget(db, { target_id: target.target_id });
    } catch (err) {
      doWarn(ctx.state, 'scheduled-action-apply: claim failed', {
        error: toLoggable(err),
        targetId: target.target_id,
      });
      continue;
    }
    if (!claimed) {
      doLog(ctx.state, 'scheduled-action-apply: claim missed (concurrent pass)', {
        targetId: target.target_id,
      });
      continue;
    }

    try {
      const outcome = await dispatchByActionType(target, ctx, db);
      if (outcome.kind === 'applied') {
        await recordScheduledActionTargetOutcome(db, {
          target_id: target.target_id,
          scheduled_action_id: target.scheduled_action_id,
          stage_id: target.stage_id,
          outcome: 'applied',
        });
        doLog(ctx.state, 'scheduled-action-apply: applied', {
          targetId: target.target_id,
          actionType: target.action_type,
        });
      } else {
        await recordScheduledActionTargetOutcome(db, {
          target_id: target.target_id,
          scheduled_action_id: target.scheduled_action_id,
          stage_id: target.stage_id,
          outcome: 'skipped',
          skip_reason: outcome.reason,
        });
        doLog(ctx.state, 'scheduled-action-apply: skipped', {
          targetId: target.target_id,
          actionType: target.action_type,
          reason: outcome.reason,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      try {
        await recordScheduledActionTargetOutcome(db, {
          target_id: target.target_id,
          scheduled_action_id: target.scheduled_action_id,
          stage_id: target.stage_id,
          outcome: 'failed',
          error_message: message,
        });
      } catch (recordErr) {
        doWarn(ctx.state, 'scheduled-action-apply: record failed failed', {
          error: toLoggable(recordErr),
          targetId: target.target_id,
        });
      }
      doWarn(ctx.state, 'scheduled-action-apply: dispatch failed', {
        error: toLoggable(err),
        targetId: target.target_id,
        actionType: target.action_type,
      });
    }
  }

  // Promote stages and parents to completed where pending count is zero.
  try {
    await maybePromoteScheduledActionsToCompleted(db, Array.from(touchedActionIds));
  } catch (err) {
    doWarn(ctx.state, 'scheduled-action-apply: promotion sweep failed', {
      error: toLoggable(err),
    });
  }

  return { processed: due.length };
}

async function dispatchByActionType(
  target: DueScheduledActionTarget,
  ctx: ApplyContext,
  db: WorkerDb
): Promise<DispatchOutcome> {
  switch (target.action_type) {
    case 'scheduled_restart':
      await ctx.restartCurrentInstance();
      return { kind: 'applied' };
    case 'version_change':
      return await applyVersionChangeForTarget({
        db,
        state: ctx.state,
        target,
        restartCurrentInstance: ctx.restartCurrentInstance,
      });
    default: {
      const exhaustive: never = target.action_type;
      throw new Error(`unhandled action_type: ${String(exhaustive)}`);
    }
  }
}
