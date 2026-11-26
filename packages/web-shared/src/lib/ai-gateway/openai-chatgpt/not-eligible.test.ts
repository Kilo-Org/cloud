jest.mock('./served-models', () => ({
  isOpenAiModelServed: jest.fn(async () => true),
}));

import { afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { useFakeByokKms } from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { openai_chatgpt_connections } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { legacyCiphertextDigestSql } from '@kilocode/web-shared/lib/ai-gateway/byok/dual-write';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { isChatGptUserNotEligible, probeOpenAiChatGptEligibility } from './eligibility';
import {
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

  it('disables the refused connection and keeps the reason for the card', async () => {
    await saveOpenAiChatGptConnection(owner, connection('refused'), owner.kiloUserId as string);

    await markOpenAiChatGptNotEligible(owner, 'refused', 'not eligible');

    const stored = await getOpenAiChatGptStoredConnection(owner);
    expect(stored?.isEnabled).toBe(false);
    expect(stored?.connection).toMatchObject({
      status: 'error',
      error_message: 'not eligible',
      access_token: '',
    });
    expect(stored?.connection.refresh_token).toBeUndefined();
  });

  it('leaves a connection made after the refused request untouched', async () => {
    await saveOpenAiChatGptConnection(owner, connection('reconnected'), owner.kiloUserId as string);

    await markOpenAiChatGptNotEligible(owner, 'refused', 'not eligible');

    const stored = await getOpenAiChatGptStoredConnection(owner);
    expect(stored?.isEnabled).toBe(true);
    expect(stored?.connection).toMatchObject({ status: 'connected', access_token: 'reconnected' });
  });

  it('writes the refusal in both stored forms, with the tokens cleared and the system actor recorded', async () => {
    await saveOpenAiChatGptConnection(
      owner,
      connection('refused-both'),
      owner.kiloUserId as string
    );
    kms.requests.length = 0;

    await markOpenAiChatGptNotEligible(owner, 'refused-both', 'not eligible');

    const [row] = await db
      .select({
        legacy: openai_chatgpt_connections.encrypted_connection,
        envelope: openai_chatgpt_connections.encrypted_connection_envelope,
        digest: sql<string>`${legacyCiphertextDigestSql(openai_chatgpt_connections.encrypted_connection)}`,
      })
      .from(openai_chatgpt_connections)
      .where(
        and(
          eq(openai_chatgpt_connections.kilo_user_id, owner.kiloUserId as string),
          isNull(openai_chatgpt_connections.organization_id)
        )
      );
    for (const stored of [row.legacy, row.envelope]) {
      const serialized = JSON.stringify(stored);
      expect(serialized).not.toContain('refused-both');
      expect(serialized).not.toContain('refresh-refused-both');
    }
    // The envelope names the static-key ciphertext written with it, as Postgres computes it.
    expect(row.envelope?.legacy_digest).toBe(row.digest);
    expect(kms.requests.find(request => request.path === '/data-key')?.body).toMatchObject({
      owner_type: 'user',
      owner_id: owner.kiloUserId,
      provider_id: 'openai-chatgpt-oauth:personal',
      actor_user_id: 'system:openai-chatgpt-eligibility',
      key_id: row.envelope?.key_id,
    });
    await expect(getOpenAiChatGptStoredConnection(owner)).resolves.toMatchObject({
      isEnabled: false,
      connection: { status: 'error', error_message: 'not eligible', access_token: '' },
    });
  });

  describe('when the KMS service cannot create a data key', () => {
    async function readPayloadColumns() {
      const [row] = await db
        .select({
          legacy: openai_chatgpt_connections.encrypted_connection,
          envelope: openai_chatgpt_connections.encrypted_connection_envelope,
        })
        .from(openai_chatgpt_connections)
        .where(
          and(
            eq(openai_chatgpt_connections.kilo_user_id, owner.kiloUserId as string),
            isNull(openai_chatgpt_connections.organization_id)
          )
        );
      return row;
    }

    it('still records the refusal, as a static-key copy without tokens and without an envelope', async () => {
      await saveOpenAiChatGptConnection(owner, connection('kms-down'), owner.kiloUserId as string);
      kms.fail('/data-key');

      await expect(
        markOpenAiChatGptNotEligible(owner, 'kms-down', 'not eligible')
      ).resolves.toBeUndefined();

      const after = await readPayloadColumns();
      expect(after.envelope).toBeNull();
      expect(JSON.stringify(after.legacy)).not.toContain('kms-down');
      // Readers use the static-key copy, so the card shows the refusal.
      const stored = await getOpenAiChatGptStoredConnection(owner);
      expect(stored?.isEnabled).toBe(false);
      expect(stored?.connection).toMatchObject({
        status: 'error',
        error_message: 'not eligible',
        access_token: '',
      });
      expect(stored?.connection.refresh_token).toBeUndefined();
    });

    it('records the refusal even when the KMS service cannot open the stored envelope either', async () => {
      await saveOpenAiChatGptConnection(
        owner,
        connection('kms-fully-down'),
        owner.kiloUserId as string
      );
      kms.fail('/data-key');
      kms.fail('/decrypt');

      await markOpenAiChatGptNotEligible(owner, 'kms-fully-down', 'not eligible');

      const after = await readPayloadColumns();
      expect(after.envelope).toBeNull();
      const stored = await getOpenAiChatGptStoredConnection(owner);
      expect(stored?.isEnabled).toBe(false);
      expect(stored?.connection).toMatchObject({ status: 'error', access_token: '' });
    });

    it('leaves a connection made after the refused request untouched', async () => {
      await saveOpenAiChatGptConnection(
        owner,
        connection('reconnected-kms-down'),
        owner.kiloUserId as string
      );
      const before = await readPayloadColumns();
      kms.fail('/data-key');

      await markOpenAiChatGptNotEligible(owner, 'refused', 'not eligible');

      await expect(readPayloadColumns()).resolves.toEqual(before);
      const stored = await getOpenAiChatGptStoredConnection(owner);
      expect(stored?.isEnabled).toBe(true);
    });
  });
});
