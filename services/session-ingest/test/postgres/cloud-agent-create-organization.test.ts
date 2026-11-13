import type * as DbClient from '@kilocode/db/client';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {},
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown;
    ctx: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('@kilocode/db/client', async importOriginal => {
  const actual = await importOriginal<typeof DbClient>();
  return { ...actual, getWorkerDb: vi.fn() };
});

vi.mock('../../src/dos/SessionIngestDO', () => ({
  getSessionIngestDO: vi.fn(() => ({ isDeleted: async () => false })),
}));

vi.mock('../../src/dos/UserConnectionDO', () => ({
  getUserConnectionDO: vi.fn(() => ({ notifySessionEvent: vi.fn() })),
}));

import { createDrizzleClient, getWorkerDb, type DrizzleClient } from '@kilocode/db/client';
import {
  cli_sessions_v2,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { SessionIngestRPC } from '../../src/session-ingest-rpc';

let client: DrizzleClient;
let rpc: SessionIngestRPC;

const createdSessionIds: string[] = [];
const createdOrganizationIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('The organization create tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  vi.mocked(getWorkerDb).mockReturnValue(client.db);
  rpc = new SessionIngestRPC(
    { waitUntil() {}, passThroughOnException() {} } as never,
    { HYPERDRIVE: { connectionString } } as never
  );
});

afterAll(async () => {
  if (!client) return;
  if (createdSessionIds.length > 0) {
    await client.db
      .delete(cli_sessions_v2)
      .where(inArray(cli_sessions_v2.session_id, createdSessionIds));
  }
  if (createdOrganizationIds.length > 0) {
    await client.db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, createdOrganizationIds));
    await client.db.delete(organizations).where(inArray(organizations.id, createdOrganizationIds));
  }
  if (createdUserIds.length > 0) {
    await client.db.delete(kilocode_users).where(inArray(kilocode_users.id, createdUserIds));
  }
  await client.pool.end();
});

/** Minimal kilocode_users row: the columns without defaults the table requires. */
async function insertUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const id = `oauth/cloud-agent-org-create-${suffix}`;
  await client.db.execute(sql`
    INSERT INTO kilocode_users (
      id, google_user_email, google_user_name, google_user_image_url, stripe_customer_id
    ) VALUES (
      ${id},
      ${`cloud-agent-org-create-${suffix}@example.test`},
      'Cloud Agent Org Create Test',
      'https://example.test/avatar.png',
      ${`cus_test_${suffix}`}
    )
  `);
  createdUserIds.push(id);
  return id;
}

async function insertOrganization(): Promise<string> {
  const id = crypto.randomUUID();
  await client.db.execute(sql`
    INSERT INTO organizations (id, name) VALUES (${id}, ${`Cloud Agent Org Create ${id}`})
  `);
  createdOrganizationIds.push(id);
  return id;
}

function uniqueSessionId(): string {
  return `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
}

async function sessionRows(sessionId: string, kiloUserId: string) {
  const result = await client.db.execute(sql`
    SELECT session_id, kilo_user_id, organization_id
    FROM cli_sessions_v2
    WHERE session_id = ${sessionId} AND kilo_user_id = ${kiloUserId}
  `);
  return result.rows;
}

describe('createSessionForCloudAgent organization membership', () => {
  it('refuses a create whose organization the acting user does not belong to', async () => {
    const kiloUserId = await insertUser();
    const organizationId = await insertOrganization();
    const sessionId = uniqueSessionId();
    createdSessionIds.push(sessionId);

    await expect(
      rpc.createSessionForCloudAgent({
        sessionId,
        kiloUserId,
        cloudAgentSessionId: `workspace_${crypto.randomUUID()}`,
        organizationId,
        createdOnPlatform: 'cloud-agent',
      })
    ).resolves.toEqual({ status: 'rejected', code: 'organization_access_denied' });

    await expect(sessionRows(sessionId, kiloUserId)).resolves.toEqual([]);
  });

  it('records the organization for a member', async () => {
    const kiloUserId = await insertUser();
    const organizationId = await insertOrganization();
    await client.db.execute(sql`
      INSERT INTO organization_memberships (organization_id, kilo_user_id, role)
      VALUES (${organizationId}, ${kiloUserId}, 'member')
    `);
    const sessionId = uniqueSessionId();
    createdSessionIds.push(sessionId);

    await expect(
      rpc.createSessionForCloudAgent({
        sessionId,
        kiloUserId,
        cloudAgentSessionId: `workspace_${crypto.randomUUID()}`,
        organizationId,
        createdOnPlatform: 'cloud-agent',
      })
    ).resolves.toEqual({ status: 'ready', clone: { sessionId, copiedItemCount: 0 } });

    await expect(sessionRows(sessionId, kiloUserId)).resolves.toEqual([
      { session_id: sessionId, kilo_user_id: kiloUserId, organization_id: organizationId },
    ]);
  });
});
