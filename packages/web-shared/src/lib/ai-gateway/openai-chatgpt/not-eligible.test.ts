jest.mock('./served-models', () => ({
  isOpenAiModelServed: jest.fn(async () => true),
}));

import { afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { useFakeByokKms } from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import { and, eq, isNull } from 'drizzle-orm';
import { openai_chatgpt_connections } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { OBSOLETE_STATIC_KEY_PLACEHOLDER } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-credential';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { isChatGptUserNotEligible, probeOpenAiChatGptEligibility } from './eligibility';
import {
  getOpenAiChatGptConnection,
  getOpenAiChatGptStoredConnection,
  markOpenAiChatGptNotEligible,
  saveOpenAiChatGptConnection,
  type OpenAiChatGptOwner,
} from './store';
import type { OpenAiChatGptConnection } from './types';

function connection(accessToken: string): OpenAiChatGptConnection {
  return {
    access_token: accessToken,
    refresh_token: `refresh-${accessToken}`,
    expires_at: 1_800_000_000,
    issuer: 'https://auth.openai.com',
    client_id: 'client-id',
    subject: `subject-${accessToken}`,
    connected_at: '2026-10-05T00:00:00.000Z',
    status: 'connected',
  };
}

const NOT_ELIGIBLE_BODY = {
  error: {
    message: 'The ChatGPT user is not eligible for subscription sharing.',
    type: 'invalid_request_error',
    param: null,
    code: 'subscription_sharing_user_not_eligible',
  },
};

describe('isChatGptUserNotEligible', () => {
  it('matches only the documented 403 code', () => {
    expect(isChatGptUserNotEligible(403, NOT_ELIGIBLE_BODY)).toBe(true);
    expect(isChatGptUserNotEligible(429, NOT_ELIGIBLE_BODY)).toBe(false);
    expect(
      isChatGptUserNotEligible(403, { error: { code: 'subscription_sharing_route_not_supported' } })
    ).toBe(false);
    // Direct admission can refuse a request with a `detail` body; that is not this code.
    expect(isChatGptUserNotEligible(403, { detail: 'region not permitted' })).toBe(false);
  });
});

describe('probeOpenAiChatGptEligibility', () => {
  const originalKey = process.env.OPENAI_CHATGPT_API_KEY;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    process.env.OPENAI_CHATGPT_API_KEY = 'partner-key';
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    if (originalKey === undefined) delete process.env.OPENAI_CHATGPT_API_KEY;
    else process.env.OPENAI_CHATGPT_API_KEY = originalKey;
  });

  it('denies the account OpenAI refuses', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(NOT_ELIGIBLE_BODY), { status: 403 }));

    await expect(probeOpenAiChatGptEligibility('token')).resolves.toBe(false);
    const init = fetchMock.mock.calls[0][1];
    expect(init?.headers).toMatchObject({ 'OpenAI-On-Behalf-Of-Token': 'token' });
  });

  it.each([
    ['a usage limit', 429],
    ['an outage', 503],
    ['a success', 200],
  ])('allows the account on %s', async (_label, status) => {
    fetchMock.mockResolvedValue(new Response('{}', { status }));

    await expect(probeOpenAiChatGptEligibility('token')).resolves.toBe(true);
  });

  it('allows the account when the probe cannot reach OpenAI', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));

    await expect(probeOpenAiChatGptEligibility('token')).resolves.toBe(true);
  });
});

describe('markOpenAiChatGptNotEligible (real database)', () => {
  let owner: OpenAiChatGptOwner;
  const kms = useFakeByokKms();

  beforeAll(async () => {
    const user = await insertTestUser({
      google_user_email: `chatgpt-not-eligible-${randomUUID()}@example.com`,
    });
    owner = { kiloUserId: user.id, organizationId: null };
  });

  function refusal(accessToken: string, credentialKeyId: string | null) {
    return { accessToken, credentialKeyId, message: 'not eligible' };
  }

  async function readPayloadColumns() {
    const [row] = await db
      .select({
        obsolete: openai_chatgpt_connections.encrypted_connection,
        envelope: openai_chatgpt_connections.encrypted_connection_envelope,
        isEnabled: openai_chatgpt_connections.is_enabled,
      })
      .from(openai_chatgpt_connections)
      .where(
        and(
          eq(openai_chatgpt_connections.kilo_user_id, owner.kiloUserId as string),
          isNull(openai_chatgpt_connections.organization_id)
        )
      );
    return row ?? null;
  }

  it('disables the refused connection and keeps the reason for the card', async () => {
    const { credentialKeyId } = await saveOpenAiChatGptConnection(
      owner,
      connection('refused'),
      owner.kiloUserId as string
    );

    await markOpenAiChatGptNotEligible(owner, refusal('refused', credentialKeyId));

    const stored = await getOpenAiChatGptStoredConnection(owner);
    expect(stored?.isEnabled).toBe(false);
    expect(stored?.connection).toMatchObject({
      status: 'error',
      error_message: 'not eligible',
      access_token: '',
    });
    expect(stored?.connection.refresh_token).toBeUndefined();
  });

  it('matches by decrypting the row when the caller does not know the credential key id', async () => {
    await saveOpenAiChatGptConnection(
      owner,
      connection('refused-no-id'),
      owner.kiloUserId as string
    );

    await markOpenAiChatGptNotEligible(owner, refusal('refused-no-id', null));

    await expect(getOpenAiChatGptStoredConnection(owner)).resolves.toMatchObject({
      isEnabled: false,
      connection: { status: 'error' },
    });
  });

  it('leaves a connection made after the refused request untouched', async () => {
    const refused = await saveOpenAiChatGptConnection(
      owner,
      connection('refused'),
      owner.kiloUserId as string
    );
    await saveOpenAiChatGptConnection(owner, connection('reconnected'), owner.kiloUserId as string);

    await markOpenAiChatGptNotEligible(owner, refusal('refused', refused.credentialKeyId));
    await markOpenAiChatGptNotEligible(owner, refusal('refused', null));

    const stored = await getOpenAiChatGptStoredConnection(owner);
    expect(stored?.isEnabled).toBe(true);
    expect(stored?.connection).toMatchObject({ status: 'connected', access_token: 'reconnected' });
  });

  it('writes the refusal as an envelope without tokens, the placeholder in the obsolete column and the system actor recorded', async () => {
    const { credentialKeyId } = await saveOpenAiChatGptConnection(
      owner,
      connection('refused-both'),
      owner.kiloUserId as string
    );
    kms.requests.length = 0;

    await markOpenAiChatGptNotEligible(owner, refusal('refused-both', credentialKeyId));

    const row = await readPayloadColumns();
    expect(row?.obsolete).toEqual(OBSOLETE_STATIC_KEY_PLACEHOLDER);
    expect(row?.envelope).not.toBeNull();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('refused-both');
    expect(serialized).not.toContain('refresh-refused-both');
    expect(kms.requests.find(request => request.path === '/data-key')?.body).toMatchObject({
      owner_type: 'user',
      owner_id: owner.kiloUserId,
      provider_id: 'openai-chatgpt-oauth:personal',
      actor_user_id: 'system:openai-chatgpt-eligibility',
      key_id: row?.envelope?.key_id,
    });
    await expect(getOpenAiChatGptStoredConnection(owner)).resolves.toMatchObject({
      isEnabled: false,
      connection: { status: 'error', error_message: 'not eligible', access_token: '' },
    });
  });

  describe('when the KMS service cannot create a data key', () => {
    it('deletes the refused credential, so it reads as no connection', async () => {
      const { credentialKeyId } = await saveOpenAiChatGptConnection(
        owner,
        connection('kms-down'),
        owner.kiloUserId as string
      );
      kms.fail('/data-key');

      await expect(
        markOpenAiChatGptNotEligible(owner, refusal('kms-down', credentialKeyId))
      ).resolves.toBeUndefined();

      await expect(readPayloadColumns()).resolves.toBeNull();
      await expect(getOpenAiChatGptConnection(owner)).resolves.toBeNull();
    });

    it('deletes a credential the refusal names without decrypting it under the row lock', async () => {
      const { credentialKeyId } = await saveOpenAiChatGptConnection(
        owner,
        connection('kms-down-no-decrypt'),
        owner.kiloUserId as string
      );
      kms.fail('/data-key');
      kms.requests.length = 0;
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await markOpenAiChatGptNotEligible(owner, refusal('kms-down-no-decrypt', credentialKeyId));
      } finally {
        consoleError.mockRestore();
      }

      expect(kms.requests.filter(request => request.path === '/decrypt')).toEqual([]);
      await expect(readPayloadColumns()).resolves.toBeNull();
    });

    it('leaves a connection made after the refused request untouched', async () => {
      const refused = await saveOpenAiChatGptConnection(
        owner,
        connection('refused'),
        owner.kiloUserId as string
      );
      await saveOpenAiChatGptConnection(
        owner,
        connection('reconnected-kms-down'),
        owner.kiloUserId as string
      );
      const before = await readPayloadColumns();
      kms.fail('/data-key');

      await markOpenAiChatGptNotEligible(owner, refusal('refused', refused.credentialKeyId));

      await expect(readPayloadColumns()).resolves.toEqual(before);
    });
  });

  describe('when the KMS service cannot open the stored envelope', () => {
    it('deletes the credential the refusal names, without decrypting it', async () => {
      const { credentialKeyId } = await saveOpenAiChatGptConnection(
        owner,
        connection('kms-fully-down'),
        owner.kiloUserId as string
      );
      kms.fail('/decrypt');
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await markOpenAiChatGptNotEligible(owner, refusal('kms-fully-down', credentialKeyId));

        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining('deleting the refused credential'),
          expect.any(String),
          expect.any(String)
        );
        expect(JSON.stringify(consoleError.mock.calls)).not.toContain('kms-fully-down');
      } finally {
        consoleError.mockRestore();
      }
      await expect(readPayloadColumns()).resolves.toBeNull();
    });

    it('leaves a credential sealed since the refused request untouched', async () => {
      const refused = await saveOpenAiChatGptConnection(
        owner,
        connection('refused'),
        owner.kiloUserId as string
      );
      await saveOpenAiChatGptConnection(
        owner,
        connection('reconnected'),
        owner.kiloUserId as string
      );
      const before = await readPayloadColumns();
      kms.fail('/decrypt');

      await markOpenAiChatGptNotEligible(owner, refusal('refused', refused.credentialKeyId));

      await expect(readPayloadColumns()).resolves.toEqual(before);
    });

    it('skips and logs a refusal without a credential key id, which cannot be matched', async () => {
      await saveOpenAiChatGptConnection(owner, connection('unmatched'), owner.kiloUserId as string);
      const before = await readPayloadColumns();
      kms.fail('/decrypt');
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await markOpenAiChatGptNotEligible(owner, refusal('unmatched', null));

        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining('refusal not applied'),
          expect.any(String),
          expect.any(String)
        );
      } finally {
        consoleError.mockRestore();
      }
      await expect(readPayloadColumns()).resolves.toEqual(before);
    });
  });
});
