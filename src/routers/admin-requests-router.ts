import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { api_request_log } from '@/db/schema';
import * as z from 'zod';
import { eq, and, or, ilike, desc, asc, count, gte, lte, sql, type SQL } from 'drizzle-orm';

const ListRequestsSchema = z.object({
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(25),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  requestId: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  query: z.string().optional(),
});

const GetByIdSchema = z.object({
  id: z.string(),
});

export const adminRequestsRouter = createTRPCRouter({
  list: adminProcedure.input(ListRequestsSchema).query(async ({ input }) => {
    const { page, limit, sortOrder, requestId, startTime, endTime, query } = input;

    const conditions: SQL[] = [];

    if (requestId) {
      conditions.push(eq(api_request_log.id, BigInt(requestId)));
    }

    if (startTime) {
      conditions.push(gte(api_request_log.created_at, startTime));
    }

    if (endTime) {
      conditions.push(lte(api_request_log.created_at, endTime));
    }

    if (query) {
      const searchTerm = `%${query}%`;
      const searchCondition = or(
        ilike(sql`${api_request_log.id}::text`, searchTerm),
        ilike(api_request_log.kilo_user_id, searchTerm),
        ilike(api_request_log.organization_id, searchTerm),
        ilike(api_request_log.provider, searchTerm),
        ilike(api_request_log.model, searchTerm)
      );
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;
    const orderFunction = sortOrder === 'asc' ? asc : desc;

    const items = await db
      .select()
      .from(api_request_log)
      .where(whereCondition)
      .orderBy(orderFunction(api_request_log.created_at))
      .limit(limit)
      .offset((page - 1) * limit);

    const totalCountResult = await db
      .select({ count: count() })
      .from(api_request_log)
      .where(whereCondition);

    const total = totalCountResult[0]?.count ?? 0;
    const totalPages = Math.ceil(total / limit);

    return {
      items: items.map(item => ({
        ...item,
        id: item.id.toString(),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }),

  getById: adminProcedure.input(GetByIdSchema).query(async ({ input }) => {
    const [item] = await db
      .select()
      .from(api_request_log)
      .where(eq(api_request_log.id, BigInt(input.id)))
      .limit(1);

    if (!item) {
      return null;
    }

    return {
      ...item,
      id: item.id.toString(),
    };
  }),
});
