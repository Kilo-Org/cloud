import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { cli_sessions_v2, kilocode_users, organizations } from '@kilocode/db/schema';
import * as z from 'zod';
import { eq, and, or, ilike, desc, asc, count, sql, type SQL } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';

const ListSessionsSchema = z.object({
  offset: z.number().min(0).default(0),
  limit: z.number().min(1).max(100).default(25),
  sortBy: z.enum(['created_at', 'updated_at', 'title']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional(),
  platform: z.enum(['all', 'unknown', 'vscode', 'cursor', 'windsurf', 'vim', 'other']).default('all'),
});

const GetSessionSchema = z.object({
  session_id: z.string(),
  kilo_user_id: z.string(),
});

export type AdminCliSessionV2 = {
  session_id: string;
  kilo_user_id: string;
  version: number;
  title: string | null;
  public_id: string | null;
  parent_session_id: string | null;
  organization_id: string | null;
  cloud_agent_session_id: string | null;
  created_on_platform: string;
  git_url: string | null;
  git_branch: string | null;
  created_at: string;
  updated_at: string;
  owner_email: string | null;
  org_name: string | null;
};

export const adminCliSessionsV2Router = createTRPCRouter({
  get: adminProcedure.input(GetSessionSchema).query(async ({ input }) => {
    const { session_id, kilo_user_id } = input;

    const [result] = await db
      .select({
        session: cli_sessions_v2,
        owner_user: {
          id: kilocode_users.id,
          email: kilocode_users.google_user_email,
        },
        org: {
          id: organizations.id,
          name: organizations.name,
        },
      })
      .from(cli_sessions_v2)
      .leftJoin(kilocode_users, eq(cli_sessions_v2.kilo_user_id, kilocode_users.id))
      .leftJoin(organizations, eq(cli_sessions_v2.organization_id, organizations.id))
      .where(
        and(
          eq(cli_sessions_v2.session_id, session_id),
          eq(cli_sessions_v2.kilo_user_id, kilo_user_id)
        )
      )
      .limit(1);

    if (!result) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Session not found',
      });
    }

    const session: AdminCliSessionV2 = {
      session_id: result.session.session_id,
      kilo_user_id: result.session.kilo_user_id,
      version: result.session.version,
      title: result.session.title,
      public_id: result.session.public_id,
      parent_session_id: result.session.parent_session_id,
      organization_id: result.session.organization_id,
      cloud_agent_session_id: result.session.cloud_agent_session_id,
      created_on_platform: result.session.created_on_platform,
      git_url: result.session.git_url,
      git_branch: result.session.git_branch,
      created_at: result.session.created_at,
      updated_at: result.session.updated_at,
      owner_email: result.owner_user?.email ?? null,
      org_name: result.org?.name ?? null,
    };

    return session;
  }),

  list: adminProcedure.input(ListSessionsSchema).query(async ({ input }) => {
    const { offset, limit, sortBy, sortOrder, search, platform } = input;
    const searchTerm = search?.trim() || '';

    const conditions: SQL[] = [];

    if (searchTerm) {
      const searchConditions: SQL[] = [
        eq(cli_sessions_v2.session_id, searchTerm),
        eq(cli_sessions_v2.kilo_user_id, searchTerm),
      ];

      if (searchTerm.length > 2) {
        searchConditions.push(ilike(cli_sessions_v2.title, `%${searchTerm}%`));
      }

      if (searchTerm.startsWith('ses_')) {
        searchConditions.push(eq(cli_sessions_v2.cloud_agent_session_id, searchTerm));
      }

      const searchCondition = or(...searchConditions);
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    if (platform !== 'all') {
      if (platform === 'other') {
        conditions.push(
          and(
            ...['unknown', 'vscode', 'cursor', 'windsurf', 'vim'].map(
              p => sql`${cli_sessions_v2.created_on_platform} != ${p}`
            )
          ) as SQL
        );
      } else {
        conditions.push(eq(cli_sessions_v2.created_on_platform, platform));
      }
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const orderFunction = sortOrder === 'asc' ? asc : desc;
    const orderCondition = orderFunction(cli_sessions_v2[sortBy]);

    const sessionsResult = await db
      .select({
        session: cli_sessions_v2,
        owner_user: {
          id: kilocode_users.id,
          email: kilocode_users.google_user_email,
        },
        org: {
          id: organizations.id,
          name: organizations.name,
        },
      })
      .from(cli_sessions_v2)
      .leftJoin(kilocode_users, eq(cli_sessions_v2.kilo_user_id, kilocode_users.id))
      .leftJoin(organizations, eq(cli_sessions_v2.organization_id, organizations.id))
      .where(whereCondition)
      .orderBy(orderCondition)
      .limit(limit)
      .offset(offset);

    const totalCountResult = await db
      .select({ count: count() })
      .from(cli_sessions_v2)
      .where(whereCondition);

    const totalCount = totalCountResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limit);

    const sessions: AdminCliSessionV2[] = sessionsResult.map(row => ({
      session_id: row.session.session_id,
      kilo_user_id: row.session.kilo_user_id,
      version: row.session.version,
      title: row.session.title,
      public_id: row.session.public_id,
      parent_session_id: row.session.parent_session_id,
      organization_id: row.session.organization_id,
      cloud_agent_session_id: row.session.cloud_agent_session_id,
      created_on_platform: row.session.created_on_platform,
      git_url: row.session.git_url,
      git_branch: row.session.git_branch,
      created_at: row.session.created_at,
      updated_at: row.session.updated_at,
      owner_email: row.owner_user?.email ?? null,
      org_name: row.org?.name ?? null,
    }));

    return {
      sessions,
      pagination: {
        offset,
        limit,
        total: totalCount,
        totalPages,
      },
    };
  }),
});
