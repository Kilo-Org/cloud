import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

const SLACK_TEAM_CLAIM = 'https://slack.com/team_id';
const SLACK_USER_CLAIM = 'https://slack.com/user_id';

const mockFetch = jest.fn();

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  SLACK_CLIENT_ID: 'client-id',
  SLACK_CLIENT_SECRET: 'client-secret',
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import {
  exchangeSlackOidcCode,
  fetchSlackIdentity,
  getSlackOidcAuthorizeUrl,
  getSlackOidcRedirectUri,
  revokeSlackOidcToken,
  SlackOidcError,
} from './slack-oidc';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  global.fetch = mockFetch as never;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getSlackOidcAuthorizeUrl', () => {
  test('requests only the openid scope and returns to the registered Slack callback', () => {
    const url = new URL(getSlackOidcAuthorizeUrl('signed-state'));

    expect(url.origin + url.pathname).toBe('https://slack.com/openid/connect/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(url.searchParams.get('redirect_uri')).toBe(getSlackOidcRedirectUri());
    expect(url.searchParams.get('redirect_uri')).toContain('/api/integrations/slack/callback');
  });
});

describe('exchangeSlackOidcCode', () => {
  test('posts the code to the OIDC token endpoint and returns the access token', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: true, access_token: 'xoxp-oidc' }));

    await expect(exchangeSlackOidcCode('the-code')).resolves.toBe('xoxp-oidc');

    const [requestUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe('https://slack.com/api/openid.connect.token');
    expect(init.method).toBe('POST');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('code')).toBe('the-code');
    expect(body.get('client_id')).toBe('client-id');
    expect(body.get('redirect_uri')).toBe(getSlackOidcRedirectUri());
  });

  test('rejects a token response without an access token', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: false, error: 'invalid_code' }));

    await expect(exchangeSlackOidcCode('the-code')).rejects.toBeInstanceOf(SlackOidcError);
  });

  test('rejects a non-2xx token response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: false }, 500));

    await expect(exchangeSlackOidcCode('the-code')).rejects.toBeInstanceOf(SlackOidcError);
  });
});

describe('fetchSlackIdentity', () => {
  test('reads the Slack-asserted team and user ids from userinfo', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ ok: true, [SLACK_TEAM_CLAIM]: 'T123', [SLACK_USER_CLAIM]: 'U123' })
    );

    await expect(fetchSlackIdentity('xoxp-oidc')).resolves.toEqual({
      teamId: 'T123',
      userId: 'U123',
    });

    const [requestUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe('https://slack.com/api/openid.connect.userInfo');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer xoxp-oidc');
  });

  test('rejects a userinfo response without the Slack identity claims', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: true, sub: 'someone' }));

    await expect(fetchSlackIdentity('xoxp-oidc')).rejects.toBeInstanceOf(SlackOidcError);
  });

  test('rejects a userinfo response that is not ok', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: false, error: 'invalid_auth' }));

    await expect(fetchSlackIdentity('xoxp-oidc')).rejects.toBeInstanceOf(SlackOidcError);
  });
});

describe('revokeSlackOidcToken', () => {
  test('never throws when revocation fails', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));

    await expect(revokeSlackOidcToken('xoxp-oidc')).resolves.toBeUndefined();
  });
});
