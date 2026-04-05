import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { createTimer } from '@/lib/timer';

export async function forceImmediateExpirationRecomputation(kiloUserId: string): Promise<void> {
  const timer = createTimer();

  await db
    .update(kilocode_users)
    .set({ next_credit_expiration_at: new Date().toISOString() })
    .where(eq(kilocode_users.id, kiloUserId));
  timer.log(`killBalanceCache for user ${kiloUserId}`);
}
