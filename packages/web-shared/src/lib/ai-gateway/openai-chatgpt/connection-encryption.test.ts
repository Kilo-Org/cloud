import { describe, expect, it } from '@jest/globals';
import type { EncryptedData } from '@kilocode/db/schema-types';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import {
  testByokEnvelope,
  useFakeByokKms,
} from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import { sealedOpenAiChatGptConnectionColumns } from '@kilocode/web-shared/tests/helpers/openai-chatgpt-connection.helper';
import { legacyCiphertextDigest } from '@kilocode/web-shared/lib/ai-gateway/byok/dual-write';
import {
  createOpenAiChatGptSealingKey,
  openAiChatGptKmsOwnerFor,
  openAiChatGptKmsOwnerOfRow,
  openOpenAiChatGptConnection,
  sealOpenAiChatGptConnection,
  type OpenAiChatGptConnectionOwnerColumns,
  type OpenAiChatGptKmsOwner,
} from './connection-encryption';
import type { OpenAiChatGptConnection } from './types';

const USER_ID = 'user-1';
const ORG_ID = '00000000-0000-4000-8000-000000000001';

const personalRow: OpenAiChatGptConnectionOwnerColumns = {
  kilo_user_id: USER_ID,
  organization_id: null,
  is_shared_services: false,
};
const memberRow: OpenAiChatGptConnectionOwnerColumns = {
  kilo_user_id: USER_ID,
  organization_id: ORG_ID,
  is_shared_services: false,
};
const sharedRow: OpenAiChatGptConnectionOwnerColumns = {
  kilo_user_id: 'connector-user',
  organization_id: ORG_ID,
  is_shared_services: true,
};

const kms = useFakeByokKms();

function connection(): OpenAiChatGptConnection {
  return {
    access_token: 'access-token-1',
    refresh_token: 'refresh-token-1',
    expires_at: 1_800_000_000,
    issuer: 'https://auth.openai.com',
    client_id: 'client-id',
    subject: 'subject-1',
    connected_at: '2026-09-16T00:00:00.000Z',
    status: 'connected',
  };
}

function storedColumns(owner: OpenAiChatGptConnectionOwnerColumns) {
  return { ...owner, ...sealedOpenAiChatGptConnectionColumns(connection()) };
}

describe('openAiChatGptKmsOwnerOfRow', () => {
  it.each([
    [
      'a personal row',
      personalRow,
      { owner_type: 'user', owner_id: USER_ID, provider_id: 'openai-chatgpt-oauth:personal' },
    ],
    [
      'an organization member row',
      memberRow,
      {
        owner_type: 'user',
        owner_id: USER_ID,
        provider_id: `openai-chatgpt-oauth:organization:${ORG_ID}`,
      },
    ],
    [
      'a shared-services row',
      sharedRow,
      {
        owner_type: 'organization',
        owner_id: ORG_ID,
        provider_id: 'openai-chatgpt-oauth:shared-services',
      },
    ],
  ] as const)('binds %s to its owner and account', (_label, row, owner) => {
    expect(openAiChatGptKmsOwnerOfRow(row)).toEqual(owner);
  });

  it('has no owner for a member row whose person was deleted', () => {
    expect(openAiChatGptKmsOwnerOfRow({ ...memberRow, kilo_user_id: null })).toBeNull();
  });

  it('has no owner for a shared-services row without an organization', () => {
    expect(openAiChatGptKmsOwnerOfRow({ ...sharedRow, organization_id: null })).toBeNull();
  });
});

describe('createOpenAiChatGptSealingKey', () => {
  it('requests a data key bound to the owner, the provider and a new key id, for the actor', async () => {
    const owner: OpenAiChatGptKmsOwner = openAiChatGptKmsOwnerFor({
      kind: 'shared_services',
      organizationId: ORG_ID,
    });

    const sealingKey = await createOpenAiChatGptSealingKey(owner, 'actor-user');

    expect(kms.requests).toEqual([
      {
        path: '/data-key',
        body: {
          key_id: sealingKey.keyId,
          owner_type: 'organization',
          owner_id: ORG_ID,
          provider_id: 'openai-chatgpt-oauth:shared-services',
          actor_user_id: 'actor-user',
        },
      },
    ]);
  });

  it('uses a different random key id for every sealing key', async () => {
    const owner: OpenAiChatGptKmsOwner = openAiChatGptKmsOwnerFor({
      kind: 'member',
      kiloUserId: USER_ID,
      organizationId: null,
    });

    const first = await createOpenAiChatGptSealingKey(owner, 'actor');
    const second = await createOpenAiChatGptSealingKey(owner, 'actor');

    expect(first.keyId).not.toBe(second.keyId);
    expect(first.keyId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('sealOpenAiChatGptConnection', () => {
  it('stores the sealing key id in the envelope and the static-key digest next to it', async () => {
    const sealingKey = await createOpenAiChatGptSealingKey(
      openAiChatGptKmsOwnerFor({ kind: 'member', kiloUserId: USER_ID, organizationId: null }),
      'actor'
    );

    const sealed = sealOpenAiChatGptConnection(connection(), sealingKey);

    expect(sealed.encrypted_connection_envelope.key_id).toBe(sealingKey.keyId);
    expect(sealed.encrypted_connection_envelope.legacy_digest).toBe(
      legacyCiphertextDigest(sealed.encrypted_connection)
    );
    expect(JSON.stringify(sealed)).not.toContain('access-token-1');
    expect(JSON.stringify(sealed)).not.toContain('refresh-token-1');
  });
});

describe('openOpenAiChatGptConnection', () => {
  it.each([
    [
      'a personal row',
      personalRow,
      { owner_type: 'user', owner_id: USER_ID, provider_id: 'openai-chatgpt-oauth:personal' },
    ],
    [
      'an organization member row',
      memberRow,
      {
        owner_type: 'user',
        owner_id: USER_ID,
        provider_id: `openai-chatgpt-oauth:organization:${ORG_ID}`,
      },
    ],
    [
      'a shared-services row',
      sharedRow,
      {
        owner_type: 'organization',
        owner_id: ORG_ID,
        provider_id: 'openai-chatgpt-oauth:shared-services',
      },
    ],
  ] as const)(
    'binds the decrypt of %s to its owner, the provider and the envelope key id',
    async (_label, owner, expected) => {
      const row = storedColumns(owner);

      await expect(openOpenAiChatGptConnection(row)).resolves.toEqual(connection());

      expect(kms.requests).toHaveLength(1);
      expect(kms.requests[0].path).toBe('/decrypt');
      expect(kms.requests[0].body).toMatchObject({
        ...expected,
        key_id: row.encrypted_connection_envelope.key_id,
      });
    }
  );

  it("opens a personal envelope copied to the same user's organization row with the organization context", async () => {
    const personal = sealedOpenAiChatGptConnectionColumns(connection());
    // The same person's organization row holding the pair copied from the personal row. The
    // fake KMS service does not check bindings; the real one refuses a context that differs
    // from the one the data key was created for, so the request body is what matters.
    const copied = { ...memberRow, ...personal };

    await openOpenAiChatGptConnection(copied);

    expect(kms.requests).toHaveLength(1);
    expect(kms.requests[0].body).toMatchObject({
      owner_type: 'user',
      owner_id: USER_ID,
      provider_id: `openai-chatgpt-oauth:organization:${ORG_ID}`,
    });
    expect(kms.requests[0].body.provider_id).not.toBe('openai-chatgpt-oauth:personal');
  });

  it('opens an envelope copied between two organization rows of one user with the target organization', async () => {
    const otherOrgId = '00000000-0000-4000-8000-000000000002';
    const copied = {
      ...memberRow,
      organization_id: otherOrgId,
      ...sealedOpenAiChatGptConnectionColumns(connection()),
    };

    await openOpenAiChatGptConnection(copied);

    expect(kms.requests[0].body.provider_id).toBe(
      `openai-chatgpt-oauth:organization:${otherOrgId}`
    );
  });

  it('gives each seal of the same connection its own key id', () => {
    const first = sealedOpenAiChatGptConnectionColumns(connection());
    const second = sealedOpenAiChatGptConnectionColumns(connection());

    expect(first.encrypted_connection_envelope.key_id).not.toBe(
      second.encrypted_connection_envelope.key_id
    );
  });

  it('reads null for a member row whose person was deleted, without contacting the KMS service', async () => {
    const row = storedColumns({ ...memberRow, kilo_user_id: null });

    await expect(openOpenAiChatGptConnection(row)).resolves.toBeNull();
    expect(kms.requests).toEqual([]);
  });

  it('reads null when the decrypted payload is not JSON', async () => {
    await expect(openOpenAiChatGptConnection(corruptRow('not json'))).resolves.toBeNull();
  });

  it('reads null when the decrypted JSON is not a connection', async () => {
    await expect(
      openOpenAiChatGptConnection(corruptRow('{"unexpected":true}'))
    ).resolves.toBeNull();
  });

  it('reads null for a static-key copy that does not decrypt when no envelope exists', async () => {
    const corrupt: EncryptedData = { iv: 'not-base64!!!', data: 'also-not', authTag: 'nope' };

    await expect(
      openOpenAiChatGptConnection({
        ...personalRow,
        encrypted_connection: corrupt,
        encrypted_connection_envelope: null,
      })
    ).resolves.toBeNull();
  });

  it('reads a row without an envelope from its static-key copy', async () => {
    await expect(
      openOpenAiChatGptConnection({
        ...personalRow,
        encrypted_connection: encryptApiKey(JSON.stringify(connection()), BYOK_ENCRYPTION_KEY),
        encrypted_connection_envelope: null,
      })
    ).resolves.toEqual(connection());
    expect(kms.requests).toEqual([]);
  });

  /** A row whose envelope is current but holds `plaintext`, which is not a connection. */
  function corruptRow(plaintext: string) {
    const legacy = encryptApiKey(plaintext, BYOK_ENCRYPTION_KEY);
    return {
      ...personalRow,
      encrypted_connection: legacy,
      encrypted_connection_envelope: {
        ...testByokEnvelope(plaintext),
        legacy_digest: legacyCiphertextDigest(legacy),
        key_id: 'key-1',
      },
    };
  }
});
