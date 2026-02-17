import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import { eq, and, desc, lt, or, ilike, sql, isNull, notInArray, type SQL } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { cliSessions, sharedCliSessions, cloud_agent_webhook_triggers } from '@/db/schema';
import { CliSessionSharedState } from '@/types/cli-session-shared-state';
import {
  generateSignedUrls,
  deleteBlobs,
  copyBlobs,
  getBlobContent,
  type FolderName,
  type FileName,
} from '@/lib/r2/cli-sessions';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { getCodeReviewById } from '@/lib/code-reviews/db/code-reviews';
import { createCloudAgentClient } from '@/lib/cloud-agent/cloud-agent-client';
import { generateApiToken } from '@/lib/tokens';

export const BLOB_TYPES = [
  'api_conversation_history',
  'task_metadata',
  'ui_messages',
  'git_state',
] as const satisfies readonly FileName[];

/** Known platform values that have dedicated filters. "Extension" is everything else. */
export const KNOWN_PLATFORMS = ['cloud-agent', 'cli', 'agent-manager', 'app-builder'] as const;

const PAGE_SIZE = 10;

const commonSessionFields = {
  session_id: cliSessions.session_id,
  title: cliSessions.title,
  git_url: cliSessions.git_url,
  cloud_agent_session_id: cliSessions.cloud_agent_session_id,
  created_on_platform: cliSessions.created_on_platform,
  created_at: cliSessions.created_at,
  updated_at: cliSessions.updated_at,
  version: cliSessions.version,
  organization_id: cliSessions.organization_id,
  last_mode: cliSessions.last_mode,
  last_model: cliSessions.last_model,
  parent_session_id: cliSessions.parent_session_id,
} as const;

/**
 * Sanitize a string by removing null bytes (0x00) which PostgreSQL rejects
 * in UTF-8 text columns with error: "invalid byte sequence for encoding UTF8: 0x00"
 */
export function sanitizeForPostgres(str: string): string {
  return str.replaceAll('\x00', '');
}

const titleField = z.string().transform(sanitizeForPostgres);

export function isValidGitUrl(url: string): boolean {
  if (url.startsWith('git@') && url.includes(':')) return true;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function sanitizeGitUrl(url: string): string {
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const path = sshMatch[2].split('?')[0];
    return `git@${host}:${path}`;
  }

  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

export function parseGitUrl(url: string): string | undefined {
  if (!isValidGitUrl(url)) return undefined;
  return sanitizeGitUrl(url);
}

const gitUrlField = z.string().transform(parseGitUrl).optional();

const createdOnPlatformField = z.string().min(1).max(100);

const lastModeField = z.string().min(1).max(200).nullable().optional();

const lastModelField = z.string().min(1).max(200).nullable().optional();

const organizationIdField = z.uuid().nullable().optional();

const sessionIdField = z.uuid();

const cloudAgentSessionIdField = z.string().min(1).max(255);

const ListSessionsInputSchema = z.object({
  cursor: z.iso.datetime().optional(),
  limit: z.number().min(1).max(50).optional().default(PAGE_SIZE),
  createdOnPlatform: z.string().optional(),
  orderBy: z.enum(['created_at', 'updated_at']).optional().default('created_at'),
  organizationId: z.uuid().nullable().optional(),
});

const SearchInputSchema = z.object({
  search_string: z.string().min(1),
  limit: z.number().min(1).max(50).optional().default(PAGE_SIZE),
  offset: z.number().min(0).optional().default(0),
  createdOnPlatform: z.string().optional(),
  organizationId: z.uuid().nullable().optional(),
});

const CreateSessionInputSchema = z.object({
  title: titleField.optional().default(''),
  git_url: gitUrlField,
  created_on_platform: createdOnPlatformField,
  version: z.number().int().min(0).optional().default(0),
  last_mode: lastModeField,
  last_model: lastModelField,
  organization_id: organizationIdField,
  parent_session_id: z.uuid().nullable().optional(),
  cloud_agent_session_id: cloudAgentSessionIdField.optional(),
});

const GetSessionInputSchema = z.object({
  session_id: sessionIdField,
  include_blob_urls: z.boolean().optional().default(false),
});

const UpdateSessionInputSchema = z
  .object({
    session_id: sessionIdField,
    title: titleField.optional(),
    git_url: gitUrlField,
    version: z.number().int().min(0).optional(),
    last_mode: lastModeField,
    last_model: lastModelField,
    organization_id: organizationIdField,
  })
  .refine(
    data => {
      const updatableFields = [
        'title',
        'git_url',
        'version',
        'last_mode',
        'last_model',
        'organization_id',
      ] as const;

      return updatableFields.some(field => data[field] !== undefined);
    },
    {
      message: 'At least one updatable field must be provided',
    }
  );

const DeleteSessionInputSchema = z.object({
  session_id: sessionIdField,
});

const ShareSessionInputSchema = z.object({
  session_id: sessionIdField,
  shared_state: z.enum(CliSessionSharedState),
});

const ForkSessionInputSchema = z.object({
  share_or_session_id: z.uuid(),
  created_on_platform: createdOnPlatformField,
});

async function getSessionWithExistsCheck(
  sessionId: string,
  userId: string,
  includeBlobUrls?: boolean
) {
  const [session] = await db
    .select()
    .from(cliSessions)
    .where(and(eq(cliSessions.session_id, sessionId), eq(cliSessions.kilo_user_id, userId)))
    .limit(1);

  if (!session) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Session not found',
    });
  }

  if (includeBlobUrls) {
    const blobTypesToFetch: FileName[] = [];

    if (session.api_conversation_history_blob_url)
      blobTypesToFetch.push('api_conversation_history');
    if (session.task_metadata_blob_url) blobTypesToFetch.push('task_metadata');
    if (session.ui_messages_blob_url) blobTypesToFetch.push('ui_messages');
    if (session.git_state_blob_url) blobTypesToFetch.push('git_state');

    if (blobTypesToFetch.length > 0) {
      const blobUrls = await generateSignedUrls(sessionId, 'sessions', blobTypesToFetch);

      return {
        ...session,
        ...blobUrls,
      };
    }
  }

  return session;
}

interface ForkableSession {
  source_id: string;
  source_folder: FolderName;
  title: string | null;
  session_id: string | null;
  version: number;
}

async function getForkableSession(
  input: z.infer<typeof ForkSessionInputSchema>,
  userId: string
): Promise<ForkableSession> {
  const [sharedSession] = await db
    .select({
      share_id: sharedCliSessions.share_id,
      session_id: sharedCliSessions.session_id,
      shared_state: sharedCliSessions.shared_state,
      title: cliSessions.title,
      version: cliSessions.version,
    })
    .from(sharedCliSessions)
    .leftJoin(cliSessions, eq(sharedCliSessions.session_id, cliSessions.session_id))
    .where(eq(sharedCliSessions.share_id, input.share_or_session_id))
    .limit(1);

  if (sharedSession) {
    if (sharedSession.shared_state !== CliSessionSharedState.Public.toString()) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Shared session is not public',
      });
    }

    return {
      session_id: sharedSession.session_id,
      title: sharedSession.title,
      version: sharedSession.version ?? 0,
      // fields used for copying blobs
      source_id: input.share_or_session_id,
      source_folder: 'shared-sessions' as const,
    };
  }

  const session = await getSessionWithExistsCheck(input.share_or_session_id, userId, false);

  return {
    session_id: session.session_id,
    title: session.title,
    version: session.version,
    // fields used for copying blobs
    source_id: input.share_or_session_id,
    source_folder: 'sessions' as const,
  };
}

/**
 * Build SQL where conditions for platform and organization scoping.
 * Used by both list and search procedures to ensure consistent filtering.
 */
function buildScopeConditions(opts: {
  createdOnPlatform?: string;
  organizationId?: string | null;
}): SQL[] {
  const conditions: SQL[] = [];

  if (opts.createdOnPlatform) {
    if (opts.createdOnPlatform === 'extension') {
      // "Extension" means everything NOT in the known platforms list
      conditions.push(notInArray(cliSessions.created_on_platform, [...KNOWN_PLATFORMS]));
    } else {
      conditions.push(eq(cliSessions.created_on_platform, opts.createdOnPlatform));
    }
  }

  if (opts.organizationId !== undefined) {
    if (opts.organizationId === null) {
      conditions.push(isNull(cliSessions.organization_id));
    } else {
      conditions.push(eq(cliSessions.organization_id, opts.organizationId));
    }
  }

  return conditions;
}

export const cliSessionsRouter = createTRPCRouter({
  list: baseProcedure.input(ListSessionsInputSchema).query(async ({ ctx, input }) => {
    const { cursor, limit, createdOnPlatform, orderBy, organizationId } = input;

    const whereConditions: SQL[] = [
      eq(cliSessions.kilo_user_id, ctx.user.id),
      ...buildScopeConditions({ createdOnPlatform, organizationId }),
    ];

    const orderColumn = orderBy === 'updated_at' ? cliSessions.updated_at : cliSessions.created_at;

    if (cursor) {
      whereConditions.push(lt(orderColumn, cursor));
    }

    const results = await db
      .select(commonSessionFields)
      .from(cliSessions)
      .where(and(...whereConditions))
      .orderBy(desc(orderColumn))
      .limit(limit + 1);

    const hasMore = results.length > limit;
    const resultSessions = hasMore ? results.slice(0, limit) : results;

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

  search: baseProcedure.input(SearchInputSchema).query(async ({ ctx, input }) => {
    const { search_string, limit, offset, createdOnPlatform, organizationId } = input;

    const whereCondition = and(
      eq(cliSessions.kilo_user_id, ctx.user.id),
      or(
        ilike(cliSessions.title, `%${search_string}%`),
        sql`${cliSessions.session_id}::text ILIKE ${`%${search_string}%`}`
      ),
      ...buildScopeConditions({ createdOnPlatform, organizationId })
    );

    const [[countResult], results] = await Promise.all([
      db
        .select({ count: sql<bigint>`count(*)` })
        .from(cliSessions)
        .where(whereCondition),
      db
        .select(commonSessionFields)
        .from(cliSessions)
        .where(whereCondition)
        .orderBy(desc(cliSessions.created_at))
        .limit(limit)
        .offset(offset),
    ]);

    const total = countResult?.count ? Number(countResult.count) : 0;

    return {
      results,
      total,
      limit,
      offset,
    };
  }),

  // DO NOT UPDATE THIS METHOD
  // TO BE REMOVED: 2026-01-01
  create: baseProcedure.input(CreateSessionInputSchema).mutation(async ({ ctx, input }) => {
    if (input.organization_id) {
      await ensureOrganizationAccess(ctx, input.organization_id);
    }

    if (input.parent_session_id) {
      const parentSession = await getSessionWithExistsCheck(input.parent_session_id, ctx.user.id);

      if (parentSession.organization_id) {
        await ensureOrganizationAccess(ctx, parentSession.organization_id);
      }
    }

    const newSessionId = crypto.randomUUID();

    const [newSession] = await db
      .insert(cliSessions)
      .values({
        session_id: newSessionId,
        kilo_user_id: ctx.user.id,
        ...input,
      })
      .returning(commonSessionFields);

    return newSession;
  }),

  createV2: baseProcedure.input(CreateSessionInputSchema).mutation(async ({ ctx, input }) => {
    if (input.organization_id) {
      await ensureOrganizationAccess(ctx, input.organization_id);
    }

    if (input.parent_session_id) {
      const parentSession = await getSessionWithExistsCheck(input.parent_session_id, ctx.user.id);

      if (parentSession.organization_id) {
        await ensureOrganizationAccess(ctx, parentSession.organization_id);
      }
    }

    const newSessionId = crypto.randomUUID();

    const [newSession] = await db
      .insert(cliSessions)
      .values({
        session_id: newSessionId,
        kilo_user_id: ctx.user.id,
        ...input,
      })
      .returning(commonSessionFields);

    return newSession;
  }),

  get: baseProcedure.input(GetSessionInputSchema).query(async ({ ctx, input }) => {
    const { session_id, include_blob_urls } = input;

    return await getSessionWithExistsCheck(session_id, ctx.user.id, include_blob_urls);
  }),

  update: baseProcedure.input(UpdateSessionInputSchema).mutation(async ({ ctx, input }) => {
    const { session_id, ...fields } = input;

    const existingSession = await getSessionWithExistsCheck(session_id, ctx.user.id);

    if (existingSession.organization_id) {
      await ensureOrganizationAccess(ctx, existingSession.organization_id);
    }

    if (input.organization_id) {
      await ensureOrganizationAccess(ctx, input.organization_id);
    }

    const [updatedSession] = await db
      .update(cliSessions)
      .set({ ...fields })
      .where(and(eq(cliSessions.session_id, session_id), eq(cliSessions.kilo_user_id, ctx.user.id)))
      .returning(commonSessionFields);

    if (!updatedSession) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Session not found',
      });
    }

    return updatedSession;
  }),

  delete: baseProcedure.input(DeleteSessionInputSchema).mutation(async ({ ctx, input }) => {
    const { session_id } = input;

    const session = await getSessionWithExistsCheck(session_id, ctx.user.id);

    if (session.cloud_agent_session_id) {
      const authToken = generateApiToken(ctx.user);
      const cloudAgentClient = createCloudAgentClient(authToken);
      await cloudAgentClient.deleteSession(session.cloud_agent_session_id);
    }

    const blobsToDelete: { folderName: FolderName; filename: FileName }[] = BLOB_TYPES.map(
      filename => ({ folderName: 'sessions', filename })
    );

    await deleteBlobs(session_id, blobsToDelete);

    const [deletedSession] = await db
      .delete(cliSessions)
      .where(and(eq(cliSessions.session_id, session_id), eq(cliSessions.kilo_user_id, ctx.user.id)))
      .returning({
        session_id: cliSessions.session_id,
      });

    if (!deletedSession) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Session not found',
      });
    }

    return { success: true, session_id };
  }),

  share: baseProcedure.input(ShareSessionInputSchema).mutation(async ({ ctx, input }) => {
    const { session_id, shared_state } = input;

    await getSessionWithExistsCheck(session_id, ctx.user.id);

    const newShareId = crypto.randomUUID();

    const blobsToCopy: FileName[] = [...BLOB_TYPES];
    const copiedBlobs = await copyBlobs(
      session_id,
      'sessions',
      newShareId,
      'shared-sessions',
      blobsToCopy
    );

    const [newSharedSession] = await db
      .insert(sharedCliSessions)
      .values({
        share_id: newShareId,
        session_id,
        kilo_user_id: ctx.user.id,
        shared_state,
        api_conversation_history_blob_url: copiedBlobs.api_conversation_history_blob_url,
        task_metadata_blob_url: copiedBlobs.task_metadata_blob_url,
        ui_messages_blob_url: copiedBlobs.ui_messages_blob_url,
        git_state_blob_url: copiedBlobs.git_state_blob_url,
      })
      .returning({
        share_id: sharedCliSessions.share_id,
        session_id: sharedCliSessions.session_id,
      });

    return newSharedSession;
  }),

  fork: baseProcedure.input(ForkSessionInputSchema).mutation(async ({ ctx, input }) => {
    const forkableSession = await getForkableSession(input, ctx.user.id);

    const newSessionId = crypto.randomUUID();

    const blobsToCopy: FileName[] = [...BLOB_TYPES];

    const blobUrls = await copyBlobs(
      forkableSession.source_id,
      forkableSession.source_folder,
      newSessionId,
      'sessions',
      blobsToCopy
    );

    const title = forkableSession.title
      ? `Forked from "${forkableSession.title}"`
      : `Forked session`;

    const [newSession] = await db
      .insert(cliSessions)
      .values({
        session_id: newSessionId,
        kilo_user_id: ctx.user.id,
        title,
        forked_from: forkableSession.session_id,
        created_on_platform: input.created_on_platform,
        version: forkableSession.version,
        ...blobUrls,
      })
      .returning(commonSessionFields);

    return newSession;
  }),

  linkCloudAgent: baseProcedure
    .input(
      z.object({
        kilo_session_id: sessionIdField,
        cloud_agent_session_id: cloudAgentSessionIdField,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const result = await db
        .update(cliSessions)
        .set({
          cloud_agent_session_id: input.cloud_agent_session_id,
        })
        .where(
          and(
            eq(cliSessions.session_id, input.kilo_session_id),
            eq(cliSessions.kilo_user_id, ctx.user.id)
          )
        )
        .returning();

      if (result.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Kilo session not found',
        });
      }

      return { success: true };
    }),

  getByCloudAgentSessionId: baseProcedure
    .input(
      z.object({
        cloud_agent_session_id: cloudAgentSessionIdField,
      })
    )
    .query(async ({ input, ctx }) => {
      const [session] = await db
        .select(commonSessionFields)
        .from(cliSessions)
        .where(
          and(
            eq(cliSessions.cloud_agent_session_id, input.cloud_agent_session_id),
            eq(cliSessions.kilo_user_id, ctx.user.id)
          )
        );

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No kilo session found for this cloud-agent session',
        });
      }

      return session;
    }),

  getSessionMessages: baseProcedure
    .input(z.object({ session_id: sessionIdField }))
    .query(async ({ ctx, input }) => {
      const session = await getSessionWithExistsCheck(input.session_id, ctx.user.id);

      if (!session.ui_messages_blob_url) {
        return { messages: [] };
      }

      const messages = await getBlobContent(session.ui_messages_blob_url);

      return { messages: messages ?? [] };
    }),

  getSessionGitState: baseProcedure
    .input(z.object({ session_id: sessionIdField }))
    .query(async ({ ctx, input }) => {
      const session = await getSessionWithExistsCheck(input.session_id, ctx.user.id);

      if (!session.git_state_blob_url) {
        return null;
      }

      const gitState = await getBlobContent(session.git_state_blob_url);

      return gitState;
    }),

  getSessionApiConversationHistory: baseProcedure
    .input(z.object({ session_id: sessionIdField }))
    .query(async ({ ctx, input }) => {
      const session = await getSessionWithExistsCheck(input.session_id, ctx.user.id);

      if (!session.api_conversation_history_blob_url) {
        return { history: [] };
      }

      const history = await getBlobContent(session.api_conversation_history_blob_url);

      return { history: history ?? [] };
    }),

  /**
   * Fork a CLI session from a code review.
   * This allows any org member to fork the session associated with an org code review,
   * or the owner to fork their personal code review session.
   */
  forkForReview: baseProcedure
    .input(
      z.object({
        review_id: z.uuid(),
        created_on_platform: createdOnPlatformField,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const review = await getCodeReviewById(input.review_id);
      if (!review) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Code review not found',
        });
      }

      if (!review.cli_session_id) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Code review has no linked session',
        });
      }

      if (review.owned_by_organization_id) {
        await ensureOrganizationAccess(ctx, review.owned_by_organization_id);
      } else if (review.owned_by_user_id) {
        if (review.owned_by_user_id !== ctx.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this code review',
          });
        }
      } else {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Invalid review ownership data',
        });
      }

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, review.cli_session_id))
        .limit(1);

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      const newSessionId = crypto.randomUUID();
      const blobsToCopy: FileName[] = [...BLOB_TYPES];

      const blobUrls = await copyBlobs(
        review.cli_session_id,
        'sessions',
        newSessionId,
        'sessions',
        blobsToCopy
      );

      const title = session.title ? `Fix: ${session.title}` : 'Fix: Code Review';

      const [newSession] = await db
        .insert(cliSessions)
        .values({
          session_id: newSessionId,
          kilo_user_id: ctx.user.id,
          title,
          git_url: `https://github.com/${review.repo_full_name}`,
          forked_from: session.session_id,
          created_on_platform: input.created_on_platform,
          version: session.version,
          organization_id: review.owned_by_organization_id,
          last_mode: session.last_mode,
          last_model: session.last_model,
          ...blobUrls,
        })
        .returning(commonSessionFields);

      return newSession;
    }),

  /**
   * Share a CLI session from a webhook trigger request.
   * This allows any org member to share the session associated with an org webhook trigger,
   * or the owner to share their personal webhook trigger session.
   */
  shareForWebhookTrigger: baseProcedure
    .input(
      z.object({
        kilo_session_id: sessionIdField,
        trigger_id: z.string().min(1),
        organization_id: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const triggerWhereClause = input.organization_id
        ? and(
            eq(cloud_agent_webhook_triggers.trigger_id, input.trigger_id),
            eq(cloud_agent_webhook_triggers.organization_id, input.organization_id)
          )
        : and(
            eq(cloud_agent_webhook_triggers.trigger_id, input.trigger_id),
            eq(cloud_agent_webhook_triggers.user_id, ctx.user.id),
            isNull(cloud_agent_webhook_triggers.organization_id)
          );

      const [trigger] = await db
        .select()
        .from(cloud_agent_webhook_triggers)
        .where(triggerWhereClause);

      if (!trigger) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Trigger not found',
        });
      }

      if (input.organization_id) {
        await ensureOrganizationAccess(ctx, input.organization_id);
      }

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, input.kilo_session_id))
        .limit(1);

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      const newShareId = crypto.randomUUID();
      const blobsToCopy: FileName[] = [...BLOB_TYPES];

      const copiedBlobs = await copyBlobs(
        input.kilo_session_id,
        'sessions',
        newShareId,
        'shared-sessions',
        blobsToCopy
      );

      const [newSharedSession] = await db
        .insert(sharedCliSessions)
        .values({
          share_id: newShareId,
          session_id: input.kilo_session_id,
          kilo_user_id: ctx.user.id,
          shared_state: CliSessionSharedState.Public,
          api_conversation_history_blob_url: copiedBlobs.api_conversation_history_blob_url,
          task_metadata_blob_url: copiedBlobs.task_metadata_blob_url,
          ui_messages_blob_url: copiedBlobs.ui_messages_blob_url,
          git_state_blob_url: copiedBlobs.git_state_blob_url,
        })
        .returning({
          share_id: sharedCliSessions.share_id,
          session_id: sharedCliSessions.session_id,
        });

      return newSharedSession;
    }),
});
