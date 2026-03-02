import { Hono } from 'hono';
import { z } from 'zod';
import { sql, eq, and, isNull } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';

import type { Env } from '../env';
import { zodJsonValidator, withDORetry } from '@kilocode/worker-utils';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { SessionSyncInputSchema } from '../types/session-sync';
import { splitIngestBatchForDO } from '../util/ingest-batching';
import { getSessionExport } from '../services/session-export';

export type ApiContext = {
  Bindings: Env;
  Variables: {
    user_id: string;
  };
};

export const api = new Hono<ApiContext>();

const createSessionSchema = z.object({
  sessionId: z.string().startsWith('ses_').length(30),
});

const ingestSessionSchema = SessionSyncInputSchema;

const sessionIdSchema = z.string().startsWith('ses_').length(30);

const ingestVersionSchema = z.coerce.number().int().nonnegative().catch(0);

api.post('/session', zodJsonValidator(createSessionSchema), async c => {
  const body = c.req.valid('json');

  // Persist a placeholder session row.
  // This is intentionally minimal; we only need a working Hyperdrive -> Postgres path.
  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const kiloUserId = c.get('user_id');

  await db
    .insert(cli_sessions_v2)
    .values({
      session_id: body.sessionId,
      kilo_user_id: kiloUserId,
    })
    .onConflictDoNothing({
      target: [cli_sessions_v2.session_id, cli_sessions_v2.kilo_user_id],
    });

  // Warm the session cache so the first ingest can skip Postgres.
  await withDORetry(
    () => getSessionAccessCacheDO(c.env, { kiloUserId }),
    sessionCache => sessionCache.add(body.sessionId),
    'SessionAccessCacheDO.add'
  );

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

  // Delete children first (FK is RESTRICT/NO ACTION).
  // This only covers direct/indirect descendants (not arbitrary cycles).
  const treeResult = await db.execute<{ session_id: string }>(sql`
    WITH RECURSIVE tree AS (
      SELECT session_id, parent_session_id, kilo_user_id, 0 AS depth, ARRAY[session_id] AS path
      FROM ${cli_sessions_v2}
      WHERE session_id = ${parsed.data} AND kilo_user_id = ${kiloUserId}
      UNION ALL
      SELECT c.session_id, c.parent_session_id, c.kilo_user_id, t.depth + 1, t.path || c.session_id
      FROM ${cli_sessions_v2} c
      INNER JOIN tree t ON c.parent_session_id = t.session_id AND c.kilo_user_id = t.kilo_user_id
      WHERE NOT (c.session_id = ANY(t.path)) AND t.depth < 10
    )
    SELECT session_id FROM tree ORDER BY depth DESC
  `);

  const treeRows = treeResult.rows;
  const orderedSessionIds = treeRows.length > 0 ? treeRows.map(r => r.session_id) : [parsed.data];

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

api.post('/session/:sessionId/ingest', zodJsonValidator(ingestSessionSchema), async c => {
  const rawSessionId = c.req.param('sessionId');
  const sessionIdParseResult = sessionIdSchema.safeParse(rawSessionId);
  if (!sessionIdParseResult.success) {
    return c.json(
      { success: false, error: 'Invalid sessionId', issues: sessionIdParseResult.error.issues },
      400
    );
  }

  const sessionId = sessionIdParseResult.data;

  const ingestBody = c.req.valid('json');

  const kiloUserId = c.get('user_id');
  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);

  const sessionCacheStubFactory = () => getSessionAccessCacheDO(c.env, { kiloUserId });

  const hasAccess = await withDORetry(
    sessionCacheStubFactory,
    sessionCache => sessionCache.has(sessionId),
    'SessionAccessCacheDO.has'
  );

  if (!hasAccess) {
    const sessionRows = await db
      .select({ session_id: cli_sessions_v2.session_id })
      .from(cli_sessions_v2)
      .where(
        and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
      )
      .limit(1);

    if (!sessionRows[0]) {
      return c.json({ success: false, error: 'session_not_found' }, 404);
    }

    // Backfill so subsequent ingests can skip Postgres.
    await withDORetry(
      sessionCacheStubFactory,
      sessionCache => sessionCache.add(sessionId),
      'SessionAccessCacheDO.add'
    );
  }

  const ingestVersion = ingestVersionSchema.parse(c.req.query('v') ?? 0);

  const split = splitIngestBatchForDO(ingestBody.data);
  if (split.droppedOversizeItems > 0) {
    console.warn('Dropping oversize ingest items', {
      incoming_items: ingestBody.data.length,
      dropped_oversize_items: split.droppedOversizeItems,
      chunk_count: split.chunks.length,
    });
  }

  const mergedChanges = new Map<string, string | null>();
  for (const chunk of split.chunks) {
    const ingestResult = await withDORetry(
      () => getSessionIngestDO(c.env, { kiloUserId, sessionId: sessionId }),
      stub => stub.ingest(chunk, kiloUserId, sessionId, ingestVersion),
      'SessionIngestDO.ingest'
    );

    for (const change of ingestResult.changes) {
      mergedChanges.set(change.name, change.value);
    }
  }

  const title = mergedChanges.has('title') ? (mergedChanges.get('title') ?? null) : undefined;
  const platform = mergedChanges.has('platform')
    ? (mergedChanges.get('platform') ?? null)
    : undefined;
  const orgId = mergedChanges.has('orgId') ? (mergedChanges.get('orgId') ?? null) : undefined;
  const gitUrl = mergedChanges.has('gitUrl') ? (mergedChanges.get('gitUrl') ?? null) : undefined;
  const gitBranch = mergedChanges.has('gitBranch')
    ? (mergedChanges.get('gitBranch') ?? null)
    : undefined;

  const updates: Partial<
    Pick<
      typeof cli_sessions_v2.$inferInsert,
      'title' | 'created_on_platform' | 'organization_id' | 'git_url' | 'git_branch'
    >
  > = {};
  if (title !== undefined) updates.title = title;
  // created_on_platform is NOT NULL in the schema, so skip if null to avoid a DB error.
  if (platform !== undefined && platform !== null) updates.created_on_platform = platform;
  if (orgId !== undefined) updates.organization_id = orgId;
  if (gitUrl !== undefined) updates.git_url = gitUrl;
  if (gitBranch !== undefined) updates.git_branch = gitBranch;

  if (Object.keys(updates).length > 0) {
    await db
      .update(cli_sessions_v2)
      .set(updates)
      .where(
        and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
      );
  }

  const parentSessionId = mergedChanges.has('parentId')
    ? (mergedChanges.get('parentId') ?? null)
    : undefined;
  if (parentSessionId !== undefined) {
    if (parentSessionId === sessionId) {
      return c.json({ success: false, error: 'parent_session_id_cannot_be_self' }, 400);
    }

    if (parentSessionId) {
      const parentRows = await db
        .select({ session_id: cli_sessions_v2.session_id })
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.session_id, parentSessionId),
            eq(cli_sessions_v2.kilo_user_id, kiloUserId)
          )
        )
        .limit(1);

      if (!parentRows[0]) {
        return c.json({ success: false, error: 'parent_session_not_found' }, 404);
      }
    }

    await db
      .update(cli_sessions_v2)
      .set({ parent_session_id: parentSessionId })
      .where(
        and(
          eq(cli_sessions_v2.session_id, sessionId),
          eq(cli_sessions_v2.kilo_user_id, kiloUserId),
          sql`${cli_sessions_v2.parent_session_id} IS DISTINCT FROM ${parentSessionId}`
        )
      );
  }

  return c.json({ success: true }, 200);
});

api.get('/session/:sessionId/export', async c => {
  const rawSessionId = c.req.param('sessionId');
  const parsed = sessionIdSchema.safeParse(rawSessionId);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid sessionId', issues: parsed.error.issues }, 400);
  }

  const kiloUserId = c.get('user_id');
  const json = await getSessionExport(c.env, parsed.data, kiloUserId);

  if (json === null) {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  return c.body(json, 200, {
    'content-type': 'application/json; charset=utf-8',
  });
});

api.post('/session/:sessionId/share', async c => {
  const rawSessionId = c.req.param('sessionId');
  const parsed = sessionIdSchema.safeParse(rawSessionId);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid sessionId', issues: parsed.error.issues }, 400);
  }

  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const kiloUserId = c.get('user_id');

  const sessionRows = await db
    .select({
      session_id: cli_sessions_v2.session_id,
      public_id: cli_sessions_v2.public_id,
    })
    .from(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.session_id, parsed.data), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
    )
    .limit(1);

  const session = sessionRows[0];

  if (!session) {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  if (session.public_id) {
    return c.json({ success: true, public_id: session.public_id }, 200);
  }

  const publicId = crypto.randomUUID();
  const updated = await db
    .update(cli_sessions_v2)
    .set({ public_id: publicId })
    .where(
      and(
        eq(cli_sessions_v2.session_id, parsed.data),
        eq(cli_sessions_v2.kilo_user_id, kiloUserId),
        isNull(cli_sessions_v2.public_id)
      )
    )
    .returning({ public_id: cli_sessions_v2.public_id });

  // If another request already set it, just return the existing value.
  if (updated.length === 0) {
    const existingRows = await db
      .select({ public_id: cli_sessions_v2.public_id })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.session_id, parsed.data),
          eq(cli_sessions_v2.kilo_user_id, kiloUserId)
        )
      )
      .limit(1);

    const existing = existingRows[0];

    if (existing?.public_id) {
      return c.json({ success: true, public_id: existing.public_id }, 200);
    }
  }

  return c.json({ success: true, public_id: publicId }, 200);
});

api.post('/session/:sessionId/unshare', async c => {
  const rawSessionId = c.req.param('sessionId');
  const parsed = sessionIdSchema.safeParse(rawSessionId);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid sessionId', issues: parsed.error.issues }, 400);
  }

  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const kiloUserId = c.get('user_id');

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
