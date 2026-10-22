jest.mock('./upstream-request', () => ({
  upstreamRequest: jest.fn(),
}));
jest.mock('./apply-provider-specific-logic', () => ({
  applyProviderSpecificLogic: jest.fn(),
}));

import { beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { OPENAI_CHATGPT_NOT_ELIGIBLE_MESSAGE } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/eligibility';
import { OPENAI_ON_BEHALF_OF_TOKEN_HEADER } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import {
  expireOpenAiChatGptAccessToken,
  getOpenAiChatGptStoredConnection,
  saveOpenAiChatGptConnection,
  type OpenAiChatGptOwner,
} from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store';
import { applyProviderSpecificLogic } from './apply-provider-specific-logic';
import { upstreamRequest } from './upstream-request';
import { sendUpstreamAttempt } from './upstream-attempt';

const ACCESS_TOKEN = 'delegated-access-token';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('sendUpstreamAttempt with a ChatGPT connection (real database)', () => {
  let owner: OpenAiChatGptOwner;

  beforeEach(async () => {
    const user = await insertTestUser({
      google_user_email: `upstream-attempt-${randomUUID()}@example.com`,
    });
    owner = { kiloUserId: user.id, organizationId: null };
    await saveOpenAiChatGptConnection(
      owner,
      {
        access_token: ACCESS_TOKEN,
        refresh_token: 'refresh',
        expires_at: 1_800_000_000,
        issuer: 'https://auth.openai.com',
        client_id: 'client-id',
        subject: 'subject',
        connected_at: '2026-10-05T00:00:00.000Z',
        status: 'connected',
      },
      user.id
    );
    // The real transform puts the delegated token in this header.
    jest
      .mocked(applyProviderSpecificLogic)
      .mockImplementation(async (_provider, _model, _request, extraHeaders) => {
        extraHeaders[OPENAI_ON_BEHALF_OF_TOKEN_HEADER] = ACCESS_TOKEN;
      });
  });

  async function send(response: Response) {
    jest.mocked(upstreamRequest).mockResolvedValue({ type: 'success', response } as never);
    return sendUpstreamAttempt({
      providerContext: {
        provider: { id: 'openai-chatgpt', chatGptOwner: owner },
        userByok: null,
      } as never,
      requestedModel: 'openai/gpt-6.1-sol',
      request: { kind: 'responses', body: { model: 'gpt-6.1-sol' } } as never,
      fraudHeaders: {} as never,
      userId: owner.kiloUserId as string,
      organizationId: null,
      sessionId: null,
      taskId: null,
      isNonTrialEnterprise: false,
      search: '',
      method: 'POST',
    });
  }

  it('disables the connection when OpenAI refuses the account, and passes the 403 on', async () => {
    const result = await send(
      jsonResponse(403, {
        error: {
          message: 'The ChatGPT user is not eligible for subscription sharing.',
          code: 'subscription_sharing_user_not_eligible',
        },
      })
    );

    expect(result.type === 'success' && result.response.status).toBe(403);
    const stored = await getOpenAiChatGptStoredConnection(owner);
    expect(stored?.isEnabled).toBe(false);
    expect(stored?.connection).toMatchObject({
      status: 'error',
      error_message: OPENAI_CHATGPT_NOT_ELIGIBLE_MESSAGE,
    });
  });

  it('keeps the connection on another 403', async () => {
    await send(jsonResponse(403, { error: { code: 'subscription_sharing_route_not_supported' } }));

    const stored = await getOpenAiChatGptStoredConnection(owner);
    expect(stored?.isEnabled).toBe(true);
    expect(stored?.connection.status).toBe('connected');
  });

  it.each(['token_expired', 'token_revoked'])(
    'expires the stored token when OpenAI answers 401 %s, and passes the 401 on',
    async code => {
      const result = await send(jsonResponse(401, { error: { code }, status: 401 }));

      expect(result.type === 'success' && result.response.status).toBe(401);
      const stored = await getOpenAiChatGptStoredConnection(owner);
      expect(stored?.isEnabled).toBe(true);
      expect(stored?.connection).toMatchObject({
        status: 'connected',
        access_token: ACCESS_TOKEN,
        refresh_token: 'refresh',
        expires_at: 0,
      });
    }
  );

  it('keeps the stored expiry on another 401', async () => {
    await send(jsonResponse(401, { error: { code: 'subscription_sharing_invalid_user' } }));

    const stored = await getOpenAiChatGptStoredConnection(owner);
    expect(stored?.connection.expires_at).toBe(1_800_000_000);
  });
});

describe('expireOpenAiChatGptAccessToken (real database)', () => {
  it('leaves a token refreshed after the rejected request untouched', async () => {
    const user = await insertTestUser({
      google_user_email: `expire-token-${randomUUID()}@example.com`,
    });
    const owner: OpenAiChatGptOwner = { kiloUserId: user.id, organizationId: null };
    await saveOpenAiChatGptConnection(
      owner,
      {
        access_token: 'refreshed-access-token',
        refresh_token: 'refresh',
        expires_at: 1_800_000_000,
        issuer: 'https://auth.openai.com',
        client_id: 'client-id',
        subject: 'subject',
        connected_at: '2026-10-05T00:00:00.000Z',
        status: 'connected',
      },
      user.id
    );

    await expireOpenAiChatGptAccessToken(owner, ACCESS_TOKEN);

    const stored = await getOpenAiChatGptStoredConnection(owner);
    expect(stored?.connection.expires_at).toBe(1_800_000_000);
  });
});
