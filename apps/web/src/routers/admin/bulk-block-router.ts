import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { sql, count, isNotNull, desc } from 'drizzle-orm';

export const adminBulkBlockRouter = createTRPCRouter({
  recentBlocks: adminProcedure.query(async () => {
    const rows = await db
      .select({
        blocked_reason: kilocode_users.blocked_reason,
        date: sql<string>`DATE(${kilocode_users.updated_at})`.as('date'),
        blocked_count: count().as('blocked_count'),
      })
      .from(kilocode_users)
      .where(isNotNull(kilocode_users.blocked_reason))
      .groupBy(kilocode_users.blocked_reason, sql`DATE(${kilocode_users.updated_at})`)
      .orderBy(desc(sql`DATE(${kilocode_users.updated_at})`))
      .limit(200);

    return rows.map(r => ({
      blocked_reason: r.blocked_reason ?? '',
      date: r.date,
      blocked_count: r.blocked_count,
    }));
  }),
});
