import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import { sql, type SQL } from 'drizzle-orm';
import { cliSessions, cli_sessions_v2 } from '@kilocode/db/schema';
import { KNOWN_PLATFORMS } from '@/routers/cli-sessions-router';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

const PAGE_SIZE = 10;
const RECENT_DAYS_LIMIT = 200;

type UnifiedSession = {
  session_id: string;
  title: string;
  git_url: string | null;
  cloud_agent_session_id: string | null;
  created_on_platform: string;
  organization_id: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  last_mode: string | null;
  last_model: string | null;
  git_branch: string | null;
  parent_session_id: string | null;
  status: string | null;
  status_updated_at: string | null;
  source: 'v1' | 'v2';
};

const createdOnPlatformField = z.string().min(1).max(100);

const ListSessionsInputSchema = z.object({
  cursor: z.iso.datetime().optional(),
  limit: z.number().min(1).max(50).optional().default(PAGE_SIZE),
  createdOnPlatform: z
    .union([createdOnPlatformField, z.array(createdOnPlatformField).min(1)])
    .optional(),
  orderBy: z.enum(['created_at', 'updated_at']).optional().default('updated_at'),
  organizationId: z.uuid().nullable().optional(),
  includeSubSessions: z.boolean().optional().default(false),
  gitUrl: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  updatedSince: z.iso.datetime().optional(),
});

const SearchInputSchema = z.object({
  search_string: z.string().min(1),
  limit: z.number().min(1).max(50).optional().default(PAGE_SIZE),
  offset: z.number().min(0).optional().default(0),
  createdOnPlatform: z
    .union([createdOnPlatformField, z.array(createdOnPlatformField).min(1)])
    .optional(),
  organizationId: z.uuid().nullable().optional(),
  includeSubSessions: z.boolean().optional().default(false),
  gitUrl: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
});

/**
 * Build WHERE clause fragments for platform and organization scoping.
 * Returns raw SQL fragments that reference the given table name.
 */
function buildScopeFragments(
  tableName: 'cli_sessions' | 'cli_sessions_v2',
  opts: {
    userId: string;
    createdOnPlatform?: string | string[];
    organizationId?: string | null;
    includeSubSessions?: boolean;
    gitUrl?: string | string[];
  }
): SQL[] {
  const table = tableName === 'cli_sessions' ? cliSessions : cli_sessions_v2;

  const fragments: SQL[] = [sql`${table.kilo_user_id} = ${opts.userId}`];

  if (opts.createdOnPlatform) {
    const platforms = Array.isArray(opts.createdOnPlatform)
      ? opts.createdOnPlatform
      : [opts.createdOnPlatform];

    const hasOther = platforms.includes('other');
    const concrete = platforms.filter(p => p !== 'other');

    if (hasOther && concrete.length > 0) {
      // 'other' is a pseudo-filter (NOT IN known platforms); OR it with
      // any concrete platform selections so both sets of sessions appear.
      fragments.push(
        sql`(${table.created_on_platform} IN (${sql.join(
          concrete.map(p => sql`${p}`),
          sql`, `
        )}) OR ${table.created_on_platform} NOT IN (${sql.join(
          KNOWN_PLATFORMS.map(p => sql`${p}`),
          sql`, `
        )}))`
      );
    } else if (hasOther) {
      fragments.push(
        sql`${table.created_on_platform} NOT IN (${sql.join(
          KNOWN_PLATFORMS.map(p => sql`${p}`),
          sql`, `
        )})`
      );
    } else if (concrete.length === 1) {
      fragments.push(sql`${table.created_on_platform} = ${concrete[0]}`);
    } else {
      fragments.push(
        sql`${table.created_on_platform} IN (${sql.join(
          concrete.map(p => sql`${p}`),
          sql`, `
        )})`
      );
    }
  }

  if (opts.organizationId !== undefined) {
    if (opts.organizationId === null) {
      fragments.push(sql`${table.organization_id} IS NULL`);
    } else {
      fragments.push(sql`${table.organization_id} = ${opts.organizationId}`);
    }
  }

  if (!opts.includeSubSessions) {
    fragments.push(sql`${table.parent_session_id} IS NULL`);
  }

  if (opts.gitUrl) {
    const urls = Array.isArray(opts.gitUrl) ? opts.gitUrl : [opts.gitUrl];
    if (urls.length === 1) {
      fragments.push(sql`${table.git_url} = ${urls[0]}`);
    } else {
      fragments.push(
        sql`${table.git_url} IN (${sql.join(
          urls.map(u => sql`${u}`),
          sql`, `
        )})`
      );
    }
  }

  return fragments;
}

function joinWithAnd(fragments: SQL[]): SQL {
  return sql.join(fragments, sql` AND `);
}

/** Column projections for the v1 side of the UNION */
function v1Columns(): SQL {
  return sql`
    ${cliSessions.session_id}::text AS session_id,
    ${cliSessions.title} AS title,
    ${cliSessions.git_url} AS git_url,
    ${cliSessions.cloud_agent_session_id} AS cloud_agent_session_id,
    ${cliSessions.created_on_platform} AS created_on_platform,
    ${cliSessions.organization_id}::text AS organization_id,
    ${cliSessions.created_at} AS created_at,
    ${cliSessions.updated_at} AS updated_at,
    ${cliSessions.version} AS version,
    ${cliSessions.last_mode} AS last_mode,
    ${cliSessions.last_model} AS last_model,
    NULL AS git_branch,
    ${cliSessions.parent_session_id}::text AS parent_session_id,
    NULL AS status,
    NULL AS status_updated_at,
    'v1' AS source`;
}

/** Column projections for the v2 side of the UNION */
function v2Columns(): SQL {
  return sql`
    ${cli_sessions_v2.session_id} AS session_id,
    COALESCE(${cli_sessions_v2.title}, 'Untitled') AS title,
    ${cli_sessions_v2.git_url} AS git_url,
    ${cli_sessions_v2.cloud_agent_session_id} AS cloud_agent_session_id,
    ${cli_sessions_v2.created_on_platform} AS created_on_platform,
    ${cli_sessions_v2.organization_id}::text AS organization_id,
    ${cli_sessions_v2.created_at} AS created_at,
    ${cli_sessions_v2.updated_at} AS updated_at,
    ${cli_sessions_v2.version} AS version,
    NULL AS last_mode,
    NULL AS last_model,
    ${cli_sessions_v2.git_branch} AS git_branch,
    ${cli_sessions_v2.parent_session_id} AS parent_session_id,
    ${cli_sessions_v2.status} AS status,
    ${cli_sessions_v2.status_updated_at} AS status_updated_at,
    'v2' AS source`;
}

export const unifiedSessionsRouter = createTRPCRouter({
  list: baseProcedure.input(ListSessionsInputSchema).query(async ({ ctx, input }) => {
    const {
      cursor,
      limit,
      createdOnPlatform,
      orderBy,
      organizationId,
      includeSubSessions,
      gitUrl,
      updatedSince,
    } = input;

    if (organizationId) {
      await ensureOrganizationAccess(ctx, organizationId);
    }

    const scopeOpts = {
      userId: ctx.user.id,
      createdOnPlatform,
      organizationId,
      includeSubSessions,
      gitUrl,
    };

    const orderColumn = sql.raw(orderBy === 'updated_at' ? 'updated_at' : 'created_at');

    const v1Where = buildScopeFragments('cli_sessions', scopeOpts);
    const v2Where = buildScopeFragments('cli_sessions_v2', scopeOpts);

    if (cursor) {
      const cursorCondition = (table: typeof cliSessions | typeof cli_sessions_v2) =>
        orderBy === 'updated_at'
          ? sql`${table.updated_at} < ${cursor}`
          : sql`${table.created_at} < ${cursor}`;

      v1Where.push(cursorCondition(cliSessions));
      v2Where.push(cursorCondition(cli_sessions_v2));
    }

    if (updatedSince) {
      v1Where.push(sql`${cliSessions.updated_at} >= ${updatedSince}`);
      v2Where.push(sql`${cli_sessions_v2.updated_at} >= ${updatedSince}`);
    }

    const effectiveLimit = updatedSince ? RECENT_DAYS_LIMIT : limit;

    const query = sql`
        SELECT * FROM (
          SELECT ${v1Columns()}
          FROM ${cliSessions}
          WHERE ${joinWithAnd(v1Where)}

          UNION ALL

          SELECT ${v2Columns()}
          FROM ${cli_sessions_v2}
          WHERE ${joinWithAnd(v2Where)}
        ) unified
        ORDER BY ${orderColumn} DESC
        LIMIT ${effectiveLimit + 1}`;

    const { rows } = await db.execute<UnifiedSession>(query);

    const hasMore = rows.length > effectiveLimit;
    const resultSessions = hasMore ? rows.slice(0, effectiveLimit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && resultSessions.length > 0) {
      const lastRow = resultSessions[resultSessions.length - 1];
      const cursorValue = orderBy === 'updated_at' ? lastRow.updated_at : lastRow.created_at;
      nextCursor = new Date(cursorValue).toISOString();
    }

    return {
      cliSessions: resultSessions,
      nextCursor,
    };
  }),

  recentRepositories: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().nullable().optional(),
        updatedSince: z.iso.datetime(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { organizationId, updatedSince } = input;

      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId);
      }

      const scopeOpts = {
        userId: ctx.user.id,
        organizationId,
        includeSubSessions: false,
      };

      const v1Where = buildScopeFragments('cli_sessions', scopeOpts);
      const v2Where = buildScopeFragments('cli_sessions_v2', scopeOpts);

      v1Where.push(sql`${cliSessions.git_url} IS NOT NULL`);
      v1Where.push(sql`${cliSessions.updated_at} >= ${updatedSince}`);
      v1Where.push(sql`${cliSessions.created_on_platform} != 'app-builder'`);

      v2Where.push(sql`${cli_sessions_v2.git_url} IS NOT NULL`);
      v2Where.push(sql`${cli_sessions_v2.updated_at} >= ${updatedSince}`);
      v2Where.push(sql`${cli_sessions_v2.created_on_platform} != 'app-builder'`);

      const query = sql`
        SELECT git_url, MAX(updated_at) AS last_used_at FROM (
          SELECT ${cliSessions.git_url} AS git_url, ${cliSessions.updated_at} AS updated_at
          FROM ${cliSessions}
          WHERE ${joinWithAnd(v1Where)}

          UNION ALL

          SELECT ${cli_sessions_v2.git_url} AS git_url, ${cli_sessions_v2.updated_at} AS updated_at
          FROM ${cli_sessions_v2}
          WHERE ${joinWithAnd(v2Where)}
        ) unified
        GROUP BY git_url
        ORDER BY last_used_at DESC
        LIMIT 10`;

      const { rows } = await db.execute<{ git_url: string; last_used_at: string }>(query);

      return {
        repositories: rows.map(r => ({
          gitUrl: r.git_url,
          lastUsedAt: r.last_used_at,
        })),
      };
    }),

  search: baseProcedure.input(SearchInputSchema).query(async ({ ctx, input }) => {
    const {
      search_string,
      limit,
      offset,
      createdOnPlatform,
      organizationId,
      includeSubSessions,
      gitUrl,
    } = input;

    if (organizationId) {
      await ensureOrganizationAccess(ctx, organizationId);
    }

    const scopeOpts = {
      userId: ctx.user.id,
      createdOnPlatform,
      organizationId,
      includeSubSessions,
      gitUrl,
    };

    const v1Where = buildScopeFragments('cli_sessions', scopeOpts);
    const v2Where = buildScopeFragments('cli_sessions_v2', scopeOpts);

    // Use position() for a case-insensitive substring match. This avoids LIKE
    // wildcard semantics entirely, so %, _, and \ in user input are matched
    // literally without any escaping dance.
    const needle = search_string.toLowerCase();
    v1Where.push(
      sql`(
        position(${needle} in lower(${cliSessions.title})) > 0
        OR position(${needle} in lower(${cliSessions.session_id}::text)) > 0
      )`
    );
    v2Where.push(
      sql`(
        position(${needle} in lower(COALESCE(${cli_sessions_v2.title}, ''))) > 0
        OR position(${needle} in lower(${cli_sessions_v2.session_id}::text)) > 0
      )`
    );

    const unionQuery = sql`
        SELECT ${v1Columns()}
        FROM ${cliSessions}
        WHERE ${joinWithAnd(v1Where)}

        UNION ALL

        SELECT ${v2Columns()}
        FROM ${cli_sessions_v2}
        WHERE ${joinWithAnd(v2Where)}`;

    const [{ rows }, countResult] = await Promise.all([
      db.execute<UnifiedSession>(sql`
          SELECT * FROM (${unionQuery}) unified
          ORDER BY updated_at DESC
          LIMIT ${limit}
          OFFSET ${offset}`),
      db.execute<{ count: string }>(sql`
          SELECT COUNT(*) AS count FROM (${unionQuery}) unified`),
    ]);

    const total = countResult.rows.length > 0 ? Number(countResult.rows[0].count) : 0;

    return {
      results: rows,
      total,
      limit,
      offset,
    };
  }),
});
