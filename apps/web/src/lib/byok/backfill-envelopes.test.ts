// The Sentry client is the reporting boundary: the mock counts reports without sending them.
jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<object>('@sentry/nextjs'),
  captureException: jest.fn(),
}));
// Decrypts read through the data key cache, which belongs to Redis rather than to this job.
jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => 'OK'),
    del: jest.fn(async () => 1),
  },
}));

import type * as SentryNextjs from '@sentry/nextjs';
import { randomBytes } from 'crypto';
import { eq, inArray, isNotNull } from 'drizzle-orm';
import { byok_api_keys, kilocode_users, organizations } from '@kilocode/db/schema';
import type { BYOKApiKeyEnvelope } from '@kilocode/db/schema-types';
import { decryptByokRow } from '@kilocode/web-shared/lib/ai-gateway/byok';
import { decryptApiKey, encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { BYOK_ENVELOPE_BACKFILL_ACTOR, backfillByokEnvelopes } from './backfill-envelopes';

const mockedCaptureException = jest.requireMock<typeof SentryNextjs>('@sentry/nextjs')
  .captureException as unknown as jest.Mock;

type KmsRequest = { path: string; body: Record<string, string> };

const envKeys = ['BYOK_KMS_SERVICE_URL', 'BYOK_KMS_SERVICE_TOKEN'] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const originalFetch = global.fetch;
const farFuture = () => Date.now() + 60_000;

let requests: KmsRequest[] = [];
/** Lets a test act while the service is answering, as a concurrent writer would. */
let onDataKeyRequest: (body: Record<string, string>) => Promise<Response | void> = async () => {};

function installFakeKms() {
  let issued = 0;
  const dataKeys = new Map<string, string>();
  global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body));
    requests.push({ path, body });
    if (path === '/decrypt') {
      const dataKey = dataKeys.get(body.wrapped_dek);
      return dataKey ? Response.json({ data_key: dataKey }) : new Response('{}', { status: 400 });
    }
    const override = await onDataKeyRequest(body);
    if (override) return override;
    const wrapped = `wrapped-${(issued += 1)}`;
    const dataKey = randomBytes(32).toString('base64');
    dataKeys.set(wrapped, dataKey);
    return Response.json({
      data_key: dataKey,
      wrapped_dek: wrapped,
      kms_key_id: 'alias/test',
      kms_key_version: '1',
    });
  }) as unknown as typeof fetch;
}

const createdUserIds: string[] = [];

async function createUser() {
  const user = await insertTestUser();
  createdUserIds.push(user.id);
  return user;
}

async function insertLegacyKey(userId: string, providerId: string, secret: string) {
  const [row] = await db
    .insert(byok_api_keys)
    .values({
      kilo_user_id: userId,
      provider_id: providerId,
      encrypted_api_key: encryptApiKey(secret, BYOK_ENCRYPTION_KEY),
      created_by: userId,
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    .returning();
  return row;
}

function clearByokKeys() {
  return db.delete(byok_api_keys).where(isNotNull(byok_api_keys.id));
}

async function loadKey(id: string) {
  const [row] = await db.select().from(byok_api_keys).where(eq(byok_api_keys.id, id));
  return row;
}

beforeEach(async () => {
  requests = [];
  onDataKeyRequest = async () => {};
  mockedCaptureException.mockClear();
  process.env.BYOK_KMS_SERVICE_URL = 'http://kms.test';
  process.env.BYOK_KMS_SERVICE_TOKEN = 'token';
  installFakeKms();
  // A worker's database is shared by the files it runs, and the job visits every row.
  await clearByokKeys();
});

afterEach(async () => {
  global.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await clearByokKeys();
  if (createdUserIds.length > 0) {
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, createdUserIds));
    createdUserIds.length = 0;
  }
});

describe('backfillByokEnvelopes', () => {
  test('gives a legacy row an envelope that decrypts to the same key', async () => {
    const user = await createUser();
    const row = await insertLegacyKey(user.id, 'anthropic', 'sk-ant-legacy');

    const summary = await backfillByokEnvelopes({ deadlineAt: farFuture() });

    expect(summary).toEqual({
      enabled: true,
      scanned: 1,
      migrated: 1,
      skippedConcurrentWrite: 0,
      failed: 0,
      remaining: 0,
      drained: true,
    });
    const migrated = await loadKey(row.id);
    expect(migrated.encrypted_api_key_envelope).toMatchObject({
      wrapped_dek: 'wrapped-1',
      kms_key_id: 'alias/test',
      algorithm: 'aes-256-gcm',
      envelope_version: 1,
    });
    // The envelope is readable on the same path inference uses.
    await expect(decryptByokRow(migrated)).resolves.toMatchObject({
      decryptedAPIKey: 'sk-ant-legacy',
    });
    // The legacy column stays valid for rollback, and a rewrite is not a user edit.
    expect(migrated.encrypted_api_key).toEqual(row.encrypted_api_key);
    expect(new Date(migrated.updated_at).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('binds the data key to the row and never sends the key to the service', async () => {
    const user = await createUser();
    const row = await insertLegacyKey(user.id, 'openai', 'sk-openai-legacy');
    const org = await createTestOrganization(`BYOK backfill ${crypto.randomUUID()}`, user.id, 0);
    const [orgRow] = await db
      .insert(byok_api_keys)
      .values({
        organization_id: org.id,
        provider_id: 'anthropic',
        encrypted_api_key: encryptApiKey('sk-ant-org', BYOK_ENCRYPTION_KEY),
        created_by: user.id,
      })
      .returning();

    try {
      await backfillByokEnvelopes({ deadlineAt: farFuture() });

      const contexts = requests.map(({ path, body }) => ({
        path,
        key_id: body.key_id,
        owner_type: body.owner_type,
        owner_id: body.owner_id,
        provider_id: body.provider_id,
        actor_user_id: body.actor_user_id,
      }));
      expect(contexts).toHaveLength(2);
      expect(contexts).toEqual(
        expect.arrayContaining([
          {
            path: '/data-key',
            key_id: row.id,
            owner_type: 'user',
            owner_id: user.id,
            provider_id: 'openai',
            actor_user_id: BYOK_ENVELOPE_BACKFILL_ACTOR,
          },
          {
            path: '/data-key',
            key_id: orgRow.id,
            owner_type: 'organization',
            owner_id: org.id,
            provider_id: 'anthropic',
            actor_user_id: BYOK_ENVELOPE_BACKFILL_ACTOR,
          },
        ])
      );
      const sent = JSON.stringify(requests);
      expect(sent).not.toContain('sk-openai-legacy');
      expect(sent).not.toContain('sk-ant-org');
      expect(sent).not.toContain((row.encrypted_api_key as { data: string }).data);
    } finally {
      await db.delete(byok_api_keys).where(eq(byok_api_keys.id, orgRow.id));
      await db.delete(organizations).where(eq(organizations.id, org.id));
    }
  });

  test('leaves a row that already has an envelope alone', async () => {
    const user = await createUser();
    const row = await insertLegacyKey(user.id, 'anthropic', 'sk-ant-legacy');
    const envelope: BYOKApiKeyEnvelope = {
      encrypted_data: encryptApiKey('sk-ant-legacy', randomBytes(32).toString('base64')),
      wrapped_dek: 'existing',
      kms_key_id: 'alias/test',
      kms_key_version: '1',
      algorithm: 'aes-256-gcm',
      envelope_version: 1,
    };
    await db
      .update(byok_api_keys)
      .set({ encrypted_api_key_envelope: envelope })
      .where(eq(byok_api_keys.id, row.id));

    const summary = await backfillByokEnvelopes({ deadlineAt: farFuture() });

    expect(summary).toMatchObject({ scanned: 0, migrated: 0, remaining: 0, drained: true });
    expect(requests).toHaveLength(0);
    expect((await loadKey(row.id)).encrypted_api_key_envelope).toEqual(envelope);
  });

  test('is a no-op on a second run', async () => {
    const user = await createUser();
    await insertLegacyKey(user.id, 'anthropic', 'sk-ant-legacy');
    await backfillByokEnvelopes({ deadlineAt: farFuture() });
    requests = [];

    const summary = await backfillByokEnvelopes({ deadlineAt: farFuture() });

    expect(summary).toMatchObject({
      scanned: 0,
      migrated: 0,
      failed: 0,
      remaining: 0,
      drained: true,
    });
    expect(requests).toHaveLength(0);
  });

  test('does not overwrite a key the user replaced while the envelope was being made', async () => {
    const user = await createUser();
    const row = await insertLegacyKey(user.id, 'anthropic', 'sk-ant-old');
    const replacement = encryptApiKey('sk-ant-new', BYOK_ENCRYPTION_KEY);
    onDataKeyRequest = async () => {
      await db
        .update(byok_api_keys)
        .set({ encrypted_api_key: replacement })
        .where(eq(byok_api_keys.id, row.id));
    };

    const summary = await backfillByokEnvelopes({ deadlineAt: farFuture() });

    expect(summary).toMatchObject({
      scanned: 1,
      migrated: 0,
      skippedConcurrentWrite: 1,
      failed: 0,
    });
    const current = await loadKey(row.id);
    expect(current.encrypted_api_key_envelope).toBeNull();
    expect(decryptApiKey(current.encrypted_api_key, BYOK_ENCRYPTION_KEY)).toBe('sk-ant-new');

    // The next run picks the replaced key up.
    onDataKeyRequest = async () => {};
    await backfillByokEnvelopes({ deadlineAt: farFuture() });
    await expect(decryptByokRow(await loadKey(row.id))).resolves.toMatchObject({
      decryptedAPIKey: 'sk-ant-new',
    });
  });

  test('does not overwrite an envelope another writer created in the meantime', async () => {
    const user = await createUser();
    const row = await insertLegacyKey(user.id, 'anthropic', 'sk-ant-legacy');
    const winner: BYOKApiKeyEnvelope = {
      encrypted_data: encryptApiKey('sk-ant-legacy', randomBytes(32).toString('base64')),
      wrapped_dek: 'winner',
      kms_key_id: 'alias/test',
      kms_key_version: '1',
      algorithm: 'aes-256-gcm',
      envelope_version: 1,
    };
    onDataKeyRequest = async () => {
      await db
        .update(byok_api_keys)
        .set({ encrypted_api_key_envelope: winner })
        .where(eq(byok_api_keys.id, row.id));
    };

    const summary = await backfillByokEnvelopes({ deadlineAt: farFuture() });

    expect(summary).toMatchObject({ migrated: 0, skippedConcurrentWrite: 1 });
    expect((await loadKey(row.id)).encrypted_api_key_envelope).toEqual(winner);
  });

  test('migrates the other rows when one fails, and reports the failure', async () => {
    const user = await createUser();
    const failing = await insertLegacyKey(user.id, 'anthropic', 'sk-ant-legacy');
    const healthy = await insertLegacyKey(user.id, 'openai', 'sk-openai-legacy');
    onDataKeyRequest = async body =>
      body.key_id === failing.id ? new Response('{}', { status: 403 }) : undefined;

    const summary = await backfillByokEnvelopes({ deadlineAt: farFuture(), batchSize: 1 });

    // The failed row is behind the paging cursor, but it is still counted as unmigrated.
    expect(summary).toMatchObject({
      scanned: 2,
      migrated: 1,
      failed: 1,
      remaining: 1,
      drained: false,
    });
    expect((await loadKey(failing.id)).encrypted_api_key_envelope).toBeNull();
    expect((await loadKey(healthy.id)).encrypted_api_key_envelope).not.toBeNull();
    expect(mockedCaptureException).toHaveBeenCalledTimes(1);
    expect(mockedCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: { keyId: failing.id } })
    );
  });

  test('reports a legacy ciphertext it cannot open instead of storing a bad envelope', async () => {
    const user = await createUser();
    const row = await insertLegacyKey(user.id, 'anthropic', 'sk-ant-legacy');
    await db
      .update(byok_api_keys)
      .set({ encrypted_api_key: encryptApiKey('sk', randomBytes(32).toString('base64')) })
      .where(eq(byok_api_keys.id, row.id));

    const summary = await backfillByokEnvelopes({ deadlineAt: farFuture() });

    expect(summary).toMatchObject({ migrated: 0, failed: 1, remaining: 1, drained: false });
    expect((await loadKey(row.id)).encrypted_api_key_envelope).toBeNull();
    expect(requests).toHaveLength(0);
  });

  test('pages through more rows than one batch holds', async () => {
    const user = await createUser();
    const rows = await Promise.all(
      ['anthropic', 'openai', 'minimax', 'zai', 'mistral'].map(provider =>
        insertLegacyKey(user.id, provider, `sk-${provider}`)
      )
    );

    const summary = await backfillByokEnvelopes({
      deadlineAt: farFuture(),
      batchSize: 2,
      concurrency: 2,
    });

    expect(summary).toMatchObject({
      scanned: 5,
      migrated: 5,
      failed: 0,
      remaining: 0,
      drained: true,
    });
    for (const row of rows) {
      expect((await loadKey(row.id)).encrypted_api_key_envelope).not.toBeNull();
    }
  });

  test('stops at the deadline without claiming to be drained', async () => {
    const user = await createUser();
    const row = await insertLegacyKey(user.id, 'anthropic', 'sk-ant-legacy');

    const summary = await backfillByokEnvelopes({ deadlineAt: Date.now() - 1 });

    expect(summary).toMatchObject({ scanned: 0, migrated: 0, remaining: 1, drained: false });
    expect(requests).toHaveLength(0);
    expect((await loadKey(row.id)).encrypted_api_key_envelope).toBeNull();
  });

  test('counts the rows a run did not reach before the deadline', async () => {
    const user = await createUser();
    await Promise.all(
      ['anthropic', 'openai', 'minimax'].map(provider =>
        insertLegacyKey(user.id, provider, `sk-${provider}`)
      )
    );
    // The clock passes the deadline once the first row is in flight.
    const deadlineAt = Date.now() + 60_000;
    let clock = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    onDataKeyRequest = async () => {
      clock = deadlineAt + 1;
    };

    try {
      const summary = await backfillByokEnvelopes({ deadlineAt, batchSize: 3, concurrency: 1 });

      expect(summary).toMatchObject({ scanned: 1, migrated: 1, remaining: 2, drained: false });
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('does nothing while the KMS service is not configured', async () => {
    delete process.env.BYOK_KMS_SERVICE_URL;
    const user = await createUser();
    const row = await insertLegacyKey(user.id, 'anthropic', 'sk-ant-legacy');

    const summary = await backfillByokEnvelopes({ deadlineAt: farFuture() });

    expect(summary).toMatchObject({
      enabled: false,
      scanned: 0,
      migrated: 0,
      remaining: 1,
      drained: false,
    });
    expect(requests).toHaveLength(0);
    expect((await loadKey(row.id)).encrypted_api_key_envelope).toBeNull();
  });
});
