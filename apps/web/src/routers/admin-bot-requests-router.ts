import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { bot_requests, kilocode_users, organizations } from '@kilocode/db/schema';
import * as z from 'zod';
import { sql, desc, eq, gte, count } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';

const bigIntToNumber = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return Number(value) || 0;
};

const DaysInput = z.object({
  days: z.number().int().min(1).max(365).default(30),
});

const PaginationInput = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.union([z.literal(10), z.literal(25), z.literal(50), z.literal(100)]).default(25),
});

export const adminBotRequestsRouter = createTRPCRouter({
  weeklyActiveUsers: adminProcedure.input(DaysInput).query(async ({ input }) => {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - input.days);

    const result = await db
      .select({
        week: sql<string>`DATE_TRUNC('week', ${bot_requests.created_at})::date`,
        activeUsers: sql<number>`COUNT(DISTINCT ${bot_requests.created_by})`,
      })
      .from(bot_requests)
      .where(gte(bot_requests.created_at, startDate.toISOString()))
      .groupBy(sql`DATE_TRUNC('week', ${bot_requests.created_at})`)
      .orderBy(sql`DATE_TRUNC('week', ${bot_requests.created_at})`);

    return result.map(row => ({
      week: String(row.week),
      activeUsers: bigIntToNumber(row.activeUsers),
    }));
  }),

  newUsersPerDay: adminProcedure.input(DaysInput).query(async ({ input }) => {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - input.days);

    const result = await db
      .select({
        date: sql<string>`first_request_date`,
        newUsers: sql<number>`COUNT(*)`,
      })
      .from(
        sql`(
          SELECT ${bot_requests.created_by},
                 DATE(MIN(${bot_requests.created_at})) AS first_request_date
          FROM ${bot_requests}
          GROUP BY ${bot_requests.created_by}
        ) AS first_requests`
      )
      .where(sql`first_request_date >= DATE(${startDate.toISOString()})`)
      .groupBy(sql`first_request_date`)
      .orderBy(sql`first_request_date`);

    return result.map(row => ({
      date: String(row.date),
      newUsers: bigIntToNumber(row.newUsers),
    }));
  }),

  dailyUsage: adminProcedure.input(DaysInput).query(async ({ input }) => {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - input.days);

    const result = await db
      .select({
        date: sql<string>`DATE(${bot_requests.created_at})`,
        platform: bot_requests.platform,
        totalRequests: sql<number>`COUNT(*)`,
      })
      .from(bot_requests)
      .where(gte(bot_requests.created_at, startDate.toISOString()))
      .groupBy(sql`DATE(${bot_requests.created_at})`, bot_requests.platform)
      .orderBy(sql`DATE(${bot_requests.created_at})`, bot_requests.platform);

    return result.map(row => ({
      date: String(row.date),
      platform: row.platform,
      totalRequests: bigIntToNumber(row.totalRequests),
    }));
  }),

  list: adminProcedure.input(PaginationInput).query(async ({ input }) => {
    const { page, limit } = input;
    const offset = (page - 1) * limit;

    const totalResult = await db.select({ count: count() }).from(bot_requests);
    const total = totalResult[0]?.count ?? 0;

    const rows = await db
      .select({
        id: bot_requests.id,
        userEmail: kilocode_users.google_user_email,
        userName: kilocode_users.google_user_name,
        organizationName: organizations.name,
        userMessage: bot_requests.user_message,
        platform: bot_requests.platform,
        status: bot_requests.status,
        createdAt: bot_requests.created_at,
      })
      .from(bot_requests)
      .innerJoin(kilocode_users, eq(bot_requests.created_by, kilocode_users.id))
      .leftJoin(organizations, eq(bot_requests.organization_id, organizations.id))
      .orderBy(desc(bot_requests.created_at))
      .limit(limit)
      .offset(offset);

    return {
      requests: rows.map(row => ({
        id: row.id,
        userEmail: row.userEmail,
        userName: row.userName,
        organizationName: row.organizationName,
        userMessage: row.userMessage,
        platform: row.platform,
        status: row.status ?? 'pending',
        createdAt: row.createdAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }),

  getById: adminProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ input }) => {
    const result = await db
      .select({
        id: bot_requests.id,
        createdBy: bot_requests.created_by,
        userEmail: kilocode_users.google_user_email,
        userName: kilocode_users.google_user_name,
        organizationId: bot_requests.organization_id,
        organizationName: organizations.name,
        platform: bot_requests.platform,
        platformThreadId: bot_requests.platform_thread_id,
        platformMessageId: bot_requests.platform_message_id,
        userMessage: bot_requests.user_message,
        status: bot_requests.status,
        errorMessage: bot_requests.error_message,
        modelUsed: bot_requests.model_used,
        steps: bot_requests.steps,
        cloudAgentSessionId: bot_requests.cloud_agent_session_id,
        responseTimeMs: bot_requests.response_time_ms,
        createdAt: bot_requests.created_at,
        updatedAt: bot_requests.updated_at,
      })
      .from(bot_requests)
      .innerJoin(kilocode_users, eq(bot_requests.created_by, kilocode_users.id))
      .leftJoin(organizations, eq(bot_requests.organization_id, organizations.id))
      .where(eq(bot_requests.id, input.id))
      .limit(1);

    const row = result[0];
    if (!row) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Bot request not found',
      });
    }

    return {
      id: row.id,
      userEmail: row.userEmail,
      userName: row.userName,
      userId: row.createdBy,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      platform: row.platform,
      platformThreadId: row.platformThreadId,
      platformMessageId: row.platformMessageId,
      userMessage: row.userMessage,
      status: row.status ?? 'pending',
      errorMessage: row.errorMessage,
      modelUsed: row.modelUsed,
      steps: row.steps,
      cloudAgentSessionId: row.cloudAgentSessionId,
      responseTimeMs: row.responseTimeMs,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }),
});
