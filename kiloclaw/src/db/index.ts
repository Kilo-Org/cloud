import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { kilocode_users, kiloclaw_access_codes, kiloclaw_instances } from '@kilocode/db/schema';
import { eq, and, isNull, gt, sql } from 'drizzle-orm';

export { getWorkerDb, type WorkerDb };

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

export async function getActiveInstance(db: WorkerDb, userId: string) {
  const row = await db
    .select({
      id: kiloclaw_instances.id,
      sandbox_id: kiloclaw_instances.sandbox_id,
    })
    .from(kiloclaw_instances)
    .where(and(eq(kiloclaw_instances.user_id, userId), isNull(kiloclaw_instances.destroyed_at)))
    .limit(1)
    .then(rows => rows[0] ?? null);

  if (!row) return null;
  return { id: row.id, sandboxId: row.sandbox_id };
}

export async function markInstanceDestroyed(db: WorkerDb, userId: string, sandboxId: string) {
  await db
    .update(kiloclaw_instances)
    .set({ destroyed_at: sql`NOW()` })
    .where(
      and(
        eq(kiloclaw_instances.user_id, userId),
        eq(kiloclaw_instances.sandbox_id, sandboxId),
        isNull(kiloclaw_instances.destroyed_at)
      )
    );
}
