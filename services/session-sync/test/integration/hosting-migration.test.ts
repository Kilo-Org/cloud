import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { expect, it } from 'vitest';
import migrations from '../../drizzle/migrations';
import { session, sessionRoles } from '../../src/db/sqlite-schema';
import { getSessionSyncDOStub } from '../../src/dos/SessionSyncDO';
import { newSessionID, personal, testEnv } from '../helpers';
import { legacySession } from '../legacy-session-schema';

it('adds a nullable hosting binding without changing a pre-migration local or stream row', async () => {
  const principal = personal('synthetic-migration-owner');
  const sessionID = newSessionID();
  const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
  await runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage);
    await migrate(db, {
      ...migrations,
      journal: { ...migrations.journal, entries: migrations.journal.entries.slice(0, -1) },
    });
    db.insert(legacySession)
      .values({
        key: 1,
        session_id: sessionID,
        tenant_type: 'user',
        tenant_id: principal.userID,
        creator_id: principal.userID,
        source_id: 'synthetic-old-source',
        position: 12,
        revision: 3,
        batches: 2,
        entity_count: 0,
        inline_bytes: 0,
        blob_bytes: 0,
        tenant_lease: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
        last_write_at: Date.now(),
        deleted_at: null,
      })
      .run();
    db.insert(sessionRoles).values({ principal_id: principal.userID, role: 'owner' }).run();
    await migrate(db, migrations);
    expect(db.select().from(session).get()).toMatchObject({
      session_id: sessionID,
      position: 12,
      revision: 3,
      cloud_agent_session_id: null,
    });
  });
  expect(await stub.authorizeLive({ principal, sessionID })).toEqual({
    ok: true,
    value: { role: 'owner' },
  });
});
