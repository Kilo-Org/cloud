/**
 * Internal API Endpoint: KiloClaw Instance Ready Notification
 *
 * Called by the KiloClaw CF Worker when a user's instance first reports low
 * load (loadAvg5m < 0.1), indicating the instance is ready. Sends a one-time
 * transactional email to the user.
 *
 * URL: POST /api/internal/kiloclaw/instance-ready
 * Protected by X-Internal-Secret header
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { KILOCLAW_INTERNAL_API_SECRET, NEXTAUTH_URL } from '@/lib/config.server';
import { send as sendEmail } from '@/lib/email';
import { findUserById } from '@/lib/user';
import { db } from '@/lib/drizzle';
import { kiloclaw_email_log } from '@kilocode/db/schema';

const BodySchema = z.object({
  userId: z.string().min(1),
  sandboxId: z.string().min(1),
});

/** Per-instance email type key. Includes sandboxId to support future multi-instance. */
function emailTypeKey(sandboxId: string): string {
  return `claw_instance_ready:${sandboxId}`;
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

  const { userId, sandboxId } = parsed.data;
  const emailType = emailTypeKey(sandboxId);

  const user = await findUserById(userId);
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // Idempotent: insert-before-send with rollback on failure (matches billing cron pattern).
  const result = await db
    .insert(kiloclaw_email_log)
    .values({ user_id: userId, email_type: emailType })
    .onConflictDoNothing();

  if (result.rowCount === 0) {
    // Already sent for this instance — skip.
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
        .where(
          and(eq(kiloclaw_email_log.user_id, userId), eq(kiloclaw_email_log.email_type, emailType))
        );
    } catch (deleteError) {
      console.error(
        '[instance-ready] Failed to roll back email log after send failure:',
        deleteError
      );
    }
    console.error('[instance-ready] Email send failed:', error);
    return NextResponse.json({ error: 'Email send failed' }, { status: 502 });
  }

  return NextResponse.json({ sent: true });
}
