import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleClient, type DrizzleClient } from '@kilocode/db/client';
import { device_sessions, kilocode_users } from '@kilocode/db/schema';
import { signModernKiloToken } from '../../src/kilo-token-policy';
import {
  createRuntimeAuthorization,
  renewRuntimeAuthorization,
  RuntimeAuthorizationRevokedError,
} from '../../src/runtime-authorization';

const secret = 'runtime-authorization-postgres-test-secret';

let client: DrizzleClient;
const createdUserIds: string[] = [];

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('The runtime authorization tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
});

afterAll(async () => {
  if (!client) return;
  if (createdUserIds.length > 0) {
    await client.db.delete(kilocode_users).where(inArray(kilocode_users.id, createdUserIds));
  }
  await client.pool.end();
});

async function insertUser(pepper: string): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const id = `oauth/runtime-authorization-${suffix}`;
  await client.db.execute(sql`
    INSERT INTO kilocode_users (
      id, google_user_email, google_user_name, google_user_image_url, stripe_customer_id, api_token_pepper
    ) VALUES (
      ${id},
      ${`runtime-authorization-${suffix}@example.test`},
      'Runtime Authorization Test',
      'https://example.test/avatar.png',
      ${`cus_test_${suffix}`},
      ${pepper}
    )
  `);
  createdUserIds.push(id);
  return id;
}

async function insertDeviceSession(userId: string): Promise<string> {
  const id = crypto.randomUUID();
  await client.db.insert(device_sessions).values({ id, kilo_user_id: userId });
  return id;
}

async function admission(options: {
  userId: string;
  pepper: string;
  deviceSessionId?: string;
}): Promise<string> {
  const { token } = await signModernKiloToken({
    userId: options.userId,
    pepper: options.pepper,
    secret,
    expiresInSeconds: 300,
    audience: 'cloud-agent-next',
    tokenPurpose: options.deviceSessionId === undefined ? 'human-api' : 'device-access',
    credentialExchange: false,
    extra: {
      ...(options.deviceSessionId === undefined
        ? {}
        : { deviceSessionId: options.deviceSessionId }),
      runtimeAdmission: {
        source: 'user',
        authorizationUserId: options.userId,
        authorizationPepper: options.pepper,
      },
    },
  });
  return token;
}

describe('runtime authorization bindings', () => {
  it('renews a device-bound delegation only while its session is live', async () => {
    const pepper = `pepper-${crypto.randomUUID()}`;
    const userId = await insertUser(pepper);
    const deviceSessionId = await insertDeviceSession(userId);
    const connectionString = process.env.POSTGRES_URL!;

    const created = await createRuntimeAuthorization({
      token: await admission({ userId, pepper, deviceSessionId }),
      secret,
      connectionString,
      resourceKind: 'cloud-agent-next',
      resourceId: 'session',
      environment: 'production',
    });
    expect(created.authorization.bindings.deviceSessionId).toBe(deviceSessionId);

    await expect(
      renewRuntimeAuthorization({
        authorization: created.authorization,
        secret,
        connectionString,
      })
    ).resolves.toMatchObject({ expiresAt: expect.any(String) });

    await client.db
      .update(device_sessions)
      .set({ revoked_at: new Date().toISOString(), revoked_reason: 'test_revocation' })
      .where(eq(device_sessions.id, deviceSessionId));

    const reasons: string[] = [];
    await expect(
      renewRuntimeAuthorization({
        authorization: created.authorization,
        secret,
        connectionString,
        onBindingRejected: reason => reasons.push(reason),
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
    expect(reasons).toEqual(['device_session_inactive']);
  });

  it('refuses to bind a delegation when the named session is already revoked', async () => {
    const pepper = `pepper-${crypto.randomUUID()}`;
    const userId = await insertUser(pepper);
    const deviceSessionId = await insertDeviceSession(userId);
    const connectionString = process.env.POSTGRES_URL!;

    await client.db
      .update(device_sessions)
      .set({ revoked_at: new Date().toISOString(), revoked_reason: 'test_revocation' })
      .where(eq(device_sessions.id, deviceSessionId));

    await expect(
      createRuntimeAuthorization({
        token: await admission({ userId, pepper, deviceSessionId }),
        secret,
        connectionString,
        resourceKind: 'cloud-agent-next',
        resourceId: 'session',
        environment: 'production',
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
  });

  it('does not bind a session a different user owns', async () => {
    const pepper = `pepper-${crypto.randomUUID()}`;
    const userId = await insertUser(pepper);
    const ownerPepper = `pepper-${crypto.randomUUID()}`;
    const ownerId = await insertUser(ownerPepper);
    const deviceSessionId = await insertDeviceSession(ownerId);
    const connectionString = process.env.POSTGRES_URL!;

    await expect(
      createRuntimeAuthorization({
        token: await admission({ userId, pepper, deviceSessionId }),
        secret,
        connectionString,
        resourceKind: 'cloud-agent-next',
        resourceId: 'session',
        environment: 'production',
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
    const [session] = await client.db
      .select({ revokedAt: device_sessions.revoked_at })
      .from(device_sessions)
      .where(and(eq(device_sessions.id, deviceSessionId)));
    expect(session?.revokedAt).toBeNull();
  });

  it('leaves a human-api delegation unbound and renewable', async () => {
    const pepper = `pepper-${crypto.randomUUID()}`;
    const userId = await insertUser(pepper);
    const connectionString = process.env.POSTGRES_URL!;

    const created = await createRuntimeAuthorization({
      token: await admission({ userId, pepper }),
      secret,
      connectionString,
      resourceKind: 'cloud-agent-next',
      resourceId: 'session',
      environment: 'production',
    });
    expect(created.authorization.bindings).not.toHaveProperty('deviceSessionId');

    await expect(
      renewRuntimeAuthorization({
        authorization: created.authorization,
        secret,
        connectionString,
      })
    ).resolves.toMatchObject({ expiresAt: expect.any(String) });
  });
});
