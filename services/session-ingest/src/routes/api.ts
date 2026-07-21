import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { sql, eq, and, inArray, isNull, or, isNotNull } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2, organization_memberships, organizations } from '@kilocode/db/schema';
import {
  DEFAULT_KILO_SDK_MESSAGE_PAGE_SIZE,
  getSessionMessagesSchema,
  MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE,
  persistedKiloSdkMessageHistorySchema,
} from '@kilocode/session-ingest-contracts';

import type { Env } from '../env';
import { zodJsonValidator, withDORetry } from '@kilocode/worker-utils';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { getUserConnectionDO } from '../dos/UserConnectionDO';
import { getSessionExport } from '../services/session-export';
import { mapSessionEventRow, notifyUserSessionEvent } from '../session-events';
import { handleDirectIngestRequest } from '../ingest/direct-ingest';
import { resolveAccessibleKiloSession } from '../services/session-access';

export type ApiContext = {
  Bindings: Env;
  Variables: {
    user_id: string;
  };
};

export const api = new Hono<ApiContext>();

type SessionEvent = Parameters<typeof notifyUserSessionEvent>[2];
type SessionEventExecutionContext = NonNullable<Parameters<typeof notifyUserSessionEvent>[3]>;

function getOptionalExecutionContext(
  c: Context<ApiContext>
): SessionEventExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch (error) {
    if (error instanceof Error && error.message === 'This context has no ExecutionContext') {
      return undefined;
    }
    throw error;
  }
}

function getRequestBodyStream(request: Request): ReadableStream<Uint8Array> {
  const body = request.body as ReadableStream<Uint8Array> | null;
  if (body) return body;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function notifyUserSessionEventFromContext(
  c: Context<ApiContext>,
  kiloUserId: string,
  event: SessionEvent
): void {
  const executionContext = getOptionalExecutionContext(c);
  if (executionContext) {
    notifyUserSessionEvent(c.env, kiloUserId, event, executionContext);
    return;
  }
  notifyUserSessionEvent(c.env, kiloUserId, event);
}

const createSessionSchema = z.object({
  sessionId: z.string().startsWith('ses_').length(30),
});

const sessionIdSchema = z.string().startsWith('ses_').length(30);

const ingestVersionSchema = z.coerce.number().int().nonnegative().catch(0);

api.post('/session', zodJsonValidator(createSessionSchema), async c => {
  const body = c.req.valid('json');

  // Persist a placeholder session row.
  // This is intentionally minimal; we only need a working Hyperdrive -> Postgres path.
  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const kiloUserId = c.get('user_id');

  const [createdRow] = await db
    .insert(cli_sessions_v2)
    .values({
      session_id: body.sessionId,
      kilo_user_id: kiloUserId,
    })
    .onConflictDoNothing({
      target: [cli_sessions_v2.session_id, cli_sessions_v2.kilo_user_id],
    })
    .returning();

  if (createdRow) {
    const session = mapSessionEventRow(createdRow);
    notifyUserSessionEventFromContext(c, kiloUserId, {
      type: 'session.created',
      data: { source: 'v2', session, changedAt: session.updatedAt },
    });
    // The session-ready push fires from UserConnectionDO when a CLI heartbeat
    // first reports the session as remote-controllable — not here.
  }

  if (createdRow) {
    try {
      await withDORetry(
        () => getSessionAccessCacheDO(c.env, { kiloUserId }),
        sessionCache =>
          sessionCache.putValidated({
            sessionId: body.sessionId,
            organizationId: null,
          }),
        'SessionAccessCacheDO.putValidated'
      );
    } catch (error) {
      console.error('Failed to warm session access cache after create', {
        kiloUserId,
        sessionId: body.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return c.json(
    {
      id: body.sessionId,
      ingestPath: `/api/session/${body.sessionId}/ingest`,
    },
    200
  );
});

api.delete('/session/:sessionId', async c => {
  const rawSessionId = c.req.param('sessionId');
  const parsed = sessionIdSchema.safeParse(rawSessionId);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid sessionId', issues: parsed.error.issues }, 400);
  }

  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const kiloUserId = c.get('user_id');
  const accessibleSession = await resolveAccessibleKiloSession(c.env, {
    kiloUserId,
    kiloSessionId: parsed.data,
  });

  if (!accessibleSession) {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  // Delete children first (FK is RESTRICT/NO ACTION).
  // This only covers direct/indirect descendants (not arbitrary cycles).
  const treeResult = await db.execute<{ session_id: string; has_access: boolean }>(sql`
    WITH RECURSIVE tree AS (
      SELECT
        session_id,
        parent_session_id,
        kilo_user_id,
        organization_id,
        0 AS depth,
        ARRAY[session_id] AS path
      FROM ${cli_sessions_v2}
      WHERE session_id = ${parsed.data} AND kilo_user_id = ${kiloUserId}
      UNION ALL
      SELECT
        c.session_id,
        c.parent_session_id,
        c.kilo_user_id,
        c.organization_id,
        t.depth + 1,
        t.path || c.session_id
      FROM ${cli_sessions_v2} c
      INNER JOIN tree t ON c.parent_session_id = t.session_id AND c.kilo_user_id = t.kilo_user_id
      WHERE NOT (c.session_id = ANY(t.path)) AND t.depth < 10
    )
    SELECT
      tree.session_id,
      tree.organization_id IS NULL OR EXISTS (
        SELECT 1
        FROM ${organization_memberships}
        INNER JOIN ${organizations}
          ON ${organizations.id} = ${organization_memberships.organization_id}
          AND ${organizations.deleted_at} IS NULL
        WHERE ${organization_memberships.organization_id} = tree.organization_id
          AND ${organization_memberships.kilo_user_id} = ${kiloUserId}
      ) AS has_access
    FROM tree
    ORDER BY depth DESC
  `);

  const treeRows = treeResult.rows;
  if (treeRows.some(row => !row.has_access)) {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }
  const orderedSessionIds = treeRows.length > 0 ? treeRows.map(r => r.session_id) : [parsed.data];
  const deletedRows = await db
    .select()
    .from(cli_sessions_v2)
    .where(
      and(
        inArray(cli_sessions_v2.session_id, orderedSessionIds),
        eq(cli_sessions_v2.kilo_user_id, kiloUserId)
      )
    );

  await db.transaction(async tx => {
    for (const sessionId of orderedSessionIds) {
      await tx
        .delete(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.session_id, sessionId),
            eq(cli_sessions_v2.kilo_user_id, kiloUserId)
          )
        );
    }
  });

  const deletedAt = new Date().toISOString();
  const deletedRowsBySessionId = new Map(deletedRows.map(row => [row.session_id, row]));
  for (const sessionId of orderedSessionIds) {
    const row = deletedRowsBySessionId.get(sessionId);
    if (!row) {
      continue;
    }
    notifyUserSessionEventFromContext(c, kiloUserId, {
      type: 'session.deleted',
      data: {
        source: 'v2',
        sessionId: row.session_id,
        parentSessionId: row.parent_session_id,
        organizationId: row.organization_id,
        gitUrl: row.git_url,
        gitBranch: row.git_branch,
        createdOnPlatform: row.created_on_platform,
        deletedAt,
      },
    });
  }

  for (const sessionId of orderedSessionIds) {
    await withDORetry(
      () => getSessionAccessCacheDO(c.env, { kiloUserId }),
      sessionCache => sessionCache.remove(sessionId),
      'SessionAccessCacheDO.remove'
    );
    await withDORetry(
      () => getSessionIngestDO(c.env, { kiloUserId, sessionId }),
      stub => stub.clear(),
      'SessionIngestDO.clear'
    );
  }

  return c.json({ success: true }, 200);
});

api.post('/session/:sessionId/ingest', async c => {
  const rawSessionId = c.req.param('sessionId');
  const sessionIdParseResult = sessionIdSchema.safeParse(rawSessionId);
  if (!sessionIdParseResult.success) {
    return c.json(
      { success: false, error: 'Invalid sessionId', issues: sessionIdParseResult.error.issues },
      400
    );
  }

  const sessionId = sessionIdParseResult.data;
  const ingestedAt = Date.now();
  const ingestRequestId = crypto.randomUUID();
  const kiloUserId = c.get('user_id');
  const accessibleSession = await resolveAccessibleKiloSession(c.env, {
    kiloUserId,
    kiloSessionId: sessionId,
  });

  if (!accessibleSession) {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  const ingestVersion = ingestVersionSchema.parse(c.req.query('v') ?? 0);

  const result = await handleDirectIngestRequest({
    env: c.env,
    body: getRequestBodyStream(c.req.raw),
    contentLength: c.req.header('content-length'),
    kiloUserId,
    sessionId,
    ingestVersion,
    ingestedAt,
    ingestRequestId,
    executionContext: getOptionalExecutionContext(c),
  });

  return c.json(result.body, result.status);
});

api.get('/session/:sessionId/export', async c => {
  const rawSessionId = c.req.param('sessionId');
  const parsed = sessionIdSchema.safeParse(rawSessionId);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid sessionId', issues: parsed.error.issues }, 400);
  }

  const kiloUserId = c.get('user_id');
  const stream = await getSessionExport(c.env, parsed.data, kiloUserId);

  if (stream === null) {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  return c.body(stream, 200, {
    'content-type': 'application/json; charset=utf-8',
  });
});

/**
 * Paginated session-message history for any Kilo session the user owns.
 * Reuses the same `(owner, current organization membership)` check shape as
 * `SessionIngestRPC.findOwnedAccessibleSession` and delegates the bounded
 * read to `SessionIngestDO.readKiloSdkMessages`. Mobile uses the default
 * page size of 50; the existing max of 100 is honored for callers that
 * request more.
 */
api.get('/session/:sessionId/messages', async c => {
  const rawSessionId = c.req.param('sessionId');
  const parsed = sessionIdSchema.safeParse(rawSessionId);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid sessionId', issues: parsed.error.issues }, 400);
  }

  const limitParam = c.req.query('limit');
  const beforeParam = c.req.query('before');
  // Apply the shared default at the HTTP layer too so the value passed to
  // the contract schema (and onward to the DO) is always defined. The
  // contract schema's `.default(...)` is the source of truth; this is a
  // symmetry shortcut that also keeps the JSON response and any logging
  // explicit about the page size.
  const limitParsed =
    limitParam === undefined
      ? { success: true as const, data: DEFAULT_KILO_SDK_MESSAGE_PAGE_SIZE }
      : z.coerce
          .number()
          .int()
          .positive()
          .max(MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE)
          .safeParse(limitParam);
  if (!limitParsed.success) {
    return c.json({ success: false, error: 'Invalid limit' }, 400);
  }
  const beforeParsed =
    beforeParam === undefined
      ? { success: true as const, data: undefined }
      : z.string().min(1).max(1024).safeParse(beforeParam);
  if (!beforeParsed.success) {
    return c.json({ success: false, error: 'Invalid before' }, 400);
  }

  const kiloUserId = c.get('user_id');
  const inputParse = getSessionMessagesSchema.safeParse({
    kiloUserId,
    kiloSessionId: parsed.data,
    limit: limitParsed.data,
    before: beforeParsed.data,
  });
  if (!inputParse.success) {
    return c.json(
      { success: false, error: 'Invalid paging input', issues: inputParse.error.issues },
      400
    );
  }

  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  // Mirrors `SessionIngestRPC.findOwnedAccessibleSession`. The join is
  // duplicated here (instead of going through the RPC) because importing
  // `SessionIngestRPC` from `routes/api.ts` would create a cycle
  // `api.ts -> session-ingest-rpc.ts -> app.ts -> api.ts` and break the
  // node-env vitest suite that loads this module. Keep the two queries
  // in sync if the access shape ever changes.
  const authorized = await db
    .select({ sessionId: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .leftJoin(
      organization_memberships,
      and(
        eq(organization_memberships.organization_id, cli_sessions_v2.organization_id),
        eq(organization_memberships.kilo_user_id, kiloUserId)
      )
    )
    .where(
      and(
        eq(cli_sessions_v2.session_id, inputParse.data.kiloSessionId),
        eq(cli_sessions_v2.kilo_user_id, kiloUserId),
        or(isNull(cli_sessions_v2.organization_id), isNotNull(organization_memberships.id))
      )
    )
    .limit(1);
  if (authorized.length === 0) {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  const rawHistory = await withDORetry<ReturnType<typeof getSessionIngestDO>, unknown>(
    () =>
      getSessionIngestDO(c.env, {
        kiloUserId,
        sessionId: inputParse.data.kiloSessionId,
      }),
    stub =>
      stub.readKiloSdkMessages({
        limit: inputParse.data.limit,
        before: inputParse.data.before,
      }),
    'SessionIngestDO.readKiloSdkMessages'
  );
  const history = persistedKiloSdkMessageHistorySchema.nullable().safeParse(rawHistory);

  return c.json(
    {
      success: true,
      kiloSessionId: inputParse.data.kiloSessionId,
      history: history.success ? history.data : { kind: 'invalid_data' },
    },
    200
  );
});

api.post('/session/:sessionId/share', async c => {
  const rawSessionId = c.req.param('sessionId');
  const parsed = sessionIdSchema.safeParse(rawSessionId);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid sessionId', issues: parsed.error.issues }, 400);
  }

  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const kiloUserId = c.get('user_id');
  const publicId = crypto.randomUUID();
  const shareResult = await db.execute<{ public_id: string }>(sql`
    UPDATE ${cli_sessions_v2}
    SET public_id = COALESCE(${cli_sessions_v2.public_id}, ${publicId})
    WHERE ${cli_sessions_v2.session_id} = ${parsed.data}
      AND ${cli_sessions_v2.kilo_user_id} = ${kiloUserId}
      AND (
        ${cli_sessions_v2.organization_id} IS NULL
        OR EXISTS (
          SELECT 1
          FROM ${organization_memberships}
          INNER JOIN ${organizations}
            ON ${organizations.id} = ${organization_memberships.organization_id}
            AND ${organizations.deleted_at} IS NULL
          WHERE ${organization_memberships.organization_id} = ${cli_sessions_v2.organization_id}
            AND ${organization_memberships.kilo_user_id} = ${kiloUserId}
        )
      )
    RETURNING ${cli_sessions_v2.public_id}
  `);

  const sharedSession = shareResult.rows[0];
  if (!sharedSession) {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  return c.json({ success: true, public_id: sharedSession.public_id }, 200);
});

api.post('/session/:sessionId/unshare', async c => {
  const rawSessionId = c.req.param('sessionId');
  const parsed = sessionIdSchema.safeParse(rawSessionId);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid sessionId', issues: parsed.error.issues }, 400);
  }

  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const kiloUserId = c.get('user_id');
  const accessibleSession = await resolveAccessibleKiloSession(c.env, {
    kiloUserId,
    kiloSessionId: parsed.data,
  });

  if (!accessibleSession) {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  const sessionRows = await db
    .select({ session_id: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.session_id, parsed.data), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
    )
    .limit(1);

  if (!sessionRows[0]) {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  await db
    .update(cli_sessions_v2)
    .set({ public_id: null })
    .where(
      and(eq(cli_sessions_v2.session_id, parsed.data), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
    );

  return c.json({ success: true }, 200);
});

api.get('/sessions/active', async c => {
  const kiloUserId = c.get('user_id');
  const stub = getUserConnectionDO(c.env, { kiloUserId });
  const sessions = await stub.getActiveSessions();

  // Overlay the heartbeat snapshot titles with the latest persisted
  // `cli_sessions_v2.title` for this user, so that a rename (which writes
  // only to Postgres) is reflected on the next poll instead of waiting for
  // the CLI's next heartbeat. The overlay is best-effort: a DB failure must
  // not blank the entire Remote section, so we fall back to the heartbeat
  // titles and return 200.
  if (sessions.length > 0) {
    const ids = sessions.map(s => s.id);
    try {
      const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
      const titleRows = await db
        .select({
          session_id: cli_sessions_v2.session_id,
          title: cli_sessions_v2.title,
        })
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.kilo_user_id, kiloUserId),
            inArray(cli_sessions_v2.session_id, ids)
          )
        );

      const titleBySessionId = new Map<string, string>();
      for (const row of titleRows) {
        // `cli_sessions_v2.title` is nullable, unconstrained text, and
        // ingest can persist `''` or whitespace. Only honor DB titles that
        // are actually meaningful; otherwise keep the heartbeat title so we
        // never blank a valid row.
        if (typeof row.title === 'string' && row.title.trim().length > 0) {
          titleBySessionId.set(row.session_id, row.title);
        }
      }

      if (titleBySessionId.size > 0) {
        for (const session of sessions) {
          const dbTitle = titleBySessionId.get(session.id);
          if (dbTitle !== undefined) {
            session.title = dbTitle;
          }
        }
      }
    } catch (error) {
      console.warn('Failed to overlay active-session titles from Postgres (non-fatal)', {
        kiloUserId,
        sessionCount: sessions.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return c.json({ sessions }, 200);
});

// CLI connects to /api/user/cli without userId in the path — userId comes from the JWT.
api.get('/user/cli', async c => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ success: false, error: 'Expected WebSocket upgrade' }, 426);
  }

  const kiloUserId = c.get('user_id');
  const stub = getUserConnectionDO(c.env, { kiloUserId });
  const wsUrl = new URL(c.req.url);
  wsUrl.pathname = '/cli';
  // The DO can't recover the user from its idFromName-derived id; it needs the
  // authenticated user for the session-ready push.
  wsUrl.searchParams.set('kiloUserId', kiloUserId);

  return stub.fetch(new Request(wsUrl.toString(), c.req.raw));
});

// Web UI connects to /api/user/web without userId in the path — userId comes from the JWT.
api.get('/user/web', async c => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ success: false, error: 'Expected WebSocket upgrade' }, 426);
  }

  const kiloUserId = c.get('user_id');
  const stub = getUserConnectionDO(c.env, { kiloUserId });
  const wsUrl = new URL(c.req.url);
  wsUrl.pathname = '/web';

  return stub.fetch(new Request(wsUrl.toString(), c.req.raw));
});
