import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDrizzleClient } from './client';
import { computeDatabaseUrl } from './database-url';
import * as schema from './schema';

const migrationsDirectory = join(__dirname, 'migrations');
const ingressMigration = readFileSync(
  join(migrationsDirectory, '0234_agent_harness_ingress.sql'),
  'utf8'
)
  .split('--> statement-breakpoint')
  .map(statement => statement.trim())
  .filter(Boolean);

function readSnapshot(name: string): ReturnType<typeof generateDrizzleJson> {
  return JSON.parse(readFileSync(join(migrationsDirectory, 'meta', name), 'utf8'));
}

// These checks need no PostgreSQL connection. The integration suite below uses the CI worker database.
describe('agent harness migration artifacts', () => {
  it('reproduces the generated DDL from its snapshots', async () => {
    const statements = await generateMigration(
      readSnapshot('0233_snapshot.json'),
      readSnapshot('0234_snapshot.json')
    );
    const normalize = (statement: string) => statement.replace(/\s+/g, ' ').trim();
    expect(ingressMigration.map(normalize)).toEqual(statements.map(normalize));
  });

  it('preserves legacy columns, context identity, and pagination indexes', () => {
    const previous = readSnapshot('0233_snapshot.json');
    const next = readSnapshot('0234_snapshot.json');
    for (const name of ['public.quick_chat_threads', 'public.quick_chat_messages']) {
      const oldTable = previous.tables[name];
      const newTable = next.tables[name];
      for (const [column, definition] of Object.entries(oldTable.columns)) {
        expect(newTable.columns[column]).toEqual(definition);
      }
      for (const [index, definition] of Object.entries(oldTable.indexes)) {
        expect(newTable.indexes[index]).toEqual(definition);
      }
      expect(newTable.foreignKeys).toEqual(oldTable.foreignKeys);
    }
  });

  it('keeps the schema synchronized with the latest generated snapshot', async () => {
    const journal = JSON.parse(
      readFileSync(join(migrationsDirectory, 'meta', '_journal.json'), 'utf8')
    ) as { entries: { idx: number }[] };
    const latest = journal.entries.at(-1);
    if (!latest) throw new Error('Missing migration journal entry');
    const snapshot = readSnapshot(`${latest.idx.toString().padStart(4, '0')}_snapshot.json`);
    const current = generateDrizzleJson(schema, snapshot.id);
    expect(await generateMigration(snapshot, current)).toEqual([]);
  });
});

describe('agent harness PostgreSQL', () => {
  let database: ReturnType<typeof createDrizzleClient>;
  let userId: string;
  let organizationId: string;
  let threadId: string;
  let organizationThreadId: string;

  beforeAll(() => {
    database = createDrizzleClient({
      connectionString: computeDatabaseUrl(),
      poolConfig: { application_name: 'agent-harness-schema-test', max: 3 },
    });
  });

  beforeEach(async () => {
    userId = `oauth/github:agent-harness-${crypto.randomUUID()}`;
    organizationId = crypto.randomUUID();
    threadId = crypto.randomUUID();
    organizationThreadId = crypto.randomUUID();
    await database.db.insert(schema.kilocode_users).values({
      id: userId,
      google_user_email: `${crypto.randomUUID()}@example.com`,
      google_user_name: 'Harness schema test',
      google_user_image_url: '',
      stripe_customer_id: `cus_${crypto.randomUUID()}`,
    });
    await database.db.insert(schema.organizations).values({
      id: organizationId,
      name: 'Harness schema test',
    });
    await database.pool.query('INSERT INTO quick_chat_threads (id, user_id) VALUES ($1, $2)', [
      threadId,
      userId,
    ]);
    await database.db.insert(schema.quick_chat_threads).values({
      id: organizationThreadId,
      user_id: userId,
      organization_id: organizationId,
    });
  });

  afterEach(async () => {
    const threadIds = [threadId, organizationThreadId];
    await database.db
      .delete(schema.agent_harness_retirements)
      .where(inArray(schema.agent_harness_retirements.thread_id, threadIds));
    await database.db
      .delete(schema.agent_harness_conversation_registry)
      .where(inArray(schema.agent_harness_conversation_registry.thread_id, threadIds));
    await database.db
      .delete(schema.quick_chat_threads)
      .where(eq(schema.quick_chat_threads.user_id, userId));
    await database.db
      .delete(schema.organization_invitations)
      .where(eq(schema.organization_invitations.organization_id, organizationId));
    await database.db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, organizationId));
    await database.db.delete(schema.kilocode_users).where(eq(schema.kilocode_users.id, userId));
  });

  afterAll(async () => {
    await database.pool.end();
  });

  function pendingRows() {
    return database.db
      .select()
      .from(schema.quick_chat_messages)
      .where(
        and(
          eq(schema.quick_chat_messages.thread_id, threadId),
          eq(schema.quick_chat_messages.provenance, 'legacy'),
          isNull(schema.quick_chat_messages.ingress_acknowledged_at)
        )
      )
      .orderBy(schema.quick_chat_messages.created_at, schema.quick_chat_messages.id)
      .limit(50);
  }

  it('accepts old-shape user and assistant inserts as pending legacy text', async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, role] of ['user', 'assistant'].entries()) {
      await database.pool.query(
        `INSERT INTO quick_chat_messages (id, thread_id, role, content, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [ids[index], threadId, role, `original ${role} text`, `2020-01-01T00:00:0${index}.000Z`]
      );
    }
    const rows = await pendingRows();
    expect(rows).toEqual([
      expect.objectContaining({
        id: ids[0],
        role: 'user',
        content: 'original user text',
        client_id: null,
        provenance: 'legacy',
        server_projection_key: null,
        ingress_acknowledged_at: null,
        ingress_lease_token: null,
        ingress_lease_expires_at: null,
      }),
      expect.objectContaining({ id: ids[1], role: 'assistant', provenance: 'legacy' }),
    ]);
    expect(rows.map(row => new Date(row.created_at).toISOString())).toEqual([
      '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:00:01.000Z',
    ]);
    const [thread] = await database.db
      .select()
      .from(schema.quick_chat_threads)
      .where(eq(schema.quick_chat_threads.id, threadId));
    expect(thread).toMatchObject({ user_id: userId, organization_id: null });
  });

  it('keeps omitted and duplicate client IDs independent of projection deduplication', async () => {
    const rows = await database.db
      .insert(schema.quick_chat_messages)
      .values(
        [null, null, 'same-client-id', 'same-client-id'].map(clientId => ({
          thread_id: threadId,
          role: 'user',
          content: 'not an idempotency key',
          client_id: clientId,
        }))
      )
      .returning();
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map(row => row.id)).size).toBe(4);
    expect((await pendingRows()).map(row => row.id).sort()).toEqual(rows.map(row => row.id).sort());
  });

  it('makes a historical row pending when the generated additive DDL runs', async () => {
    const legacyDDL = readFileSync(join(migrationsDirectory, '0233_big_abomination.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .find(statement => statement.startsWith('CREATE TABLE "quick_chat_messages"'));
    if (!legacyDDL) throw new Error('Missing legacy message table DDL');
    const connection = await database.pool.connect();
    const historicalId = crypto.randomUUID();
    try {
      await connection.query('BEGIN');
      // A transaction-local table runs the actual old/new DDL without changing the migrated public table.
      await connection.query(legacyDDL.replace('CREATE TABLE', 'CREATE TEMP TABLE'));
      await connection.query(
        `INSERT INTO quick_chat_messages (id, thread_id, role, content, created_at)
         VALUES ($1, $2, 'assistant', 'historical text', '2020-01-01T00:00:00.000Z')`,
        [historicalId, threadId]
      );
      for (const statement of ingressMigration) {
        if (statement.startsWith('ALTER TABLE "quick_chat_messages"')) {
          await connection.query(statement);
        }
      }
      const result = await connection.query<{ id: string; content: string; created_at: string }>(
        `SELECT id, content, created_at::text FROM quick_chat_messages
         WHERE provenance = 'legacy' AND ingress_acknowledged_at IS NULL`
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ id: historicalId, content: 'historical text' });
      expect(new Date(result.rows[0].created_at).toISOString()).toBe('2020-01-01T00:00:00.000Z');
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
    }
  });

  it('discovers a late commit after a newer row receives durable acknowledgment', async () => {
    const connection = await database.pool.connect();
    const lateId = crypto.randomUUID();
    const newerId = crypto.randomUUID();
    let committed = false;
    try {
      await connection.query('BEGIN');
      await connection.query(
        `INSERT INTO quick_chat_messages (id, thread_id, role, content, created_at)
         VALUES ($1, $2, 'user', 'late commit', '2020-01-01T00:00:00.000Z')`,
        [lateId, threadId]
      );
      await database.db.insert(schema.quick_chat_messages).values({
        id: newerId,
        thread_id: threadId,
        role: 'assistant',
        content: 'commits first',
        created_at: '2026-01-01T00:00:00.000Z',
      });
      expect((await pendingRows()).map(row => row.id)).toEqual([newerId]);
      await database.db
        .update(schema.quick_chat_messages)
        .set({ ingress_acknowledged_at: sql`now()` })
        .where(eq(schema.quick_chat_messages.id, newerId));
      expect(await pendingRows()).toEqual([]);
      await connection.query('COMMIT');
      committed = true;
      expect((await pendingRows()).map(row => row.id)).toEqual([lateId]);
    } finally {
      if (!committed) await connection.query('ROLLBACK');
      connection.release();
    }
  });

  it('deduplicates server projections without importing them as legacy ingress', async () => {
    const projection = {
      thread_id: threadId,
      role: 'assistant',
      content: 'server text',
      provenance: 'harness' as const,
      server_projection_key: crypto.randomUUID(),
    };
    const [inserted] = await database.db
      .insert(schema.quick_chat_messages)
      .values(projection)
      .returning();
    expect(inserted.content).toBe('server text');
    expect(
      await database.db
        .insert(schema.quick_chat_messages)
        .values(projection)
        .onConflictDoNothing()
        .returning()
    ).toEqual([]);
    await expect(
      database.db
        .insert(schema.quick_chat_messages)
        .values({ ...projection, thread_id: organizationThreadId })
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'quick_chat_messages_server_projection_uidx' },
    });
    expect(await pendingRows()).toEqual([]);
  });

  it('keeps leased rows pending until explicit acknowledgment, even after lease expiry', async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    await database.db.insert(schema.quick_chat_messages).values(
      ids.map((id, index) => ({
        id,
        thread_id: threadId,
        role: 'user',
        content: 'awaiting durable import',
        ingress_lease_token: crypto.randomUUID(),
        ingress_lease_expires_at:
          index === 0 ? '2020-01-01T00:00:00.000Z' : '2100-01-01T00:00:00.000Z',
      }))
    );
    expect((await pendingRows()).map(row => row.id).sort()).toEqual([...ids].sort());
    await database.db
      .update(schema.quick_chat_messages)
      .set({ ingress_acknowledged_at: sql`now()` })
      .where(eq(schema.quick_chat_messages.id, ids[0]));
    expect((await pendingRows()).map(row => row.id)).toEqual([ids[1]]);
  });

  it('uses partial indexes for bounded pending and lease scans', async () => {
    await database.db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const pending = await tx.execute<{ 'QUERY PLAN': string }>(sql`
        EXPLAIN SELECT id FROM quick_chat_messages
        WHERE thread_id = ${threadId} AND provenance = 'legacy' AND ingress_acknowledged_at IS NULL
        ORDER BY created_at, id LIMIT 50
      `);
      const leases = await tx.execute<{ 'QUERY PLAN': string }>(sql`
        EXPLAIN SELECT id FROM quick_chat_messages
        WHERE provenance = 'legacy' AND ingress_acknowledged_at IS NULL
        ORDER BY ingress_lease_expires_at NULLS FIRST, thread_id, id LIMIT 50
      `);
      expect(pending.rows.map(row => row['QUERY PLAN']).join('\n')).toContain(
        'IDX_quick_chat_messages_pending_ingress'
      );
      expect(leases.rows.map(row => row['QUERY PLAN']).join('\n')).toContain(
        'IDX_quick_chat_messages_ingress_lease'
      );
    });
  });

  it('retains canonical invitation results after invitation expiry and deletion', async () => {
    const invitationId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const canonicalResult = {
      invitationId,
      acceptInviteUrl: 'https://example.com/invite/test-token',
      emailStatus: 'pending' as const,
    };
    await database.db.insert(schema.organization_invitations).values({
      id: invitationId,
      organization_id: organizationId,
      invited_by: userId,
      email: 'recipient@example.com',
      role: 'member',
      token: crypto.randomUUID(),
      expires_at: '2100-01-01T00:00:00.000Z',
    });
    const result = {
      thread_id: threadId,
      operation_id: operationId,
      invitation_id: invitationId,
      input_digest: 'original-input-digest',
      canonical_result: canonicalResult,
    };
    await database.db.insert(schema.agent_harness_invitation_results).values(result);
    await database.db
      .update(schema.organization_invitations)
      .set({ expires_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(schema.organization_invitations.id, invitationId));
    await database.db
      .delete(schema.organization_invitations)
      .where(eq(schema.organization_invitations.id, invitationId));
    const retained = await database.db
      .select()
      .from(schema.agent_harness_invitation_results)
      .where(eq(schema.agent_harness_invitation_results.thread_id, threadId));
    expect(retained).toEqual([expect.objectContaining(result)]);
    await expect(
      database.db
        .insert(schema.agent_harness_invitation_results)
        .values({ ...result, input_digest: 'changed-input-digest' })
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('keeps discovery and acknowledged retirement fences after cascading parent deletion', async () => {
    await database.db.insert(schema.agent_harness_conversation_registry).values({
      thread_id: organizationThreadId,
      user_id: userId,
      organization_id: organizationId,
      generation: 3,
    });
    await database.db.insert(schema.agent_harness_retirements).values({
      thread_id: organizationThreadId,
      generation: 3,
      reason: 'context_retired',
    });
    await database.db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, organizationId));
    expect(
      await database.db
        .select()
        .from(schema.quick_chat_threads)
        .where(eq(schema.quick_chat_threads.id, organizationThreadId))
    ).toEqual([]);
    await database.db
      .delete(schema.quick_chat_threads)
      .where(eq(schema.quick_chat_threads.id, threadId));
    await database.db.delete(schema.kilocode_users).where(eq(schema.kilocode_users.id, userId));
    expect(
      await database.db
        .select()
        .from(schema.agent_harness_conversation_registry)
        .where(eq(schema.agent_harness_conversation_registry.thread_id, organizationThreadId))
    ).toEqual([expect.objectContaining({ user_id: userId, organization_id: organizationId })]);
    await database.db
      .delete(schema.agent_harness_conversation_registry)
      .where(eq(schema.agent_harness_conversation_registry.thread_id, organizationThreadId));
    await database.db
      .update(schema.agent_harness_retirements)
      .set({ acknowledged_at: sql`now()` })
      .where(eq(schema.agent_harness_retirements.thread_id, organizationThreadId));
    expect(
      await database.db
        .select()
        .from(schema.agent_harness_retirements)
        .where(eq(schema.agent_harness_retirements.thread_id, organizationThreadId))
    ).toEqual([
      expect.objectContaining({
        thread_id: organizationThreadId,
        generation: 3,
        reason: 'context_retired',
      }),
    ]);
  });
});
