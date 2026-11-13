import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDrizzleClient, type DrizzleClient } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { asc, sql } from 'drizzle-orm';
import { setCloudAgentSessionVersion } from '../../src/services/cloud-agent-session-version';

const userId = 'oauth/session-version-test';
const sessionId = 'ses_12345678901234567890123456';
const cloudAgentSessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const updatedAt = '2026-01-01T00:00:00.000Z';
let client: DrizzleClient;

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('Session version tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  // A session-local copy of the table tests the real query without changing shared data.
  await client.db.execute(sql`
    CREATE TEMP TABLE cli_sessions_v2 (LIKE public.cli_sessions_v2 INCLUDING DEFAULTS)
  `);
});

afterAll(async () => {
  if (client) await client.pool.end();
});

beforeEach(async () => {
  await client.db.execute(sql`TRUNCATE pg_temp.cli_sessions_v2`);
  await client.db.insert(cli_sessions_v2).values([
    {
      session_id: sessionId,
      kilo_user_id: userId,
      cloud_agent_session_id: cloudAgentSessionId,
      updated_at: updatedAt,
    },
    { session_id: sessionId, kilo_user_id: 'oauth/someone-else', updated_at: updatedAt },
  ]);
});

async function readRows() {
  return client.db
    .select({
      kilo_user_id: cli_sessions_v2.kilo_user_id,
      version: cli_sessions_v2.version,
      updated_at: cli_sessions_v2.updated_at,
    })
    .from(cli_sessions_v2)
    .orderBy(asc(cli_sessions_v2.kilo_user_id));
}

describe('setCloudAgentSessionVersion', () => {
  it.each([
    ['kilo2', 2],
    ['kilo', 1],
  ] as const)(
    'records %s as version %i without moving the session in the list',
    async (runtimeHarness, version) => {
      await setCloudAgentSessionVersion(client.db, {
        sessionId,
        kiloUserId: userId,
        cloudAgentSessionId,
        runtimeHarness,
      });

      const rows = await readRows();
      expect(rows.map(row => [row.kilo_user_id, row.version])).toEqual([
        [userId, version],
        ['oauth/someone-else', 0],
      ]);
      expect(new Date(rows[0]!.updated_at).toISOString()).toBe(updatedAt);
    }
  );

  it('does not write a row owned by another Cloud Agent session', async () => {
    await setCloudAgentSessionVersion(client.db, {
      sessionId,
      kiloUserId: userId,
      cloudAgentSessionId: 'workspace_22222222-2222-4222-8222-222222222222',
      runtimeHarness: 'kilo2',
    });

    expect((await readRows()).map(row => row.version)).toEqual([0, 0]);
  });
});
