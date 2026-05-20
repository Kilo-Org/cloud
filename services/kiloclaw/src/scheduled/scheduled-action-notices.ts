/**
 * Notice sweep for the scheduled-action framework.
 *
 * Runs from the kiloclaw worker's `scheduled()` handler at a 1-minute
 * cadence. Selects pending notification rows whose dispatch window has
 * opened (`now() >= stage.scheduled_at - parent.notice_lead_hours`),
 * fans them out to the backend's internal side-effects endpoint, and
 * records the per-row outcome (`sent` or `failed`).
 *
 * Why this lives in the kiloclaw worker rather than the web layer: the
 * cron lives somewhere that already has Hyperdrive + the catalog + the
 * scheduled-action tables in scope, and the dispatch itself fans out
 * across multiple users (so it can't be a per-DO alarm). The actual
 * side effect (sending the email / push / banner state) lives behind a
 * web HTTP endpoint so the email and push code stays where it has been.
 *
 * Failure handling is deliberately simple in v1:
 *   - Each notification dispatches independently. One failed channel
 *     does not affect siblings.
 *   - On success: row goes to status='sent', sent_at=now().
 *   - On dispatch error: row goes to status='failed', error_message
 *     stamped. We do not retry — admins can see failures in the
 *     scheduled-action detail view and decide what to do.
 *   - On sweeper crash between successful dispatch and markSent: the
 *     row stays 'pending' and will be re-dispatched on the next tick.
 *     The CAS in markSent (WHERE status='pending') is the only barrier
 *     to a duplicate email — there is no kiloclaw_email_log dedup on
 *     this path. Acceptable for v1: the crash window is small (single
 *     DB round-trip after the HTTP call returns) and a duplicate
 *     "your bot is scheduled to upgrade" email is mildly noisy but
 *     not harmful. If this turns out to matter, the side-effects route
 *     can grow a kiloclaw_email_log entry keyed on notificationId.
 */

import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  kiloclaw_scheduled_action_notifications,
  kiloclaw_scheduled_action_targets,
  kiloclaw_scheduled_action_stages,
  kiloclaw_scheduled_actions,
  kiloclaw_instances,
  kiloclaw_image_catalog,
  kilocode_users,
} from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { KiloClawEnv } from '../types';

// Cap how many notifications we dispatch per tick. Bounds the worst
// case time of a single sweep (each dispatch is one HTTP round-trip)
// and keeps a single misbehaving channel from blocking forever. The
// next tick picks up whatever's left.
const MAX_NOTIFICATIONS_PER_TICK = 100;

// Concurrent dispatches inside a single tick. Each dispatch is its
// own HTTP/RPC round-trip, so serial processing of 100 rows at ~200ms
// each would push tick duration to ~20s and crowd the next 1-minute
// cron. Batched concurrency drops it to ~2s for 100 rows. Per-row
// try/catch in the loop keeps one slow dispatch from blocking siblings
// in the same batch.
const DISPATCH_CONCURRENCY = 10;

// How long a 'sending' row must sit before recovery considers it
// stuck. Must be longer than the longest realistic tick duration so
// in-flight claims from the current tick aren't reset by a parallel
// recovery on the next tick.
//
// Worst-case tick budget: MAX_NOTIFICATIONS_PER_TICK / DISPATCH_CONCURRENCY
// = 10 batches; each batch dispatches up to 10 rows in parallel and
// each dispatch is bounded by DISPATCH_TIMEOUT_MS = 10s. So the
// theoretical max tick is ~100s (10 batches × 10s each). 5 minutes
// is comfortably above that, with headroom for the cron's 1-minute
// cadence + a slow upstream blocking past the timeout deadline.
const STUCK_CLAIM_RECOVERY_MINUTES = 5;

// Per-dispatch timeout. Cloudflare allows subrequests to hold open up to
// 900s; without this, a hung BACKEND_API_URL or upstream Mailgun would
// block all DISPATCH_CONCURRENCY workers in a batch and stall subsequent
// batches in the same tick. 10s is generous for an internal POST that
// only renders + sends an email.
const DISPATCH_TIMEOUT_MS = 10_000;

// Zod-validated at the dispatch boundary so a Drizzle type widening
// (or a schema-shape drift in selectDueNotifications) is caught
// loudly with a parse error rather than silently passing a malformed
// row into channel-specific dispatchers. Per-tick rows are bounded
// by MAX_NOTIFICATIONS_PER_TICK so the parse cost is negligible.
const DueNotificationRowSchema = z.object({
  notification_id: z.string(),
  notification_kind: z.enum(['notice', 'cancelled']),
  notification_channel: z.enum(['email', 'webapp', 'mobile_push', 'agent']),
  target_id: z.string(),
  scheduled_action_id: z.string(),
  action_type: z.enum(['scheduled_restart', 'version_change']),
  // From the target row (always present; FK NOT NULL).
  user_id: z.string(),
  // Null when the joined kilocode_users row is missing (e.g. a hard-
  // delete bypassed the GDPR anonymize-only flow). Used as a sentinel
  // to fail the dispatch instead of looping the orphan row forever.
  user_record_id: z.string().nullable(),
  user_email: z.string().nullable(),
  user_name: z.string().nullable(),
  instance_id: z.string(),
  instance_sandbox_id: z.string(),
  instance_name: z.string().nullable(),
  source_image_tag: z.string().nullable(),
  source_openclaw_version: z.string().nullable(),
  target_image_tag: z.string().nullable(),
  target_openclaw_version: z.string().nullable(),
  override_pins: z.boolean(),
  scheduled_at: z.string(),
  notice_lead_hours: z.number(),
  notice_subject: z.string(),
  notice_body: z.string(),
  reason: z.string().nullable(),
});

type DueNotificationRow = z.infer<typeof DueNotificationRowSchema>;

export type SweepResult = {
  processed: number;
  sent: number;
  failed: number;
  recovered: number;
  voidedStale: number;
};

/**
 * Pure orchestration interface for the sweep. The DB-backed and
 * worker-binding-backed implementations live in the entry point below;
 * tests inject their own implementations via runSweepWithIO to verify
 * the orchestration logic without a real Postgres or NOTIFICATIONS
 * service binding.
 */
export type SweepIO = {
  /** Reset stuck 'sending' rows from prior crashed sweeps to 'pending'. */
  recoverStuckClaims(): Promise<number>;
  /**
   * Finalize pending notice rows whose parent target/action/stage left
   * valid pre-apply states. The claim CAS already prevents stale
   * dispatch, but a row that lost the claim race because the parent
   * moved would otherwise sit 'pending' forever (selectDue filters
   * them out, claim refuses them). This step gives those rows a
   * terminal status so the lifecycle stays clean.
   */
  voidStaleParents(): Promise<number>;
  /** Select pending rows whose notice window has opened. */
  selectDue(): Promise<DueNotificationRow[]>;
  /**
   * Atomic CAS pending → sending. Returns true iff this call won the
   * claim. Takes the full row so the claim can re-validate parent
   * (target/action/stage) state for `kind='notice'` rows in the same
   * UPDATE — closes the TOCTOU window between selectDue and claim
   * where the apply path could otherwise drive the target through
   * pending → running → applied while we hold an in-flight notice.
   */
  claim(row: DueNotificationRow): Promise<boolean>;
  /**
   * CAS sending → sent on the notification row. Takes the full row so
   * that for kind='notice' we can also queue a cancellation row in the
   * same DB round-trip if the parent action moved to 'cancelled' while
   * we were dispatching. Coupling the cancellation creation to the
   * actual notice success means a dispatch failure leaves no orphan
   * cancellation queued — the cancellation only exists if the user
   * actually got the original notice.
   */
  markSent(row: DueNotificationRow): Promise<void>;
  markFailed(notificationId: string, error: string): Promise<void>;
  /** Channel-specific dispatch (HTTP/RPC). Returns ok/fail per row. */
  dispatchOne(row: DueNotificationRow): Promise<{ ok: true } | { ok: false; error: string }>;
};

/**
 * Testable orchestrator. Concurrent batches via Promise.allSettled.
 *
 * Per-row flow inside a batch:
 *   1. claim() — CAS pending → sending. If 0 rows updated (another
 *      sweep already claimed), skip silently. This is what prevents
 *      duplicate dispatch when two cron ticks overlap.
 *   2. dispatchOne() — fire the channel-specific side effect.
 *   3. markSent() / markFailed() — final transition. CAS WHERE
 *      status='sending' inside; ignored if recovery already reset
 *      this row to pending (extremely unlikely given the recovery
 *      threshold).
 *   4. The mark step is wrapped in try/catch so a transient DB error
 *      doesn't abort the rest of the batch. The dispatched side
 *      effect is durable; on a mark failure the row stays in
 *      'sending' until recovery resets it on a future tick.
 */
export async function runSweepWithIO(io: SweepIO): Promise<SweepResult> {
  const recovered = await io.recoverStuckClaims();
  const voidedStale = await io.voidStaleParents();
  const due = await io.selectDue();
  if (due.length === 0) return { processed: 0, sent: 0, failed: 0, recovered, voidedStale };

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < due.length; i += DISPATCH_CONCURRENCY) {
    const batch = due.slice(i, i + DISPATCH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async row => {
        const claimed = await io.claim(row);
        if (!claimed) {
          // Either another concurrent sweep tick won the claim, OR
          // the apply path raced ahead and the parent target is no
          // longer pending. Either way, skip silently — the winning
          // sweep handles the final outcome, and the stale-notice
          // case is exactly what the parent-state gate inside claim
          // is preventing.
          return { kind: 'skipped' as const };
        }
        const dispatchResult = await io.dispatchOne(row);
        try {
          if (dispatchResult.ok) {
            await io.markSent(row);
            return { kind: 'sent' as const };
          }
          await io.markFailed(row.notification_id, dispatchResult.error);
          return { kind: 'failed' as const };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[notices-sweep] failed to mark notification status', {
            notificationId: row.notification_id,
            error: msg,
          });
          return { kind: 'failed' as const };
        }
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value.kind === 'sent') sent += 1;
        else if (r.value.kind === 'failed') failed += 1;
        // 'skipped' rows neither sent nor failed; they belong to the
        // sweep that won the claim.
      } else {
        // Defensive: the inner branches all return rather than throw,
        // but if claim() or dispatchOne() throws synchronously the
        // rejection lands here. Count as failed; the row stays in
        // whatever state it was in (pending if claim threw, sending if
        // dispatch threw and recovery will reset).
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.error('[notices-sweep] dispatch settle rejected', { error: reason });
        failed += 1;
      }
    }
  }

  return { processed: due.length, sent, failed, recovered, voidedStale };
}

export async function runScheduledActionNoticesSweep(env: KiloClawEnv): Promise<SweepResult> {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    console.warn('[notices-sweep] HYPERDRIVE not bound; skipping');
    return { processed: 0, sent: 0, failed: 0, recovered: 0, voidedStale: 0 };
  }
  if (!env.BACKEND_API_URL || !env.INTERNAL_API_SECRET) {
    console.warn('[notices-sweep] BACKEND_API_URL or internal secret missing; skipping');
    return { processed: 0, sent: 0, failed: 0, recovered: 0, voidedStale: 0 };
  }

  const db = getWorkerDb(connectionString);

  const io: SweepIO = {
    recoverStuckClaims: () => recoverStuckClaims(db),
    voidStaleParents: () => voidStaleParents(db),
    selectDue: () => selectDueNotifications(db),
    claim: row => claimNotification(db, row),
    markSent: row => markSent(db, row),
    markFailed: (id, error) => markFailed(db, id, error),
    dispatchOne: row => dispatchOne(env, row),
  };
  return runSweepWithIO(io);
}

async function selectDueNotifications(db: WorkerDb): Promise<DueNotificationRow[]> {
  // Single query joining everything the dispatcher needs to render its
  // payload. Avoids N round-trips inside the sweep loop. Filter on
  // notice_lead_hours — for kind='cancelled' rows the lead doesn't apply
  // (we want to send those right away), so the predicate is
  // OR-shaped on kind. Image catalog joins are LEFT so a deleted
  // catalog row doesn't drop the notification.
  const rows = await db
    .select({
      notification_id: kiloclaw_scheduled_action_notifications.id,
      notification_kind: kiloclaw_scheduled_action_notifications.kind,
      notification_channel: kiloclaw_scheduled_action_notifications.channel,
      target_id: kiloclaw_scheduled_action_targets.id,
      scheduled_action_id: kiloclaw_scheduled_actions.id,
      action_type: kiloclaw_scheduled_actions.action_type,
      user_id: kiloclaw_scheduled_action_targets.user_id,
      user_record_id: kilocode_users.id,
      user_email: kilocode_users.google_user_email,
      user_name: kilocode_users.google_user_name,
      instance_id: kiloclaw_instances.id,
      instance_sandbox_id: kiloclaw_instances.sandbox_id,
      instance_name: kiloclaw_instances.name,
      source_image_tag: kiloclaw_scheduled_action_targets.source_image_tag,
      source_openclaw_version: sql<string | null>`source_catalog.openclaw_version`,
      target_image_tag: kiloclaw_scheduled_action_targets.target_image_tag,
      target_openclaw_version: sql<string | null>`target_catalog.openclaw_version`,
      override_pins: kiloclaw_scheduled_actions.override_pins,
      scheduled_at: kiloclaw_scheduled_action_stages.scheduled_at,
      notice_lead_hours: kiloclaw_scheduled_actions.notice_lead_hours,
      notice_subject: kiloclaw_scheduled_actions.notice_subject,
      notice_body: kiloclaw_scheduled_actions.notice_body,
      reason: kiloclaw_scheduled_actions.reason,
    })
    .from(kiloclaw_scheduled_action_notifications)
    .innerJoin(
      kiloclaw_scheduled_action_targets,
      eq(kiloclaw_scheduled_action_targets.id, kiloclaw_scheduled_action_notifications.target_id)
    )
    .innerJoin(
      kiloclaw_scheduled_action_stages,
      eq(kiloclaw_scheduled_action_stages.id, kiloclaw_scheduled_action_targets.stage_id)
    )
    .innerJoin(
      kiloclaw_scheduled_actions,
      eq(kiloclaw_scheduled_actions.id, kiloclaw_scheduled_action_targets.scheduled_action_id)
    )
    // leftJoin (not inner) so an orphaned target — e.g. user record
    // hard-deleted out from under us, bypassing the GDPR
    // anonymize-only flow — still surfaces and can be marked failed
    // by dispatchOne. An inner join would silently drop it and the
    // row would loop forever in 'pending'.
    .leftJoin(kilocode_users, eq(kilocode_users.id, kiloclaw_scheduled_action_targets.user_id))
    .innerJoin(
      kiloclaw_instances,
      eq(kiloclaw_instances.id, kiloclaw_scheduled_action_targets.instance_id)
    )
    .leftJoin(
      sql`${kiloclaw_image_catalog} AS source_catalog`,
      sql`source_catalog.image_tag = ${kiloclaw_scheduled_action_targets.source_image_tag}`
    )
    .leftJoin(
      sql`${kiloclaw_image_catalog} AS target_catalog`,
      sql`target_catalog.image_tag = ${kiloclaw_scheduled_action_targets.target_image_tag}`
    )
    .where(
      and(
        eq(kiloclaw_scheduled_action_notifications.status, 'pending'),
        // 'cancelled' rows fire on the next tick regardless of lead time
        // or parent state — they announce "the previously-noticed action
        // is now off". 'notice' rows additionally require:
        //   - The lead-time window has opened (now >= scheduled_at - lead).
        //   - The target is still pending (action hasn't applied yet).
        //   - The parent action is still scheduled or running (not
        //     completed/cancelled/failed).
        //   - The stage is still pending or running.
        // Without those gates a 'notice' row could fire AFTER the action
        // already applied (e.g. sweep delayed past apply, or
        // notice_lead_hours=0): the user would receive a "your bot will
        // restart soon" message for an action that already ran. The
        // cancellation path explicitly voids pending notices to handle
        // its own race; the apply-path equivalent is handled here at
        // query time so we don't have to mutate notification rows from
        // every place a target completes.
        sql`(
          ${kiloclaw_scheduled_action_notifications.kind} = 'cancelled'
          OR (
            now() >= (${kiloclaw_scheduled_action_stages.scheduled_at}::timestamptz - (${kiloclaw_scheduled_actions.notice_lead_hours} * interval '1 hour'))
            AND ${kiloclaw_scheduled_action_targets.status} = 'pending'
            AND ${kiloclaw_scheduled_actions.status} IN ('scheduled', 'running')
            AND ${kiloclaw_scheduled_action_stages.status} IN ('pending', 'running')
          )
        )`
      )
    )
    .orderBy(kiloclaw_scheduled_action_stages.scheduled_at)
    .limit(MAX_NOTIFICATIONS_PER_TICK);

  // Validate at the boundary instead of casting. If a Drizzle upgrade
  // ever widens a column type, or a schema migration changes a shape
  // out from under us, parse errors here are loud and traceable. A
  // single malformed row drops the whole tick — better than silently
  // routing bad data into dispatch where it would corrupt downstream
  // state. The parse runs on at most MAX_NOTIFICATIONS_PER_TICK rows.
  return rows.map(row => DueNotificationRowSchema.parse(row));
}

export async function dispatchOne(
  env: KiloClawEnv,
  row: DueNotificationRow
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Orphaned target — kilocode_users row missing for the FK. Fail
  // every channel uniformly so the row exits the pending pool with
  // a legible error_message instead of looping forever. Webapp/agent
  // also fail here even though they don't strictly need a user record:
  // the banner queries getStatus by instance, but if the user is gone
  // the parent surface is gone too, so there's nothing to render.
  if (row.user_record_id === null) {
    return { ok: false, error: `kilocode_users row missing for user_id=${row.user_id}` };
  }
  switch (row.notification_channel) {
    case 'email':
      // Email goes through the web internal endpoint because the email
      // log + send infra lives in the web app.
      return dispatchEmail(env, row);
    case 'mobile_push':
      // Direct RPC to the notifications service. Worker-to-worker, no
      // round-trip through web.
      return dispatchMobilePush(env, row);
    case 'webapp':
      // No-op dispatch — the banner reads its state from
      // `kiloclaw.getStatus.scheduledAction` on each poll, so we just
      // mark the row sent immediately. The fact that a row exists IS
      // the user-visible artifact (a notice row in 'sent' tells the
      // banner what to show; a 'cancelled' row hides it).
      return { ok: true };
    case 'agent':
      // Reserved for a follow-up PR (kilo-chat sendSystemNotice RPC).
      // Mark failed so an inadvertently-inserted row doesn't sit
      // pending forever.
      return { ok: false, error: 'agent channel not implemented' };
  }
}

async function dispatchEmail(
  env: KiloClawEnv,
  row: DueNotificationRow
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Narrow the optional bindings explicitly. The entry-point
  // runScheduledActionNoticesSweep already returns early when either
  // is missing, so in production this guard is dead code — but
  // dispatchOne is exported for unit tests that pass {} as KiloClawEnv,
  // and a future refactor of the entry-point shouldn't be able to
  // silently send an empty 'X-Internal-Secret' header (which the
  // backend would 401, marking every row failed with an opaque
  // 'dispatcher 401' instead of skipping the sweep loudly).
  if (!env.BACKEND_API_URL || !env.INTERNAL_API_SECRET) {
    return { ok: false, error: 'BACKEND_API_URL or internal secret not bound' };
  }
  try {
    const res = await fetch(
      `${env.BACKEND_API_URL}/api/internal/kiloclaw/scheduled-action-side-effects`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': env.INTERNAL_API_SECRET,
        },
        body: JSON.stringify({
          notificationId: row.notification_id,
          kind: row.notification_kind,
          channel: row.notification_channel,
          targetId: row.target_id,
          scheduledActionId: row.scheduled_action_id,
          actionType: row.action_type,
          userId: row.user_id,
          userEmail: row.user_email,
          userName: row.user_name,
          instanceId: row.instance_id,
          instanceSandboxId: row.instance_sandbox_id,
          instanceName: row.instance_name,
          sourceImageTag: row.source_image_tag,
          sourceOpenclawVersion: row.source_openclaw_version,
          targetImageTag: row.target_image_tag,
          targetOpenclawVersion: row.target_openclaw_version,
          overridePins: row.override_pins,
          scheduledAt: row.scheduled_at,
          noticeLeadHours: row.notice_lead_hours,
          noticeSubject: row.notice_subject,
          noticeBody: row.notice_body,
          reason: row.reason,
        }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `dispatcher ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

async function dispatchMobilePush(
  env: KiloClawEnv,
  row: DueNotificationRow
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!env.NOTIFICATIONS) {
    return { ok: false, error: 'NOTIFICATIONS binding not bound' };
  }
  try {
    const event = mobilePushEventFor(row.action_type, row.notification_kind);
    await env.NOTIFICATIONS.sendScheduledActionNotice({
      userId: row.user_id,
      instanceId: row.instance_sandbox_id,
      sandboxId: row.instance_sandbox_id,
      event,
      instanceName: row.instance_name,
      scheduledAt: row.scheduled_at,
      targetImageTag: row.target_image_tag,
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

function mobilePushEventFor(
  actionType: 'scheduled_restart' | 'version_change',
  kind: 'notice' | 'cancelled'
):
  | 'scheduled_restart_notice'
  | 'scheduled_restart_cancelled'
  | 'scheduled_version_change_notice'
  | 'scheduled_version_change_cancelled' {
  if (actionType === 'scheduled_restart') {
    return kind === 'notice' ? 'scheduled_restart_notice' : 'scheduled_restart_cancelled';
  }
  return kind === 'notice'
    ? 'scheduled_version_change_notice'
    : 'scheduled_version_change_cancelled';
}

/**
 * CAS pending → sending. Returns true iff this call won the claim, i.e.
 * the row was 'pending' at execution time AND (for `kind='notice'`) the
 * parent target/action/stage are still in pre-apply states.
 *
 * The parent-state gate inside the CAS closes the TOCTOU window between
 * selectDueNotifications and the dispatch — if the apply path won the
 * race and moved target.status pending → running between selection and
 * claim, the EXISTS subquery here returns false and the CAS doesn't fire.
 * Without this gate, a notice could be claimed and dispatched for an
 * action that already started or finished applying.
 *
 * `kind='cancelled'` rows skip the parent-state gate — those announce
 * "the previously-noticed action is now off" and must fire regardless
 * of whether the target moved to applied/skipped/failed.
 *
 * Returning false means: another concurrent sweep won the claim, OR
 * the apply path raced ahead, OR recovery reset the row to pending after
 * a prior crash. The caller skips dispatch in all three cases.
 */
async function claimNotification(db: WorkerDb, row: DueNotificationRow): Promise<boolean> {
  const parentStateGate =
    row.notification_kind === 'cancelled'
      ? sql`true`
      : sql`EXISTS (
          SELECT 1
          FROM ${kiloclaw_scheduled_action_targets} t
          INNER JOIN ${kiloclaw_scheduled_actions} a ON a.id = t.scheduled_action_id
          INNER JOIN ${kiloclaw_scheduled_action_stages} s ON s.id = t.stage_id
          WHERE t.id = ${row.target_id}
            AND t.status = 'pending'
            AND a.status IN ('scheduled', 'running')
            AND s.status IN ('pending', 'running')
        )`;

  const updated = await db
    .update(kiloclaw_scheduled_action_notifications)
    .set({ status: 'sending', claimed_at: sql`now()` })
    .where(
      and(
        eq(kiloclaw_scheduled_action_notifications.id, row.notification_id),
        eq(kiloclaw_scheduled_action_notifications.status, 'pending'),
        parentStateGate
      )
    )
    .returning({ id: kiloclaw_scheduled_action_notifications.id });
  return updated.length > 0;
}

/**
 * Mark pending 'notice' rows whose parent target/action/stage left
 * pre-apply states as 'failed'. The claim CAS already prevents stale
 * dispatch when the parent moved between selectDue and claim, but the
 * row would otherwise stay 'pending' forever since selectDue and claim
 * both refuse it. This step gives stale rows a terminal status so the
 * lifecycle stays clean. Idempotent. 'cancelled' rows are skipped —
 * they fire regardless of parent state.
 */
async function voidStaleParents(db: WorkerDb): Promise<number> {
  const reset = await db
    .update(kiloclaw_scheduled_action_notifications)
    .set({
      status: 'failed',
      error_message: 'parent state changed before notice was dispatched',
    })
    .where(
      and(
        eq(kiloclaw_scheduled_action_notifications.status, 'pending'),
        eq(kiloclaw_scheduled_action_notifications.kind, 'notice'),
        sql`NOT EXISTS (
          SELECT 1
          FROM ${kiloclaw_scheduled_action_targets} t
          INNER JOIN ${kiloclaw_scheduled_actions} a ON a.id = t.scheduled_action_id
          INNER JOIN ${kiloclaw_scheduled_action_stages} s ON s.id = t.stage_id
          WHERE t.id = ${kiloclaw_scheduled_action_notifications.target_id}
            AND t.status = 'pending'
            AND a.status IN ('scheduled', 'running')
            AND s.status IN ('pending', 'running')
        )`
      )
    )
    .returning({ id: kiloclaw_scheduled_action_notifications.id });
  return reset.length;
}

/**
 * Reset rows that have been 'sending' longer than the recovery threshold
 * back to 'pending'. Without this, a sweep that crashed after CAS-claiming
 * a row but before markSent/markFailed would leave the row stranded in
 * 'sending' forever. Returns the number of rows reset for sweep telemetry.
 */
async function recoverStuckClaims(db: WorkerDb): Promise<number> {
  const reset = await db
    .update(kiloclaw_scheduled_action_notifications)
    .set({ status: 'pending', claimed_at: null })
    .where(
      and(
        eq(kiloclaw_scheduled_action_notifications.status, 'sending'),
        sql`${kiloclaw_scheduled_action_notifications.claimed_at} < now() - (${STUCK_CLAIM_RECOVERY_MINUTES} * interval '1 minute')`
      )
    )
    .returning({ id: kiloclaw_scheduled_action_notifications.id });
  return reset.length;
}

async function markSent(db: WorkerDb, row: DueNotificationRow): Promise<void> {
  // Two operations chained atomically via CTE:
  //   1. CAS WHERE status='sending' — only the sweep that claimed this
  //      row (and hasn't been recovered as stuck) can finalize it.
  //   2. If the row was a notice AND the parent action is already
  //      'cancelled' (admin cancelled while we were dispatching), queue
  //      the cancellation row in the same step. Coupling cancellation
  //      creation to a successful markSent means a dispatch failure
  //      leaves no orphan cancellation; the cancellation row only
  //      exists when the user actually received the original notice.
  // ON CONFLICT keeps the insert idempotent against a separate cancel
  // transaction that already queued the cancellation from a 'sent' row.
  await db.execute(sql`
    WITH finalized AS (
      UPDATE kiloclaw_scheduled_action_notifications
      SET status = 'sent', sent_at = now()
      WHERE id = ${row.notification_id}
        AND status = 'sending'
      RETURNING target_id, channel, kind
    )
    INSERT INTO kiloclaw_scheduled_action_notifications
      (target_id, channel, kind, status)
    SELECT f.target_id, f.channel, 'cancelled', 'pending'
    FROM finalized f
    INNER JOIN kiloclaw_scheduled_action_targets t ON t.id = f.target_id
    INNER JOIN kiloclaw_scheduled_actions a ON a.id = t.scheduled_action_id
    WHERE f.kind = 'notice'
      AND a.status = 'cancelled'
    ON CONFLICT (target_id, kind, channel) DO NOTHING
  `);
}

async function markFailed(
  db: WorkerDb,
  notificationId: string,
  errorMessage: string
): Promise<void> {
  await db
    .update(kiloclaw_scheduled_action_notifications)
    .set({ status: 'failed', error_message: errorMessage })
    .where(
      and(
        eq(kiloclaw_scheduled_action_notifications.id, notificationId),
        eq(kiloclaw_scheduled_action_notifications.status, 'sending')
      )
    );
}
