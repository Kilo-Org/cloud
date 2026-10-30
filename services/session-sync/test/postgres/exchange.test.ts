import { randomUUID } from 'node:crypto';

import { createDrizzleClient, type DrizzleClient } from '@kilocode/db/client';
import {
  device_sessions,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { signKiloToken, type SignKiloTokenExtra } from '@kilocode/worker-utils/kilo-token';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { authorize, exchange, type AuthEnv } from '../../src/auth';
import { exchangeResponseSchema } from '../../src/protocol';

const NEXTAUTH_SECRET = 'exchange-postgres-nextauth-secret-0123456789';
const GRANT_SECRET = 'exchange-postgres-grant-secret-0123456789abc';
const FIVE_YEARS = 157_680_000;

let client: DrizzleClient;
let env: AuthEnv;
const users: string[] = [];
const orgs: string[] = [];

beforeAll(() => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a migrated local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('The exchange tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  env = {
    NEXTAUTH_SECRET,
    SESSION_SYNC_SECRET: GRANT_SECRET,
    HYPERDRIVE: { connectionString } as Hyperdrive,
    ENVIRONMENT: 'development',
  };
});

afterAll(async () => {
  if (!client) return;
  if (users.length) {
    await client.db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.kilo_user_id, users));
    await client.db.delete(kilocode_users).where(inArray(kilocode_users.id, users));
  }
  if (orgs.length) await client.db.delete(organizations).where(inArray(organizations.id, orgs));
  await client.pool.end();
});

async function account(overrides: Partial<typeof kilocode_users.$inferInsert> = {}) {
  const id = `oauth/session-sync-exchange-${randomUUID()}`;
  const pepper = randomUUID();
  users.push(id);
  await client.db.insert(kilocode_users).values({
    id,
    google_user_email: `${randomUUID()}@example.test`,
    google_user_name: 'Session sync exchange fixture',
    google_user_image_url: '',
    stripe_customer_id: `cus_${randomUUID()}`,
    api_token_pepper: pepper,
    ...overrides,
  });
  return { id, pepper };
}

async function organization(member?: string) {
  const id = randomUUID();
  orgs.push(id);
  await client.db.insert(organizations).values({ id, name: 'Session sync exchange fixture' });
  if (member) {
    await client.db
      .insert(organization_memberships)
      .values({ organization_id: id, kilo_user_id: member, role: 'member' });
  }
  return id;
}

async function legacy(
  user: { id: string; pepper: string },
  options: { lifetime?: number; extra?: SignKiloTokenExtra } = {}
) {
  const { token } = await signKiloToken({
    userId: user.id,
    pepper: user.pepper,
    secret: NEXTAUTH_SECRET,
    expiresInSeconds: options.lifetime ?? FIVE_YEARS,
    env: 'development',
    extra: options.extra ?? { deviceAuthRequestCode: 'SYNTH-0001' },
  });
  return token;
}

function request(token: string, organizationID?: string) {
  return new Request('https://session-sync.test/v1/auth/exchange', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(
      organizationID === undefined ? { version: 1 } : { version: 1, organizationID }
    ),
  });
}

async function code(response: Response) {
  const body: { error?: { code?: unknown } } = await response.json();
  return { status: response.status, code: body.error?.code };
}

describe('credential exchange against the account database', () => {
  it('issues a personal grant that authorizes data routes', async () => {
    const user = await account();
    const response = await exchange(request(await legacy(user)), env);
    expect(response.status).toBe(200);
    const body = exchangeResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ userID: user.id, tenant: { type: 'user', id: user.id } });
    const lifetime = Date.parse(body.expiresAt) - Date.now();
    expect(lifetime).toBeGreaterThan(0);
    expect(lifetime).toBeLessThanOrEqual(60_000);

    const data = new Request('https://session-sync.test/v1/sessions/ses_synthetic', {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    await expect(authorize(data, env)).resolves.toEqual({
      userID: user.id,
      tenant: { type: 'user', id: user.id },
    });
  });

  it('never extends a grant beyond the credential expiration', async () => {
    const user = await account();
    const { token, expiresAt } = await signModernKiloToken({
      userId: user.id,
      pepper: user.pepper,
      secret: NEXTAUTH_SECRET,
      env: 'development',
      expiresInSeconds: 20,
      audience: 'kilo-api',
      tokenPurpose: 'human-api',
      credentialExchange: true,
    });
    const response = await exchange(request(token), env);
    expect(response.status).toBe(200);
    const body = exchangeResponseSchema.parse(await response.json());
    expect(Date.parse(body.expiresAt)).toBeLessThanOrEqual(Date.parse(expiresAt));
  });

  it('binds a member to one lowercase organization tenant', async () => {
    const user = await account();
    const org = await organization(user.id);
    const response = await exchange(request(await legacy(user), org.toUpperCase()), env);
    expect(response.status).toBe(200);
    expect(exchangeResponseSchema.parse(await response.json()).tenant).toEqual({
      type: 'organization',
      id: org,
    });
  });

  it('accepts a live device session and rejects it after revocation', async () => {
    const user = await account();
    const [session] = await client.db
      .insert(device_sessions)
      .values({ kilo_user_id: user.id })
      .returning({ id: device_sessions.id });
    if (!session) throw new Error('The device session fixture was not created');
    const token = await legacy(user, {
      lifetime: 60 * 60,
      extra: { deviceSessionId: session.id },
    });
    expect((await exchange(request(token), env)).status).toBe(200);

    await client.db
      .update(device_sessions)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(device_sessions.id, session.id));
    expect(await code(await exchange(request(token), env))).toEqual({
      status: 401,
      code: 'invalid_credential',
    });
  });

  it('rejects a credential whose pepper was rotated', async () => {
    const user = await account();
    const token = await legacy(user);
    await client.db
      .update(kilocode_users)
      .set({ api_token_pepper: randomUUID() })
      .where(eq(kilocode_users.id, user.id));
    expect(await code(await exchange(request(token), env))).toEqual({
      status: 401,
      code: 'invalid_credential',
    });
  });

  it('rejects a blocked account', async () => {
    const user = await account({ blocked_reason: 'synthetic block' });
    expect(await code(await exchange(request(await legacy(user)), env))).toEqual({
      status: 403,
      code: 'account_blocked',
    });
  });

  it('rejects an organization the account does not belong to', async () => {
    const user = await account();
    const org = await organization();
    expect(await code(await exchange(request(await legacy(user), org), env))).toEqual({
      status: 403,
      code: 'organization_access_denied',
    });
  });
});
