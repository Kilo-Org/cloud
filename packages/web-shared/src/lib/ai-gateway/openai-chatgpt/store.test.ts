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

import { CredentialKmsError } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-credential';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { OpenAiChatGptConnectionEnvelope } from '@kilocode/db/schema-types';
import {
  testByokEnvelope,
  useFakeByokKms,
} from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import { sealedOpenAiChatGptConnectionColumns } from '@kilocode/web-shared/tests/helpers/openai-chatgpt-connection.helper';
import {
  clearOpenAiChatGptConnection,
  getOpenAiChatGptConnection,
  getOpenAiChatGptStoredConnection,
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
  is_shared_services: boolean;
  encrypted_connection_envelope: OpenAiChatGptConnectionEnvelope | null;
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

/** A stored row the way the writers produce it. */
function storedRow(
  connection: OpenAiChatGptConnection,
  overrides: Partial<StoredRow> = {}
): StoredRow {
  return {
    kilo_user_id: TEST_USER_ID,
    organization_id: null,
    is_shared_services: false,
    ...sealedOpenAiChatGptConnectionColumns(connection),
    is_enabled: true,
    created_by: TEST_USER_ID,
    ...overrides,
  };
}

/** A row whose envelope holds `plaintext`, which need not be a connection. */
function storedRowWithPlaintext(plaintext: string): StoredRow {
  return {
    ...storedRow(buildConnection()),
    encrypted_connection_envelope: {
      ...testByokEnvelope(plaintext),
      key_id: crypto.randomUUID(),
    },
  };
}

describe('openai-chatgpt connection store', () => {
  const mockDb = db as unknown as MockDb;
  const kms = useFakeByokKms();
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
    expect(JSON.stringify(rows[0].encrypted_connection_envelope)).not.toContain('access-token-1');

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
      createdBy: TEST_USER_ID,
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

  it('returns null for a row without an envelope', async () => {
    rows.push(storedRow(buildConnection(), { encrypted_connection_envelope: null }));

    await expect(getOpenAiChatGptConnection(USER_OWNER)).resolves.toBeNull();
    await expect(getOpenAiChatGptStoredConnection(USER_OWNER)).resolves.toBeNull();
    expect(kms.requests).toEqual([]);
  });

  it('returns null when the decrypted payload is not JSON', async () => {
    rows.push(storedRowWithPlaintext('not json'));

    await expect(getOpenAiChatGptConnection(USER_OWNER)).resolves.toBeNull();
  });

  it('returns null when the decrypted payload is not the expected shape', async () => {
    rows.push(storedRowWithPlaintext(JSON.stringify({ unexpected: true })));

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
    rows.push(storedRow(errored, { is_enabled: false }));

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

  describe('KMS envelopes', () => {
    it('writes the payload only into the envelope', async () => {
      await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), 'connecting-user');

      const [row] = rows;
      const serialized = JSON.stringify(row.encrypted_connection_envelope);
      expect(serialized).not.toContain('access-token-1');
      expect(serialized).not.toContain('refresh-token-1');
      expect(row.encrypted_connection_envelope).toMatchObject({
        envelope_version: 1,
      });
      expect(row.encrypted_connection_envelope?.key_id).toEqual(expect.any(String));
    });

    it('creates the data key for the connecting user before the write', async () => {
      await saveOpenAiChatGptConnection(ORG_OWNER, buildConnection(), 'connecting-user');

      expect(kms.requests).toHaveLength(1);
      expect(kms.requests[0]).toEqual({
        path: '/data-key',
        body: {
          key_id: rows[0].encrypted_connection_envelope?.key_id,
          owner_type: 'user',
          owner_id: TEST_USER_ID,
          provider_id: `openai-chatgpt-oauth:organization:${TEST_ORG_ID}`,
          actor_user_id: 'connecting-user',
        },
      });
    });

    it('replaces the envelope and the key id when the connection is saved again', async () => {
      await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);
      const first = rows[0];

      await saveOpenAiChatGptConnection(
        USER_OWNER,
        buildConnection({ access_token: 'access-token-2', refresh_token: 'refresh-token-2' }),
        TEST_USER_ID
      );

      const [second] = rows;
      expect(second.encrypted_connection_envelope).not.toEqual(first.encrypted_connection_envelope);
      expect(second.encrypted_connection_envelope?.key_id).not.toBe(
        first.encrypted_connection_envelope?.key_id
      );
      await expect(getOpenAiChatGptConnection(USER_OWNER)).resolves.toMatchObject({
        access_token: 'access-token-2',
        refresh_token: 'refresh-token-2',
      });
    });

    it('reads the envelope with the owner, provider and key id as the decrypt context', async () => {
      await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);
      kms.requests.length = 0;

      await expect(getOpenAiChatGptConnection(USER_OWNER)).resolves.toEqual(buildConnection());

      expect(kms.requests.map(request => request.path)).toEqual(['/decrypt']);
      expect(kms.requests[0].body).toMatchObject({
        key_id: rows[0].encrypted_connection_envelope?.key_id,
        owner_type: 'user',
        owner_id: TEST_USER_ID,
        provider_id: 'openai-chatgpt-oauth:personal',
      });
    });

    it('throws when the KMS service refuses the decrypt', async () => {
      await saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID);
      kms.fail('/decrypt');

      await expect(getOpenAiChatGptConnection(USER_OWNER)).rejects.toBeInstanceOf(
        CredentialKmsError
      );
    });

    it('does not create a data key when the KMS service fails, and stores nothing', async () => {
      kms.fail('/data-key');

      await expect(
        saveOpenAiChatGptConnection(USER_OWNER, buildConnection(), TEST_USER_ID)
      ).rejects.toThrow('/data-key');
      expect(rows).toEqual([]);
    });

    it('reads an envelope sealed through the helper that the writers share', async () => {
      rows.push(storedRow(buildConnection()));

      await expect(getOpenAiChatGptConnection(USER_OWNER)).resolves.toEqual(buildConnection());
      expect(kms.requests.map(request => request.path)).toEqual(['/decrypt']);
    });
  });
});
