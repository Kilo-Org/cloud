import {
  markInstanceDestroyedWithPersonalSubscriptionCollapse,
  type KiloClawSubscriptionChangeActor,
} from '@kilocode/db';
import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  kilocode_users,
  kiloclaw_access_codes,
  kiloclaw_google_oauth_connections,
  kiloclaw_instances,
  kiloclaw_scheduled_actions,
  kiloclaw_scheduled_action_stages,
  kiloclaw_scheduled_action_targets,
  kiloclaw_version_pins,
} from '@kilocode/db/schema';
import type { KiloClawScheduledActionStatus } from '@kilocode/db/schema-types';
import { eq, and, isNull, gt, lte, inArray, sql } from 'drizzle-orm';

export { getWorkerDb, type WorkerDb };

const KILOCLAW_WORKER_DESTROY_ACTOR = {
  actorType: 'system',
  actorId: 'kiloclaw-worker',
} satisfies KiloClawSubscriptionChangeActor;

export async function findPepperByUserId(db: WorkerDb, userId: string) {
  const row = await db
    .select({
      id: kilocode_users.id,
      api_token_pepper: kilocode_users.api_token_pepper,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1)
    .then(rows => rows[0] ?? null);
  return row;
}

export async function findEmailByUserId(db: WorkerDb, userId: string): Promise<string | null> {
  const row = await db
    .select({ email: kilocode_users.google_user_email })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1)
    .then(rows => rows[0] ?? null);
  return row?.email ?? null;
}

export async function validateAndRedeemAccessCode(db: WorkerDb, code: string, userId: string) {
  return await db.transaction(async tx => {
    const rows = await tx
      .select({
        id: kiloclaw_access_codes.id,
        kilo_user_id: kiloclaw_access_codes.kilo_user_id,
      })
      .from(kiloclaw_access_codes)
      .where(
        and(
          eq(kiloclaw_access_codes.code, code),
          eq(kiloclaw_access_codes.kilo_user_id, userId),
          eq(kiloclaw_access_codes.status, 'active'),
          gt(kiloclaw_access_codes.expires_at, sql`NOW()`)
        )
      )
      .limit(1)
      .for('update');

    if (rows.length === 0) return null;
    const row = rows[0];

    await tx
      .update(kiloclaw_access_codes)
      .set({
        status: 'redeemed',
        redeemed_at: sql`NOW()`,
      })
      .where(eq(kiloclaw_access_codes.id, row.id));

    return row.kilo_user_id;
  });
}

export async function getActivePersonalInstance(db: WorkerDb, userId: string) {
  const row = await db
    .select({
      id: kiloclaw_instances.id,
      sandbox_id: kiloclaw_instances.sandbox_id,
      organization_id: kiloclaw_instances.organization_id,
    })
    .from(kiloclaw_instances)
    .where(
      and(
        eq(kiloclaw_instances.user_id, userId),
        isNull(kiloclaw_instances.organization_id),
        isNull(kiloclaw_instances.destroyed_at)
      )
    )
    .orderBy(kiloclaw_instances.created_at)
    .limit(1)
    .then(rows => rows[0] ?? null);

  if (!row) return null;
  return { id: row.id, sandboxId: row.sandbox_id, orgId: row.organization_id };
}

/**
 * Look up an active instance by its sandboxId.
 * Used for DO restore when the DO has a stored sandboxId but lost other state.
 */
export async function getInstanceBySandboxId(db: WorkerDb, sandboxId: string) {
  const row = await db
    .select({
      id: kiloclaw_instances.id,
      sandbox_id: kiloclaw_instances.sandbox_id,
      user_id: kiloclaw_instances.user_id,
      organization_id: kiloclaw_instances.organization_id,
      provider: kiloclaw_instances.provider,
      instance_type: kiloclaw_instances.instance_type,
    })
    .from(kiloclaw_instances)
    .where(
      and(eq(kiloclaw_instances.sandbox_id, sandboxId), isNull(kiloclaw_instances.destroyed_at))
    )
    .limit(1)
    .then(rows => rows[0] ?? null);

  if (!row) return null;
  return {
    id: row.id,
    sandboxId: row.sandbox_id,
    userId: row.user_id,
    orgId: row.organization_id,
    provider: row.provider,
    instanceType: row.instance_type,
  };
}

/**
 * Look up an active instance by its primary key UUID.
 * Used for DO restore when the caller knows the instanceId (= DB row id).
 */
export async function getInstanceById(db: WorkerDb, instanceId: string) {
  return getInstanceByIdIncludingDestroyed(db, instanceId, { includeDestroyed: false });
}

export async function getInstanceByIdIncludingDestroyed(
  db: WorkerDb,
  instanceId: string,
  options: { includeDestroyed?: boolean } = {}
) {
  const where = options.includeDestroyed
    ? eq(kiloclaw_instances.id, instanceId)
    : and(eq(kiloclaw_instances.id, instanceId), isNull(kiloclaw_instances.destroyed_at));

  const row = await db
    .select({
      id: kiloclaw_instances.id,
      sandbox_id: kiloclaw_instances.sandbox_id,
      user_id: kiloclaw_instances.user_id,
      organization_id: kiloclaw_instances.organization_id,
      inbound_email_enabled: kiloclaw_instances.inbound_email_enabled,
      provider: kiloclaw_instances.provider,
      instance_type: kiloclaw_instances.instance_type,
    })
    .from(kiloclaw_instances)
    .where(where)
    .limit(1)
    .then(rows => rows[0] ?? null);

  if (!row) return null;
  return {
    id: row.id,
    sandboxId: row.sandbox_id,
    userId: row.user_id,
    orgId: row.organization_id,
    inboundEmailEnabled: row.inbound_email_enabled,
    provider: row.provider,
    instanceType: row.instance_type,
  };
}

export async function markInstanceDestroyed(db: WorkerDb, userId: string, sandboxId: string) {
  await db.transaction(async tx => {
    const row = await tx
      .select({
        id: kiloclaw_instances.id,
      })
      .from(kiloclaw_instances)
      .where(
        and(
          eq(kiloclaw_instances.user_id, userId),
          eq(kiloclaw_instances.sandbox_id, sandboxId),
          isNull(kiloclaw_instances.destroyed_at)
        )
      )
      .limit(1)
      .then(rows => rows[0] ?? null);

    if (!row) {
      return;
    }

    await markInstanceDestroyedWithPersonalSubscriptionCollapse({
      actor: KILOCLAW_WORKER_DESTROY_ACTOR,
      executor: tx,
      instanceId: row.id,
      reason: 'destroy_path_inline_collapse',
      userId,
    });
  });
}

/**
 * Sync the active instance's tracked_image_tag column from DO state.
 * No-op at the SQL level when the value already matches (IS DISTINCT FROM).
 */
export async function syncTrackedImageTag(
  db: WorkerDb,
  userId: string,
  sandboxId: string,
  trackedImageTag: string | null
) {
  await db
    .update(kiloclaw_instances)
    .set({ tracked_image_tag: trackedImageTag })
    .where(
      and(
        eq(kiloclaw_instances.user_id, userId),
        eq(kiloclaw_instances.sandbox_id, sandboxId),
        isNull(kiloclaw_instances.destroyed_at),
        sql`${kiloclaw_instances.tracked_image_tag} IS DISTINCT FROM ${trackedImageTag}`
      )
    );
}

export async function syncInstanceType(
  db: WorkerDb,
  userId: string,
  sandboxId: string,
  instanceType: string | null
) {
  await db
    .update(kiloclaw_instances)
    .set({ instance_type: instanceType })
    .where(
      and(
        eq(kiloclaw_instances.user_id, userId),
        eq(kiloclaw_instances.sandbox_id, sandboxId),
        isNull(kiloclaw_instances.destroyed_at),
        sql`${kiloclaw_instances.instance_type} IS DISTINCT FROM ${instanceType}`
      )
    );
}

/**
 * Sync `admin_size_override` from DO state. Pass `null` to clear, or the
 * full payload (override size + metadata) to set. Conditional UPDATE — the
 * SQL `IS DISTINCT FROM` guards against churning rows when nothing changed.
 *
 * Called from the DO RPC paths that explicitly mutate the override
 * (`setAdminMachineSizeOverride` / `clearAdminMachineSizeOverride`) and as
 * part of tier resize when the override is auto-cleared. NOT called from
 * the alarm tick — there's no "observed override" to derive.
 */
export type AdminSizeOverridePayload = {
  size: { cpus: number; memory_mb: number; cpu_kind?: 'shared' | 'performance' };
  reason: string;
  actorId: string;
  actorEmail: string;
  setAt: number;
};

export async function syncAdminSizeOverride(
  db: WorkerDb,
  userId: string,
  sandboxId: string,
  payload: AdminSizeOverridePayload | null
) {
  await db
    .update(kiloclaw_instances)
    .set({ admin_size_override: payload })
    .where(
      and(
        eq(kiloclaw_instances.user_id, userId),
        eq(kiloclaw_instances.sandbox_id, sandboxId),
        isNull(kiloclaw_instances.destroyed_at),
        sql`${kiloclaw_instances.admin_size_override} IS DISTINCT FROM ${payload}::jsonb`
      )
    );
}

export async function getGoogleOAuthConnectionByInstanceId(db: WorkerDb, instanceId: string) {
  return await db
    .select()
    .from(kiloclaw_google_oauth_connections)
    .where(eq(kiloclaw_google_oauth_connections.instance_id, instanceId))
    .limit(1)
    .then(rows => rows[0] ?? null);
}

export async function updateGoogleOAuthConnectionTokenData(
  db: WorkerDb,
  instanceId: string,
  patch: {
    refreshTokenEncrypted?: string;
    oauthClientId?: string;
    oauthClientSecretEncrypted?: string | null;
    credentialProfile?: 'legacy' | 'kilo_owned';
    scopes?: string[];
    status?: 'active' | 'action_required' | 'disconnected';
    lastError?: string | null;
    lastErrorAt?: string | null;
  }
) {
  const update: Record<string, unknown> = {
    updated_at: sql`NOW()`,
  };

  if (patch.refreshTokenEncrypted !== undefined) {
    update.refresh_token_encrypted = patch.refreshTokenEncrypted;
  }

  if (patch.oauthClientId !== undefined) {
    update.oauth_client_id = patch.oauthClientId;
  }

  if (patch.oauthClientSecretEncrypted !== undefined) {
    update.oauth_client_secret_encrypted = patch.oauthClientSecretEncrypted;
  }

  if (patch.credentialProfile !== undefined) {
    update.credential_profile = patch.credentialProfile;
  }

  if (patch.scopes !== undefined) {
    update.scopes = patch.scopes;
  }

  if (patch.status !== undefined) {
    update.status = patch.status;
  }

  if (patch.lastError !== undefined) {
    update.last_error = patch.lastError;
  }

  if (patch.lastErrorAt !== undefined) {
    update.last_error_at = patch.lastErrorAt;
  }

  await db
    .update(kiloclaw_google_oauth_connections)
    .set(update)
    .where(eq(kiloclaw_google_oauth_connections.instance_id, instanceId));
}

// ─── Scheduled Actions (PR 1: scheduled_restart) ───────────────────────

export type DueScheduledActionTarget = {
  target_id: string;
  scheduled_action_id: string;
  // Non-null because the apply query INNER JOINs on stage. The schema
  // column is nullable (ON DELETE SET NULL is defensive), but a target
  // whose stage has been deleted intentionally drops out of the apply
  // path — without a stage we have no scheduled_at to gate on, so firing
  // the action would be unsafe. Such orphans remain visible to the admin
  // via getScheduledAction for cleanup.
  stage_id: string;
  instance_id: string;
  user_id: string;
  action_type: 'scheduled_restart' | 'version_change';
  target_image_tag: string | null;
  override_pins: boolean;
  parent_status: KiloClawScheduledActionStatus;
};

/**
 * Find pending scheduled-action targets for a single instance whose stage
 * time has passed and whose parent is still actionable. Used by the DO
 * apply path on alarm fire.
 *
 * The INNER JOIN on stages is intentional: a target whose stage has been
 * deleted (nullable FK with ON DELETE SET NULL) drops out — we have no
 * scheduled_at to gate on, so firing it would be unsafe. Stages aren't
 * deleted outside parent CASCADE in v1; the SET NULL is defensive.
 */
export async function findDueScheduledActionTargetsForInstance(
  db: WorkerDb,
  instanceId: string
): Promise<DueScheduledActionTarget[]> {
  const rows = await db
    .select({
      target_id: kiloclaw_scheduled_action_targets.id,
      scheduled_action_id: kiloclaw_scheduled_action_targets.scheduled_action_id,
      stage_id: kiloclaw_scheduled_action_targets.stage_id,
      instance_id: kiloclaw_scheduled_action_targets.instance_id,
      user_id: kiloclaw_scheduled_action_targets.user_id,
      action_type: kiloclaw_scheduled_actions.action_type,
      target_image_tag: kiloclaw_scheduled_actions.target_image_tag,
      override_pins: kiloclaw_scheduled_actions.override_pins,
      parent_status: kiloclaw_scheduled_actions.status,
      stage_scheduled_at: kiloclaw_scheduled_action_stages.scheduled_at,
    })
    .from(kiloclaw_scheduled_action_targets)
    .innerJoin(
      kiloclaw_scheduled_actions,
      eq(kiloclaw_scheduled_actions.id, kiloclaw_scheduled_action_targets.scheduled_action_id)
    )
    .innerJoin(
      kiloclaw_scheduled_action_stages,
      eq(kiloclaw_scheduled_action_stages.id, kiloclaw_scheduled_action_targets.stage_id)
    )
    .where(
      and(
        eq(kiloclaw_scheduled_action_targets.instance_id, instanceId),
        eq(kiloclaw_scheduled_action_targets.status, 'pending'),
        lte(kiloclaw_scheduled_action_stages.scheduled_at, sql`now()`),
        inArray(kiloclaw_scheduled_actions.status, ['scheduled', 'running'])
      )
    )
    .orderBy(kiloclaw_scheduled_action_stages.scheduled_at);

  return rows.map(r => {
    // INNER JOIN on stages guarantees stage_id is non-null at runtime;
    // assert the invariant rather than `as`-casting through it. If the
    // join is ever loosened to LEFT, this throw documents what the
    // change would mean for the apply path.
    if (!r.stage_id) {
      throw new Error('findDueScheduledActionTargetsForInstance: stage_id null after INNER JOIN');
    }
    return {
      target_id: r.target_id,
      scheduled_action_id: r.scheduled_action_id,
      stage_id: r.stage_id,
      instance_id: r.instance_id,
      user_id: r.user_id,
      action_type: r.action_type,
      target_image_tag: r.target_image_tag,
      override_pins: r.override_pins,
      parent_status: r.parent_status,
    };
  });
}

/**
 * Atomically claim a pending target before the apply path dispatches
 * its side effect. Returns true iff this caller won the CAS — the row
 * transitions pending → running, and the caller is now the single
 * writer that will set the final outcome.
 *
 * Cloudflare's DO model lets a subsequent alarm() reach the handler
 * while a previous waitUntil pass is still outstanding. Without claim-
 * before-dispatch, both passes can find the same due target and both
 * fire restartMachine — only one wins the final CAS, but both side
 * effects have already started.
 *
 * Important for callers that look up "is there an in-flight action on
 * this instance?" (e.g. the conflict check in scheduleAction): you
 * must filter on `status IN ('pending', 'running')`, not just
 * 'pending'. A target in the brief window between this CAS and the
 * recordOutcome call sits in 'running' and would otherwise be missed.
 */
export async function claimScheduledActionTarget(
  db: WorkerDb,
  args: { target_id: string }
): Promise<boolean> {
  const claimed = await db
    .update(kiloclaw_scheduled_action_targets)
    .set({ status: 'running' })
    .where(
      and(
        eq(kiloclaw_scheduled_action_targets.id, args.target_id),
        eq(kiloclaw_scheduled_action_targets.status, 'pending')
      )
    )
    .returning({ id: kiloclaw_scheduled_action_targets.id });
  return claimed.length > 0;
}

/**
 * Mark a scheduled-action target with its outcome (applied / skipped /
 * failed) and bump the corresponding stage + parent counters atomically.
 *
 * Stage / parent transitions to 'completed' happen lazily — this writer
 * just records the per-target outcome and increments counters. A
 * follow-up sweep (or the next apply call when no targets remain) can
 * promote stage/parent statuses if their pending counts hit zero.
 */
export async function recordScheduledActionTargetOutcome(
  db: WorkerDb,
  args: {
    target_id: string;
    scheduled_action_id: string;
    stage_id: string;
    outcome: 'applied' | 'skipped' | 'failed';
    skip_reason?: string;
    error_message?: string;
  }
): Promise<void> {
  // All three writes (target row update + stage counter + parent counter)
  // run in a single transaction. If any one fails, all three roll back —
  // which means the target row stays 'pending' and the next apply pass
  // can re-attempt cleanly. Without the transaction wrapper, a Postgres
  // failure between the target update and the counter bumps would
  // permanently desync counters: the target would already be off
  // 'pending' so retry's CAS would no-op, and there's no other reconciler.
  await db.transaction(async tx => {
    const now = sql`now()`;

    // Use RETURNING so we can short-circuit the counter increments when
    // the CAS UPDATE was a no-op. Cloudflare's DO model lets a subsequent
    // alarm() reach the handler while a previous waitUntil pass is still
    // outstanding; both passes can call this with the same pending target,
    // only one wins the CAS, but without this guard both would still
    // increment the stage/parent counters and double-count.
    // CAS accepts either 'pending' (skip-due-to-parent-cancelled path,
    // where we haven't claimed the target) or 'running' (post-dispatch
    // path, where the apply loop just claimed it pending → running
    // before invoking the side effect).
    const updated = await tx
      .update(kiloclaw_scheduled_action_targets)
      .set({
        status: args.outcome,
        applied_at: args.outcome === 'applied' ? sql`now()` : null,
        skip_reason: args.skip_reason ?? null,
        error_message: args.error_message ?? null,
      })
      .where(
        and(
          eq(kiloclaw_scheduled_action_targets.id, args.target_id),
          inArray(kiloclaw_scheduled_action_targets.status, ['pending', 'running'])
        )
      )
      .returning({ id: kiloclaw_scheduled_action_targets.id });

    if (updated.length === 0) {
      // Another pass already claimed this target. Don't bump counters.
      return;
    }

    const counterField =
      args.outcome === 'applied'
        ? 'applied_count'
        : args.outcome === 'skipped'
          ? 'skipped_count'
          : 'failed_count';

    await tx
      .update(kiloclaw_scheduled_action_stages)
      .set({
        [counterField]: sql`${kiloclaw_scheduled_action_stages[counterField]} + 1`,
        started_at: sql`COALESCE(${kiloclaw_scheduled_action_stages.started_at}, ${now})`,
      })
      .where(eq(kiloclaw_scheduled_action_stages.id, args.stage_id));

    await tx
      .update(kiloclaw_scheduled_actions)
      .set({
        [counterField]: sql`${kiloclaw_scheduled_actions[counterField]} + 1`,
        status: sql`CASE WHEN ${kiloclaw_scheduled_actions.status} = 'scheduled' THEN 'running' ELSE ${kiloclaw_scheduled_actions.status} END`,
        started_at: sql`COALESCE(${kiloclaw_scheduled_actions.started_at}, ${now})`,
      })
      .where(eq(kiloclaw_scheduled_actions.id, args.scheduled_action_id));
  });
}

/**
 * Promote stages and parents to 'completed' when all targets have
 * resolved. Called at the end of the DO apply pass. Safe to run when no
 * targets are pending — it just no-ops on already-completed rows.
 */
export async function maybePromoteScheduledActionsToCompleted(
  db: WorkerDb,
  scheduledActionIds: string[]
): Promise<void> {
  if (scheduledActionIds.length === 0) return;

  // Build a parameterised IN list explicitly. Interpolating a bare
  // string[] into `sql\`... IN ${ids}\`` happens to work (drizzle wraps
  // the array as a tuple of positional params) but is an implicit
  // contract: if the array ever contains an SQL fragment instead of a
  // primitive, the serialisation silently changes. sql.join makes the
  // shape explicit.
  const idList = sql.join(
    scheduledActionIds.map(id => sql`${id}`),
    sql`, `
  );

  // Promotion rule: when no targets remain pending, transition to
  // 'completed' if anything was applied or skipped, otherwise 'failed'.
  // This prevents an action where every target hit a dispatch error
  // from rendering as a green "completed" badge.
  // The NOT EXISTS clause must treat both 'pending' and 'running' as
  // unresolved. Targets sit briefly in 'running' between
  // claimScheduledActionTarget and recordScheduledActionTargetOutcome;
  // if we only filter 'pending' here, a parallel apply pass on a
  // different instance under the same parent can promote prematurely
  // while another target is still mid-dispatch. Premature promotion
  // also breaks the scheduleAction conflict check (which looks at
  // parent.status IN ('scheduled', 'running')), letting a new schedule
  // race in against the still-running target.
  await db.execute(sql`
    UPDATE kiloclaw_scheduled_action_stages s
    SET status = CASE
          WHEN s.applied_count > 0 OR s.skipped_count > 0 THEN 'completed'
          ELSE 'failed'
        END,
        completed_at = COALESCE(s.completed_at, now())
    WHERE s.scheduled_action_id IN (${idList})
      AND s.status IN ('pending', 'running')
      AND NOT EXISTS (
        SELECT 1 FROM kiloclaw_scheduled_action_targets t
        WHERE t.stage_id = s.id AND t.status IN ('pending', 'running')
      )
  `);

  await db.execute(sql`
    UPDATE kiloclaw_scheduled_actions a
    SET status = CASE
          WHEN a.applied_count > 0 OR a.skipped_count > 0 THEN 'completed'
          ELSE 'failed'
        END,
        completed_at = COALESCE(a.completed_at, now())
    WHERE a.id IN (${idList})
      AND a.status IN ('scheduled', 'running')
      AND NOT EXISTS (
        SELECT 1 FROM kiloclaw_scheduled_action_targets t
        WHERE t.scheduled_action_id = a.id AND t.status IN ('pending', 'running')
      )
  `);
}

// ─── Version pins (read-only access from the DO apply path) ──────────
//
// The web layer is the canonical writer for kiloclaw_version_pins (via
// admin-kiloclaw-instances-router and the user pin UI). The worker DO
// only needs read + atomic-CAS-delete access during the version_change
// scheduled-action apply path, so the helpers here are intentionally
// scoped to that one use case.

export type VersionPinRow = {
  id: string;
  instance_id: string;
  image_tag: string;
  pinned_by: string;
  updated_at: string;
};

/**
 * Look up the active pin row for an instance (or null if none exists).
 */
export async function selectVersionPinForInstance(
  db: WorkerDb,
  instanceId: string
): Promise<VersionPinRow | null> {
  const [row] = await db
    .select({
      id: kiloclaw_version_pins.id,
      instance_id: kiloclaw_version_pins.instance_id,
      image_tag: kiloclaw_version_pins.image_tag,
      pinned_by: kiloclaw_version_pins.pinned_by,
      updated_at: kiloclaw_version_pins.updated_at,
    })
    .from(kiloclaw_version_pins)
    .where(eq(kiloclaw_version_pins.instance_id, instanceId))
    .limit(1);
  return row ?? null;
}

/**
 * Atomic compare-and-set delete for a pin row. Mirrors the three-
 * predicate guard `bulkChangeVersion.applyOne` and `restartMachine` use:
 * deletes only when (instance_id, id, updated_at) all match the row we
 * observed. If a concurrent writer modified or replaced the pin
 * between observation and delete, this returns `{ deleted: false }` so
 * the caller can mark the target skipped:pin_changed_in_flight rather
 * than silently overriding the user's fresh pin.
 */
export async function deleteVersionPinWithCAS(
  db: WorkerDb,
  observed: { instance_id: string; id: string; updated_at: string }
): Promise<{ deleted: boolean }> {
  const result = await db
    .delete(kiloclaw_version_pins)
    .where(
      and(
        eq(kiloclaw_version_pins.instance_id, observed.instance_id),
        eq(kiloclaw_version_pins.id, observed.id),
        eq(kiloclaw_version_pins.updated_at, observed.updated_at)
      )
    )
    .returning({ id: kiloclaw_version_pins.id });
  return { deleted: result.length > 0 };
}
