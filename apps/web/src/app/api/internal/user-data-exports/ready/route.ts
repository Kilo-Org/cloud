import { timingSafeEqual } from '@kilocode/encryption';
import { sql } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { sendUserDataExportReadyEmail } from '@/lib/email';
import { markDelivery, markRetryableDelivery } from './delivery-state';

const BodySchema = z.object({ exportId: z.string().uuid() }).strict();
const MAX_EMAIL_ATTEMPTS = 4;
const executeDeliveryState = (query: ReturnType<typeof sql>) =>
  db.execute<{ id: string }>(query).then(result => ({ rows: result.rows }));

type ClaimedExport = {
  id: string;
  email: string | null;
  expires_at: string;
  email_lease_token: string;
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = request.headers.get('x-internal-api-key');
  if (!INTERNAL_API_SECRET || !secret || !timingSafeEqual(secret, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const { rows } = await db.execute<ClaimedExport>(sql`
    WITH claimed AS (
      UPDATE user_data_exports
      SET email_status = 'sending', email_lease_token = gen_random_uuid(),
        email_lease_expires_at = now() + interval '10 minutes',
        email_attempt_count = email_attempt_count + 1, updated_at = now()
      WHERE id = ${parsed.data.exportId}
        AND status = 'ready' AND expires_at > now()
        AND email_attempt_count < ${MAX_EMAIL_ATTEMPTS}
        AND (email_status = 'pending' OR (email_status = 'sending' AND email_lease_expires_at < now()))
      RETURNING id, kilo_user_id, expires_at, email_lease_token
    )
    SELECT claimed.id, kilocode_users.google_user_email AS email, claimed.expires_at,
      claimed.email_lease_token
    FROM claimed INNER JOIN kilocode_users ON kilocode_users.id = claimed.kilo_user_id
  `);
  const claimed = rows[0];
  if (!claimed) return NextResponse.json({ outcome: 'cancelled' });
  if (!claimed.email) {
    const retainedLease = await markDelivery(
      executeDeliveryState,
      claimed.id,
      claimed.email_lease_token,
      'failed'
    );
    if (!retainedLease) return NextResponse.json({ outcome: 'cancelled' });
    return NextResponse.json(
      { outcome: 'permanent_failure', reason: 'no_usable_email' },
      { status: 422 }
    );
  }

  try {
    const result = await sendUserDataExportReadyEmail(claimed.email, {
      expiresAt: new Date(claimed.expires_at),
    });
    if (result.sent) {
      const retainedLease = await markDelivery(
        executeDeliveryState,
        claimed.id,
        claimed.email_lease_token,
        'sent'
      );
      if (!retainedLease) return NextResponse.json({ outcome: 'cancelled' });
      return NextResponse.json({ outcome: 'sent' });
    }
    const retainedLease =
      result.reason === 'neverbounce_rejected'
        ? await markDelivery(executeDeliveryState, claimed.id, claimed.email_lease_token, 'failed')
        : await markRetryableDelivery(executeDeliveryState, claimed.id, claimed.email_lease_token);
    if (!retainedLease) return NextResponse.json({ outcome: 'cancelled' });
    return NextResponse.json(
      {
        outcome:
          result.reason === 'neverbounce_rejected' ? 'permanent_failure' : 'retryable_failure',
      },
      { status: result.reason === 'neverbounce_rejected' ? 422 : 503 }
    );
  } catch {
    const retainedLease = await markRetryableDelivery(
      executeDeliveryState,
      claimed.id,
      claimed.email_lease_token
    );
    if (!retainedLease) return NextResponse.json({ outcome: 'cancelled' });
    return NextResponse.json({ outcome: 'retryable_failure' }, { status: 503 });
  }
}
