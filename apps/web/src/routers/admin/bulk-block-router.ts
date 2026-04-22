import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { unblockBulkBlockedUsers } from '@/lib/abuse/bulkBlock';
import { sql, count, isNotNull, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import * as z from 'zod';

const BulkBlockRowSchema = z.object({
  blocked_reason: z.string().trim().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  blocked_by_kilo_user_id: z.string().min(1).nullable(),
});

export const adminBulkBlockRouter = createTRPCRouter({
  recentBlocks: adminProcedure.query(async () => {
    const blockedByUser = alias(kilocode_users, 'blocked_by_user');
    const blockedDate = sql<string>`DATE(COALESCE(${kilocode_users.blocked_at}, ${kilocode_users.updated_at}))`;

    const rows = await db
      .select({
        blocked_reason: kilocode_users.blocked_reason,
        date: blockedDate.as('date'),
        blocked_by_kilo_user_id: kilocode_users.blocked_by_kilo_user_id,
        blocked_by_email: blockedByUser.google_user_email,
        blocked_count: count().as('blocked_count'),
      })
      .from(kilocode_users)
      .leftJoin(blockedByUser, eq(kilocode_users.blocked_by_kilo_user_id, blockedByUser.id))
      .where(isNotNull(kilocode_users.blocked_reason))
      .groupBy(
        kilocode_users.blocked_reason,
        blockedDate,
        kilocode_users.blocked_by_kilo_user_id,
        blockedByUser.google_user_email
      )
      .orderBy(desc(blockedDate))
      .limit(200);

    return rows.map(r => ({
      blocked_reason: r.blocked_reason ?? '',
      date: r.date,
      blocked_by_kilo_user_id: r.blocked_by_kilo_user_id,
      blocked_by_email: r.blocked_by_email,
      blocked_count: r.blocked_count,
    }));
  }),

  unblockRecentBlock: adminProcedure.input(BulkBlockRowSchema).mutation(async ({ input }) => {
    return unblockBulkBlockedUsers(input.blocked_reason, input.date, input.blocked_by_kilo_user_id);
  }),
});
