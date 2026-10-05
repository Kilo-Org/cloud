jest.mock('./served-models', () => ({
  isOpenAiModelServed: jest.fn(async () => true),
}));

import { afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
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
});
