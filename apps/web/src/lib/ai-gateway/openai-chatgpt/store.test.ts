jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('@/lib/config.server', () => ({
  BYOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
}));

import { db } from '@/lib/drizzle';
import { encryptApiKey, type EncryptedData } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import {
  clearOpenAiChatGptConnection,
  getOpenAiChatGptConnection,
  getOpenAiChatGptStoredConnection,
  markOpenAiChatGptError,
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

describe('openai-chatgpt connection store', () => {
  const mockDb = db as unknown as MockDb;
  let rows: StoredRow[] = [];
  let activeOwner: OpenAiChatGptOwner = USER_OWNER;

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

  it('markOpenAiChatGptError clears the token set and disables the connection', async () => {
    await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);

    await markOpenAiChatGptError(USER_OWNER, 'Your ChatGPT connection has expired.');

    const stored = await getOpenAiChatGptConnection(USER_OWNER);
    expect(stored).toMatchObject({
      access_token: '',
      expires_at: 0,
      status: 'error',
      error_message: 'Your ChatGPT connection has expired.',
    });
    expect(stored?.refresh_token).toBeUndefined();
    // The identity the card renders survives the cleared credential.
    expect(stored?.email).toBe('user@example.com');
    expect(stored?.error_at).toBeTruthy();
    expect(rows[0].is_enabled).toBe(false);
  });

  it('markOpenAiChatGptError is a no-op when no row exists', async () => {
    await markOpenAiChatGptError(USER_OWNER, 'Your ChatGPT connection has expired.');

    expect(rows).toHaveLength(0);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('clears a previous error state when the connection is saved again', async () => {
    await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);
    await markOpenAiChatGptError(USER_OWNER, 'expired');

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
});
