import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { isNull, count, sql } from 'drizzle-orm';
import { normalizeEmail } from '@/lib/utils';

export type NormalizedEmailCountsResponse = {
  missing: number;
};

export type NormalizedEmailBackfillResponse = {
  processed: number;
  remaining: boolean;
};

export async function GET(): Promise<
  NextResponse<NormalizedEmailCountsResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const [result] = await db
    .select({ count: count() })
    .from(kilocode_users)
    .where(isNull(kilocode_users.normalized_email));

  return NextResponse.json({ missing: result?.count ?? 0 });
}

const BATCH_SIZE = 1000;
const BATCHES_PER_REQUEST = 50;

export async function POST(): Promise<
  NextResponse<NormalizedEmailBackfillResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  let totalProcessed = 0;

  for (let i = 0; i < BATCHES_PER_REQUEST; i++) {
    const rows = await db
      .select({ id: kilocode_users.id, google_user_email: kilocode_users.google_user_email })
      .from(kilocode_users)
      .where(isNull(kilocode_users.normalized_email))
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;

    const updates = rows.map(row => ({
      id: row.id,
      normalized_email: normalizeEmail(row.google_user_email),
    }));

    await db.execute(sql`
      UPDATE ${kilocode_users}
      SET normalized_email = email_updates.normalized_email
      FROM (VALUES ${sql.join(
        updates.map(u => sql`(${u.id}, ${u.normalized_email})`),
        sql`, `
      )}) AS email_updates(id, normalized_email)
      WHERE ${kilocode_users.id} = email_updates.id
    `);

    totalProcessed += rows.length;

    if (rows.length < BATCH_SIZE) break;
  }

  return NextResponse.json({
    processed: totalProcessed,
    remaining: totalProcessed === BATCH_SIZE * BATCHES_PER_REQUEST,
  });
}
