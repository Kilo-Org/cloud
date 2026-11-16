/**
 * The operator token exchange needs a persisted signing key, so the federation
 * signature is stubbed and the token endpoint is answered by the fetch stub.
 */
const mockConfig: {
  CLAUDE_API_BASE_URL: string;
  CLAUDE_BILLING_CLIENT_ID: string | undefined;
} = {
  CLAUDE_API_BASE_URL: 'http://127.0.0.1:4791',
  CLAUDE_BILLING_CLIENT_ID: 'claude-billing-app',
};

jest.mock('@kilocode/web-shared/lib/auth/claude/config', () => ({
  get CLAUDE_API_BASE_URL() {
    return mockConfig.CLAUDE_API_BASE_URL;
  },
  get CLAUDE_BILLING_CLIENT_ID() {
    return mockConfig.CLAUDE_BILLING_CLIENT_ID;
  },
  CLAUDE_OPERATOR_FEDERATION_RULE_ID: 'federation-rule',
  CLAUDE_OPERATOR_ORGANIZATION_ID: 'operator-organization',
  CLAUDE_OPERATOR_SERVICE_ACCOUNT_ID: 'operator-service-account',
  CLAUDE_OPERATOR_TOKEN_AUDIENCE: 'operator-audience',
  CLAUDE_OPERATOR_WORKSPACE_ID: 'operator-workspace',
}));
jest.mock('@kilocode/web-shared/lib/auth/claude/federation-jwt', () => ({
  signClaudeFederationJwt: () => 'identity-token',
}));

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { invalidateClaudeOperatorToken, unlinkClaudeUserProfile } from './operator';

type RecordedCall = { url: string; init: RequestInit | undefined };

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function stubAnthropic(unlinkResponse: Response | 'network-error'): RecordedCall[] {
  const calls: RecordedCall[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    calls.push({ url, init });
    if (!url.endsWith('/unlink')) {
      return new Response(
        JSON.stringify({ access_token: 'operator-token', expires_in: 3600, token_type: 'Bearer' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (unlinkResponse === 'network-error') throw new TypeError('fetch failed');
    return unlinkResponse;
  });
  return calls;
}

beforeEach(() => {
  mockConfig.CLAUDE_BILLING_CLIENT_ID = 'claude-billing-app';
  invalidateClaudeOperatorToken();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('unlinkClaudeUserProfile', () => {
  it('ends the link with the operator token and only the app id', async () => {
    const calls = stubAnthropic(
      new Response(JSON.stringify({ revoked_connection_ids: ['ocon_1'] }), { status: 200 })
    );

    await expect(unlinkClaudeUserProfile('uprof_1')).resolves.toEqual({
      kind: 'unlinked',
      revokedConnectionIds: ['ocon_1'],
    });

    const [call] = calls.filter(call => call.url.endsWith('/unlink'));
    expect(call?.url).toBe('http://127.0.0.1:4791/v1/user_profiles/uprof_1/unlink');
    expect(call?.init?.method).toBe('POST');
    expect(call?.init?.headers).toMatchObject({
      Authorization: 'Bearer operator-token',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'user-profiles-search-2026-08-30',
      'content-type': 'application/json',
    });
    const body = call?.init?.body;
    if (typeof body !== 'string') throw new Error('expected a JSON string body');
    expect(JSON.parse(body)).toEqual({ oauth_app_id: 'claude-billing-app' });
  });

  it('treats an empty list as a link that was already ended', async () => {
    stubAnthropic(new Response(JSON.stringify({ revoked_connection_ids: [] }), { status: 200 }));

    await expect(unlinkClaudeUserProfile('uprof_2')).resolves.toEqual({
      kind: 'unlinked',
      revokedConnectionIds: [],
    });
  });

  it.each([500, 503, 429, 408, 401])('asks for a retry on %s', async status => {
    stubAnthropic(new Response(JSON.stringify({ error: 'unavailable' }), { status }));

    await expect(unlinkClaudeUserProfile('uprof_3')).resolves.toEqual({ kind: 'retry' });
  });

  it('asks for a retry when Anthropic cannot be reached', async () => {
    stubAnthropic('network-error');

    await expect(unlinkClaudeUserProfile('uprof_4')).resolves.toEqual({ kind: 'retry' });
  });

  it('asks for a retry when the answer is not the documented shape', async () => {
    stubAnthropic(new Response(JSON.stringify({ id: 'uprof_5' }), { status: 200 }));

    await expect(unlinkClaudeUserProfile('uprof_5')).resolves.toEqual({ kind: 'retry' });
  });

  it('mints a new operator token after a 401', async () => {
    let tokenRequests = 0;
    const unlinkAuthorization: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      if (!url.endsWith('/unlink')) {
        tokenRequests += 1;
        return new Response(
          JSON.stringify({
            access_token: `operator-token-${tokenRequests}`,
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      unlinkAuthorization.push(new Headers(init?.headers).get('Authorization') ?? '');
      return unlinkAuthorization.length === 1
        ? new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
        : new Response(JSON.stringify({ revoked_connection_ids: [] }), { status: 200 });
    });

    await expect(unlinkClaudeUserProfile('uprof_8')).resolves.toEqual({ kind: 'retry' });
    await expect(unlinkClaudeUserProfile('uprof_8')).resolves.toEqual({
      kind: 'unlinked',
      revokedConnectionIds: [],
    });

    expect(tokenRequests).toBe(2);
    expect(unlinkAuthorization).toEqual(['Bearer operator-token-1', 'Bearer operator-token-2']);
  });

  it.each([400, 403, 404])('sends the customer to Claude Console on %s', async status => {
    stubAnthropic(new Response(JSON.stringify({ error: 'refused' }), { status }));

    await expect(unlinkClaudeUserProfile('uprof_6')).resolves.toEqual({ kind: 'needs_console' });
  });

  it('does not call Anthropic without the app id', async () => {
    mockConfig.CLAUDE_BILLING_CLIENT_ID = undefined;
    const calls = stubAnthropic(
      new Response(JSON.stringify({ revoked_connection_ids: [] }), { status: 200 })
    );

    await expect(unlinkClaudeUserProfile('uprof_7')).resolves.toEqual({ kind: 'needs_console' });
    expect(calls).toHaveLength(0);
  });
});
