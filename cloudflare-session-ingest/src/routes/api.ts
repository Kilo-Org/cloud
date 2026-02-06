import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Env } from '../env';
import { zodJsonValidator } from '../util/validation';
import { getDb } from '../db/kysely';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { SessionSyncInputSchema } from '../types/session-sync';
import { withDORetry } from '../util/do-retry';
import { splitIngestBatchForDO } from '../util/ingest-batching';

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

api.post('/session', zodJsonValidator(createSessionSchema), async c => {
  const body = c.req.valid('json');

  // Persist a placeholder session row.
  // This is intentionally minimal; we only need a working Hyperdrive -> Postgres path.
  const db = getDb(c.env.HYPERDRIVE);
  const kiloUserId = c.get('user_id');

  await db
    .insertInto('cli_sessions_v2')
    .values({
      session_id: body.sessionId,
      kilo_user_id: kiloUserId,
    })
    .onConflict(oc => oc.columns(['session_id', 'kilo_user_id']).doNothing())
    .execute();

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

  const db = getDb(c.env.HYPERDRIVE);
  const kiloUserId = c.get('user_id');

  const session = await db
    .selectFrom('cli_sessions_v2')
    .select(['session_id'])
    .where('session_id', '=', parsed.data)
    .where('kilo_user_id', '=', kiloUserId)
    .executeTakeFirst();

  if (!session) {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  // Delete children first (FK is RESTRICT/NO ACTION).
  // This only covers direct/indirect descendants (not arbitrary cycles).
  const treeRows = await (
    db
      .withRecursive('tree', qb =>
        qb
          .selectFrom('cli_sessions_v2')
          .select([
            'session_id',
            'parent_session_id',
            'kilo_user_id',
            sql<number>`0`.as('depth'),
            // Used for cycle detection in the recursive term.
            sql<string[]>`ARRAY[session_id]`.as('path'),
          ])
          .where('session_id', '=', parsed.data)
          .where('kilo_user_id', '=', kiloUserId)
          .unionAll(
            qb
              .selectFrom('cli_sessions_v2 as c')
              .innerJoin('tree as t', join =>
                join
                  .onRef('c.parent_session_id', '=', 't.session_id')
                  .onRef('c.kilo_user_id', '=', 't.kilo_user_id')
              )
              .select([
                'c.session_id as session_id',
                'c.parent_session_id as parent_session_id',
                'c.kilo_user_id as kilo_user_id',
                sql<number>`t.depth + 1`.as('depth'),
                sql<string[]>`t.path || c.session_id`.as('path'),
              ])
              // Break cycles (e.g. A->B, B->A) by skipping already-visited nodes.
              .where(sql<boolean>`NOT (c.session_id = ANY(t.path))`)
              // Hard cap as a last resort against pathological graphs.
              .where(sql<boolean>`t.depth < 10`)
          )
      )
      .selectFrom('tree')
      .select(['session_id'])
      .orderBy('depth', 'desc') as unknown as {
      execute: () => Promise<Array<{ session_id: string }>>;
    }
  ).execute();

  const orderedSessionIds = treeRows.length > 0 ? treeRows.map(r => r.session_id) : [parsed.data];

  await db.transaction().execute(async trx => {
    for (const sessionId of orderedSessionIds) {
      await trx
        .deleteFrom('cli_sessions_v2')
        .where('session_id', '=', sessionId)
        .where('kilo_user_id', '=', kiloUserId)
        .execute();
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
  const parsed = sessionIdSchema.safeParse(rawSessionId);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid sessionId', issues: parsed.error.issues }, 400);
  }

  const ingestBody = c.req.valid('json');

  const kiloUserId = c.get('user_id');
  const db = getDb(c.env.HYPERDRIVE);

  const sessionCacheStubFactory = () => getSessionAccessCacheDO(c.env, { kiloUserId });

  const hasAccess = await withDORetry(
    sessionCacheStubFactory,
    sessionCache => sessionCache.has(parsed.data),
    'SessionAccessCacheDO.has'
  );

  if (!hasAccess) {
    const session = await db
      .selectFrom('cli_sessions_v2')
      .select(['session_id'])
      .where('session_id', '=', parsed.data)
      .where('kilo_user_id', '=', kiloUserId)
      .executeTakeFirst();

    if (!session) {
      return c.json({ success: false, error: 'session_not_found' }, 404);
    }

    // Backfill so subsequent ingests can skip Postgres.
    await withDORetry(
      sessionCacheStubFactory,
      sessionCache => sessionCache.add(parsed.data),
      'SessionAccessCacheDO.add'
    );
  }

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
      () => getSessionIngestDO(c.env, { kiloUserId, sessionId: parsed.data }),
      stub => stub.ingest(chunk),
      'SessionIngestDO.ingest'
    );

    for (const change of ingestResult.changes) {
      mergedChanges.set(change.name, change.value);
    }
  }

  const titleValue = mergedChanges.has('title') ? (mergedChanges.get('title') ?? null) : undefined;
  const platformValue = mergedChanges.has('platform')
    ? (mergedChanges.get('platform') ?? null)
    : undefined;
  const orgIdValue = mergedChanges.has('orgId') ? (mergedChanges.get('orgId') ?? null) : undefined;

  let hasSessionUpdate = false;
  let sessionUpdate = db.updateTable('cli_sessions_v2');
  if (titleValue !== undefined) {
    hasSessionUpdate = true;
    sessionUpdate = sessionUpdate.set({ title: titleValue });
  }
  if (platformValue !== undefined) {
    hasSessionUpdate = true;
    sessionUpdate = sessionUpdate.set({ created_on_platform: platformValue });
  }
  if (orgIdValue !== undefined) {
    hasSessionUpdate = true;
    sessionUpdate = sessionUpdate.set({ organization_id: orgIdValue });
  }

  if (hasSessionUpdate) {
    await sessionUpdate
      .where('session_id', '=', parsed.data)
      .where('kilo_user_id', '=', kiloUserId)
      .execute();
  }

  const parentIdValue = mergedChanges.has('parentId')
    ? (mergedChanges.get('parentId') ?? null)
    : undefined;
  if (parentIdValue !== undefined) {
    if (parentIdValue === parsed.data) {
      return c.json({ success: false, error: 'parent_session_id_cannot_be_self' }, 400);
    }

    if (parentIdValue) {
      const parent = await db
        .selectFrom('cli_sessions_v2')
        .select(['session_id'])
        .where('session_id', '=', parentIdValue)
        .where('kilo_user_id', '=', kiloUserId)
        .executeTakeFirst();

      if (!parent) {
        return c.json({ success: false, error: 'parent_session_not_found' }, 404);
      }
    }

    await db
      .updateTable('cli_sessions_v2')
      .set({ parent_session_id: parentIdValue })
      .where('session_id', '=', parsed.data)
      .where('kilo_user_id', '=', kiloUserId)
      .where('parent_session_id', 'is distinct from', parentIdValue)
      .execute();
  }

  return c.json({ success: true }, 200);
});

api.get('/session/:sessionId/export', async c => {
  const rawSessionId = c.req.param('sessionId');
  const parsed = sessionIdSchema.safeParse(rawSessionId);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid sessionId', issues: parsed.error.issues }, 400);
  }

  const db = getDb(c.env.HYPERDRIVE);
  const kiloUserId = c.get('user_id');

  const session = await db
    .selectFrom('cli_sessions_v2')
    .select(['session_id'])
    .where('session_id', '=', parsed.data)
    .where('kilo_user_id', '=', kiloUserId)
    .executeTakeFirst();

  if (!session) {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  const json = await withDORetry(
    () => getSessionIngestDO(c.env, { kiloUserId, sessionId: parsed.data }),
    stub => stub.getAll(),
    'SessionIngestDO.getAll'
  );

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

  const db = getDb(c.env.HYPERDRIVE);
  const kiloUserId = c.get('user_id');

  const session = await db
    .selectFrom('cli_sessions_v2')
    .select(['session_id', 'public_id'])
    .where('session_id', '=', parsed.data)
    .where('kilo_user_id', '=', kiloUserId)
    .executeTakeFirst();

  if (!session) {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  if (session.public_id) {
    return c.json({ success: true, public_id: session.public_id }, 200);
  }

  const publicId = crypto.randomUUID();
  const res = await db
    .updateTable('cli_sessions_v2')
    .set({ public_id: publicId })
    .where('session_id', '=', parsed.data)
    .where('kilo_user_id', '=', kiloUserId)
    .where('public_id', 'is', null)
    .executeTakeFirst();

  // If another request already set it, just return the existing value.
  const updatedRows = Number(res.numUpdatedRows);
  if (updatedRows === 0) {
    const existing = await db
      .selectFrom('cli_sessions_v2')
      .select(['public_id'])
      .where('session_id', '=', parsed.data)
      .where('kilo_user_id', '=', kiloUserId)
      .executeTakeFirst();

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

  const db = getDb(c.env.HYPERDRIVE);
  const kiloUserId = c.get('user_id');

  const session = await db
    .selectFrom('cli_sessions_v2')
    .select(['session_id'])
    .where('session_id', '=', parsed.data)
    .where('kilo_user_id', '=', kiloUserId)
    .executeTakeFirst();

  if (!session) {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  await db
    .updateTable('cli_sessions_v2')
    .set({ public_id: null })
    .where('session_id', '=', parsed.data)
    .where('kilo_user_id', '=', kiloUserId)
    .execute();

  return c.json({ success: true }, 200);
});
