import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleClient } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import {
  readContainerAccountBlocked,
  assertContainerAccountAvailable,
} from '../../src/container-account-admission.js';

const connectionString = process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set POSTGRES_URL to the isolated local test database');
const client = createDrizzleClient({ connectionString, ssl: false });
const users = [`oauth/blocked-${randomUUID()}`, `oauth/clear-${randomUUID()}`];
beforeAll(async () => {
  await client.db.insert(kilocode_users).values(
    users.map(id => ({
      id,
      google_user_email: `${randomUUID()}@example.test`,
      google_user_name: 'Account admission fixture',
      google_user_image_url: '',
      stripe_customer_id: '',
    }))
  );
});
afterAll(async () => {
  await client.db.delete(kilocode_users).where(inArray(kilocode_users.id, users));
  await client.pool.end();
});

describe('container account admission against PostgreSQL', () => {
  it.each(['blocked_at', 'blocked_reason'] as const)(
    'rejects %s for human actors and personal bot payers',
    async column => {
      await client.db
        .update(kilocode_users)
        .set({
          blocked_at: column === 'blocked_at' ? new Date().toISOString() : null,
          blocked_reason: column === 'blocked_reason' ? 'test block' : null,
        })
        .where(eq(kilocode_users.id, users[0]));
      for (const subject of [
        { type: 'user', id: users[1] },
        { type: 'org', id: randomUUID() },
      ] as const) {
        expect(
          await readContainerAccountBlocked(client.db, {
            subject,
            actor: { type: 'user', id: users[0] },
          })
        ).toBe(true);
      }
      expect(
        await readContainerAccountBlocked(client.db, {
          subject: { type: 'user', id: users[0] },
          actor: { type: 'bot', id: 'automation' },
        })
      ).toBe(true);
      expect(
        await readContainerAccountBlocked(client.db, {
          subject: { type: 'user', id: users[0] },
          actor: { type: 'user', id: users[1] },
        })
      ).toBe(true);
    }
  );

  it('fails admission with the account-specific reason', async () => {
    await client.db
      .update(kilocode_users)
      .set({ blocked_reason: 'test block' })
      .where(eq(kilocode_users.id, users[0]));
    await expect(
      assertContainerAccountAvailable(
        {
          HYPERDRIVE: { connectionString } as Hyperdrive,
        },
        { subject: { type: 'user', id: users[0] }, actor: { type: 'user', id: users[1] } }
      )
    ).rejects.toMatchObject({ code: 'account_blocked' });
  });

  it('permits unblocked accounts and organization bots without a human identity', async () => {
    expect(
      await readContainerAccountBlocked(client.db, {
        subject: { type: 'user', id: users[1] },
        actor: { type: 'user', id: users[1] },
      })
    ).toBe(false);
    expect(
      await readContainerAccountBlocked(client.db, {
        subject: { type: 'org', id: randomUUID() },
        actor: { type: 'bot', id: 'automation' },
      })
    ).toBe(false);
  });
});
