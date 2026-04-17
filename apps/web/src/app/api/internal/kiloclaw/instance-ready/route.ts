/**
 * Internal API Endpoint: KiloClaw Instance Ready Notification
 *
 * Called by the KiloClaw CF Worker when a user's instance first reports low
 * load (loadAvg5m < 0.1), indicating the instance is ready. Sends a one-time
 * transactional email to the user and finalizes any pending async auto-resume.
 *
 * URL: POST /api/internal/kiloclaw/instance-ready
 * Protected by X-Internal-Secret header
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, isNull, or } from 'drizzle-orm';
import { KILOCLAW_INTERNAL_API_SECRET, NEXTAUTH_URL } from '@/lib/config.server';
import { send as sendEmail } from '@/lib/email';
import { findUserById } from '@/lib/user';
import { db } from '@/lib/drizzle';
import { kiloclaw_email_log } from '@kilocode/db/schema';
import { completeAutoResumeIfReady } from '@/lib/kiloclaw/instance-lifecycle';

const BodySchema = z.object({
  userId: z.string().min(1),
  sandboxId: z.string().min(1),
  instanceId: z.string().uuid().optional(),
  shouldNotify: z.boolean().optional(),
});

const INSTANCE_READY_EMAIL_TYPE = 'claw_instance_ready';

function legacyInstanceReadyEmailType(sandboxId: string): string {
  return `claw_instance_ready:${sandboxId}`;
}

function instanceEmailLogFilter(userId: string, instanceId: string, emailType: string) {
  return and(
    eq(kiloclaw_email_log.user_id, userId),
    eq(kiloclaw_email_log.instance_id, instanceId),
    eq(kiloclaw_email_log.email_type, emailType)
  );
}

function logInstanceReady(
  level: 'info' | 'error',
  message: string,
  fields: Record<string, unknown>
) {
  const record = JSON.stringify({
    level,
    message,
    billingComponent: 'instance_ready',
    ...fields,
  });

  if (level === 'error') {
    console.error(record);
    return;
  }
  console.log(record);
}

async function hasSentCompatibleInstanceReadyEmail(
  userId: string,
  instanceId: string,
  sandboxId: string
): Promise<boolean> {
  const [existing] = await db
    .select({ id: kiloclaw_email_log.id })
    .from(kiloclaw_email_log)
    .where(
      or(
        instanceEmailLogFilter(userId, instanceId, INSTANCE_READY_EMAIL_TYPE),
        and(
          eq(kiloclaw_email_log.user_id, userId),
          isNull(kiloclaw_email_log.instance_id),
          eq(kiloclaw_email_log.email_type, legacyInstanceReadyEmailType(sandboxId))
        )
      )
    )
    .limit(1);

  return !!existing;
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('X-Internal-Secret');
  if (!KILOCLAW_INTERNAL_API_SECRET || secret !== KILOCLAW_INTERNAL_API_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rawBody: unknown = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const { userId, sandboxId, instanceId, shouldNotify } = parsed.data;

  const user = await findUserById(userId);
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const resumeState = await completeAutoResumeIfReady(userId, sandboxId, instanceId);
  if (resumeState.resumeCompleted) {
    logInstanceReady('info', 'Completed async auto-resume on instance readiness', {
      event: 'resume_completed',
      outcome: 'completed',
      userId,
      instanceId: resumeState.instanceId,
      sandboxId,
    });
  }

  // The controller calls this endpoint on every low-load checkin (for auto-resume
  // completion above), but only sets shouldNotify=true on the first readiness
  // detection per DO lifetime. Skip the email when shouldNotify is explicitly false
  // to avoid sending stale "instance ready" emails to long-running instances.
  if (shouldNotify === false) {
    return NextResponse.json({ sent: false, reason: 'not_first_ready' });
  }

  const targetInstanceId = resumeState.instanceId ?? instanceId ?? null;
  if (!targetInstanceId) {
    logInstanceReady(
      'error',
      'Instance-ready email skipped because instance could not be resolved',
      {
        event: 'instance_ready_email_skipped',
        outcome: 'skipped',
        userId,
        sandboxId,
      }
    );
    return NextResponse.json({ sent: false, reason: 'instance_unresolved' });
  }

  if (await hasSentCompatibleInstanceReadyEmail(userId, targetInstanceId, sandboxId)) {
    return NextResponse.json({ sent: false, reason: 'already_sent' });
  }

  // Idempotent: insert-before-send with rollback on failure (matches billing cron pattern).
  const result = await db
    .insert(kiloclaw_email_log)
    .values({
      user_id: userId,
      instance_id: targetInstanceId,
      email_type: INSTANCE_READY_EMAIL_TYPE,
    })
    .onConflictDoNothing();

  if (result.rowCount === 0) {
    return NextResponse.json({ sent: false, reason: 'already_sent' });
  }

  try {
    await sendEmail({
      to: user.google_user_email,
      templateName: 'clawInstanceReady',
      templateVars: { claw_url: `${NEXTAUTH_URL}/claw` },
    });
  } catch (error) {
    // Roll back the email log entry so the next attempt can retry.
    try {
      await db
        .delete(kiloclaw_email_log)
        .where(instanceEmailLogFilter(userId, targetInstanceId, INSTANCE_READY_EMAIL_TYPE));
    } catch (deleteError) {
      logInstanceReady('error', 'Failed to roll back instance-ready email log after send failure', {
        event: 'email_rollback_failed',
        outcome: 'failed',
        userId,
        instanceId: resumeState.instanceId,
        sandboxId,
        error: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
    }
    logInstanceReady('error', 'Instance-ready email send failed', {
      event: 'instance_ready_email_failed',
      outcome: 'failed',
      userId,
      instanceId: resumeState.instanceId,
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Email send failed' }, { status: 502 });
  }

  return NextResponse.json({ sent: true });
}
