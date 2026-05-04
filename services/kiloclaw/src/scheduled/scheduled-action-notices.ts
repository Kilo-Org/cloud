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
 *   - On sweeper crash mid-dispatch: row stays 'pending' and will be
 *     retried on the next tick. The email channel's existing
 *     `kiloclaw_email_log` idempotency filter prevents duplicate
 *     emails; mobile push duplicates are rare and not catastrophic
 *     given the 1-minute cadence.
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
import type { KiloClawEnv } from '../types';

// Cap how many notifications we dispatch per tick. Bounds the worst
// case time of a single sweep (each dispatch is one HTTP round-trip)
// and keeps a single misbehaving channel from blocking forever. The
// next tick picks up whatever's left.
const MAX_NOTIFICATIONS_PER_TICK = 100;

type DueNotificationRow = {
  notification_id: string;
  notification_kind: 'notice' | 'cancelled';
  notification_channel: 'email' | 'webapp' | 'mobile_push' | 'agent';
  target_id: string;
  scheduled_action_id: string;
  action_type: 'scheduled_restart' | 'version_change';
  user_id: string;
  user_email: string | null;
  user_name: string | null;
  instance_id: string;
  instance_sandbox_id: string;
  instance_name: string | null;
  source_image_tag: string | null;
  source_openclaw_version: string | null;
  target_image_tag: string | null;
  target_openclaw_version: string | null;
  override_pins: boolean;
  scheduled_at: string;
  notice_lead_hours: number;
  notice_subject: string;
  notice_body: string;
  reason: string | null;
};

export async function runScheduledActionNoticesSweep(env: KiloClawEnv): Promise<{
  processed: number;
  sent: number;
  failed: number;
}> {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    console.warn('[notices-sweep] HYPERDRIVE not bound; skipping');
    return { processed: 0, sent: 0, failed: 0 };
  }
  if (!env.BACKEND_API_URL || !env.KILOCLAW_INTERNAL_API_SECRET) {
    console.warn('[notices-sweep] BACKEND_API_URL or internal secret missing; skipping');
    return { processed: 0, sent: 0, failed: 0 };
  }

  const db = getWorkerDb(connectionString);

  const due = await selectDueNotifications(db);
  if (due.length === 0) return { processed: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  for (const row of due) {
    const result = await dispatchOne(env, row);
    if (result.ok) {
      await markSent(db, row.notification_id);
      sent += 1;
    } else {
      await markFailed(db, row.notification_id, result.error);
      failed += 1;
    }
  }

  return { processed: due.length, sent, failed };
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
      user_id: kilocode_users.id,
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
    .innerJoin(kilocode_users, eq(kilocode_users.id, kiloclaw_scheduled_action_targets.user_id))
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
        sql`(
          ${kiloclaw_scheduled_action_notifications.kind} = 'cancelled'
          OR now() >= (${kiloclaw_scheduled_action_stages.scheduled_at}::timestamptz - (${kiloclaw_scheduled_actions.notice_lead_hours} * interval '1 hour'))
        )`
      )
    )
    .orderBy(kiloclaw_scheduled_action_stages.scheduled_at)
    .limit(MAX_NOTIFICATIONS_PER_TICK);

  return rows as DueNotificationRow[];
}

async function dispatchOne(
  env: KiloClawEnv,
  row: DueNotificationRow
): Promise<{ ok: true } | { ok: false; error: string }> {
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
  try {
    const res = await fetch(
      `${env.BACKEND_API_URL}/api/internal/kiloclaw/scheduled-action-side-effects`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': env.KILOCLAW_INTERNAL_API_SECRET ?? '',
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

async function markSent(db: WorkerDb, notificationId: string): Promise<void> {
  // CAS WHERE status='pending' so an overlapping sweeper can't move
  // a 'failed' or already-'sent' row.
  await db
    .update(kiloclaw_scheduled_action_notifications)
    .set({ status: 'sent', sent_at: sql`now()` })
    .where(
      and(
        eq(kiloclaw_scheduled_action_notifications.id, notificationId),
        eq(kiloclaw_scheduled_action_notifications.status, 'pending')
      )
    );
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
        eq(kiloclaw_scheduled_action_notifications.status, 'pending')
      )
    );
}
