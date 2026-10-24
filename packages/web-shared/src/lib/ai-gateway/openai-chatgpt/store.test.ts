jest.mock('@kilocode/web-shared/lib/drizzle', () => {
  const db = {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  return { db, readDb: db };
});

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  BYOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
}));

jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

import { db } from '@kilocode/web-shared/lib/drizzle';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { openAiChatGptConnectionPresenceRedisKey } from '@kilocode/web-shared/lib/redis-keys';
import {
  encryptApiKey,
  type EncryptedData,
} from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import {
  clearOpenAiChatGptConnection,
  getOpenAiChatGptConnection,
  getOpenAiChatGptStoredConnection,
  openAiChatGptSharedServicesOwner,
  recordOpenAiChatGptConnectionPresence,
  saveOpenAiChatGptConnection,
  type OpenAiChatGptOwner,
} from './store';
import type { OpenAiChatGptConnection } from './types';

type MockDb = {
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
};

type StoredRow = {
  kilo_user_id: string;
  organization_id: string | null;
  encrypted_connection: EncryptedData;
  is_enabled: boolean;
  created_by: string;
};

const TEST_USER_ID = 'user-1';
const TEST_ORG_ID = '00000000-0000-4000-8000-000000000001';
const USER_OWNER: OpenAiChatGptOwner = { kiloUserId: TEST_USER_ID, organizationId: null };
const ORG_OWNER: OpenAiChatGptOwner = { kiloUserId: TEST_USER_ID, organizationId: TEST_ORG_ID };

function buildConnection(
  overrides: Partial<OpenAiChatGptConnection> = {}
): OpenAiChatGptConnection {
  return {
    access_token: 'access-token-1',
    refresh_token: 'refresh-token-1',
    expires_at: 1_800_000_000,
    scope: 'openid profile email offline_access',
    token_type: 'Bearer',
    issuer: 'https://auth.openai.com',
    client_id: 'client-id',
    subject: 'subject-1',
    email: 'user@example.com',
    connected_at: '2026-09-16T00:00:00.000Z',
    status: 'connected',
    ...overrides,
  };
}

const mockedRedisGet = jest.mocked(redisClient.get);
const mockedRedisSet = jest.mocked(redisClient.set);
const mockedRedisDel = jest.mocked(redisClient.del);

function flushPromises(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe('openai-chatgpt connection store', () => {
  const mockDb = db as unknown as MockDb;
  let rows: StoredRow[] = [];
  let activeOwner: OpenAiChatGptOwner = USER_OWNER;
  let cache = new Map<string, string>();

  function matchesActiveOwner(row: StoredRow): boolean {
    return (
      row.kilo_user_id === activeOwner.kiloUserId &&
      (activeOwner.organizationId === null
        ? row.organization_id === null
        : row.organization_id === activeOwner.organizationId)
    );
  }

  beforeEach(() => {
    rows = [];
    activeOwner = USER_OWNER;
    cache = new Map();

    mockedRedisGet.mockReset();
    mockedRedisGet.mockImplementation((async (key: string) => cache.get(key) ?? null) as never);
    mockedRedisSet.mockReset();
    mockedRedisSet.mockImplementation((async (
      key: string,
      value: string,
      options?: { nx?: boolean }
    ) => {
      if (options?.nx && cache.has(key)) return null;
      cache.set(key, value);
      return 'OK';
    }) as never);
    mockedRedisDel.mockReset();
    mockedRedisDel.mockImplementation((async (key: string) =>
      cache.delete(key) ? 1 : 0) as never);

    mockDb.select.mockReset();
    mockDb.select.mockImplementation(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn(() => Promise.resolve(rows.filter(matchesActiveOwner))),
        })),
      })),
    }));

    mockDb.insert.mockReset();
    mockDb.insert.mockImplementation(() => ({
      values: jest.fn((values: StoredRow) => ({
        onConflictDoUpdate: jest.fn(({ set }: { set: Partial<StoredRow> }) => {
          const index = rows.findIndex(
            row =>
              row.kilo_user_id === values.kilo_user_id &&
              row.organization_id === values.organization_id
          );
          if (index >= 0) {
            rows[index] = { ...rows[index], ...set };
          } else {
            rows.push({ ...values });
          }
          return Promise.resolve(undefined);
        }),
      })),
    }));

    mockDb.update.mockReset();
    mockDb.update.mockImplementation(() => ({
      set: jest.fn((set: Partial<StoredRow>) => ({
        where: jest.fn(() => {
          rows = rows.map(row => (matchesActiveOwner(row) ? { ...row, ...set } : row));
          return Promise.resolve(undefined);
        }),
      })),
    }));

    mockDb.delete.mockReset();
    mockDb.delete.mockImplementation(() => ({
      where: jest.fn(() => {
        rows = rows.filter(row => !matchesActiveOwner(row));
        return Promise.resolve(undefined);
      }),
    }));
  });

  it('round-trips an encrypted personal connection', async () => {
    const connection = buildConnection();

    await saveOpenAiChatGptConnection(USER_OWNER, connection, TEST_USER_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0].kilo_user_id).toBe(TEST_USER_ID);
    expect(rows[0].organization_id).toBeNull();
    expect(rows[0].is_enabled).toBe(true);
    // The stored blob is ciphertext, never the plaintext token.
    expect(JSON.stringify(rows[0].encrypted_connection)).not.toContain('access-token-1');

    await expect(getOpenAiChatGptConnection(USER_OWNER)).resolves.toEqual(connection);
  });

  it('stores an organization connection for the member who connected it', async () => {
    activeOwner = ORG_OWNER;

    await saveOpenAiChatGptConnection(ORG_OWNER, buildConnection(), TEST_USER_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(TEST_ORG_ID);
    // The connection is personal, so the member stays the owner.
    expect(rows[0].kilo_user_id).toBe(TEST_USER_ID);
    await expect(getOpenAiChatGptConnection(ORG_OWNER)).resolves.toEqual(buildConnection());
  });

  it('keeps one connection per account, so personal and organization rows coexist', async () => {
    await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);
    await saveOpenAiChatGptConnection(
      ORG_OWNER,
      buildConnection({ access_token: 'org-access-token' }),
      TEST_USER_ID
    );

    expect(rows).toHaveLength(2);
    activeOwner = USER_OWNER;
    await expect(getOpenAiChatGptConnection(USER_OWNER)).resolves.toMatchObject({
      access_token: 'access-token-1',
    });
    activeOwner = ORG_OWNER;
    await expect(getOpenAiChatGptConnection(ORG_OWNER)).resolves.toMatchObject({
      access_token: 'org-access-token',
    });
  });

  it('reports the row enabled flag alongside the stored connection', async () => {
    await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);

    await expect(getOpenAiChatGptStoredConnection(USER_OWNER)).resolves.toEqual({
      connection: buildConnection(),
      isEnabled: true,
    });
  });

  it('reports isEnabled false when the row is disabled while the payload still says connected', async () => {
    await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);
    // Mimics the ordinary BYOK toggle, which only flips the row flag.
    rows = rows.map(row => ({ ...row, is_enabled: false }));

    const stored = await getOpenAiChatGptStoredConnection(USER_OWNER);

    expect(stored?.isEnabled).toBe(false);
    expect(stored?.connection.status).toBe('connected');
  });

  it('replaces the existing row on save instead of inserting a second', async () => {
    await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);
    await saveOpenAiChatGptConnection(
      USER_OWNER,
      buildConnection({ access_token: 'access-token-2', refresh_token: 'refresh-token-2' }),
      TEST_USER_ID
    );

    expect(rows).toHaveLength(1);
    const stored = await getOpenAiChatGptConnection(USER_OWNER);
    expect(stored?.access_token).toBe('access-token-2');
    expect(stored?.refresh_token).toBe('refresh-token-2');
  });

  it('returns null for an undecryptable payload instead of throwing', async () => {
    rows.push({
      kilo_user_id: TEST_USER_ID,
      organization_id: null,
      encrypted_connection: { iv: 'not-base64!!!', data: 'also-not', authTag: 'nope' },
      is_enabled: true,
      created_by: TEST_USER_ID,
    });

    await expect(getOpenAiChatGptConnection(USER_OWNER)).resolves.toBeNull();
  });

  it('returns null when the decrypted payload is not the expected shape', async () => {
    rows.push({
      kilo_user_id: TEST_USER_ID,
      organization_id: null,
      encrypted_connection: encryptApiKey(
        JSON.stringify({ unexpected: true }),
        BYOK_ENCRYPTION_KEY
      ),
      is_enabled: true,
      created_by: TEST_USER_ID,
    });

    await expect(getOpenAiChatGptConnection(USER_OWNER)).resolves.toBeNull();
  });

  it('returns null when no row exists', async () => {
    await expect(getOpenAiChatGptConnection(USER_OWNER)).resolves.toBeNull();
  });

  it('clears a previous error state when the connection is saved again', async () => {
    const errored = {
      ...buildConnection(),
      access_token: '',
      expires_at: 0,
      status: 'error' as const,
      error_message: 'expired',
      error_at: new Date().toISOString(),
    };
    rows.push({
      kilo_user_id: TEST_USER_ID,
      organization_id: null,
      encrypted_connection: encryptApiKey(JSON.stringify(errored), BYOK_ENCRYPTION_KEY),
      is_enabled: false,
      created_by: TEST_USER_ID,
    });

    await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);

    const stored = await getOpenAiChatGptConnection(USER_OWNER);
    expect(stored?.status).toBe('connected');
    expect(stored?.error_message).toBeUndefined();
    expect(stored?.error_at).toBeUndefined();
    expect(rows[0].is_enabled).toBe(true);
  });

  it('clearOpenAiChatGptConnection deletes only the account row', async () => {
    await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);
    await saveOpenAiChatGptConnection(ORG_OWNER, buildConnection(), TEST_USER_ID);

    await clearOpenAiChatGptConnection(USER_OWNER);

    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(TEST_ORG_ID);
    await expect(getOpenAiChatGptConnection(USER_OWNER)).resolves.toBeNull();
  });

  describe('connection presence cache', () => {
    const userKey = openAiChatGptConnectionPresenceRedisKey(USER_OWNER);

    it('returns null without a database query when the owner is cached as absent', async () => {
      cache.set(userKey, 'absent');

      await expect(getOpenAiChatGptStoredConnection(USER_OWNER)).resolves.toBeNull();
      expect(mockDb.select).not.toHaveBeenCalled();
      expect(mockedRedisSet).not.toHaveBeenCalled();
    });

    it('reads the row when the owner is cached as present, without repopulating', async () => {
      await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);
      rows = rows.map(row => ({ ...row, is_enabled: false }));
      mockedRedisSet.mockClear();

      await expect(getOpenAiChatGptStoredConnection(USER_OWNER)).resolves.toEqual({
        connection: buildConnection(),
        isEnabled: false,
      });
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(mockedRedisSet).not.toHaveBeenCalled();
    });

    it('populates a miss with NX and a one-hour TTL from the row it read', async () => {
      await expect(getOpenAiChatGptStoredConnection(USER_OWNER)).resolves.toBeNull();
      expect(mockedRedisSet).toHaveBeenCalledWith(userKey, 'absent', { nx: true, ex: 3600 });

      cache.clear();
      mockedRedisSet.mockClear();
      rows.push({
        kilo_user_id: TEST_USER_ID,
        organization_id: null,
        encrypted_connection: encryptApiKey(JSON.stringify(buildConnection()), BYOK_ENCRYPTION_KEY),
        is_enabled: true,
        created_by: TEST_USER_ID,
      });

      await expect(getOpenAiChatGptStoredConnection(USER_OWNER)).resolves.toMatchObject({
        isEnabled: true,
      });
      expect(mockedRedisSet).toHaveBeenCalledWith(userKey, 'present', { nx: true, ex: 3600 });
    });

    it('does not let a populating reader overwrite the value a writer recorded', async () => {
      await recordOpenAiChatGptConnectionPresence(USER_OWNER, 'present');
      mockedRedisGet.mockResolvedValueOnce(null);

      await getOpenAiChatGptStoredConnection(USER_OWNER);

      expect(cache.get(userKey)).toBe('present');
    });

    it('treats an unreadable cached value as a miss', async () => {
      cache.set(userKey, 'maybe');

      await expect(getOpenAiChatGptStoredConnection(USER_OWNER)).resolves.toBeNull();
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });

    it('falls back to the database when Redis fails, without an unhandled rejection', async () => {
      await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);
      mockedRedisGet.mockRejectedValue(new Error('redis timeout'));
      mockedRedisSet.mockRejectedValue(new Error('redis timeout'));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(getOpenAiChatGptStoredConnection(USER_OWNER)).resolves.toMatchObject({
        isEnabled: true,
      });
      await flushPromises();

      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });

    it('does not fail the lookup when populating throws synchronously', async () => {
      await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);
      mockedRedisGet.mockResolvedValue(null);
      mockedRedisSet.mockImplementation(() => {
        throw new TypeError('redis client unavailable');
      });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(getOpenAiChatGptStoredConnection(USER_OWNER)).resolves.toMatchObject({
        isEnabled: true,
      });
      await flushPromises();

      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('records present after a save and absent after a disconnect, overriding the cache', async () => {
      cache.set(userKey, 'absent');

      await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);
      expect(mockedRedisSet).toHaveBeenLastCalledWith(userKey, 'present', { ex: 3600 });
      expect(cache.get(userKey)).toBe('present');

      await clearOpenAiChatGptConnection(USER_OWNER);
      expect(mockedRedisSet).toHaveBeenLastCalledWith(userKey, 'absent', { ex: 3600 });
      expect(cache.get(userKey)).toBe('absent');
    });

    it('deletes the key when the authoritative write fails', async () => {
      cache.set(userKey, 'absent');
      mockedRedisSet.mockRejectedValue(new Error('redis timeout'));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);

      expect(rows).toHaveLength(1);
      expect(mockedRedisDel).toHaveBeenCalledWith(userKey);
      expect(cache.has(userKey)).toBe(false);
      warn.mockRestore();
    });

    it('never throws from the authoritative write when Redis is down', async () => {
      mockedRedisSet.mockRejectedValue(new Error('redis timeout'));
      mockedRedisDel.mockRejectedValue(new Error('redis timeout'));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(
        recordOpenAiChatGptConnectionPresence(USER_OWNER, 'absent')
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });

    it('stores only the presence marker, never token material', async () => {
      await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);
      cache.clear();
      await getOpenAiChatGptStoredConnection(USER_OWNER);

      expect([...cache.values()]).toEqual(['present']);
    });

    it('encodes each owner scope under a distinct key', () => {
      expect(openAiChatGptConnectionPresenceRedisKey(USER_OWNER)).toBe(
        `openai-chatgpt-connection:v1:user:${TEST_USER_ID}`
      );
      expect(openAiChatGptConnectionPresenceRedisKey(ORG_OWNER)).toBe(
        `openai-chatgpt-connection:v1:org:${TEST_ORG_ID}:user:${TEST_USER_ID}`
      );
      expect(
        openAiChatGptConnectionPresenceRedisKey(openAiChatGptSharedServicesOwner(TEST_ORG_ID))
      ).toBe(`openai-chatgpt-connection:v1:org:${TEST_ORG_ID}:shared-services`);

      const adversarialUserIds = ['shared-services', `org:${TEST_ORG_ID}`, 'personal'];
      const keys = [
        openAiChatGptConnectionPresenceRedisKey(openAiChatGptSharedServicesOwner(TEST_ORG_ID)),
        ...adversarialUserIds.flatMap(kiloUserId => [
          openAiChatGptConnectionPresenceRedisKey({ kiloUserId, organizationId: null }),
          openAiChatGptConnectionPresenceRedisKey({ kiloUserId, organizationId: TEST_ORG_ID }),
        ]),
      ];
      expect(new Set(keys).size).toBe(keys.length);
    });
  });
});
