import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import {
  eq,
  and,
  desc,
  lt,
  isNull,
  inArray,
  notInArray,
  gte,
  isNotNull,
  sql,
  type SQL,
} from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { captureException } from '@sentry/nextjs';
import { TRPCClientError } from '@trpc/client';
import { cli_sessions_v2, cli_session_pull_requests } from '@kilocode/db/schema';
import { createCloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';
import { generateApiToken, generateInternalServiceToken } from '@/lib/tokens';
import {
  fetchSessionMessages,
  deleteSession as deleteSessionIngest,
  shareSession as shareSessionIngest,
} from '@/lib/session-ingest-client';
import { SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { baseGetSessionNextOutputSchema } from './cloud-agent-next-schemas';
import { KNOWN_PLATFORMS, sanitizeGitUrl } from '@/routers/cli-sessions-router';
import { verifyWebhookTriggerAccess } from '@/lib/webhook-trigger-ownership';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import {
  fetchPullRequestForBranch,
  GitHubRateLimitError,
} from '@/lib/integrations/platforms/github/adapter';
import { getIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';
import { PLATFORM } from '@/lib/integrations/core/constants';

/**
 * Check if an error indicates the session was not found in the cloud-agent DO.
 * This is expected for legacy sessions created before the new DO-based system.
 */
function isSessionNotFoundError(err: unknown): boolean {
  if (err instanceof TRPCClientError) {
    const data = err.data as { code?: string; httpStatus?: number } | undefined;
    const shape = err.shape as { data?: { code?: string; httpStatus?: number } } | undefined;
    // Check TRPC error code
    const code = data?.code ?? shape?.data?.code;
    if (code === 'NOT_FOUND') {
      return true;
    }
    // Also check HTTP status 404
    const httpStatus = data?.httpStatus ?? shape?.data?.httpStatus;
    if (httpStatus === 404) {
      return true;
    }
  }
  return false;
}

const PAGE_SIZE = 10;
const RECENT_DAYS_LIMIT = 200;

/**
 * If a refresh was performed within this window, the mutation short-circuits
 * and returns the persisted row without hitting the GitHub API.
 */
const REFRESH_THROTTLE_MS = 10_000;

/**
 * Parse a git URL into `{ owner, repo }` when it points at GitHub. Returns
 * `null` for non-GitHub hosts or URLs that cannot be parsed into exactly
 * `owner/repo`. Handles https URLs, ssh URLs (`git@github.com:owner/repo.git`)
 * and trailing `.git` suffixes.
 */
export function parseGitHubOwnerRepo(url: string): { owner: string; repo: string } | null {
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  let host: string;
  let path: string;
  if (sshMatch) {
    host = sshMatch[1].toLowerCase();
    path = sshMatch[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.replace(/^\/+/, '');
  }

  if (host !== 'github.com' && host !== 'www.github.com') {
    return null;
  }

  const cleaned = path.replace(/\.git$/i, '').replace(/\/+$/, '');
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length !== 2) {
    return null;
  }
  const [owner, repo] = segments;
  if (!owner || !repo) {
    return null;
  }
  return { owner, repo };
}

const associatedPrSchema = z.object({
  url: z.string(),
  number: z.number(),
  state: z.string(),
  title: z.string().nullable(),
  headSha: z.string().nullable(),
  lastSyncedAt: z.string(),
});

type AssociatedPrRow = {
  pr_url: string | null;
  pr_number: number | null;
  pr_state: string | null;
  pr_title: string | null;
  pr_head_sha: string | null;
  pr_last_synced_at: string | null;
};

function formatAssociatedPr(row: AssociatedPrRow): z.infer<typeof associatedPrSchema> | null {
  if (
    row.pr_url === null ||
    row.pr_number === null ||
    row.pr_state === null ||
    row.pr_last_synced_at === null
  ) {
    return null;
  }
  return {
    url: row.pr_url,
    number: row.pr_number,
    state: row.pr_state,
    title: row.pr_title,
    headSha: row.pr_head_sha,
    lastSyncedAt: row.pr_last_synced_at,
  };
}

const createdOnPlatformField = z.string().min(1).max(100);

/**
 * Fields to select for session list/get operations
 */
const commonSessionFields = {
  session_id: cli_sessions_v2.session_id,
  title: cli_sessions_v2.title,
  cloud_agent_session_id: cli_sessions_v2.cloud_agent_session_id,
  parent_session_id: cli_sessions_v2.parent_session_id,
  organization_id: cli_sessions_v2.organization_id,
  created_on_platform: cli_sessions_v2.created_on_platform,
  git_url: cli_sessions_v2.git_url,
  git_branch: cli_sessions_v2.git_branch,
  status: cli_sessions_v2.status,
  status_updated_at: cli_sessions_v2.status_updated_at,
  created_at: cli_sessions_v2.created_at,
  updated_at: cli_sessions_v2.updated_at,
  version: cli_sessions_v2.version,
} as const;

const sessionIdField = z.string().min(1);
const cloudAgentSessionIdField = z.string().min(1).max(255);

/**
 * Verify user owns the session. Returns the session if found.
 */
async function getSessionWithOwnerCheck(sessionId: string, userId: string) {
  const [session] = await db
    .select()
    .from(cli_sessions_v2)
    .where(and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, userId)))
    .limit(1);

  if (!session) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Session not found',
    });
  }

  return session;
}

const ListSessionsInputSchema = z.object({
  cursor: z.iso.datetime().optional(),
  limit: z.number().min(1).max(RECENT_DAYS_LIMIT).optional().default(PAGE_SIZE),
  orderBy: z.enum(['created_at', 'updated_at']).optional().default('created_at'),
  includeChildren: z.boolean().optional().default(false),
  createdOnPlatform: z
    .union([createdOnPlatformField, z.array(createdOnPlatformField).min(1)])
    .optional(),
  organizationId: z.uuid().nullable().optional(),
  gitUrl: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  updatedSince: z.iso.datetime().optional(),
  version: z.number().optional(),
});

const GetSessionInputSchema = z.object({
  session_id: sessionIdField,
});

const GetByCloudAgentSessionIdInputSchema = z.object({
  cloud_agent_session_id: cloudAgentSessionIdField,
});

const DeleteSessionInputSchema = z.object({
  session_id: sessionIdField,
});

const RenameSessionInputSchema = z.object({
  session_id: sessionIdField,
  title: z.string().trim().min(1).max(200),
});

const ShareSessionInputSchema = z.object({
  session_id: sessionIdField,
});

function addCreatedOnPlatformConditions(
  whereConditions: SQL[],
  createdOnPlatform: string | string[] | undefined
): void {
  if (!createdOnPlatform) {
    return;
  }

  const platforms = Array.isArray(createdOnPlatform) ? createdOnPlatform : [createdOnPlatform];
  const hasOther = platforms.includes('other');
  const concretePlatforms = platforms.filter(platform => platform !== 'other');

  if (hasOther && concretePlatforms.length > 0) {
    whereConditions.push(
      sql`(${inArray(cli_sessions_v2.created_on_platform, concretePlatforms)} OR ${notInArray(
        cli_sessions_v2.created_on_platform,
        [...KNOWN_PLATFORMS]
      )})`
    );
    return;
  }

  if (hasOther) {
    whereConditions.push(notInArray(cli_sessions_v2.created_on_platform, [...KNOWN_PLATFORMS]));
    return;
  }

  if (concretePlatforms.length === 1) {
    const [platform] = concretePlatforms;
    if (platform === undefined) {
      return;
    }
    whereConditions.push(eq(cli_sessions_v2.created_on_platform, platform));
    return;
  }

  whereConditions.push(inArray(cli_sessions_v2.created_on_platform, concretePlatforms));
}

function addGitUrlConditions(whereConditions: SQL[], gitUrl: string | string[] | undefined): void {
  if (!gitUrl) {
    return;
  }

  const urls = (Array.isArray(gitUrl) ? gitUrl : [gitUrl]).map(sanitizeGitUrl);
  if (urls.length === 1) {
    const [url] = urls;
    if (url === undefined) {
      return;
    }
    whereConditions.push(eq(cli_sessions_v2.git_url, url));
    return;
  }

  whereConditions.push(inArray(cli_sessions_v2.git_url, urls));
}

async function addOrganizationCondition(
  whereConditions: SQL[],
  ctx: Parameters<typeof ensureOrganizationAccess>[0],
  organizationId: string | null | undefined
): Promise<void> {
  if (organizationId === undefined) {
    return;
  }

  if (organizationId === null) {
    whereConditions.push(isNull(cli_sessions_v2.organization_id));
    return;
  }

  await ensureOrganizationAccess(ctx, organizationId);
  whereConditions.push(eq(cli_sessions_v2.organization_id, organizationId));
}

function joinWithAnd(fragments: SQL[]): SQL {
  return sql.join(fragments, sql` AND `);
}

/**
 * Router for cli_sessions_v2 table operations.
 * Used by cloud-agent-next for session storage and retrieval.
 *
 * Note: Records in this table are created by the cloud-agent-next worker.
 * This router only queries the data.
 */
export const cliSessionsV2Router = createTRPCRouter({
  /**
   * List sessions for the current user with cursor-based pagination.
   */
  list: baseProcedure.input(ListSessionsInputSchema).query(async ({ ctx, input }) => {
    const {
      cursor,
      limit,
      orderBy,
      includeChildren,
      createdOnPlatform,
      organizationId,
      gitUrl,
      updatedSince,
      version,
    } = input;

    const orderColumn =
      orderBy === 'updated_at' ? cli_sessions_v2.updated_at : cli_sessions_v2.created_at;

    const whereConditions: SQL[] = [eq(cli_sessions_v2.kilo_user_id, ctx.user.id)];

    await addOrganizationCondition(whereConditions, ctx, organizationId);
    addCreatedOnPlatformConditions(whereConditions, createdOnPlatform);
    addGitUrlConditions(whereConditions, gitUrl);

    if (cursor) {
      whereConditions.push(lt(orderColumn, cursor));
    }

    if (!includeChildren) {
      whereConditions.push(isNull(cli_sessions_v2.parent_session_id));
    }

    if (updatedSince) {
      whereConditions.push(gte(cli_sessions_v2.updated_at, updatedSince));
    }

    if (version !== undefined) {
      whereConditions.push(eq(cli_sessions_v2.version, version));
    }

    const effectiveLimit = updatedSince ? RECENT_DAYS_LIMIT : limit;

    const results = await db
      .select(commonSessionFields)
      .from(cli_sessions_v2)
      .where(and(...whereConditions))
      .orderBy(desc(orderColumn))
      .limit(effectiveLimit + 1);

    const hasMore = results.length > effectiveLimit;
    const resultSessions = hasMore ? results.slice(0, effectiveLimit) : results;

    const nextCursor =
      resultSessions.length > 0
        ? new Date(
            orderBy === 'updated_at'
              ? resultSessions[resultSessions.length - 1].updated_at
              : resultSessions[resultSessions.length - 1].created_at
          ).toISOString()
        : null;

    return {
      cliSessions: resultSessions,
      nextCursor: hasMore ? nextCursor : null,
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
      const whereConditions: SQL[] = [
        eq(cli_sessions_v2.kilo_user_id, ctx.user.id),
        isNull(cli_sessions_v2.parent_session_id),
        isNotNull(cli_sessions_v2.git_url),
        gte(cli_sessions_v2.updated_at, input.updatedSince),
        sql`${cli_sessions_v2.created_on_platform} != 'app-builder'`,
      ];

      await addOrganizationCondition(whereConditions, ctx, input.organizationId);

      const { rows } = await db.execute<{ git_url: string; last_used_at: string }>(sql`
        SELECT ${cli_sessions_v2.git_url} AS git_url, MAX(${cli_sessions_v2.updated_at}) AS last_used_at
        FROM ${cli_sessions_v2}
        WHERE ${joinWithAnd(whereConditions)}
        GROUP BY ${cli_sessions_v2.git_url}
        ORDER BY last_used_at DESC
        LIMIT 10`);

      return {
        repositories: rows.map(row => ({
          gitUrl: row.git_url,
          lastUsedAt: row.last_used_at,
        })),
      };
    }),

  /**
   * Get a single session by session_id.
   */
  get: baseProcedure.input(GetSessionInputSchema).query(async ({ ctx, input }) => {
    const { session_id } = input;

    const [session] = await db
      .select()
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.session_id, session_id),
          eq(cli_sessions_v2.kilo_user_id, ctx.user.id)
        )
      )
      .limit(1);

    if (!session) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Session not found',
      });
    }

    return session;
  }),

  /**
   * Get a session by its cloud_agent_session_id.
   * Used for reverse lookup from cloud-agent session ID to kilo session.
   */
  getByCloudAgentSessionId: baseProcedure
    .input(GetByCloudAgentSessionIdInputSchema)
    .query(async ({ ctx, input }) => {
      const { cloud_agent_session_id } = input;

      const [session] = await db
        .select(commonSessionFields)
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.cloud_agent_session_id, cloud_agent_session_id),
            eq(cli_sessions_v2.kilo_user_id, ctx.user.id)
          )
        )
        .limit(1);

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No kilo session found for this cloud-agent session',
        });
      }

      return session;
    }),

  /**
   * Get messages for a V2 session from the session ingest worker.
   */
  getSessionMessages: baseProcedure
    .input(z.object({ session_id: sessionIdField }))
    .query(async ({ ctx, input }) => {
      await getSessionWithOwnerCheck(input.session_id, ctx.user.id);

      try {
        const messages = await fetchSessionMessages(input.session_id, ctx.user);
        return { messages: messages ?? [] };
      } catch (error) {
        console.error(
          `Failed to fetch messages for session ${input.session_id}:`,
          error instanceof Error ? error.message : error
        );
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch session messages',
          cause: error,
        });
      }
    }),

  /**
   * Get a session by session_id with runtime state from the Durable Object.
   *
   * This combines the DB fetch (ownership check + metadata) with the DO fetch
   * (mode, model, repository, execution state) in a single call.
   *
   * For V2 sessions (those with cloud_agent_session_id), this also fetches
   * runtime state from the cloud-agent DO. For CLI sessions without a
   * cloud_agent_session_id, runtimeState will be null.
   */
  getWithRuntimeState: baseProcedure
    .input(GetSessionInputSchema)
    .output(
      z.object({
        // DB fields
        session_id: z.string(),
        title: z.string().nullable(),
        cloud_agent_session_id: z.string().nullable(),
        organization_id: z.string().nullable(),
        git_url: z.string().nullable(),
        git_branch: z.string().nullable(),
        created_at: z.coerce.date(),
        updated_at: z.coerce.date(),
        version: z.number(),
        // Runtime state from DO (null for CLI sessions without cloud_agent_session_id)
        runtimeState: baseGetSessionNextOutputSchema.nullable(),
        // Associated GitHub pull request for this session's branch, if any.
        // Populated by the pull_request webhook handler or a manual refresh.
        associatedPr: associatedPrSchema.nullable(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { session_id } = input;

      // 1. Fetch from DB with ownership check, LEFT JOINing the associated PR
      //    side table (1:1 on session_id).
      const [row] = await db
        .select({
          session: cli_sessions_v2,
          pr_url: cli_session_pull_requests.pr_url,
          pr_number: cli_session_pull_requests.pr_number,
          pr_state: cli_session_pull_requests.pr_state,
          pr_title: cli_session_pull_requests.pr_title,
          pr_head_sha: cli_session_pull_requests.pr_head_sha,
          pr_last_synced_at: cli_session_pull_requests.pr_last_synced_at,
        })
        .from(cli_sessions_v2)
        .leftJoin(
          cli_session_pull_requests,
          eq(cli_session_pull_requests.session_id, cli_sessions_v2.session_id)
        )
        .where(
          and(
            eq(cli_sessions_v2.session_id, session_id),
            eq(cli_sessions_v2.kilo_user_id, ctx.user.id)
          )
        )
        .limit(1);

      if (!row) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      const { session } = row;

      // 2. If session has cloud_agent_session_id, fetch runtime state from DO
      let runtimeState: z.infer<typeof baseGetSessionNextOutputSchema> | null = null;

      if (session.cloud_agent_session_id) {
        try {
          const authToken = generateApiToken(ctx.user);
          const client = createCloudAgentNextClient(authToken);
          runtimeState = await client.getSession(session.cloud_agent_session_id);
        } catch (error) {
          // Only swallow "not found" errors - these indicate legacy sessions
          // For transient errors (network, timeout, 5xx), re-throw so the client can retry
          if (isSessionNotFoundError(error)) {
            console.log(
              `Session ${session_id} not found in cloud-agent DO - treating as legacy session`
            );
            // runtimeState stays null
          } else {
            console.error(
              `Failed to fetch runtime state for session ${session_id}:`,
              error instanceof Error ? error.message : error
            );
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Failed to fetch session runtime state',
              cause: error,
            });
          }
        }
      }

      return {
        session_id: session.session_id,
        title: session.title,
        cloud_agent_session_id: session.cloud_agent_session_id,
        organization_id: session.organization_id ?? null,
        git_url: session.git_url ?? null,
        git_branch: session.git_branch ?? null,
        created_at: session.created_at,
        updated_at: session.updated_at,
        version: session.version,
        runtimeState,
        associatedPr: formatAssociatedPr(row),
      };
    }),

  /**
   * Refresh the associated PR for a session by querying GitHub directly.
   *
   * Invoked when the user explicitly asks for a refresh (e.g. "Refresh PR info"
   * action in the UI). The webhook handler is the primary path; this mutation
   * exists to recover from missed webhooks. Throttled to once per 10 seconds
   * per session to avoid hammering the GitHub API.
   */
  refreshAssociatedPullRequest: baseProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .output(z.object({ associatedPr: associatedPrSchema.nullable() }))
    .mutation(async ({ ctx, input }) => {
      const { sessionId } = input;

      // 1. Load session with ownership check, LEFT JOINing the PR row so we
      //    can evaluate the throttle without a second query.
      const [row] = await db
        .select({
          session: cli_sessions_v2,
          pr_url: cli_session_pull_requests.pr_url,
          pr_number: cli_session_pull_requests.pr_number,
          pr_state: cli_session_pull_requests.pr_state,
          pr_title: cli_session_pull_requests.pr_title,
          pr_head_sha: cli_session_pull_requests.pr_head_sha,
          pr_last_synced_at: cli_session_pull_requests.pr_last_synced_at,
        })
        .from(cli_sessions_v2)
        .leftJoin(
          cli_session_pull_requests,
          eq(cli_session_pull_requests.session_id, cli_sessions_v2.session_id)
        )
        .where(
          and(
            eq(cli_sessions_v2.session_id, sessionId),
            eq(cli_sessions_v2.kilo_user_id, ctx.user.id)
          )
        )
        .limit(1);

      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
      }

      const { session } = row;
      const gitUrl = session.git_url;
      const branch = session.git_branch;
      if (!gitUrl || !branch) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Session is not associated with a git branch',
        });
      }

      const parsed = parseGitHubOwnerRepo(gitUrl);
      if (!parsed) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Session git URL is not a recognized GitHub repository',
        });
      }

      // 2. Throttle: if the side table was synced recently, short-circuit.
      if (row.pr_last_synced_at !== null) {
        const lastSyncedMs = Date.parse(row.pr_last_synced_at);
        if (Number.isFinite(lastSyncedMs) && Date.now() - lastSyncedMs < REFRESH_THROTTLE_MS) {
          return { associatedPr: formatAssociatedPr(row) };
        }
      }

      // 3. Resolve the GitHub installation for this session's owner. For
      //    org-scoped sessions we must re-verify the caller is still a member
      //    of the org before touching its installation — an old session row
      //    with our kilo_user_id alone is not sufficient authorization.
      let integration;
      if (session.organization_id) {
        await ensureOrganizationAccess(ctx, session.organization_id);
        integration = await getIntegrationForOwner(
          { type: 'org', id: session.organization_id },
          PLATFORM.GITHUB
        );
      } else {
        integration = await getIntegrationForOwner(
          { type: 'user', id: ctx.user.id },
          PLATFORM.GITHUB
        );
      }

      if (!integration?.platform_installation_id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'No GitHub integration configured for this session',
        });
      }

      const installationId = Number(integration.platform_installation_id);
      if (!Number.isFinite(installationId)) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'GitHub installation ID is malformed',
        });
      }
      const appType = integration.github_app_type ?? 'standard';

      // 4. Call GitHub.
      let fetched;
      try {
        fetched = await fetchPullRequestForBranch({
          installationId,
          owner: parsed.owner,
          repo: parsed.repo,
          branch,
          appType,
        });
      } catch (error) {
        if (error instanceof GitHubRateLimitError) {
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: `GitHub rate limit reached; try again after ${error.resetAt.toISOString()}`,
            cause: error,
          });
        }
        captureException(error, {
          tags: {
            source: 'cli-sessions-v2-router',
            endpoint: 'refreshAssociatedPullRequest',
          },
          extra: { sessionId, owner: parsed.owner, repo: parsed.repo, branch },
        });
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch pull request from GitHub',
        });
      }

      // 5. Persist the result. Even for a null (no-PR) result we upsert a
      //    sentinel row with pr_last_synced_at = now() so the throttle in
      //    step 2 applies to subsequent refreshes for branches without a PR.
      const prColumns = {
        pr_url: fetched?.htmlUrl ?? null,
        pr_number: fetched?.number ?? null,
        pr_state: fetched?.state ?? null,
        pr_title: fetched?.title ?? null,
        pr_head_sha: fetched?.headSha ?? null,
      };

      const [persisted] = await db
        .insert(cli_session_pull_requests)
        .values({
          session_id: sessionId,
          ...prColumns,
          pr_last_synced_at: sql`now()`,
        })
        .onConflictDoUpdate({
          target: cli_session_pull_requests.session_id,
          set: {
            ...prColumns,
            pr_last_synced_at: sql`now()`,
            updated_at: sql`now()`,
          },
        })
        .returning({
          pr_url: cli_session_pull_requests.pr_url,
          pr_number: cli_session_pull_requests.pr_number,
          pr_state: cli_session_pull_requests.pr_state,
          pr_title: cli_session_pull_requests.pr_title,
          pr_head_sha: cli_session_pull_requests.pr_head_sha,
          pr_last_synced_at: cli_session_pull_requests.pr_last_synced_at,
        });

      return { associatedPr: formatAssociatedPr(persisted) };
    }),

  /**
   * Delete a V2 session.
   *
   * Cleans up the cloud-agent-next DO/sandbox if applicable, then delegates
   * all DB deletion and ingest DO/cache cleanup to the session-ingest worker.
   */
  delete: baseProcedure.input(DeleteSessionInputSchema).mutation(async ({ ctx, input }) => {
    const { session_id } = input;
    const session = await getSessionWithOwnerCheck(session_id, ctx.user.id);

    if (session.cloud_agent_session_id) {
      const authToken = generateApiToken(ctx.user);
      const client = createCloudAgentNextClient(authToken);
      try {
        await client.deleteSession(session.cloud_agent_session_id);
      } catch (err) {
        if (!isSessionNotFoundError(err)) {
          captureException(err, {
            tags: { source: 'cli-sessions-v2-router', endpoint: 'delete' },
            extra: {
              session_id,
              cloud_agent_session_id: session.cloud_agent_session_id,
            },
          });
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to clean up cloud-agent session',
            cause: err,
          });
        }
        // Session not found in cloud-agent DO — already gone, continue with DB cleanup.
      }
    }

    // Delegate DB deletion (including child sessions) and ingest DO/cache cleanup
    // to the session-ingest worker.
    await deleteSessionIngest(session_id, ctx.user.id);

    return { success: true, session_id };
  }),

  /**
   * Rename a V2 session by updating its title.
   */
  rename: baseProcedure.input(RenameSessionInputSchema).mutation(async ({ ctx, input }) => {
    const { session_id, title } = input;
    const session = await getSessionWithOwnerCheck(session_id, ctx.user.id);

    const [updated] = await db
      .update(cli_sessions_v2)
      .set({ title, updated_at: session.updated_at })
      .where(
        and(
          eq(cli_sessions_v2.session_id, session_id),
          eq(cli_sessions_v2.kilo_user_id, ctx.user.id)
        )
      )
      .returning({ title: cli_sessions_v2.title });

    if (!updated) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Session not found',
      });
    }

    return { title: updated.title };
  }),

  /**
   * Share a V2 session by generating a public_id.
   *
   * Delegates to the session-ingest worker which is idempotent — if the session
   * already has a public_id, the existing one is returned.
   */
  share: baseProcedure.input(ShareSessionInputSchema).mutation(async ({ ctx, input }) => {
    const { session_id } = input;
    await getSessionWithOwnerCheck(session_id, ctx.user.id);

    try {
      const result = await shareSessionIngest(session_id, ctx.user.id);
      return { public_id: result.public_id };
    } catch (error) {
      captureException(error, {
        tags: { source: 'cli-sessions-v2-router', endpoint: 'share' },
        extra: { session_id },
      });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to share session',
        cause: error,
      });
    }
  }),

  /**
   * Share a v2 CLI session from a webhook trigger request.
   * Creates a read-only public snapshot via the session-ingest worker.
   *
   * For org triggers, any org member can share; for personal triggers, only the owner.
   */
  shareForWebhookTrigger: baseProcedure
    .input(
      z.object({
        kilo_session_id: z.string().startsWith('ses_'),
        trigger_id: z.string().min(1),
        organization_id: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await verifyWebhookTriggerAccess(ctx, input.trigger_id, input.organization_id);

      // For org triggers, verify the session belongs to the same org.
      // For personal triggers, verify the session belongs to the requesting user.
      const ownerCondition = input.organization_id
        ? eq(cli_sessions_v2.organization_id, input.organization_id)
        : eq(cli_sessions_v2.kilo_user_id, ctx.user.id);

      const [session] = await db
        .select({ kilo_user_id: cli_sessions_v2.kilo_user_id })
        .from(cli_sessions_v2)
        .where(and(eq(cli_sessions_v2.session_id, input.kilo_session_id), ownerCondition))
        .limit(1);

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      if (!SESSION_INGEST_WORKER_URL) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'SESSION_INGEST_WORKER_URL is not configured',
        });
      }

      const token = generateInternalServiceToken(session.kilo_user_id);
      const url = `${SESSION_INGEST_WORKER_URL}/api/session/${encodeURIComponent(input.kilo_session_id)}/share`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Session share failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`,
        });
      }

      const shareResponseSchema = z.object({ public_id: z.string() });
      let body: z.infer<typeof shareResponseSchema>;
      try {
        body = shareResponseSchema.parse(await response.json());
      } catch {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Session share succeeded but response was malformed',
        });
      }

      return { share_id: body.public_id, session_id: input.kilo_session_id };
    }),
});
