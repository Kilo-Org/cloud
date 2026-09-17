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
import { OPENAI_CHATGPT_PROVIDER_ID } from './provider-id';
import {
  clearOpenAiChatGptConnection,
  getOpenAiChatGptConnection,
  markOpenAiChatGptError,
  saveOpenAiChatGptConnection,
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
  provider_id: string;
  encrypted_api_key: EncryptedData;
  is_enabled: boolean;
};

const TEST_USER_ID = 'user-1';

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

  beforeEach(() => {
    rows = [];

    mockDb.select.mockReset();
    mockDb.select.mockImplementation(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn(() =>
            Promise.resolve(rows.filter(row => row.kilo_user_id === TEST_USER_ID))
          ),
        })),
      })),
    }));

    mockDb.insert.mockReset();
    mockDb.insert.mockImplementation(() => ({
      values: jest.fn((values: StoredRow) => ({
        onConflictDoUpdate: jest.fn(({ set }: { set: Partial<StoredRow> }) => {
          const index = rows.findIndex(
            row =>
              row.kilo_user_id === values.kilo_user_id && row.provider_id === values.provider_id
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
          rows = rows.map(row => (row.kilo_user_id === TEST_USER_ID ? { ...row, ...set } : row));
          return Promise.resolve(undefined);
        }),
      })),
    }));

    mockDb.delete.mockReset();
    mockDb.delete.mockImplementation(() => ({
      where: jest.fn(() => {
        rows = rows.filter(row => row.kilo_user_id !== TEST_USER_ID);
        return Promise.resolve(undefined);
      }),
    }));
  });

  it('round-trips an encrypted connection through the byok row', async () => {
    const connection = buildConnection();

    await saveOpenAiChatGptConnection(TEST_USER_ID, connection);

    expect(rows).toHaveLength(1);
    expect(rows[0].provider_id).toBe(OPENAI_CHATGPT_PROVIDER_ID);
    expect(rows[0].is_enabled).toBe(true);
    // The stored blob is ciphertext, never the plaintext token.
    expect(JSON.stringify(rows[0].encrypted_api_key)).not.toContain('access-token-1');

    await expect(getOpenAiChatGptConnection(TEST_USER_ID)).resolves.toEqual(connection);
  });

  it('replaces the existing row on save instead of inserting a second', async () => {
    await saveOpenAiChatGptConnection(TEST_USER_ID, buildConnection());
    await saveOpenAiChatGptConnection(
      TEST_USER_ID,
      buildConnection({ access_token: 'access-token-2', refresh_token: 'refresh-token-2' })
    );

    expect(rows).toHaveLength(1);
    const stored = await getOpenAiChatGptConnection(TEST_USER_ID);
    expect(stored?.access_token).toBe('access-token-2');
    expect(stored?.refresh_token).toBe('refresh-token-2');
  });

  it('returns null for an undecryptable payload instead of throwing', async () => {
    rows.push({
      kilo_user_id: TEST_USER_ID,
      provider_id: OPENAI_CHATGPT_PROVIDER_ID,
      encrypted_api_key: { iv: 'not-base64!!!', data: 'also-not', authTag: 'nope' },
      is_enabled: true,
    });

    await expect(getOpenAiChatGptConnection(TEST_USER_ID)).resolves.toBeNull();
  });

  it('returns null when the decrypted payload is not the expected shape', async () => {
    rows.push({
      kilo_user_id: TEST_USER_ID,
      provider_id: OPENAI_CHATGPT_PROVIDER_ID,
      encrypted_api_key: encryptApiKey(JSON.stringify({ unexpected: true }), BYOK_ENCRYPTION_KEY),
      is_enabled: true,
    });

    await expect(getOpenAiChatGptConnection(TEST_USER_ID)).resolves.toBeNull();
  });

  it('returns null when no row exists', async () => {
    await expect(getOpenAiChatGptConnection(TEST_USER_ID)).resolves.toBeNull();
  });

  it('markOpenAiChatGptError clears the token set and disables the connection', async () => {
    await saveOpenAiChatGptConnection(TEST_USER_ID, buildConnection());

    await markOpenAiChatGptError(TEST_USER_ID, 'Your ChatGPT connection has expired.');

    const stored = await getOpenAiChatGptConnection(TEST_USER_ID);
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
    await markOpenAiChatGptError(TEST_USER_ID, 'Your ChatGPT connection has expired.');

    expect(rows).toHaveLength(0);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('clears a previous error state when the connection is saved again', async () => {
    await saveOpenAiChatGptConnection(TEST_USER_ID, buildConnection());
    await markOpenAiChatGptError(TEST_USER_ID, 'expired');

    await saveOpenAiChatGptConnection(TEST_USER_ID, buildConnection());

    const stored = await getOpenAiChatGptConnection(TEST_USER_ID);
    expect(stored?.status).toBe('connected');
    expect(stored?.error_message).toBeUndefined();
    expect(stored?.error_at).toBeUndefined();
    expect(rows[0].is_enabled).toBe(true);
  });

  it('clearOpenAiChatGptConnection deletes the row', async () => {
    await saveOpenAiChatGptConnection(TEST_USER_ID, buildConnection());

    await clearOpenAiChatGptConnection(TEST_USER_ID);

    expect(rows).toHaveLength(0);
    await expect(getOpenAiChatGptConnection(TEST_USER_ID)).resolves.toBeNull();
  });
});
