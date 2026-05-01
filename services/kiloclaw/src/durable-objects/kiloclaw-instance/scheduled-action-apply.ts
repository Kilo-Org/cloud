/**
 * Scheduled-action apply path. Runs inside the kiloclaw instance DO's
 * `alarm()` handler. For each pending target whose stage time has passed
 * (and whose parent action is still actionable), dispatches by
 * action_type and records the outcome.
 *
 * PR 1 implements only `action_type='scheduled_restart'`. PR 3 will add
 * `version_change`. The action_type switch is structured so future types
 * slot in without churning the dispatcher.
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
  recordScheduledActionTargetOutcome,
  maybePromoteScheduledActionsToCompleted,
  type DueScheduledActionTarget,
} from '../../db';
import { kiloclaw_instances } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { doLog, doWarn, toLoggable } from './log';

type ApplyContext = {
  env: KiloClawEnv;
  state: InstanceMutableState;
  /**
   * Trigger the DO's existing redeploy / restart machinery for the
   * current instance. The DO calls into this from its own internal
   * restartMachine path with no `imageTag` argument, which is the
   * scheduled_restart semantic.
   */
  restartCurrentInstance: () => Promise<void>;
};

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
  let resolvedInstanceId: string | null = null;
  try {
    const [row] = await db
      .select({ id: kiloclaw_instances.id })
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.sandbox_id, ctx.state.sandboxId))
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

    // The query already filters parent.status IN ('scheduled', 'running')
    // but a concurrent cancellation between the query and the apply is
    // possible. Re-check parent status before dispatching. If cancelled,
    // mark the target skipped:cancelled.
    if (target.parent_status === 'cancelled' || target.parent_status === 'completed') {
      try {
        await recordScheduledActionTargetOutcome(db, {
          target_id: target.target_id,
          scheduled_action_id: target.scheduled_action_id,
          stage_id: target.stage_id,
          outcome: 'skipped',
          skip_reason: 'cancelled',
        });
      } catch (err) {
        doWarn(ctx.state, 'scheduled-action-apply: record skipped failed', {
          error: toLoggable(err),
          targetId: target.target_id,
        });
      }
      continue;
    }

    try {
      await dispatchByActionType(target, ctx);
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
  ctx: ApplyContext
): Promise<void> {
  switch (target.action_type) {
    case 'scheduled_restart':
      await ctx.restartCurrentInstance();
      return;
    case 'version_change':
      // PR 3 will implement this case via the shared
      // applyVersionChangeToInstance helper. For PR 1, fail loudly.
      throw new Error('version_change action_type not implemented in PR 1');
    default: {
      const exhaustive: never = target.action_type;
      throw new Error(`unhandled action_type: ${String(exhaustive)}`);
    }
  }
}
